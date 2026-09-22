/** Chroma-heavy denoise for live video (`docs/video-research/quality.md`, proposal 2 and the
 *  addendum's "chroma-heavy denoise at half resolution"): most visible noise on the Pi's MJPEG is
 *  colour speckle, and the JPEG's chroma is already 4:2:0, so smoothing Cb/Cr at half resolution
 *  loses nothing and costs a quarter of a full-res pass. Luma is never touched, so edges stay sharp.
 *
 *  Per frame:
 *    1. RGBA → Y (BT.601: 0.299 R + 0.587 G + 0.114 B) at full res, Cb/Cr and Y box-averaged 2×2
 *       into half-res Float32 planes (0..255 units, chroma centred on 128).
 *    2. Guided filter (He, Sun & Tang 2010) on each chroma plane with the half-res *luma* as guide:
 *       q = mean(a)·Y + mean(b), a = cov(Y, C)/(var(Y) + ε), b = mean(C) − a·mean(Y), box windows of
 *       `radius`. Where the luma is flat the chroma is flattened to its local mean (speckle goes);
 *       where the luma has an edge the chroma follows it (no colour bleeding across cell walls).
 *       ε is in the planes' own units squared: (8/255)² in 0..1 is 64 here. Same maths as
 *       `denoise.ts#guidedFilter`, re-implemented over preallocated scratch planes so a frame
 *       allocates nothing after warm-up.
 *    3. Optional temporal EMA on the filtered chroma with a soft motion gate,
 *       a = temporal · T/(T + d²) with T = 2ε, so a colour change larger than the noise pulls the
 *       history to the current frame instead of trailing a coloured organism.
 *    4. Bilinear upsample of the chroma back to full res, recombined with each pixel's own Y.
 *
 *  Units: everything in 0..255. Allocation-free per frame once the size is known. */

export interface ChromaDenoiseOptions {
  /** guided-filter window radius on the half-res grid (4) */
  radius: number
  /** guided-filter regularisation in (0..255)² units; 64 = (8/255)² */
  eps: number
  /** temporal history weight for the chroma EMA, 0 = off, 0.8 default, capped at 0.95 */
  temporal: number
}

export const defaultChromaDenoiseOptions: ChromaDenoiseOptions = { radius: 4, eps: 64, temporal: 0.8 }

/** Reflect-101 index into [0, n) (mirrors without duplicating the edge sample). */
function reflect(i: number, n: number): number {
  if (n <= 1) return 0
  const period = 2 * (n - 1)
  const m = ((i % period) + period) % period
  return m >= n ? period - m : m
}

/** Separable box mean of `src` into `dst` via running sums (`tmp` is a scratch plane). */
function boxInto(src: Float32Array, dst: Float32Array, tmp: Float32Array, w: number, h: number, r: number): void {
  const win = 2 * r + 1
  for (let y = 0; y < h; y++) {
    const row = y * w
    let sum = 0
    for (let k = -r; k <= r; k++) sum += src[row + reflect(k, w)]
    tmp[row] = sum / win
    for (let x = 1; x < w; x++) {
      sum += src[row + reflect(x + r, w)] - src[row + reflect(x - r - 1, w)]
      tmp[row + x] = sum / win
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let k = -r; k <= r; k++) sum += tmp[reflect(k, h) * w + x]
    dst[x] = sum / win
    for (let y = 1; y < h; y++) {
      sum += tmp[reflect(y + r, h) * w + x] - tmp[reflect(y - r - 1, h) * w + x]
      dst[y * w + x] = sum / win
    }
  }
}

export class ChromaDenoiser {
  private w = 0; private h = 0; private hw = 0; private hh = 0
  private yh!: Float32Array; private cb!: Float32Array; private cr!: Float32Array
  private meanI!: Float32Array; private varI!: Float32Array
  private prod!: Float32Array; private meanP!: Float32Array; private a!: Float32Array; private b!: Float32Array; private tmp!: Float32Array
  private histCb!: Float32Array; private histCr!: Float32Array
  private hasHist = false
  private out!: Uint8ClampedArray
  readonly opts: ChromaDenoiseOptions

  constructor(opts: Partial<ChromaDenoiseOptions> = {}) {
    this.opts = { ...defaultChromaDenoiseOptions, ...opts }
    this.opts.temporal = Math.min(0.95, Math.max(0, this.opts.temporal))
  }

  /** Drop the temporal chroma history (stream reconnect, stage move). */
  reset(): void { this.hasHist = false }

  private ensure(w: number, h: number): void {
    if (w === this.w && h === this.h) return
    this.w = w; this.h = h
    this.hw = Math.max(1, w >> 1); this.hh = Math.max(1, h >> 1)
    const n = this.hw * this.hh
    const f = () => new Float32Array(n)
    this.yh = f(); this.cb = f(); this.cr = f(); this.meanI = f(); this.varI = f()
    this.prod = f(); this.meanP = f(); this.a = f(); this.b = f(); this.tmp = f()
    this.histCb = f(); this.histCr = f()
    this.out = new Uint8ClampedArray(w * h * 4)
    this.hasHist = false
  }

  /** Split into half-res Y (guide) and chroma planes; a 2×2 box average per cell. */
  private split(d: Uint8ClampedArray): void {
    const { w, hw, hh, yh, cb, cr } = this
    for (let cy = 0; cy < hh; cy++) {
      const y0 = cy * 2, y1 = Math.min(this.h - 1, y0 + 1)
      for (let cx = 0; cx < hw; cx++) {
        const x0 = cx * 2, x1 = Math.min(w - 1, x0 + 1)
        const i00 = (y0 * w + x0) * 4, i01 = (y0 * w + x1) * 4, i10 = (y1 * w + x0) * 4, i11 = (y1 * w + x1) * 4
        const r = (d[i00] + d[i01] + d[i10] + d[i11]) * 0.25
        const g = (d[i00 + 1] + d[i01 + 1] + d[i10 + 1] + d[i11 + 1]) * 0.25
        const b = (d[i00 + 2] + d[i01 + 2] + d[i10 + 2] + d[i11 + 2]) * 0.25
        const k = cy * hw + cx
        yh[k] = 0.299 * r + 0.587 * g + 0.114 * b
        cb[k] = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b
        cr[k] = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b
      }
    }
  }

  /** Guide statistics shared by both chroma planes: mean(Y) and var(Y). */
  private guideStats(): void {
    const { hw, hh, yh, prod, meanI, varI, tmp } = this
    const r = this.opts.radius, n = hw * hh
    boxInto(yh, meanI, tmp, hw, hh, r)
    for (let i = 0; i < n; i++) prod[i] = yh[i] * yh[i]
    boxInto(prod, varI, tmp, hw, hh, r)
    for (let i = 0; i < n; i++) varI[i] -= meanI[i] * meanI[i]
  }

  /** Guided filter of one chroma plane in place (guide = half-res luma). */
  private guided(p: Float32Array): void {
    const { hw, hh, yh, prod, meanI, varI, meanP, a, b, tmp } = this
    const r = this.opts.radius, eps = this.opts.eps, n = hw * hh
    boxInto(p, meanP, tmp, hw, hh, r)
    for (let i = 0; i < n; i++) prod[i] = yh[i] * p[i]
    boxInto(prod, a, tmp, hw, hh, r)                 // a ← corr(Y, P)
    for (let i = 0; i < n; i++) {
      const ai = (a[i] - meanI[i] * meanP[i]) / (varI[i] + eps)
      a[i] = ai
      b[i] = meanP[i] - ai * meanI[i]
    }
    boxInto(a, meanP, tmp, hw, hh, r)                // meanP ← mean(a)
    boxInto(b, prod, tmp, hw, hh, r)                 // prod  ← mean(b)
    for (let i = 0; i < n; i++) p[i] = meanP[i] * yh[i] + prod[i]
  }

  /** Soft-gated EMA of the chroma planes against their history. */
  private temporal(): void {
    const al = this.opts.temporal
    if (al <= 0) return
    const { cb, cr, histCb, histCr } = this
    const n = cb.length
    if (!this.hasHist) { histCb.set(cb); histCr.set(cr); this.hasHist = true; return }
    const T = 2 * this.opts.eps
    for (let i = 0; i < n; i++) {
      const db = cb[i] - histCb[i], dr = cr[i] - histCr[i]
      const wgt = al * T / (T + db * db + dr * dr)
      const nb = histCb[i] + (1 - wgt) * db, nr = histCr[i] + (1 - wgt) * dr
      cb[i] = histCb[i] = nb; cr[i] = histCr[i] = nr
    }
  }

  /** Recombine: each pixel's own Y with the bilinearly upsampled filtered chroma. */
  private merge(d: Uint8ClampedArray): void {
    const { w, h, hw, hh, cb, cr, out } = this
    for (let y = 0; y < h; y++) {
      const v = Math.min(hh - 1, Math.max(0, (y - 0.5) / 2)), y0 = v | 0, y1 = Math.min(hh - 1, y0 + 1), fy = v - y0
      for (let x = 0; x < w; x++) {
        const u = Math.min(hw - 1, Math.max(0, (x - 0.5) / 2)), x0 = u | 0, x1 = Math.min(hw - 1, x0 + 1), fx = u - x0
        const k00 = y0 * hw + x0, k01 = y0 * hw + x1, k10 = y1 * hw + x0, k11 = y1 * hw + x1
        const w00 = (1 - fx) * (1 - fy), w01 = fx * (1 - fy), w10 = (1 - fx) * fy, w11 = fx * fy
        const pb = cb[k00] * w00 + cb[k01] * w01 + cb[k10] * w10 + cb[k11] * w11 - 128
        const pr = cr[k00] * w00 + cr[k01] * w01 + cr[k10] * w10 + cr[k11] * w11 - 128
        const i = (y * w + x) * 4
        const Y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
        out[i] = Y + 1.402 * pr
        out[i + 1] = Y - 0.344136 * pb - 0.714136 * pr
        out[i + 2] = Y + 1.772 * pb
        out[i + 3] = 255
      }
    }
  }

  /** Denoise one RGBA frame; the returned buffer is owned by the denoiser and reused next call. */
  push(rgba: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
    this.ensure(w, h)
    this.split(rgba)
    this.guideStats()
    this.guided(this.cb)
    this.guided(this.cr)
    this.temporal()
    this.merge(rgba)
    return this.out
  }
}
