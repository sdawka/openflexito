/** User-imported LUT storage: a small IndexedDB database of its own, kept separate from the gallery
 *  database (`store/gallery.ts`) and the macro database (`store/macroDb.ts`) so this feature never has
 *  to touch either DB's version, following the same pattern. Colour data (`Float32Array`) survives
 *  structured clone natively, unlike a Svelte `$state` proxy - nothing here needs `store/macroDb.ts`'s
 *  `plain()` stringify round-trip as long as callers hand in plain (non-reactive) objects. */

export type LutSource = 'cube' | '3dl' | 'imagej' | 'hald' | 'csv' | 'adjust'

/** A user-imported LUT. `kind: '1d'` stores `data` as three concatenated `size`-length blocks (r, then
 *  g, then b) rather than `Lut1D`'s separate typed arrays, so one `Float32Array` covers both kinds;
 *  `kind: '3d'` stores `data` exactly as `Lut3D.data` (red-fastest, `size^3 * 3` floats) - see
 *  `store/look.svelte.ts`'s `lutFromStored`/`storedFromLut` for the conversion. */
export interface StoredLut {
  id: string
  name: string
  kind: '1d' | '3d'
  size: number
  data: Float32Array
  source: LutSource
  when: string
}

const DB = 'openflexito-luts', VERSION = 1

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('luts')) db.createObjectStore('luts', { keyPath: 'id' }).createIndex('when', 'when')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction('luts', mode)
    const req = fn(t.objectStore('luts'))
    t.oncomplete = () => resolve((req as IDBRequest<T> | undefined)?.result as T)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  }))
}

export const newLutId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export async function listLuts(): Promise<StoredLut[]> {
  const all = await tx<StoredLut[]>('readonly', (s) => s.getAll())
  return all.sort((a, b) => b.when.localeCompare(a.when))
}

export async function getLut(id: string): Promise<StoredLut | undefined> {
  return tx<StoredLut | undefined>('readonly', (s) => s.get(id))
}

export async function putLut(l: StoredLut): Promise<void> {
  await tx('readwrite', (s) => s.put(l))
}

export async function deleteLut(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id))
}
