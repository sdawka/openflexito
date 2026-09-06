/** Main-thread wrapper around the AI worker, with a reactive status line. */

import { settings } from '../store/settings.svelte'

export interface Detection { label: string; score: number; box: { xmin: number; ymin: number; xmax: number; ymax: number } }   // fractions 0..1

class AiService {
  status = $state('')
  busy = $state(0)
  private worker: Worker | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()

  private get w(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('../workers/aiWorker.ts', import.meta.url), { type: 'module' })
      this.worker.onmessage = (ev) => {
        const { id, result, error, progress } = ev.data
        if (progress) { this.status = progress; return }
        const p = this.pending.get(id)
        if (!p) return
        this.pending.delete(id)
        error ? p.reject(new Error(error)) : p.resolve(result)
      }
      this.worker.onerror = (e) => { this.status = e.message }
    }
    return this.worker
  }

  private call<T>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    const id = this.nextId++
    this.busy++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.w.postMessage({ id, ...msg }, transfer)
    }).finally(() => { this.busy--; if (!this.busy) this.status = '' }) as Promise<T>
  }

  detect(bitmap: ImageBitmap, threshold = 0.5): Promise<Detection[]> {
    return this.call({ type: 'detect', bitmap, model: settings.detectModel, threshold }, [bitmap])
  }
  embedImage(bitmap: ImageBitmap): Promise<number[]> {
    return this.call({ type: 'embedImage', bitmap, model: settings.clipModel }, [bitmap])
  }
  embedText(text: string): Promise<number[]> {
    return this.call({ type: 'embedText', text, model: settings.clipModel })
  }
}

export const ai = new AiService()

export function cosine(a: number[], b: number[]): number {
  let s = 0
  for (let i = 0; i < a.length && i < b.length; i++) s += a[i] * b[i]
  return s
}

/** Crop a region (fractions of the source) out of a blob/bitmap into a new ImageBitmap. */
export async function cropBitmap(src: Blob | ImageBitmap, region?: { x: number; y: number; w: number; h: number }, maxSize = 512): Promise<ImageBitmap> {
  const bmp = src instanceof Blob ? await createImageBitmap(src) : src
  const r = region ?? { x: 0, y: 0, w: 1, h: 1 }
  const sx = Math.round(r.x * bmp.width), sy = Math.round(r.y * bmp.height)
  const sw = Math.max(1, Math.round(r.w * bmp.width)), sh = Math.max(1, Math.round(r.h * bmp.height))
  const scale = Math.min(1, maxSize / Math.max(sw, sh))
  const c = new OffscreenCanvas(Math.round(sw * scale), Math.round(sh * scale))
  c.getContext('2d')!.drawImage(bmp, sx, sy, sw, sh, 0, 0, c.width, c.height)
  if (src instanceof Blob) bmp.close()
  return c.transferToImageBitmap()
}
