/** Temporal focus stacking of the live stream ("lucky imaging" for depth of field).
 *
 *  Small z vibrations move the plane of focus a little from frame to frame. The composite is a
 *  per-pixel weighted average of the recent frames where each 16×16 block weights a frame by
 *  (sharpness / best sharpness seen)^power: the sharpest frames dominate a block, frames of equal
 *  sharpness are averaged (so a still scene gets its noise averaged away instead of flickering),
 *  and blurrier frames barely count. Sharpness is Laplacian energy on a half-resolution luminance,
 *  which is far less sensitive to JPEG noise than the full-resolution measure. Each frame is aligned
 *  to the first one (xy jitter); a large shift means the scene moved and restarts the composite. The
 *  accumulators forget old frames and the stored best sharpness decays slowly, so the composite
 *  follows a genuine change of scene instead of freezing on stale frames.
 *
 *  Previous version replaced whole blocks whenever a frame beat the stored sharpness by 5 %: JPEG
 *  noise alone fluctuates more than that, so the composite was the latest frame with a lag. */

import { displacement } from './fftTrack'
import type { Gray } from './sharpness'
import { grayDown } from './stack'
import { translateRgbaSubpixel } from './align'

export interface LiveStackStats { frames: number; replaced: number /* fraction of blocks the last frame sharpened noticeably */; shift: { dx: number; dy: number }; coverage: number /* fraction of blocks ever filled */ }

export class LiveStacker {
  composite: Uint8ClampedArray
  private acc: Float32Array      // Σ weight·rgb per pixel
  private wsum: Float32Array     // Σ weight per pixel
  private best: Float32Array     // per block: decayed running maximum of the sharpness
  private cellsX: number; private cellsY: number
  private ref: Gray | null = null
  frames = 0
  /** how strongly sharper frames dominate a block: weight = (sharpness / best)^power */
  power = 4
  /** smallest weight of any frame, so a blurrier new scene still takes over within ~3 s at 8 fps */
  floor = 0.02
  /** per-frame multiplier on the accumulated weights (frames older than ~25 are forgotten) */
  forget = 0.96
  /** per-frame multiplier on the stored best sharpness */
  bestDecay = 0.995
  /** xy shift (fraction of the width) beyond which the scene has moved: the composite restarts */
  maxShift = 0.05

  constructor(public width: number, public height: number, public cell = 16) {
    this.cellsX = Math.ceil(width / cell); this.cellsY = Math.ceil(height / cell)
    this.composite = new Uint8ClampedArray(width * height * 4)
    this.acc = new Float32Array(width * height * 3)
    this.wsum = new Float32Array(width * height)
    this.best = new Float32Array(this.cellsX * this.cellsY).fill(-1)
  }

  reset(): void {
    this.composite.fill(0); this.acc.fill(0); this.wsum.fill(0); this.best.fill(-1); this.ref = null; this.frames = 0
  }

  /** Per-block Laplacian energy of the 2×2-averaged luminance (noise-robust, 4× cheaper). */
  private energies(rgba: Uint8ClampedArray): Float32Array {
    const { width: w, height: h, cell, cellsX } = this
    const w2 = w >> 1, h2 = h >> 1
    const lum = new Float32Array(w2 * h2)
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
      let s = 0
      for (let dy = 0; dy < 2; dy++) { let p = ((2 * y + dy) * w + 2 * x) * 4; for (let dx = 0; dx < 2; dx++, p += 4) s += 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2] }
      lum[y * w2 + x] = s * 0.25
    }
    const e = new Float32Array(this.cellsX * this.cellsY)
    const half = cell / 2
    for (let y = 1; y < h2 - 1; y++) {
      const cy = Math.floor(y / half) * cellsX
      for (let x = 1; x < w2 - 1; x++) {
        const i = y * w2 + x
        const lap = 4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - w2] - lum[i + w2]
        e[cy + Math.floor(x / half)] += lap * lap
      }
    }
    return e
  }

  update(frame: Uint8ClampedArray): LiveStackStats {
    const { width: w, height: h, cell, cellsX, cellsY, power, floor, forget } = this
    // xy alignment against the first frame of this composite; a big shift means the scene moved
    const g = grayDown(frame, w, h, 205)
    let dx = 0, dy = 0
    if (this.ref) {
      const d = displacement(this.ref, g), f = w / g.width
      if (Number.isFinite(d.quality) && d.quality > 1.15) {
        const r = Math.hypot(d.dx, d.dy) * f
        if (r >= w * this.maxShift) this.reset()
        else if (r >= 0.25) { dx = -d.dx * f; dy = -d.dy * f }
      }
    }
    if (!this.ref) this.ref = g
    const aligned = dx || dy ? translateRgbaSubpixel(frame, w, h, dx, dy) : frame
    const e = this.energies(aligned)
    // per block: weight of this frame and the factor that re-expresses the old accumulation
    // relative to a new best (the weights are pure powers of the ratio, so this is exact)
    const wgt = new Float32Array(cellsX * cellsY), fac = new Float32Array(cellsX * cellsY)
    let replaced = 0
    for (let c = 0; c < wgt.length; c++) {
      const b = this.best[c] * this.bestDecay
      if (b <= 0) { wgt[c] = 1; fac[c] = forget; this.best[c] = Math.max(e[c], 0); replaced++; continue }
      if (e[c] > b) {
        wgt[c] = 1; fac[c] = forget * Math.pow(b / e[c], power); this.best[c] = e[c]
        if (e[c] > b * 1.05) replaced++
      } else { wgt[c] = Math.max(floor, Math.pow(e[c] / b, power)); fac[c] = forget; this.best[c] = b }
    }
    // feathered accumulation: per-pixel weight and factor are the bilinear interpolation of the block maps
    const xs0 = new Int32Array(w), xs1 = new Int32Array(w), txs = new Float32Array(w)
    for (let x = 0; x < w; x++) {
      const fx = Math.min(cellsX - 1, Math.max(0, (x + 0.5) / cell - 0.5)), x0 = Math.floor(fx)
      xs0[x] = x0; xs1[x] = Math.min(cellsX - 1, x0 + 1); txs[x] = fx - x0
    }
    const { acc, wsum, composite: comp } = this
    for (let y = 0; y < h; y++) {
      const fy = Math.min(cellsY - 1, Math.max(0, (y + 0.5) / cell - 0.5)), y0 = Math.floor(fy), y1 = Math.min(cellsY - 1, y0 + 1), ty = fy - y0
      const r0 = y0 * cellsX, r1 = y1 * cellsX
      for (let x = 0; x < w; x++) {
        const x0 = xs0[x], x1 = xs1[x], tx = txs[x]
        const a00 = (1 - tx) * (1 - ty), a01 = tx * (1 - ty), a10 = (1 - tx) * ty, a11 = tx * ty
        const wt = wgt[r0 + x0] * a00 + wgt[r0 + x1] * a01 + wgt[r1 + x0] * a10 + wgt[r1 + x1] * a11
        const f = fac[r0 + x0] * a00 + fac[r0 + x1] * a01 + fac[r1 + x0] * a10 + fac[r1 + x1] * a11
        const i = y * w + x, q = i * 3, p = i * 4
        const s = wsum[i] * f + wt
        acc[q] = acc[q] * f + aligned[p] * wt
        acc[q + 1] = acc[q + 1] * f + aligned[p + 1] * wt
        acc[q + 2] = acc[q + 2] * f + aligned[p + 2] * wt
        wsum[i] = s
        const inv = 1 / s
        comp[p] = acc[q] * inv; comp[p + 1] = acc[q + 1] * inv; comp[p + 2] = acc[q + 2] * inv; comp[p + 3] = 255
      }
    }
    this.frames++
    return { frames: this.frames, replaced: replaced / wgt.length, shift: { dx: Math.round(dx), dy: Math.round(dy) }, coverage: 1 }
  }
}


/** Temporal averaging of the live stream (exponential moving average): halves the visible noise
 *  after ~4 frames while the stage is still. Same interface as LiveStacker so the worker can host either. */
export class LiveAverager {
  composite: Uint8ClampedArray
  private acc: Float32Array
  frames = 0
  /** weight of the newest frame; 0.25 ≈ averaging over the last ~4 frames */
  alpha = 0.25
  constructor(public width: number, public height: number) {
    this.composite = new Uint8ClampedArray(width * height * 4)
    this.acc = new Float32Array(width * height * 4)
  }
  reset(): void { this.acc.fill(0); this.composite.fill(0); this.frames = 0 }
  update(frame: Uint8ClampedArray): LiveStackStats {
    const a = this.frames === 0 ? 1 : this.alpha, acc = this.acc, out = this.composite
    for (let i = 0; i < acc.length; i += 4) {
      acc[i] += (frame[i] - acc[i]) * a; acc[i + 1] += (frame[i + 1] - acc[i + 1]) * a; acc[i + 2] += (frame[i + 2] - acc[i + 2]) * a
      out[i] = acc[i]; out[i + 1] = acc[i + 1]; out[i + 2] = acc[i + 2]; out[i + 3] = 255
    }
    this.frames++
    return { frames: this.frames, replaced: a, shift: { dx: 0, dy: 0 }, coverage: 1 }
  }
}
