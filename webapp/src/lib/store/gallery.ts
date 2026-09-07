/** Gallery storage in the browser: IndexedDB for metadata and image blobs. */

import { currentSample, type SampleRecord } from './sample.svelte'

export type ItemKind = 'snapshot' | 'scan' | 'video' | 'timelapse'

export interface TimelapseFrameMeta { t: string; z: number; shift: { dx: number; dy: number } }

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
  /** focus stack: how it was taken and how much of the result each slice supplied */
  stack?: {
    slices: number; stepZ: number; zs: number[]; contributions: number[]; method?: 'blocks' | 'pyramid'; centreZ?: number; span?: number; shifts?: { dx: number; dy: number }[]; source?: 'jpeg' | 'raw'
    /** depth-from-focus map derived alongside a pyramid fusion: blobs 'depth' (colour-mapped PNG),
     *  'relief' (pseudo-3D shaded preview) and 'depth.bin' (raw per-pixel winning-slice index, 8-bit) */
    depth?: { minZ: number; maxZ: number; colorMap: 'ramp' }
  }
  /** pixel-shift super-resolution: N sub-pixel-shifted stills fused by drizzle onto a finer grid */
  superres?: { frames: number; scale: number; shifts: { dx: number; dy: number; quality: number }[]; crop: { width: number; height: number; x0: number; y0: number } | null }
  /** video: blob 'video' (WebM) recorded in the browser from the live view or the live focus stack */
  video?: { durationS: number; fps: number; source: string; mime: string }
  /** time-lapse: blobs 'f0000', 'f0001', ... one JPEG per frame, plus 'thumb' from the first frame.
   *  `frames[i].shift` is that frame's measured drift (px) from the first frame (see `algo/drift.ts`);
   *  subtracting it plays the sequence back drift-free. */
  timelapse?: { intervalMs: number; source: 'stream' | 'full'; driftCorrected: boolean; frames: TimelapseFrameMeta[] }
  /** raw develop: the sensor data behind 'image' ('dng' blob = the untouched mosaic as a DNG) */
  raw?: { bitDepth: number; bayer: string; blackLevel: number; gains: [number, number]; applied?: { lsc: boolean; ccm: boolean; gammaCurve: boolean; demosaic: string } }
  scan?: {
    cols: number; rows: number; overlap: number
    tiles: { index: number; col: number; row: number; stage: { x: number; y: number }; x: number; y: number; width: number; height: number; blob: string
      /** focused z for this tile (device steps): measured directly (focus 'every tile'), or predicted
       *  from the height map (focus 'interpolate') — see `algo/heightMap.ts` and `routes/Scan.svelte`. */
      z?: number; zMeasured?: boolean }[]
    positions?: { x: number; y: number }[]
    /** how autofocus was used during this scan, and its region/order settings, for the gallery's height-map overlay */
    focus?: { mode: 'none' | 'every' | 'interpolate'; step?: number; method?: 'plane' | 'bilinear' }
    region?: { mode: 'rect' | 'polygon'; order: 'raster' | 'snake' | 'spiral' }
  }
  /** what was on the stage, copied from `store/sample.svelte.ts` at capture time (if it was filled in). */
  sample?: SampleRecord
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

export async function saveSnapshot(blob: Blob, meta: { position?: GalleryItem['position']; controls?: object; name?: string;
  /** extra item fields (stack, raw) and extra blobs (slices, raw data) stored alongside the image */
  extra?: Partial<Pick<GalleryItem, 'stack' | 'raw' | 'superres'>>; extraBlobs?: Record<string, Blob>; thumbFrom?: Blob; size?: { width: number; height: number } }): Promise<GalleryItem> {
  const id = newId()
  const bmp = meta.size ?? await createImageBitmap(meta.thumbFrom ?? blob)
  const extraNames = Object.keys(meta.extraBlobs ?? {})
  const item: GalleryItem = {
    id, kind: 'snapshot', name: meta.name ?? `Snapshot ${new Date().toLocaleString()}`, when: new Date().toISOString(),
    position: meta.position, controls: meta.controls, width: bmp.width, height: bmp.height, blobs: ['image', 'thumb', ...extraNames],
    sample: currentSample(),
    ...(meta.extra ?? {}),
  }
  if ('close' in bmp) bmp.close()
  await putBlob(id, 'image', blob)
  await putBlob(id, 'thumb', await makeThumb(meta.thumbFrom ?? blob))
  for (const [name, b] of Object.entries(meta.extraBlobs ?? {})) await putBlob(id, name, b)
  await putItem(item)
  return item
}

export async function saveVideo(blob: Blob, thumb: Blob | null, meta: { durationS: number; fps: number; source: string; width: number; height: number; position?: GalleryItem['position'] }): Promise<GalleryItem> {
  const id = newId()
  const item: GalleryItem = {
    id, kind: 'video', name: `Video ${meta.source} ${meta.durationS.toFixed(0)} s`, when: new Date().toISOString(),
    position: meta.position, width: meta.width, height: meta.height, blobs: thumb ? ['video', 'thumb'] : ['video'],
    video: { durationS: meta.durationS, fps: meta.fps, source: meta.source, mime: blob.type },
    sample: currentSample(),
  }
  await putBlob(id, 'video', blob)
  if (thumb) await putBlob(id, 'thumb', thumb)
  await putItem(item)
  return item
}

export async function saveTimelapse(frames: Blob[], frameMeta: TimelapseFrameMeta[], info: { intervalMs: number; source: 'stream' | 'full'; driftCorrected: boolean }): Promise<GalleryItem> {
  if (!frames.length) throw new Error('no frames to save')
  const id = newId()
  const bmp = await createImageBitmap(frames[0])
  const width = bmp.width, height = bmp.height
  bmp.close()
  const blobNames = frames.map((_, i) => `f${String(i).padStart(4, '0')}`)
  const item: GalleryItem = {
    id, kind: 'timelapse', name: `Time-lapse ${frames.length} frames`, when: new Date().toISOString(),
    width, height, blobs: [...blobNames, 'thumb'],
    timelapse: { intervalMs: info.intervalMs, source: info.source, driftCorrected: info.driftCorrected, frames: frameMeta },
  }
  for (let i = 0; i < frames.length; i++) await putBlob(id, blobNames[i], frames[i])
  await putBlob(id, 'thumb', await makeThumb(frames[0]))
  await putItem(item)
  return item
}

/** The files an item exports to: its blobs plus a `<name>.json` sidecar with the full item metadata
 *  (sample record, position, controls, stack/raw/video fields). Shared by `exportItem` and
 *  `exportSampleBundle`. */
async function itemFiles(item: GalleryItem): Promise<{ name: string; blob: Blob }[]> {
  const files: { name: string; blob: Blob }[] = []
  const safe = item.name.replace(/[^\w.-]+/g, '_')
  for (const b of item.blobs) {
    const blob = await getBlob(item.id, b)
    if (!blob) continue
    const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/x-adobe-dng' ? 'dng' : blob.type.startsWith('video/webm') ? 'webm' : blob.type.startsWith('video/') ? 'mp4' : blob.type === 'application/octet-stream' ? 'bin' : 'jpg'
    files.push({ name: `${safe}-${b.replace('/', '-')}.${ext}`, blob })
  }
  files.push({ name: `${safe}.json`, blob: new Blob([JSON.stringify(item, null, 2)], { type: 'application/json' }) })
  return files
}

function downloadFile(f: { name: string; blob: Blob }): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(f.blob); a.download = f.name; a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000)
}

/** Export an item's files. Uses the File System Access API when available, else downloads. */
export async function exportItem(item: GalleryItem): Promise<void> {
  const files = await itemFiles(item)
  const picker = (window as any).showDirectoryPicker as (() => Promise<any>) | undefined
  if (picker) {
    const dir = await picker()
    for (const f of files) {
      const fh = await dir.getFileHandle(f.name, { create: true })
      const w = await fh.createWritable(); await w.write(f.blob); await w.close()
    }
    return
  }
  for (const f of files) downloadFile(f)
}

const csvCell = (v: unknown): string => `"${String(v ?? '').replace(/"/g, '""')}"`

/** Export every one of `items` (typically everything from one sample) as a subfolder per item plus
 *  an `<sampleName>-index.csv` summary row per item (name, time, kind, size, z, sample fields). Falls
 *  back to flat downloads (no real folders) without the File System Access API. */
export async function exportSampleBundle(items: GalleryItem[], sampleName: string): Promise<void> {
  const safeSample = sampleName.replace(/[^\w.-]+/g, '_') || 'sample'
  const rows = ['name,when,kind,size,z,sample_name,specimen,stain,slideId,magnification,operator']
  const sizes = new Map<string, number>()
  for (const it of items) {
    let size = 0
    for (const b of it.blobs) { const blob = await getBlob(it.id, b); if (blob) size += blob.size }
    sizes.set(it.id, size)
    rows.push([
      it.name, it.when, it.kind, size, it.position?.z ?? '',
      it.sample?.name, it.sample?.specimen, it.sample?.stain, it.sample?.slideId, it.sample?.magnification, it.sample?.operator,
    ].map(csvCell).join(','))
  }
  const csv = new Blob([rows.join('\n')], { type: 'text/csv' })
  const picker = (window as any).showDirectoryPicker as (() => Promise<any>) | undefined
  if (picker) {
    const root = await picker()
    const fh = await root.getFileHandle(`${safeSample}-index.csv`, { create: true })
    const w = await fh.createWritable(); await w.write(csv); await w.close()
    for (const it of items) {
      const sub = await root.getDirectoryHandle(`${it.name.replace(/[^\w.-]+/g, '_') || it.id}-${it.id}`, { create: true })
      for (const f of await itemFiles(it)) {
        const fh2 = await sub.getFileHandle(f.name, { create: true })
        const w2 = await fh2.createWritable(); await w2.write(f.blob); await w2.close()
      }
    }
    return
  }
  downloadFile({ name: `${safeSample}-index.csv`, blob: csv })
  for (const it of items) for (const f of await itemFiles(it)) downloadFile({ name: `${safeSample}-${f.name}`, blob: f.blob })
}
