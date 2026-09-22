/** Recursive soft Wiener temporal merge with a per-pixel frame-count map — HDR+'s pairwise merge
 *  (Hasinoff et al. 2016, "Burst photography for HDR and low-light imaging") applied recursively per
 *  pixel instead of per DCT tile, for live video (`docs/video-research/quality.md`, proposal 1).
 *
 *  Per pixel, with `d` the luma difference between the current frame and the (motion-compensated)
 *  history, σ²(Y) a per-luma-bin noise curve measured from static pixels, and `c` a robustness knob:
 *
 *      m   = max(0, d²_box − σ²·(1 + 1/n))   motion evidence: the difference beyond what noise alone
 *                                           explains (the history's own variance is σ²/n)
 *      s   = c·σ² / (m + c·σ²)             shrinkage in [0, 1]: 1 where the frames agree, → 0 on motion
 *      n   = min(N_max, s·n + 1)          effective frame count (Float32 map)
 *      a   = s · (1 − 1/n)                 history weight: → 0 on motion, → 1 − 1/N_max when static
 *      out = a·history + (1 − a)·cur       same weight for all three channels
 *
 *  Unlike a hard k·σ gate the blend never snaps, and the count map gives a 1/n warm-up after any
 *  local reset, so a pixel that was just occluded rebuilds its average in a few frames instead of
 *  restarting at a fixed α. `d²` is box-filtered 3×3 before the shrinkage (motion detection on a
 *  patch, not a pixel — what hqdn3d and broadcast DNR do), which is what keeps slow drifters from
 *  smearing. The noise curve (16 luma bins) is refreshed every 8 frames from pixels that were
 *  static last frame; σ² = 0.6·mean(d²) there, since the history is already cleaner than one frame.
 *  History is warped by the caller-supplied stage shift (bilinear, skipped below 0.05 px). */

export interface BurstMergeOptions {
  /** N_max: the longest effective average (8 default; the "strength") */
  maxFrames: number
  /** c: robustness — 2 cautious (movers stay crisp), 8 smooth */
  c: number
  /** shifts beyond this (px) mean an unrelated frame: history restarts */
  maxShiftPx: number
}

export const defaultBurstMergeOptions: BurstMergeOptions = { maxFrames: 8, c: 4, maxShiftPx: 60 }

const BINS = 16

export class BurstMerge {
  private hist: Float32Array | null = null
  private warped: Float32Array | null = null
  private count: Float32Array | null = null
  private d2: Float32Array | null = null
  private d2box: Float32Array | null = null
  private out: Uint8ClampedArray | null = null
  /** per-luma-bin noise variance (8-bit units²) */
  sigma2 = new Float32Array(BINS).fill(9)
  /** per-bin histogram of |d| on a coarse sample, for a robust (median) noise estimate that movers
   *  (a minority of pixels) cannot bias — no chicken-and-egg with the count map */
  private dh = new Uint32Array(BINS * 256)
  frames = 0
  /** mean effective frame count over the picture (for the status line) */
  meanCount = 0

  constructor(public opts: BurstMergeOptions = defaultBurstMergeOptions) {}

  reset(): void { this.frames = 0 }

  push(cur: Uint8ClampedArray, w: number, h: number, shift: { dx: number; dy: number } = { dx: 0, dy: 0 }): Uint8ClampedArray {
    const n = w * h
    if (!this.out || this.out.length !== cur.length) {
      this.hist = new Float32Array(n * 3); this.warped = new Float32Array(n * 3); this.count = new Float32Array(n)
      this.d2 = new Float32Array(n); this.d2box = new Float32Array(n); this.out = new Uint8ClampedArray(cur.length)
      this.frames = 0
    }
    const hist = this.hist!, out = this.out!, count = this.count!
    const restart = this.frames === 0 || Math.abs(shift.dx) > this.opts.maxShiftPx || Math.abs(shift.dy) > this.opts.maxShiftPx
    if (restart) {
      for (let i = 0, q = 0; i < cur.length; i += 4, q += 3) { hist[q] = cur[i]; hist[q + 1] = cur[i + 1]; hist[q + 2] = cur[i + 2] }
      count.fill(1)
      out.set(cur)
      this.frames = 1
      this.meanCount = 1
      return out
    }
    // motion-compensate the history
    let src = hist
    if (Math.abs(shift.dx) >= 0.05 || Math.abs(shift.dy) >= 0.05) { warp3(hist, w, h, shift.dx, shift.dy, this.warped!); src = this.warped! }
    // luma difference², box 3×3
    const d2 = this.d2!, d2box = this.d2box!
    for (let p = 0, i = 0, q = 0; p < n; p++, i += 4, q += 3) {
      const d = (cur[i] - src[q]) * 0.299 + (cur[i + 1] - src[q + 1]) * 0.587 + (cur[i + 2] - src[q + 2]) * 0.114
      d2[p] = d * d
    }
    box3(d2, w, h, d2box)
    // noise curve refresh every 8 frames (and on the first merge) from the per-bin median of |d|
    const refresh = this.frames % 8 === 1
    if (refresh) this.dh.fill(0)
    const c = this.opts.c, nMax = this.opts.maxFrames
    let sumCount = 0
    for (let p = 0, i = 0, q = 0; p < n; p++, i += 4, q += 3) {
      const y = cur[i] * 0.299 + cur[i + 1] * 0.587 + cur[i + 2] * 0.114
      const bin = y >= 255 ? BINS - 1 : (y / 16) | 0
      const s2 = this.sigma2[bin], cs2 = c * s2
      const m = d2box[p] - s2 * (1 + 1 / count[p])
      const s = m <= 0 ? 1 : cs2 / (m + cs2)
      if (refresh && (p & 3) === 0) { const ad = Math.sqrt(d2[p]); this.dh[bin * 256 + (ad > 255 ? 255 : ad | 0)]++ }
      const nc = Math.min(nMax, s * count[p] + 1)
      count[p] = nc
      sumCount += nc
      const a = s * (1 - 1 / nc), b = 1 - a
      const r = a * src[q] + b * cur[i], g = a * src[q + 1] + b * cur[i + 1], bl = a * src[q + 2] + b * cur[i + 2]
      hist[q] = r; hist[q + 1] = g; hist[q + 2] = bl
      out[i] = r; out[i + 1] = g; out[i + 2] = bl; out[i + 3] = 255
    }
    if (refresh) {
      for (let k = 0; k < BINS; k++) {
        let tot = 0
        for (let v = 0; v < 256; v++) tot += this.dh[k * 256 + v]
        if (tot < 64) continue
        let acc = 0, med = 0
        for (let v = 0; v < 256; v++) { acc += this.dh[k * 256 + v]; if (acc * 2 >= tot) { med = v + 0.5; break } }
        // |d| between the frame and its history: median·1.4826 ≈ σ_d; σ_d² = σ²·(1 + 1/n̄)
        this.sigma2[k] = Math.max(1, (med * 1.4826) ** 2 / (1 + 1 / Math.max(1, this.meanCount)))
      }
    }
    this.meanCount = sumCount / n
    this.frames++
    return out
  }
}

function box3(src: Float32Array, w: number, h: number, out: Float32Array): void {
  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? y - 1 : 0, y1 = y < h - 1 ? y + 1 : h - 1
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : 0, x1 = x < w - 1 ? x + 1 : w - 1
      out[y * w + x] = (src[y0 * w + x0] + src[y0 * w + x] + src[y0 * w + x1] + src[y * w + x0] + src[y * w + x] + src[y * w + x1] + src[y1 * w + x0] + src[y1 * w + x] + src[y1 * w + x1]) / 9
    }
  }
}

function warp3(src: Float32Array, w: number, h: number, dx: number, dy: number, out: Float32Array): void {
  for (let y = 0; y < h; y++) {
    const sy = y - dy, y0 = Math.floor(sy), ty = sy - y0
    const cy0 = Math.min(h - 1, Math.max(0, y0)), cy1 = Math.min(h - 1, Math.max(0, y0 + 1))
    for (let x = 0; x < w; x++) {
      const sx = x - dx, x0 = Math.floor(sx), tx = sx - x0
      const cx0 = Math.min(w - 1, Math.max(0, x0)), cx1 = Math.min(w - 1, Math.max(0, x0 + 1))
      const p00 = (cy0 * w + cx0) * 3, p10 = (cy0 * w + cx1) * 3, p01 = (cy1 * w + cx0) * 3, p11 = (cy1 * w + cx1) * 3, o = (y * w + x) * 3
      for (let c = 0; c < 3; c++) out[o + c] = (src[p00 + c] * (1 - tx) + src[p10 + c] * tx) * (1 - ty) + (src[p01 + c] * (1 - tx) + src[p11 + c] * tx) * ty
    }
  }
}
