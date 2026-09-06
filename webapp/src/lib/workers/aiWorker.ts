/** Web Worker running Transformers.js models: object detection and CLIP image/text embeddings.
 *  Models are downloaded from the Hugging Face hub on first use and cached by the browser. */

import { pipeline, env, AutoProcessor, AutoTokenizer, CLIPVisionModelWithProjection, CLIPTextModelWithProjection, RawImage } from '@huggingface/transformers'

env.allowLocalModels = false

type Req =
  | { id: number; type: 'detect'; bitmap: ImageBitmap; model: string; threshold: number }
  | { id: number; type: 'embedImage'; bitmap: ImageBitmap; model: string }
  | { id: number; type: 'embedText'; text: string; model: string }

const post = (m: unknown) => (self as unknown as Worker).postMessage(m)
const progress = (id: number) => (p: any) => {
  if (p.status === 'progress' && p.file) post({ id, progress: `${p.file.split('/').pop()} ${Math.round(p.progress ?? 0)} %` })
  else if (p.status === 'initiate' && p.file) post({ id, progress: `downloading ${p.file.split('/').pop()}` })
}

let device: 'webgpu' | 'wasm' = (self as any).navigator?.gpu ? 'webgpu' : 'wasm'
const detectors = new Map<string, Promise<any>>()
const clips = new Map<string, Promise<{ processor: any; vision: any; tokenizer: any; text: any }>>()

async function withFallback<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn() } catch (e) {
    if (device === 'webgpu') { device = 'wasm'; detectors.clear(); clips.clear(); return fn() }
    throw e
  }
}

function getDetector(model: string, id: number) {
  if (!detectors.has(model)) detectors.set(model, pipeline('object-detection', model, { device, progress_callback: progress(id) } as any))
  return detectors.get(model)!
}

function getClip(model: string, id: number) {
  if (!clips.has(model)) clips.set(model, (async () => {
    const pc = progress(id)
    const [processor, vision, tokenizer, text] = await Promise.all([
      AutoProcessor.from_pretrained(model, { progress_callback: pc } as any),
      CLIPVisionModelWithProjection.from_pretrained(model, { device, progress_callback: pc } as any),
      AutoTokenizer.from_pretrained(model, { progress_callback: pc } as any),
      CLIPTextModelWithProjection.from_pretrained(model, { device, progress_callback: pc } as any),
    ])
    return { processor, vision, tokenizer, text }
  })())
  return clips.get(model)!
}

function toRawImage(bitmap: ImageBitmap): RawImage {
  const c = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = c.getContext('2d')!
  ctx.drawImage(bitmap, 0, 0)
  const d = ctx.getImageData(0, 0, c.width, c.height)
  bitmap.close()
  return new RawImage(d.data, c.width, c.height, 4)
}

function normalise(v: Float32Array): number[] {
  let n = 0; for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  return Array.from(v, (x) => x / n)
}

self.onmessage = async (ev: MessageEvent<Req>) => {
  const req = ev.data
  try {
    if (req.type === 'detect') {
      const img = toRawImage(req.bitmap)
      const out = await withFallback(async () => (await getDetector(req.model, req.id))(img, { threshold: req.threshold, percentage: true }))
      post({ id: req.id, result: out.map((d: any) => ({ label: d.label, score: d.score, box: d.box })) })
    } else if (req.type === 'embedImage') {
      const img = toRawImage(req.bitmap)
      const vec = await withFallback(async () => {
        const { processor, vision } = await getClip(req.model, req.id)
        const inputs = await processor(img)
        const { image_embeds } = await vision(inputs)
        return image_embeds.data as Float32Array
      })
      post({ id: req.id, result: normalise(vec) })
    } else if (req.type === 'embedText') {
      const vec = await withFallback(async () => {
        const { tokenizer, text } = await getClip(req.model, req.id)
        const inputs = tokenizer([req.text], { padding: true, truncation: true })
        const { text_embeds } = await text(inputs)
        return text_embeds.data as Float32Array
      })
      post({ id: req.id, result: normalise(vec) })
    }
  } catch (e) {
    post({ id: req.id, error: (e as Error).message ?? String(e) })
  }
}
