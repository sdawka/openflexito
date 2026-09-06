/** Gallery storage in the browser: IndexedDB for metadata and image blobs. */

export type ItemKind = 'snapshot' | 'scan'

export interface GalleryItem {
  id: string
  kind: ItemKind
  name: string
  when: string
  position?: { x: number; y: number; z: number }
  controls?: object
  width?: number
  height?: number
  /** blob keys: 'image' (snapshot or stitched mosaic), 'thumb', 'tile/<n>' */
  blobs: string[]
  scan?: {
    cols: number; rows: number; overlap: number
    tiles: { index: number; col: number; row: number; stage: { x: number; y: number }; x: number; y: number; width: number; height: number; blob: string }[]
    positions?: { x: number; y: number }[]
  }
}

const DB = 'openflexito', VERSION = 2

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('items')) db.createObjectStore('items', { keyPath: 'id' }).createIndex('when', 'when')
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs')
      if (!db.objectStoreNames.contains('embeddings')) db.createObjectStore('embeddings', { keyPath: 'key' }).createIndex('item', 'item')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode)
    const req = fn(t.objectStore(store))
    t.oncomplete = () => resolve((req as IDBRequest<T> | undefined)?.result as T)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  }))
}

export { tx as _tx }
export const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const blobKey = (id: string, name: string) => `${id}/${name}`

export async function listItems(): Promise<GalleryItem[]> {
  const items = await tx<GalleryItem[]>('items', 'readonly', (s) => s.getAll())
  return items.sort((a, b) => b.when.localeCompare(a.when))
}

export async function getItem(id: string): Promise<GalleryItem | undefined> {
  return tx<GalleryItem | undefined>('items', 'readonly', (s) => s.get(id))
}

/** Structured clone cannot serialise Svelte `$state` proxies (or functions); store plain data only. */
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

export async function putItem(item: GalleryItem): Promise<void> {
  await tx('items', 'readwrite', (s) => s.put(plain(item)))
}

export async function putBlob(id: string, name: string, blob: Blob): Promise<string> {
  await tx('blobs', 'readwrite', (s) => s.put(blob, blobKey(id, name)))
  return name
}

export async function getBlob(id: string, name: string): Promise<Blob | undefined> {
  return tx<Blob | undefined>('blobs', 'readonly', (s) => s.get(blobKey(id, name)))
}

export interface Embedding { key: string; item: string; blob: string; model: string; vector: number[] }

export async function putEmbedding(e: Embedding): Promise<void> { await tx('embeddings', 'readwrite', (s) => s.put({ ...e, vector: e.vector })) }
export async function allEmbeddings(): Promise<Embedding[]> { return tx<Embedding[]>('embeddings', 'readonly', (s) => s.getAll()) }
export async function deleteEmbeddingsFor(itemId: string): Promise<void> {
  const all = await allEmbeddings()
  await tx('embeddings', 'readwrite', (s) => { for (const e of all) if (e.item === itemId) s.delete(e.key) })
}

export async function deleteItem(item: GalleryItem): Promise<void> {
  await deleteEmbeddingsFor(item.id)
  await tx('blobs', 'readwrite', (s) => { for (const b of item.blobs) s.delete(blobKey(item.id, b)) })
  await tx('items', 'readwrite', (s) => s.delete(item.id))
}

export async function makeThumb(blob: Blob, size = 256): Promise<Blob> {
  const bmp = await createImageBitmap(blob)
  const scale = Math.min(1, size / Math.max(bmp.width, bmp.height))
  const c = new OffscreenCanvas(Math.round(bmp.width * scale), Math.round(bmp.height * scale))
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height)
  bmp.close()
  return c.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
}

export async function saveSnapshot(blob: Blob, meta: { position?: GalleryItem['position']; controls?: object; name?: string }): Promise<GalleryItem> {
  const id = newId()
  const bmp = await createImageBitmap(blob)
  const item: GalleryItem = {
    id, kind: 'snapshot', name: meta.name ?? `Snapshot ${new Date().toLocaleString()}`, when: new Date().toISOString(),
    position: meta.position, controls: meta.controls, width: bmp.width, height: bmp.height, blobs: ['image', 'thumb'],
  }
  bmp.close()
  await putBlob(id, 'image', blob)
  await putBlob(id, 'thumb', await makeThumb(blob))
  await putItem(item)
  return item
}

/** Export an item's files. Uses the File System Access API when available, else downloads. */
export async function exportItem(item: GalleryItem): Promise<void> {
  const files: { name: string; blob: Blob }[] = []
  const safe = item.name.replace(/[^\w.-]+/g, '_')
  for (const b of item.blobs) {
    const blob = await getBlob(item.id, b)
    if (!blob) continue
    const ext = blob.type === 'image/png' ? 'png' : 'jpg'
    files.push({ name: `${safe}-${b.replace('/', '-')}.${ext}`, blob })
  }
  files.push({ name: `${safe}.json`, blob: new Blob([JSON.stringify(item, null, 2)], { type: 'application/json' }) })
  const picker = (window as any).showDirectoryPicker as (() => Promise<any>) | undefined
  if (picker) {
    const dir = await picker()
    for (const f of files) {
      const fh = await dir.getFileHandle(f.name, { create: true })
      const w = await fh.createWritable(); await w.write(f.blob); await w.close()
    }
    return
  }
  for (const f of files) {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(f.blob); a.download = f.name; a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
  }
}
