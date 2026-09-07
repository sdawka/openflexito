/** Temporal focus stacking of the live stream ("lucky imaging" for depth of field).
 *
 *  Small z vibrations move the plane of focus a little from frame to frame. For every 16×16 block the
 *  composite keeps the content of the frame in which that block was sharpest (Laplacian energy), so
 *  over a second or two the live view accumulates an extended-depth-of-field image without moving
 *  the stage. Each frame is first aligned to the composite (xy jitter), replacements are feathered
 *  between blocks, and the stored sharpness decays slowly so the composite follows a genuine change of
 *  scene instead of freezing on stale frames. */

import { displacement } from './fftTrack'
import type { Gray } from './sharpness'
import { grayDown } from './stack'
import { translateRgba } from './pyramidFuse'

export interface LiveStackStats { frames: number; replaced: number /* fraction of blocks refreshed by the last frame */; shift: { dx: number; dy: number }; coverage: number /* fraction of blocks ever filled */ }

export class LiveStacker {
  composite: Uint8ClampedArray
  private best: Float32Array
  private filled: Uint8Array
  private cellsX: number; private cellsY: number
  private ref: Gray | null = null
  frames = 0
  /** per-frame multiplier on the stored sharpness; 0.99 ≈ a block is up for replacement after ~1–2 s at 10 fps */
  decay = 0.99
  /** a new block must beat the stored sharpness by this factor to replace it */
  margin = 1.05

  constructor(public width: number, public height: number, public cell = 16) {
    this.cellsX = Math.ceil(width / cell); this.cellsY = Math.ceil(height / cell)
    this.composite = new Uint8ClampedArray(width * height * 4)
    this.best = new Float32Array(this.cellsX * this.cellsY).fill(-1)
    this.filled = new Uint8Array(this.cellsX * this.cellsY)
  }

  reset(): void {
    this.composite.fill(0); this.best.fill(-1); this.filled.fill(0); this.ref = null; this.frames = 0
  }

  private energies(rgba: Uint8ClampedArray): Float32Array {
    const { width: w, height: h, cell, cellsX } = this
    const lum = new Float32Array(w * h)
    for (let i = 0, p = 0; i < w * h; i++, p += 4) lum[i] = 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]
    const e = new Float32Array(this.cellsX * this.cellsY)
    for (let y = 1; y < h - 1; y++) {
      const cy = Math.floor(y / cell) * cellsX
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x
        const lap = 4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - w] - lum[i + w]
        e[cy + Math.floor(x / cell)] += lap * lap
      }
    }
    return e
  }

  update(frame: Uint8ClampedArray): LiveStackStats {
    const { width: w, height: h, cell, cellsX, cellsY } = this
    // xy alignment against the first frame of this composite
    const g = grayDown(frame, w, h, 205)
    let dx = 0, dy = 0
    if (!this.ref) this.ref = g
    else {
      const d = displacement(this.ref, g), f = w / g.width
      if (Number.isFinite(d.quality) && d.quality > 1.15 && Math.hypot(d.dx, d.dy) * f < w * 0.05) { dx = Math.round(-d.dx * f); dy = Math.round(-d.dy * f) }
    }
    const aligned = translateRgba(frame, w, h, dx, dy)
    const e = this.energies(aligned)
    const mask = new Float32Array(cellsX * cellsY)
    let replaced = 0
    for (let c = 0; c < mask.length; c++) {
      this.best[c] *= this.decay
      if (!this.filled[c] || e[c] > this.best[c] * this.margin) {
        mask[c] = 1; this.best[c] = e[c]; this.filled[c] = 1; replaced++
      }
    }
    // feathered blend: per-pixel weight is the bilinear interpolation of the block mask
    const comp = this.composite
    for (let y = 0; y < h; y++) {
      const fy = Math.min(cellsY - 1, Math.max(0, (y + 0.5) / cell - 0.5)), y0 = Math.floor(fy), y1 = Math.min(cellsY - 1, y0 + 1), ty = fy - y0
      for (let x = 0; x < w; x++) {
        const fx = Math.min(cellsX - 1, Math.max(0, (x + 0.5) / cell - 0.5)), x0 = Math.floor(fx), x1 = Math.min(cellsX - 1, x0 + 1), tx = fx - x0
        const wgt = (mask[y0 * cellsX + x0] * (1 - tx) + mask[y0 * cellsX + x1] * tx) * (1 - ty) + (mask[y1 * cellsX + x0] * (1 - tx) + mask[y1 * cellsX + x1] * tx) * ty
        if (wgt <= 0) continue
        const p = (y * w + x) * 4
        if (wgt >= 1) { comp[p] = aligned[p]; comp[p + 1] = aligned[p + 1]; comp[p + 2] = aligned[p + 2]; comp[p + 3] = 255; continue }
        comp[p] = comp[p] + (aligned[p] - comp[p]) * wgt
        comp[p + 1] = comp[p + 1] + (aligned[p + 1] - comp[p + 1]) * wgt
        comp[p + 2] = comp[p + 2] + (aligned[p + 2] - comp[p + 2]) * wgt
        comp[p + 3] = 255
      }
    }
    this.frames++
    let filled = 0; for (let c = 0; c < this.filled.length; c++) filled += this.filled[c]
    return { frames: this.frames, replaced: replaced / mask.length, shift: { dx, dy }, coverage: filled / mask.length }
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
