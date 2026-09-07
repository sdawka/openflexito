/** Macro storage in the browser: a small IndexedDB database of its own, kept separate from the
 *  gallery database (`store/gallery.ts`) so this feature never has to touch that DB's version. */

import type { Macro } from '../algo/macro'

const DB = 'openflexito-macros', VERSION = 1

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('macros')) db.createObjectStore('macros', { keyPath: 'id' }).createIndex('createdAt', 'createdAt')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const t = db.transaction('macros', mode)
    const req = fn(t.objectStore('macros'))
    t.oncomplete = () => resolve((req as IDBRequest<T> | undefined)?.result as T)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  }))
}

/** Structured clone cannot serialise Svelte `$state` proxies; store plain data only. */
const plain = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

export const newMacroId = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export async function listMacros(): Promise<Macro[]> {
  const all = await tx<Macro[]>('readonly', (s) => s.getAll())
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function getMacro(id: string): Promise<Macro | undefined> {
  return tx<Macro | undefined>('readonly', (s) => s.get(id))
}

export async function putMacro(m: Macro): Promise<void> {
  await tx('readwrite', (s) => s.put(plain(m)))
}

export async function deleteMacro(id: string): Promise<void> {
  await tx('readwrite', (s) => s.delete(id))
}
