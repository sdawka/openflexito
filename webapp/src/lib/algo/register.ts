/** Coarse-to-fine sub-pixel registration of two frames of the same scene.
 *
 *  Registering a downscaled frame and multiplying the shift back (what super-resolution used to do
 *  at 8× downscale) multiplies the estimator's error by the same factor and throws away the
 *  full-resolution detail that carries the sub-pixel information. This primitive does what
 *  `SliceAligner` does for focus stacks, as one reusable function:
 *    1. coarse: `displacement()` on box-downscaled copies (≤ `coarseW` wide) finds the shift to
 *       the nearest full-resolution pixel and gives a first quality figure;
 *    2. fine: `displacement()` again on a full-resolution central crop of the reference and the
 *       correspondingly offset crop of the frame, which measures the sub-pixel residual with the
 *       full-resolution estimator (~0.01 px on a textured scene, see fftTrack tests).
 *  `confident` is false when either stage has an ambiguous peak, the fine residual disagrees with
 *  the coarse estimate by more than a pixel, or the shift is too large a fraction of the frame. */

import { displacement } from './fftTrack'
import type { Gray } from './sharpness'

export interface Registration {
  /** Shift of `img` relative to `ref` in full-resolution pixels (positive dx: content moved right). */
  dx: number; dy: number
  /** Peak-to-sidelobe ratio of the fine (full-resolution) correlation; the coarse one when the fine
   *  stage could not run (frame too small for a crop). */
  quality: number
  /** Coarse and fine quality separately, for logging. */
  coarseQuality: number; fineQuality: number
  confident: boolean
}

export interface RegisterOptions {
  /** Width the coarse stage works at (integer box downscale; default 410, like `grayDown`). */
  coarseW?: number
  /** Side of the full-resolution crop used by the fine stage (default 512, clipped to the frame). */
  crop?: number
  /** Largest acceptable shift as a fraction of the frame width (default 0.2). */
  maxShiftFrac?: number
  /** Minimum peak-to-sidelobe ratio for a stage to count as unambiguous (default 1.5). */
  minQuality?: number
}

/** Integer box downscale of a greyscale image by `f`. */
export function boxDown(g: Gray, f: number): Gray {
  if (f <= 1) return g
  const w = Math.floor(g.width / f), h = Math.floor(g.height / f)
  const data = new Float32Array(w * h)
  const inv = 1 / (f * f)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0
    for (let j = 0; j < f; j++) { const row = (y * f + j) * g.width + x * f; for (let i = 0; i < f; i++) s += g.data[row + i] }
    data[y * w + x] = s * inv
  }
  return { data, width: w, height: h }
}

/** Crop `size`×`size` (clipped) at the given top-left corner. */
function cropAt(g: Gray, x0: number, y0: number, w: number, h: number): Gray {
  const data = new Float32Array(w * h)
  for (let y = 0; y < h; y++) data.set(g.data.subarray((y0 + y) * g.width + x0, (y0 + y) * g.width + x0 + w), y * w)
  return { data, width: w, height: h }
}

/** Register `img` to `ref` (same geometry). */
export function register(ref: Gray, img: Gray, opts: RegisterOptions = {}): Registration {
  if (ref.width !== img.width || ref.height !== img.height) throw new Error('register: frames must have the same size')
  const coarseW = opts.coarseW ?? 410, cropSide = opts.crop ?? 512, maxShiftFrac = opts.maxShiftFrac ?? 0.2, minQ = opts.minQuality ?? 1.5
  const f = Math.max(1, Math.floor(ref.width / coarseW))
  const c = displacement(boxDown(ref, f), boxDown(img, f))
  let ix = Math.round(c.dx * f), iy = Math.round(c.dy * f)
  const coarseOk = Number.isFinite(c.quality) ? c.quality >= minQ : true
  const limit = maxShiftFrac * ref.width
  const inRange = Math.hypot(ix, iy) <= limit
  if (!inRange) { ix = 0; iy = 0 }
  // fine stage on a central crop of ref and the crop of img offset by the integer estimate (so both
  // show the same scene content); leave room for a ±2 px residual search
  const cw = Math.min(cropSide, ref.width - Math.abs(ix) - 4), ch = Math.min(cropSide, ref.height - Math.abs(iy) - 4)
  if (cw < 32 || ch < 32) {
    const dx = c.dx * f, dy = c.dy * f
    return { dx, dy, quality: c.quality, coarseQuality: c.quality, fineQuality: NaN, confident: coarseOk && inRange }
  }
  // ref crop centred; img crop shifted by (ix, iy) and clamped into the frame together with ref's
  let rx0 = Math.floor((ref.width - cw) / 2), ry0 = Math.floor((ref.height - ch) / 2)
  let gx0 = rx0 + ix, gy0 = ry0 + iy
  if (gx0 < 0) { rx0 -= gx0; gx0 = 0 } else if (gx0 + cw > ref.width) { const o = gx0 + cw - ref.width; rx0 -= o; gx0 -= o }
  if (gy0 < 0) { ry0 -= gy0; gy0 = 0 } else if (gy0 + ch > ref.height) { const o = gy0 + ch - ref.height; ry0 -= o; gy0 -= o }
  const d = displacement(cropAt(ref, rx0, ry0, cw, ch), cropAt(img, gx0, gy0, cw, ch))
  const fineOk = Number.isFinite(d.quality) ? d.quality >= minQ : true
  const consistent = Math.hypot(d.dx, d.dy) <= 1.5
  const dx = ix + d.dx, dy = iy + d.dy
  return { dx, dy, quality: d.quality, coarseQuality: c.quality, fineQuality: d.quality, confident: coarseOk && inRange && fineOk && consistent }
}
