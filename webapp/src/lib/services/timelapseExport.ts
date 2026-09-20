/** Encode a saved time-lapse's stored frames into an MP4 (WebCodecs + mediabunny, in
 *  `workers/encodeWorker.ts`) at an exact fps. Complements `services/timelapse.svelte.ts`'s existing
 *  `exportTimelapseWebm` (MediaRecorder, kept as is — not WP5's file to change): this is the
 *  WebCodecs/mediabunny path, offered as "Export MP4" in `TimelapseViewer.svelte`.
 *
 *  Per-frame backpressure: the worker acks each frame once mediabunny's encoder has accepted it, and
 *  the loop below awaits that ack before decoding the next one, so at most one frame's `ImageBitmap`
 *  is ever in flight regardless of how many frames the time-lapse has. */
import { getBlob, type GalleryItem } from '../store/gallery'
import { playbackShift } from '../algo/drift'
import { applyLookRgba, type Look } from '../algo/lut'
import type { VideoCodecPref, VideoQuality } from './videoEncoder'

let lookCanvas: OffscreenCanvas | null = null

/** Bake `look` into a decoded frame with a CPU readback (WP1's `algo/lut.ts#applyLookRgba`), returning
 *  a fresh `ImageBitmap` the caller owns (the input bitmap is closed here). */
async function bakeLook(bitmap: ImageBitmap, look: Look): Promise<ImageBitmap> {
  if (!lookCanvas || lookCanvas.width !== bitmap.width || lookCanvas.height !== bitmap.height) lookCanvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = lookCanvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  const img = ctx.getImageData(0, 0, lookCanvas.width, lookCanvas.height)
  const out = new Uint8ClampedArray(img.data.length)
  applyLookRgba(img.data, out, look)
  ctx.putImageData(new ImageData(out, img.width, img.height), 0, 0)
  return createImageBitmap(lookCanvas)
}

export interface TimelapseExportOptions {
  fps: number
  codec?: VideoCodecPref
  quality?: VideoQuality
  keyframeS?: number
  /** subtract the measured drift per frame, same convention as the live time-lapse player (default true) */
  stabilised?: boolean
  /** baked with `algo/lut.ts#applyLookRgba` (CPU readback) before the frame is handed to the worker */
  look?: Look
  onProgress?: (frac: number) => void
}

export interface TimelapseExportResult { blob: Blob; mime: string; frames: number }

export function timelapseExportSupported(): boolean {
  return typeof VideoEncoder !== 'undefined' && typeof OffscreenCanvas !== 'undefined'
}

export async function exportTimelapse(item: GalleryItem, opts: TimelapseExportOptions): Promise<TimelapseExportResult> {
  const meta = item.timelapse
  if (!meta || !meta.frames.length) throw new Error('not a time-lapse item')
  if (!timelapseExportSupported()) throw new Error('this browser has no WebCodecs VideoEncoder; MP4 export is unavailable (try Export WebM instead)')
  const w = item.width ?? 640, h = item.height ?? 480
  const fps = Math.max(1, opts.fps)
  const stabilised = opts.stabilised ?? true

  const worker = new Worker(new URL('../workers/encodeWorker.ts', import.meta.url), { type: 'module' })
  const pending = new Map<number, () => void>()
  let doneResolve!: (r: TimelapseExportResult) => void
  let doneReject!: (e: Error) => void
  const done = new Promise<TimelapseExportResult>((res, rej) => { doneResolve = res; doneReject = rej })
  worker.onmessage = (ev: MessageEvent) => {
    const m = ev.data
    if (m?.error) { doneReject(new Error(m.error)); return }
    if (m?.type === 'ack') pending.get(m.index)?.()
    else if (m?.type === 'done') doneResolve({ blob: new Blob([m.buffer], { type: m.mime }), mime: m.mime, frames: m.frames })
  }
  worker.onerror = (e) => doneReject(new Error(e.message))

  try {
    worker.postMessage({ type: 'start', width: w, height: h, fps, container: 'mp4', codec: opts.codec ?? 'auto', quality: typeof opts.quality === 'object' ? { bitrateMbps: opts.quality.bitrateMbps } : (opts.quality ?? 'high'), keyframeS: opts.keyframeS ?? 2 })
    for (let i = 0; i < meta.frames.length; i++) {
      const blob = await getBlob(item.id, `f${String(i).padStart(4, '0')}`)
      if (!blob) continue
      let bitmap = await createImageBitmap(blob)
      if (opts.look) bitmap = await bakeLook(bitmap, opts.look)
      // plain copy: `playbackShift` may hand back the item's own (Svelte `$state`-proxied) shift object,
      // which structured clone rejects
      const s = stabilised ? playbackShift(meta.frames[i], bitmap.width) : { dx: 0, dy: 0 }
      const shift = { dx: s.dx, dy: s.dy }
      await new Promise<void>((resolve) => {
        pending.set(i, () => { pending.delete(i); resolve() })
        worker.postMessage({ type: 'frame', bitmap, index: i, shift }, [bitmap])
      })
      opts.onProgress?.((i + 1) / meta.frames.length)
    }
    worker.postMessage({ type: 'finish' })
    return await done
  } finally {
    worker.terminate()
  }
}
