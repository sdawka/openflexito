/** Motion visualisation for video modes (`services/video/motionModes.ts`): pure RGBA-in/RGBA-out
 *  helpers with their own state, allocation-free per frame after warm-up.
 *
 *  - `BackgroundModel`: a slowly adapting running background (exponential mean of the luma, the
 *    cheap end of the MOG family); `highlight()` paints what differs from it in colour over a
 *    dimmed grey copy of the frame ("digital dark-field for motion"), with a σ-scaled threshold
 *    so sensor noise stays grey.
 *  - `MotionHistory`: Bobick & Davis motion-history image — every pixel that moves is set to full
 *    intensity and everything decays by `decay` per frame, so a moving organism drags a fading
 *    trail. Rendered as the live frame plus a coloured trail.
 *  - `TemporalColorCode`: ImageJ's Temporal-Color Code for live use — each frame's motion (or, in
 *    `'all'` mode, its intensity) is added in the hue of its time in a cycling window, so the
 *    trajectory of anything moving is painted as a rainbow with time along it. */

import { colormapPreview } from './colormaps'

function lumaOf(data: Uint8ClampedArray, i: number): number {
  return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
}

/** Robust σ of a difference field from a 256-bin histogram of a coarse sample (median × 1.4826),
 *  allocation-free: O(n) instead of sorting a fresh array every frame. */
const HIST = new Uint32Array(256)
export function robustSigma(sample: (k: number) => number, count: number): number {
  HIST.fill(0)
  for (let k = 0; k < count; k++) { const v = sample(k); HIST[v > 255 ? 255 : v < 0 ? 0 : v | 0]++ }
  let acc = 0
  for (let v = 0; v < 256; v++) { acc += HIST[v]; if (acc * 2 >= count) return Math.max(1, (v + 0.5) * 1.4826) }
  return 1
}

/** Largest per-channel change: a coloured organism on a luminance-matched background is invisible
 *  to a luma difference; the max channel difference at ~1.2× the luma threshold catches it. */
function colourDiff(a: Uint8ClampedArray, i: number, r: number, g: number, b: number): number {
  const dr = Math.abs(a[i] - r), dg = Math.abs(a[i + 1] - g), db = Math.abs(a[i + 2] - b)
  return dr > dg ? (dr > db ? dr : db) : (dg > db ? dg : db)
}

export class BackgroundModel {
  /** background RGB (three planes) */
  private bg: Float32Array
  private diff: Float32Array
  count = 0
  /** robust noise estimate of the last difference field (median absolute difference × 1.4826) */
  sigma = 2

  /** `median` = true uses the McFarlane–Schofield running median (`bg += sign(x − bg)·step`), which
   *  never learns a pixel occupied less than half the time: a stationary-then-moving organism is not
   *  absorbed and a passing one leaves no ghost. `alpha` is the exponential-mean rate otherwise. */
  constructor(public readonly width: number, public readonly height: number, public alpha = 0.03, public median = true, public step = 0.5) {
    this.bg = new Float32Array(width * height * 3)
    this.diff = new Float32Array(width * height)
  }

  reset(): void { this.count = 0 }

  /** Update the background with `frame` and return the colour-aware |frame − background| field (the
   *  buffer is reused). `learnMoving` = false freezes the exponential model where motion is
   *  detected (the running median is inherently robust and always updates). */
  update(frame: Uint8ClampedArray, learnMoving = true): Float32Array {
    const bg = this.bg, diff = this.diff, n = diff.length
    if (this.count === 0) { for (let p = 0, i = 0; p < n; p++, i += 4) { bg[p * 3] = frame[i]; bg[p * 3 + 1] = frame[i + 1]; bg[p * 3 + 2] = frame[i + 2]; diff[p] = 0 } this.count = 1; return diff }
    const a = Math.max(this.alpha, 1 / (this.count + 1)), b = 1 - a, st = this.step
    for (let p = 0, i = 0, q = 0; p < n; p++, i += 4, q += 3) {
      const d = colourDiff(frame, i, bg[q], bg[q + 1], bg[q + 2])
      diff[p] = d
      if (this.median) {
        for (let c = 0; c < 3; c++) { const x = frame[i + c], v = bg[q + c]; bg[q + c] = x > v ? Math.min(x, v + st) : x < v ? Math.max(x, v - st) : v }
      } else if (learnMoving || d < 3 * this.sigma) {
        bg[q] = b * bg[q] + a * frame[i]; bg[q + 1] = b * bg[q + 1] + a * frame[i + 1]; bg[q + 2] = b * bg[q + 2] + a * frame[i + 2]
      }
    }
    const stepN = Math.max(1, Math.floor(n / 4096)), cnt = Math.floor(n / stepN)
    this.sigma = robustSigma((k) => diff[k * stepN], cnt) * 1.2
    this.count++
    return diff
  }

  /** Paint moving pixels (diff > k·σ) in `colour` over a dimmed grey copy of the frame. `amount` = 1
   *  fully replaces the pixel with the colour; the grey base keeps context. */
  highlight(frame: Uint8ClampedArray, diff: Float32Array, out: Uint8ClampedArray, k = 4, colour: [number, number, number] = [255, 140, 0], dim = 0.45): void {
    const th = k * this.sigma
    for (let p = 0, i = 0; p < diff.length; p++, i += 4) {
      const g = lumaOf(frame, i) * dim
      const d = diff[p]
      if (d > th) {
        const w = Math.min(1, (d - th) / (2 * th + 1e-6) + 0.35)
        out[i] = g + (colour[0] - g) * w; out[i + 1] = g + (colour[1] - g) * w; out[i + 2] = g + (colour[2] - g) * w
      } else { out[i] = g; out[i + 1] = g; out[i + 2] = g }
      out[i + 3] = 255
    }
  }
}

export class MotionHistory {
  private mhi: Float32Array
  private prev: Float32Array
  count = 0
  /** optional external difference field (e.g. `BackgroundModel.update()`'s), so slow movers that a
   *  two-frame difference misses still enter the history; null = frame difference */
  source: Float32Array | null = null

  /** `decay` per frame (0.92 ≈ a 12-frame trail at 18 fps); `k` × σ difference threshold. */
  constructor(public readonly width: number, public readonly height: number, public decay = 0.92, public k = 4) {
    this.mhi = new Float32Array(width * height)
    this.prev = new Float32Array(width * height)
  }

  reset(): void { this.count = 0; this.mhi.fill(0) }

  /** Frame-difference motion → decaying history; draw it as a coloured trail over the frame. */
  update(frame: Uint8ClampedArray, out: Uint8ClampedArray, colour: [number, number, number] = [0, 200, 255]): void {
    const mhi = this.mhi, prev = this.prev, n = mhi.length
    if (this.count === 0) { for (let p = 0; p < n; p++) prev[p] = lumaOf(frame, p * 4); out.set(frame); this.count = 1; return }
    // σ of the frame difference from a coarse histogram sample
    const step = Math.max(1, Math.floor(n / 4096)), cnt = Math.floor(n / step)
    const sigma = robustSigma((k) => Math.abs(lumaOf(frame, k * step * 4) - prev[k * step]), cnt), th = this.k * sigma
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const l = lumaOf(frame, i)
      const moved = (this.source ? this.source[p] : Math.abs(l - prev[p])) > th
      prev[p] = l
      const v = moved ? 1 : mhi[p] * this.decay
      mhi[p] = v < 0.02 ? 0 : v
      const w = mhi[p]
      out[i] = frame[i] + (colour[0] - frame[i]) * w; out[i + 1] = frame[i + 1] + (colour[1] - frame[i + 1]) * w; out[i + 2] = frame[i + 2] + (colour[2] - frame[i + 2]) * w; out[i + 3] = 255
    }
    this.count++
  }
}

export class TemporalColorCode {
  private accR: Float32Array; private accG: Float32Array; private accB: Float32Array
  private prev: Float32Array
  private lut: Uint8ClampedArray
  count = 0
  decay: number

  /** `period` frames per hue cycle; `decay` fades old colour so the code keeps working indefinitely
   *  (1 = ImageJ's cumulative projection; default 1 − 1/(3·period), so a whole cycle stays visible);
   *  `map` any `algo/colormaps.ts` name. */
  constructor(public readonly width: number, public readonly height: number, public period = 90, decay?: number, map = 'spectrum', public k = 4) {
    this.decay = decay ?? 1 - 1 / (3 * period)
    const n = width * height
    this.accR = new Float32Array(n); this.accG = new Float32Array(n); this.accB = new Float32Array(n)
    this.prev = new Float32Array(n)
    this.lut = colormapPreview(map, 256)
  }

  reset(): void { this.count = 0; this.accR.fill(0); this.accG.fill(0); this.accB.fill(0) }

  update(frame: Uint8ClampedArray, out: Uint8ClampedArray, dim = 0.35): void {
    const n = this.prev.length, prev = this.prev
    if (this.count === 0) { for (let p = 0; p < n; p++) prev[p] = lumaOf(frame, p * 4); this.count = 1; for (let i = 0; i < out.length; i += 4) { const g = lumaOf(frame, i) * dim; out[i] = g; out[i + 1] = g; out[i + 2] = g; out[i + 3] = 255 } return }
    const phase = (this.count % this.period) / this.period
    const ci = Math.min(255, Math.floor(phase * 256)) * 4
    const cr = this.lut[ci], cg = this.lut[ci + 1], cb = this.lut[ci + 2]
    const step = Math.max(1, Math.floor(n / 4096)), cnt = Math.floor(n / step)
    const th = this.k * robustSigma((k) => Math.abs(lumaOf(frame, k * step * 4) - prev[k * step]), cnt)
    const d = this.decay, R = this.accR, G = this.accG, B = this.accB
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const l = lumaOf(frame, i)
      const w = Math.abs(l - prev[p]) > th ? 1 : 0
      prev[p] = l
      R[p] = R[p] * d + cr * w; G[p] = G[p] * d + cg * w; B[p] = B[p] * d + cb * w
      const g = l * dim
      out[i] = Math.min(255, g + R[p]); out[i + 1] = Math.min(255, g + G[p]); out[i + 2] = Math.min(255, g + B[p]); out[i + 3] = 255
    }
    this.count++
  }
}

/** z-projection over time (Fiji's Z Project on the time axis, live): per-pixel running max, min, or
 *  max − min ("range" = activity) with an optional decay toward the current frame so old extremes
 *  fade. Max projection on dark-field shows the tracks of bright particles as a photo finish; min
 *  projection on brightfield shows dark swimmers' paths. */
export class TimeProjection {
  private mx: Float32Array; private mn: Float32Array
  count = 0
  constructor(public readonly width: number, public readonly height: number, public kind: 'max' | 'min' | 'range' = 'max', public decay = 1) {
    this.mx = new Float32Array(width * height * 3); this.mn = new Float32Array(width * height * 3)
  }
  reset(): void { this.count = 0 }
  update(frame: Uint8ClampedArray, out: Uint8ClampedArray): void {
    const mx = this.mx, mn = this.mn, d = this.decay
    if (this.count === 0) { for (let i = 0, q = 0; i < frame.length; i += 4, q += 3) { mx[q] = mn[q] = frame[i]; mx[q + 1] = mn[q + 1] = frame[i + 1]; mx[q + 2] = mn[q + 2] = frame[i + 2] } }
    else for (let i = 0, q = 0; i < frame.length; i += 4, q += 3) for (let c = 0; c < 3; c++) {
      const x = frame[i + c]
      const hi = d < 1 ? x + (mx[q + c] - x) * d : mx[q + c], lo = d < 1 ? x + (mn[q + c] - x) * d : mn[q + c]
      mx[q + c] = x > hi ? x : hi; mn[q + c] = x < lo ? x : lo
    }
    this.count++
    for (let i = 0, q = 0; i < frame.length; i += 4, q += 3) {
      for (let c = 0; c < 3; c++) out[i + c] = this.kind === 'max' ? mx[q + c] : this.kind === 'min' ? mn[q + c] : mx[q + c] - mn[q + c]
      out[i + 3] = 255
    }
  }
}
