/** Per-frame processing chain shared by the live view, the recorder and time-lapse playback.
 *
 *  Anything that wants to transform a decoded frame before it is shown or encoded (a colour LUT,
 *  live denoising, deflicker, ...) registers a `FrameProcessor` here instead of editing StreamView or
 *  the recorder. Consumers call `frameChain.run(target, frame)` once per frame; processors are applied
 *  in ascending `order` and each one sees the previous one's output. A processor that is not
 *  `enabled(target)` is skipped, so `frameChain.active(target)` tells a consumer whether it can leave
 *  the plain `<img>` path alone (nothing registered and enabled means zero overhead).
 *
 *  Frames are exchanged as `ImageData`-like RGBA buffers (`Uint8ClampedArray`, width, height) so a
 *  processor can be pure CPU, a worker round-trip or a WebGL pass that reads back; a processor that
 *  renders on the GPU may instead return a `CanvasImageSource` and the next processor must accept
 *  either (use `toImageData` to normalise). Processors must be synchronous per frame: a slow one
 *  should keep its own latest-result cache and return the previous frame's output rather than block. */

export type FrameTarget = 'view' | 'record' | 'playback'

export interface RgbaFrame { data: Uint8ClampedArray; width: number; height: number }
export type FrameInput = RgbaFrame | CanvasImageSource

export interface FrameProcessor {
  id: string
  /** Lower runs first. Suggested: 100 denoise/deflicker, 200 stabilise, 300 enhance, 900 LUT (last: colour). */
  order: number
  enabled(target: FrameTarget): boolean
  /** `t` is the frame's device timestamp (ns, CLOCK_BOOTTIME) when known, else `performance.now()*1e6`. */
  process(frame: FrameInput, target: FrameTarget, t: number): FrameInput
  /** Called when the consumer's frame source restarts (stream reconnect, new recording) so temporal state resets. */
  reset?(): void
}

const processors: FrameProcessor[] = []
let scratch: OffscreenCanvas | HTMLCanvasElement | null = null

function scratchCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (!scratch) scratch = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas')
  if (scratch.width !== w || scratch.height !== h) { scratch.width = w; scratch.height = h }
  return scratch
}

export function isRgbaFrame(f: FrameInput): f is RgbaFrame {
  return (f as RgbaFrame).data instanceof Uint8ClampedArray
}

function sourceSize(src: CanvasImageSource): { w: number; h: number } {
  const s = src as any
  if (typeof VideoFrame !== 'undefined' && src instanceof VideoFrame) return { w: src.displayWidth, h: src.displayHeight }
  if (s.naturalWidth) return { w: s.naturalWidth, h: s.naturalHeight }
  if (s.videoWidth) return { w: s.videoWidth, h: s.videoHeight }
  return { w: s.width, h: s.height }
}

/** Normalise any frame input to an RGBA buffer (drawing GPU/bitmap sources through a scratch canvas). */
export function toImageData(f: FrameInput): RgbaFrame {
  if (isRgbaFrame(f)) return f
  const { w, h } = sourceSize(f)
  const c = scratchCanvas(w, h)
  const ctx = c.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
  ctx.drawImage(f, 0, 0)
  const id = ctx.getImageData(0, 0, w, h)
  return { data: id.data, width: id.width, height: id.height }
}

export const frameChain = {
  register(p: FrameProcessor): () => void {
    this.unregister(p.id)
    processors.push(p)
    processors.sort((a, b) => a.order - b.order)
    return () => this.unregister(p.id)
  },
  unregister(id: string): void {
    const i = processors.findIndex((p) => p.id === id)
    if (i >= 0) processors.splice(i, 1)
  },
  /** True when at least one processor would touch frames for this target. */
  active(target: FrameTarget): boolean {
    return processors.some((p) => p.enabled(target))
  },
  list(): readonly FrameProcessor[] { return processors },
  run(target: FrameTarget, frame: FrameInput, t = performance.now() * 1e6): FrameInput {
    let f = frame
    for (const p of processors) if (p.enabled(target)) f = p.process(f, target, t)
    return f
  },
  reset(): void { for (const p of processors) p.reset?.() },
}
