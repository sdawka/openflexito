/** Similarity search over the gallery with CLIP embeddings (computed in the AI worker). */

import { ai, cosine, cropBitmap } from './aiService.svelte'
import { allEmbeddings, getBlob, listItems, putEmbedding, type GalleryItem } from '../store/gallery'
import { settings } from '../store/settings.svelte'

export interface SearchHit { item: GalleryItem; blob: string; score: number }

/** Embed every image and scan tile that has no embedding for the current model yet. */
export async function indexGallery(onProgress?: (m: string) => void): Promise<number> {
  const items = await listItems()
  const have = new Set((await allEmbeddings()).filter((e) => e.model === settings.clipModel).map((e) => e.key))
  let n = 0, total = 0
  const todo: { item: GalleryItem; blob: string }[] = []
  for (const it of items) for (const b of it.blobs) if (b === 'image' || b.startsWith('tile/')) { total++; if (!have.has(`${it.id}/${b}`)) todo.push({ item: it, blob: b }) }
  for (const { item, blob } of todo) {
    const data = await getBlob(item.id, blob)
    if (!data) continue
    onProgress?.(`embedding ${item.name} ${blob} (${n + 1}/${todo.length})`)
    const vector = await ai.embedImage(await cropBitmap(data, undefined, 384))
    await putEmbedding({ key: `${item.id}/${blob}`, item: item.id, blob, model: settings.clipModel, vector })
    n++
  }
  onProgress?.(`indexed ${n} new of ${total}`)
  return n
}

async function rank(query: number[], limit: number): Promise<SearchHit[]> {
  const items = new Map((await listItems()).map((i) => [i.id, i]))
  const hits: SearchHit[] = []
  for (const e of await allEmbeddings()) {
    if (e.model !== settings.clipModel) continue
    const item = items.get(e.item)
    if (item) hits.push({ item, blob: e.blob, score: cosine(query, e.vector) })
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit)
}

export async function searchByText(text: string, limit = 12): Promise<SearchHit[]> {
  return rank(await ai.embedText(text), limit)
}

export async function searchByImage(src: Blob | ImageBitmap, region?: { x: number; y: number; w: number; h: number }, limit = 12): Promise<SearchHit[]> {
  return rank(await ai.embedImage(await cropBitmap(src, region, 384)), limit)
}
