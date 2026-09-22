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

export class BackgroundModel {
  private bg: Float32Array
  private diff: Float32Array
  count = 0
  /** robust noise estimate of the last difference field (median absolute difference × 1.4826) */
  sigma = 2

  constructor(public readonly width: number, public readonly height: number, public alpha = 0.03) {
    this.bg = new Float32Array(width * height)
    this.diff = new Float32Array(width * height)
  }

  reset(): void { this.count = 0 }

  /** Update the background with `frame` and return the |frame − background| luma field (the buffer is
   *  reused). `learnMoving` = false freezes the model where motion is detected, so a slow organism
   *  does not get absorbed into the background as quickly. */
  update(frame: Uint8ClampedArray, learnMoving = true): Float32Array {
    const bg = this.bg, diff = this.diff, n = bg.length
    if (this.count === 0) { for (let p = 0; p < n; p++) { bg[p] = lumaOf(frame, p * 4); diff[p] = 0 } this.count = 1; return diff }
    const a = Math.max(this.alpha, 1 / (this.count + 1)), b = 1 - a
    // noise estimate from a coarse sample of the differences, before the update
    const sample: number[] = []
    const step = Math.max(1, Math.floor(n / 4096))
    for (let p = 0; p < n; p++) {
      const l = lumaOf(frame, p * 4)
      const d = Math.abs(l - bg[p])
      diff[p] = d
      if (p % step === 0) sample.push(d)
      if (learnMoving || d < 3 * this.sigma) bg[p] = b * bg[p] + a * l
    }
    sample.sort((x, y) => x - y)
    this.sigma = Math.max(1, sample[sample.length >> 1] * 1.4826)
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
    // σ of the frame difference from a coarse sample
    const sample: number[] = []
    const step = Math.max(1, Math.floor(n / 4096))
    for (let p = 0; p < n; p += step) sample.push(Math.abs(lumaOf(frame, p * 4) - prev[p]))
    sample.sort((a, b) => a - b)
    const sigma = Math.max(1, sample[sample.length >> 1] * 1.4826), th = this.k * sigma
    for (let p = 0, i = 0; p < n; p++, i += 4) {
      const l = lumaOf(frame, i)
      const moved = Math.abs(l - prev[p]) > th
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

  /** `period` frames per hue cycle; `decay` fades old colour so the code keeps working indefinitely
   *  (1 = ImageJ's cumulative projection); `map` any `algo/colormaps.ts` name. */
  constructor(public readonly width: number, public readonly height: number, public period = 90, public decay = 0.985, map = 'spectrum', public k = 4) {
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
    const sample: number[] = []
    const step = Math.max(1, Math.floor(n / 4096))
    for (let p = 0; p < n; p += step) sample.push(Math.abs(lumaOf(frame, p * 4) - prev[p]))
    sample.sort((a, b) => a - b)
    const th = this.k * Math.max(1, sample[sample.length >> 1] * 1.4826)
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
