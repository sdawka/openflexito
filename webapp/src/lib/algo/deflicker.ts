/** Per-frame brightness (de-flicker) normalisation for video: measure each frame's luma, compare it
 *  to a slow exponential-moving-average reference and apply a clamped multiplicative gain so a
 *  mains/LED-driver beat (see `algo/flicker.ts`'s analysis of the same symptom) is damped instead of
 *  baked into the recording. Pure and allocation-light; `services/deflickerProcessor.ts` wires it into
 *  the frame chain. */

export interface DeflickerOptions {
  /** EMA smoothing of the reference luma: higher = slower to adapt (0..1). */
  alpha: number
  /** clamp on the per-frame gain, e.g. 0.25 = ±25 %. */
  maxGainDelta: number
  /** measure the median (50th percentile) luma via a histogram instead of the mean; more robust to a
   *  bright/dark object entering the frame, slightly more expensive. */
  usePercentile: boolean
}

export const defaultDeflickerOptions: DeflickerOptions = { alpha: 0.9, maxGainDelta: 0.25, usePercentile: false }

/** Mean or median luma (Rec. 601 weights) of an RGBA buffer, 0..255. */
export function frameLuma(rgba: Uint8ClampedArray | Uint8Array, usePercentile = false): number {
  const n = rgba.length >> 2
  if (n === 0) return 0
  if (!usePercentile) {
    let sum = 0
    for (let i = 0; i < rgba.length; i += 4) sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]
    return sum / n
  }
  const hist = new Uint32Array(256)
  for (let i = 0; i < rgba.length; i += 4) {
    const l = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]
    hist[Math.max(0, Math.min(255, Math.round(l)))]++
  }
  const half = n / 2
  let acc = 0
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= half) return v }
  return 128
}

/** Scale every RGB channel by `gain` in place (alpha untouched); a no-op at `gain === 1`. */
export function applyGainRgba(data: Uint8ClampedArray, gain: number): void {
  if (gain === 1) return
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i] * gain; data[i + 1] = data[i + 1] * gain; data[i + 2] = data[i + 2] * gain
  }
}

/** Stateful per-run gain estimator: `nextGain(luma)` returns the gain to apply to the frame that
 *  luma was measured from and updates the EMA reference for the next one. */
export class Deflicker {
  private ref: number | null = null

  constructor(private opts: DeflickerOptions = defaultDeflickerOptions) {}

  /** Drop the reference (stage move, scene cut, run restart): the next frame becomes the new anchor
   *  (gain 1) instead of being compared against a now-unrelated brightness. */
  reset(): void { this.ref = null }

  nextGain(luma: number): number {
    if (this.ref === null) { this.ref = luma; return 1 }
    const raw = luma > 1e-6 ? this.ref / luma : 1
    const gain = Math.max(1 - this.opts.maxGainDelta, Math.min(1 + this.opts.maxGainDelta, raw))
    this.ref = this.opts.alpha * this.ref + (1 - this.opts.alpha) * luma
    return gain
  }
}
