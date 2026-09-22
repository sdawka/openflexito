/** Eulerian video magnification (Wu, Rubinstein, Shih, Guttag, Durand, Freeman — SIGGRAPH 2012),
 *  the linear/intensity variant, for live use: tiny periodic motions (cilia beating, a heart wall,
 *  a vibrating flagellum) become visible by amplifying the temporal band-pass of each pixel's
 *  intensity at a coarse spatial scale.
 *
 *  Per frame: box-downsample the luma by `factor` (spatial low-pass = the Gaussian-pyramid level of
 *  the paper), run two first-order IIR low-passes per coarse pixel (cut-offs `fLo` < `fHi` Hz), their
 *  difference is the band-pass signal, multiply by `alpha`, clamp to `±maxDelta`, bilinear-upsample
 *  and add to all three channels of the full-resolution frame. Cost is dominated by one pass over
 *  the full frame (downsample + add-back); the IIRs run on the coarse grid. The phase-based variant
 *  (Wadhwa 2013) is better for large amplification but needs complex steerable pyramids — see the
 *  "do not bother" note in `webapp/docs/video-modes.md`. */

export interface EulerianOptions {
  /** spatial downsample factor (8 → 205×154 coarse grid at 1640×1232) */
  factor: number
  /** temporal band, Hz */
  fLo: number
  fHi: number
  /** amplification of the band-passed intensity */
  alpha: number
  /** clamp on the added intensity (8-bit units) so amplification never blows out */
  maxDelta: number
  /** paint the amplified signal in a colour (positive = warm, negative = cool) instead of adding it to
   *  the intensity — makes "where does it move" readable even when the amplitude is small */
  colour?: boolean
}

export const defaultEulerianOptions: EulerianOptions = { factor: 8, fLo: 0.5, fHi: 4, alpha: 15, maxDelta: 60, colour: false }

export class EulerianMagnifier {
  private cw: number; private ch: number
  private coarse: Float32Array
  private lo: Float32Array
  private hi: Float32Array
  private band: Float32Array
  private lastT: number | null = null
  count = 0

  constructor(public readonly width: number, public readonly height: number, public opts: EulerianOptions = defaultEulerianOptions) {
    this.cw = Math.max(1, Math.floor(width / opts.factor)); this.ch = Math.max(1, Math.floor(height / opts.factor))
    const n = this.cw * this.ch
    this.coarse = new Float32Array(n); this.lo = new Float32Array(n); this.hi = new Float32Array(n); this.band = new Float32Array(n)
  }

  reset(): void { this.count = 0; this.lastT = null }

  /** `tSec` is the frame time in seconds (the IIR coefficients follow the real frame interval). */
  update(frame: Uint8ClampedArray, tSec: number, out: Uint8ClampedArray): void {
    const { factor, fLo, fHi, alpha, maxDelta, colour } = this.opts
    const w = this.width, h = this.height, cw = this.cw, ch = this.ch
    const coarse = this.coarse
    coarse.fill(0)
    const inv = 1 / (factor * factor)
    for (let y = 0; y < ch * factor; y++) {
      const cy = (y / factor) | 0
      for (let x = 0; x < cw * factor; x++) {
        const i = (y * w + x) * 4
        coarse[cy * cw + ((x / factor) | 0)] += (frame[i] * 0.299 + frame[i + 1] * 0.587 + frame[i + 2] * 0.114) * inv
      }
    }
    const lo = this.lo, hi = this.hi, band = this.band
    if (this.count === 0 || this.lastT == null) { lo.set(coarse); hi.set(coarse); band.fill(0); this.lastT = tSec; this.count = 1; out.set(frame); return }
    const dt = Math.min(0.5, Math.max(1e-3, tSec - this.lastT))
    this.lastT = tSec
    const aLo = 1 - Math.exp(-2 * Math.PI * fLo * dt), aHi = 1 - Math.exp(-2 * Math.PI * fHi * dt)
    for (let p = 0; p < coarse.length; p++) {
      lo[p] += aLo * (coarse[p] - lo[p])
      hi[p] += aHi * (coarse[p] - hi[p])
      const b = (hi[p] - lo[p]) * alpha
      band[p] = b > maxDelta ? maxDelta : b < -maxDelta ? -maxDelta : b
    }
    this.count++
    // bilinear upsample of `band`, added to the frame
    for (let y = 0; y < h; y++) {
      const fy = Math.min(ch - 1, Math.max(0, (y + 0.5) / factor - 0.5))
      const y0 = fy | 0, y1 = Math.min(ch - 1, y0 + 1), ty = fy - y0
      for (let x = 0; x < w; x++) {
        const fx = Math.min(cw - 1, Math.max(0, (x + 0.5) / factor - 0.5))
        const x0 = fx | 0, x1 = Math.min(cw - 1, x0 + 1), tx = fx - x0
        const b = (band[y0 * cw + x0] * (1 - tx) + band[y0 * cw + x1] * tx) * (1 - ty) + (band[y1 * cw + x0] * (1 - tx) + band[y1 * cw + x1] * tx) * ty
        const i = (y * w + x) * 4
        if (colour) {
          const g = frame[i] * 0.299 + frame[i + 1] * 0.587 + frame[i + 2] * 0.114
          if (b >= 0) { out[i] = g + b; out[i + 1] = g + b * 0.4; out[i + 2] = g } else { out[i] = g; out[i + 1] = g - b * 0.4; out[i + 2] = g - b }
        } else { out[i] = frame[i] + b; out[i + 1] = frame[i + 1] + b; out[i + 2] = frame[i + 2] + b }
        out[i + 3] = 255
      }
    }
  }
}
