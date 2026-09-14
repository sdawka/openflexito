/** Pixel-shift super-resolution off the main thread. Full-resolution stills arrive one at a time
 *  (already decoded and, if oversized, centre-cropped by the caller); each is registered to the
 *  first by `register()`'s coarse-to-fine phase correlation (the measured shift, not the commanded
 *  stage offset — backlash and any residual stage error would otherwise bias the reconstruction),
 *  run at full resolution (register() does its own internal downscale for the coarse stage and
 *  refines on a full-resolution crop; the worker no longer pre-downscales the whole frame the way
 *  the original 8x/4x `grayDown` + `displacement` path did — that discarded exactly the sub-pixel
 *  information super-resolution depends on, see superres-hdr-report.md D4). A frame whose
 *  registration is not `confident` is drizzled with weight 0 (excluded, but still reported) rather
 *  than silently corrupting the reconstruction.
 *
 *  Two independent modes share this one worker (one `Worker` instance per capture either way, so
 *  there's no benefit splitting the file, and `register()`'s registration logic is identical):
 *   - the default JPEG/RGBA path (`init`/`add`/`finish`) — unchanged from before, produces an RGBA
 *     image the caller PNG-encodes itself.
 *   - `initRaw`/`addRaw`/`finish` — `superresraw` mode: each frame is a whole OFRW record instead of
 *     a decoded still. Registration runs on a caller-supplied proxy (a half-resolution green-plane
 *     extraction is enough, see `services/photo/superres.ts`), not on the mosaic itself, since
 *     `register()`/`displacement()` assume a normal image, not CFA-patterned data; the proxy's shift
 *     is in half-mosaic-pixel units (it is itself at half the mosaic's resolution, one sample per CFA
 *     tile), so it is doubled here to the full-mosaic-pixel units `drizzleBayer`/`drizzleRawSuperres`
 *     expect. `finish` drizzles the raw planes (`drizzleRawSuperres`, no demosaic step) and runs the
 *     rest of the develop pipeline (WB/shading already applied per source frame inside that function;
 *     highlights + colour matrix on the combined planes) to a 16-bit PNG + 8-bit preview, entirely in
 *     the worker so the ~390 MB of intermediate float planes (a 2x grid of a 3280x2464 sensor) never
 *     has to cross back to the main thread. If drizzling throws (most likely an allocation failure on
 *     a memory-constrained device), the stored mosaics are centre-cropped further (kept even, so the
 *     CFA phase is not disturbed) and the drizzle is retried a couple of times before giving up. */
import { defineWorker, post } from './workerUtil'
import { register } from '../algo/register'
import { luminance } from '../algo/align'
import { drizzle, drizzleRawSuperres, type BayerOrder, type RawSuperresFrame } from '../algo/drizzle'
import { encodeRgb16, toRgba8, type DevelopOptions } from '../algo/rawdev'
import { encodePng16 } from '../algo/png16'
import type { RawImage } from '../algo/raw'
import type { Gray } from '../algo/sharpness'

export type SuperresMessage =
  | { type: 'init'; width: number; height: number; scale: number; pixfrac?: number }
  | { type: 'add'; index: number; data: Uint8ClampedArray }
  | { type: 'initRaw'; scale: number; pixfrac?: number; bayer: BayerOrder; opts: DevelopOptions }
  | { type: 'addRaw'; index: number; raw: RawImage; proxy: { data: Float32Array; width: number; height: number } }
  | { type: 'finish' }

export interface MeasuredShift { dx: number; dy: number; quality: number; confident: boolean }

/** `finish` result for `superresraw` (raw mode) — a develop-ready 16-bit PNG + 8-bit preview, unlike
 *  the RGBA-mode result (which the caller still has to PNG-encode itself). */
export interface SuperresRawResult {
  raw: true
  png: Blob; preview: { data: Uint8ClampedArray; width: number; height: number }
  width: number; height: number; coverage: { r: number; g: number; b: number }
  shifts: MeasuredShift[]; used: number; total: number
}

// RGBA (JPEG) mode state
let W = 0, H = 0, scale = 2, pixfrac = 0.5
let ref: Gray | null = null
const frames: { data: Uint8ClampedArray; dx: number; dy: number; weight: number }[] = []
const shifts: MeasuredShift[] = []

// Raw (mosaic) mode state
let rawMode = false
let rawScale = 2, rawPixfrac = 0.5
let rawBayer: BayerOrder = 'RGGB'
let rawOpts: DevelopOptions = {}
let proxyRef: Gray | null = null
const rawFrames: { raw: RawImage; dx: number; dy: number; weight: number }[] = []
const rawShifts: MeasuredShift[] = []

/** Centre-crop a mosaic to at most `maxLong` on the long side, keeping width/height even (so the CFA
 *  phase pattern is not disturbed) — used only as a last-resort fallback when drizzling the frames as
 *  captured runs out of memory (see the module comment). */
function cropMosaicEven(raw: RawImage, maxLong: number): RawImage {
  const long = Math.max(raw.width, raw.height)
  if (long <= maxLong) return raw
  const target = maxLong - (maxLong % 2)
  const w = Math.min(raw.width, target) & ~1, h = Math.min(raw.height, target) & ~1
  let x0 = Math.floor((raw.width - w) / 2), y0 = Math.floor((raw.height - h) / 2)
  x0 -= x0 % 2; y0 -= y0 % 2
  const data = new Uint16Array(w * h)
  for (let y = 0; y < h; y++) data.set(raw.data.subarray((y0 + y) * raw.width + x0, (y0 + y) * raw.width + x0 + w), y * w)
  return { ...raw, width: w, height: h, data }
}

defineWorker<SuperresMessage>(async (m) => {
  if (m.type === 'init') {
    W = m.width; H = m.height; scale = m.scale; pixfrac = m.pixfrac ?? 0.5
    ref = null; frames.length = 0; shifts.length = 0
    rawMode = false
    return
  }
  if (m.type === 'add') {
    const g = luminance(m.data, W, H)
    let dx = 0, dy = 0, quality = Infinity, confident = true
    if (!ref) ref = g
    else {
      const r = register(ref, g)
      dx = r.dx; dy = r.dy; quality = r.quality; confident = r.confident
    }
    shifts.push({ dx, dy, quality, confident })
    frames.push({ data: m.data, dx, dy, weight: confident ? 1 : 0 })
    post({
      progress: confident
        ? `frame ${m.index + 1} registered${m.index ? ` (measured shift ${dx.toFixed(2)}, ${dy.toFixed(2)} px, quality ${Number.isFinite(quality) ? quality.toFixed(1) : '∞'})` : ' (reference)'}`
        : `frame ${m.index + 1} rejected (registration not confident, quality ${Number.isFinite(quality) ? quality.toFixed(1) : '∞'}) — excluded from the fusion`,
    })
    return
  }
  if (m.type === 'initRaw') {
    rawMode = true
    rawScale = m.scale; rawPixfrac = m.pixfrac ?? 0.5; rawBayer = m.bayer; rawOpts = m.opts
    proxyRef = null; rawFrames.length = 0; rawShifts.length = 0
    return
  }
  if (m.type === 'addRaw') {
    let dx = 0, dy = 0, quality = Infinity, confident = true
    if (!proxyRef) proxyRef = m.proxy
    else {
      // the proxy is at half the mosaic's resolution (one sample per CFA tile); double its measured
      // shift to full mosaic-pixel units before it reaches drizzleRawSuperres/drizzleBayer.
      const r = register(proxyRef, m.proxy)
      dx = r.dx * 2; dy = r.dy * 2; quality = r.quality; confident = r.confident
    }
    rawShifts.push({ dx, dy, quality, confident })
    rawFrames.push({ raw: m.raw, dx, dy, weight: confident ? 1 : 0 })
    post({
      progress: confident
        ? `raw frame ${m.index + 1} registered${m.index ? ` (measured shift ${dx.toFixed(2)}, ${dy.toFixed(2)} px, quality ${Number.isFinite(quality) ? quality.toFixed(1) : '∞'})` : ' (reference)'}`
        : `raw frame ${m.index + 1} rejected (registration not confident, quality ${Number.isFinite(quality) ? quality.toFixed(1) : '∞'}) — excluded from the fusion`,
    })
    return
  }
  if (m.type === 'finish') {
    if (rawMode) {
      if (!rawFrames.length) throw new Error('superres: no raw frames captured')
      const used = rawFrames.filter((f) => f.weight > 0).length
      post({ progress: `drizzling ${used}/${rawFrames.length} raw frames onto a ${rawScale}× grid (no demosaic)…` })
      let attempt = rawFrames.map((f) => ({ raw: f.raw, dx: f.dx, dy: f.dy, weight: f.weight }) satisfies RawSuperresFrame)
      let result: ReturnType<typeof drizzleRawSuperres> | null = null
      for (let tries = 0; ; tries++) {
        try {
          result = drizzleRawSuperres(attempt, rawScale, rawPixfrac, rawOpts)
          break
        } catch (e) {
          const cur = attempt[0].raw
          const long = Math.max(cur.width, cur.height)
          const target = Math.floor(long / 2 / 2) * 2   // halve, keep even
          if (tries >= 2 || target < 512) throw e
          post({ progress: `retrying at a smaller crop after ${(e as Error).message}…` })
          attempt = attempt.map((f) => ({ ...f, raw: cropMosaicEven(f.raw, target) }))
        }
      }
      const rgb16 = encodeRgb16(result.rgb, { gammaCurve: rawOpts.gammaCurve })
      const preview = toRgba8(rgb16, 4)
      const png = await encodePng16(rgb16.data, rgb16.width, rgb16.height)
      post({ result: { raw: true, png, preview, width: rgb16.width, height: rgb16.height, coverage: result.coverage, shifts: [...rawShifts], used, total: rawFrames.length } }, [preview.data.buffer])
      proxyRef = null; rawFrames.length = 0; rawShifts.length = 0
      return
    }
    if (!frames.length) throw new Error('superres: no frames captured')
    const used = frames.filter((f) => f.weight > 0).length
    post({ progress: `drizzling ${used}/${frames.length} frames onto a ${scale}× grid…` })
    const r = drizzle(frames.map((f) => ({ ...f, width: W, height: H })), scale, pixfrac)
    post({ result: { data: r.data, width: r.width, height: r.height, coverage: r.coverage, shifts: [...shifts], used, total: frames.length } }, [r.data.buffer])
    ref = null; frames.length = 0
  }
})
