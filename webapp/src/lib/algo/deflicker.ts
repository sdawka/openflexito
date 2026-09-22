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
  /** measure the *background* — the mean luma of the brightest 30 % of unclipped pixels — instead
   *  of the whole frame. In LED brightfield that is the illuminant itself, so an organism drifting
   *  through no longer "breathes" the gain (research note `docs/video-research/colour.md`). Takes
   *  precedence over `usePercentile`. */
  background?: boolean
}

export const defaultDeflickerOptions: DeflickerOptions = { alpha: 0.9, maxGainDelta: 0.25, usePercentile: false, background: true }

/** Mean luma of the brightest 30 % of pixels below 250 (the illuminated background in brightfield);
 *  falls back to the median when fewer than 5 % of pixels qualify (dark-field, fluorescence). */
export function backgroundLuma(rgba: Uint8ClampedArray | Uint8Array): number {
  const n = rgba.length >> 2
  if (n === 0) return 0
  const hist = new Uint32Array(256)
  for (let i = 0; i < rgba.length; i += 4) {
    const l = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]
    hist[l > 255 ? 255 : l < 0 ? 0 : l | 0]++
  }
  let unclipped = 0
  for (let v = 0; v < 250; v++) unclipped += hist[v]
  if (unclipped < n * 0.05) return frameLuma(rgba, true)
  const want = unclipped * 0.3
  let acc = 0, sum = 0
  for (let v = 249; v >= 0 && acc < want; v--) { const take = Math.min(hist[v], want - acc); acc += take; sum += take * v }
  return acc ? sum / acc : frameLuma(rgba, true)
}

const toLin = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const toSrgb = (l: number) => { const c = l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055; return c * 255 }

/** 256-entry table applying `gain` in linear light (a flicker is multiplicative on the illuminant,
 *  i.e. linear, not gamma-space), with a soft knee so the top of the range rolls into 255 instead of
 *  clipping. */
export function gainLut(gain: number, out = new Uint8ClampedArray(256)): Uint8ClampedArray {
  const knee = 0.85
  for (let v = 0; v < 256; v++) {
    let x = toSrgb(toLin(v) * gain) / 255
    if (gain > 1 && x > knee) x = knee + (1 - knee) * Math.tanh((x - knee) / (1 - knee))   // only a lift can clip
    out[v] = Math.round(Math.max(0, Math.min(255, x * 255)))
  }
  return out
}

/** Apply a `gainLut` table to every RGB channel in place. */
export function applyLutRgba(data: Uint8ClampedArray, lut: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) { data[i] = lut[data[i]]; data[i + 1] = lut[data[i + 1]]; data[i + 2] = lut[data[i + 2]] }
}

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
