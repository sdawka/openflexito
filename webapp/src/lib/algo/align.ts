/** Sub-pixel alignment of focus-stack slices.
 *
 *  A z move on a flexure stage shifts the image a little, and every slice of a focus stack has a
 *  different amount of defocus. The previous alignment correlated each slice against the first (the
 *  most defocused one) on a ≤410 px luminance and rounded to whole pixels: at full resolution that
 *  is a ±4 px error even when the correlation was good, and correlating a sharp slice against a
 *  badly defocused one often is not. This module instead
 *    - chains: each slice is aligned to its neighbour (similar defocus, strong correlation) and the
 *      shifts are accumulated, so every slice ends up in the first slice's frame;
 *    - refines coarse-to-fine: phase correlation on the coarsest pyramid level finds the shift to
 *      the pixel there; each finer level searches ±2 px around the doubled estimate by normalised
 *      cross-correlation on a central crop (contrast-invariant, so a blurrier slice still matches);
 *    - ends sub-pixel: a parabolic fit through the correlation at the finest level, and bilinear
 *      translation of the slice.
 */

import { displacement } from './fftTrack'
import type { Gray } from './sharpness'

export interface Shift { dx: number; dy: number; quality: number }

/** Luminance pyramid: level 0 is the input, each further level the 2×2 mean, down to ≤ `coarseW` wide. */
export function lumPyramid(g: Gray, coarseW = 410): Gray[] {
  const levels = [g]
  while (levels[levels.length - 1].width > coarseW) {
    const s = levels[levels.length - 1], w = s.width >> 1, h = s.height >> 1, d = new Float32Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = 2 * y * s.width + 2 * x
      d[y * w + x] = 0.25 * (s.data[p] + s.data[p + 1] + s.data[p + s.width] + s.data[p + s.width + 1])
    }
    levels.push({ data: d, width: w, height: h })
  }
  return levels
}

/** Full-resolution luminance of an RGBA (8-bit) or packed RGB (16-bit) image, or of float planes. */
export function luminance(data: Uint8ClampedArray | Uint16Array | [Float32Array, Float32Array, Float32Array], w: number, h: number): Gray {
  const out = new Float32Array(w * h)
  if (Array.isArray(data)) { for (let i = 0; i < out.length; i++) out[i] = 0.299 * data[0][i] + 0.587 * data[1][i] + 0.114 * data[2][i] }
  else { const s = data instanceof Uint16Array ? 3 : 4; for (let i = 0, p = 0; i < out.length; i++, p += s) out[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2] }
  return { data: out, width: w, height: h }
}

/** Normalised cross-correlation between ref and img shifted by (sx, sy) (img[x + sx] ≙ ref[x]) over a
 *  central crop of ref of at most crop×crop pixels; NaN when a plane is flat. */
function ncc(ref: Gray, img: Gray, sx: number, sy: number, crop: number): number {
  const w = ref.width, h = ref.height
  const cw = Math.min(crop, w >> 1), ch = Math.min(crop, h >> 1)
  const x0 = (w - cw) >> 1, y0 = (h - ch) >> 1
  let sr = 0, si = 0, srr = 0, sii = 0, sri = 0, n = 0
  for (let y = y0; y < y0 + ch; y++) {
    const yy = y + sy; if (yy < 0 || yy >= h) continue
    for (let x = x0; x < x0 + cw; x++) {
      const xx = x + sx; if (xx < 0 || xx >= w) continue
      const r = ref.data[y * w + x], i = img.data[yy * w + xx]
      sr += r; si += i; srr += r * r; sii += i * i; sri += r * i; n++
    }
  }
  if (!n) return NaN
  const vr = srr - sr * sr / n, vi = sii - si * si / n
  return vr > 0 && vi > 0 ? (sri - sr * si / n) / Math.sqrt(vr * vi) : NaN
}

/** Displacement of `img` relative to `ref` (pyramids from lumPyramid of equal geometry), in level-0
 *  pixels, sub-pixel. `quality` is the phase-correlation peak ratio at the coarsest level (∞ = unique
 *  peak); a shift larger than `maxFrac` of the width at the coarse level is rejected (returned as 0). */
export function alignPyramids(ref: Gray[], img: Gray[], opts: { crop?: number; maxFrac?: number; search?: number } = {}): Shift {
  const crop = opts.crop ?? 512, maxFrac = opts.maxFrac ?? 0.05, search = opts.search ?? 2
  const top = ref.length - 1
  const d = displacement(ref[top], img[top])
  let dx = 0, dy = 0
  const ok = Number.isFinite(d.quality) && d.quality > 1.15 && Math.hypot(d.dx, d.dy) < ref[top].width * maxFrac
  if (ok) { dx = Math.round(d.dx); dy = Math.round(d.dy) }
  let best = NaN
  for (let L = top; L >= 0; L--) {
    if (L !== top) { dx *= 2; dy *= 2 }
    // widen the search at the coarsest level when phase correlation found nothing usable
    const s = L === top && !ok ? search * 3 : search
    let bx = dx, by = dy; best = -Infinity
    for (let sy = dy - s; sy <= dy + s; sy++) for (let sx = dx - s; sx <= dx + s; sx++) {
      const c = ncc(ref[L], img[L], sx, sy, crop)
      if (c > best) { best = c; bx = sx; by = sy }
    }
    if (!Number.isFinite(best)) return { dx: 0, dy: 0, quality: 0 }
    dx = bx; dy = by
  }
  // parabolic sub-pixel fit through the three correlations straddling the peak, per axis
  const c0 = best, cl = ncc(ref[0], img[0], dx - 1, dy, crop), cr = ncc(ref[0], img[0], dx + 1, dy, crop)
  const ct = ncc(ref[0], img[0], dx, dy - 1, crop), cb = ncc(ref[0], img[0], dx, dy + 1, crop)
  const sub = (l: number, c: number, r: number) => { const den = l - 2 * c + r; return Number.isFinite(den) && den < -1e-12 ? Math.max(-0.5, Math.min(0.5, 0.5 * (l - r) / den)) : 0 }
  return { dx: dx + sub(cl, c0, cr), dy: dy + sub(ct, c0, cb), quality: ok ? d.quality : best }
}

/** Aligns the slices of a stack one after another, each against the previous one, and returns the
 *  cumulative shift that brings a slice into the first slice's frame (apply with translateXxxSubpixel(-dx, -dy)). */
export class SliceAligner {
  private prev: Gray[] | null = null
  private acc = { dx: 0, dy: 0 }
  constructor(private opts: { crop?: number; maxFrac?: number; coarseW?: number } = {}) {}
  /** Feed the next slice's full-resolution luminance; returns its displacement from the first slice. */
  next(lum: Gray): Shift {
    const pyr = lumPyramid(lum, this.opts.coarseW)
    let quality = Infinity
    if (this.prev) {
      const d = alignPyramids(this.prev, pyr, this.opts)
      this.acc = { dx: this.acc.dx + d.dx, dy: this.acc.dy + d.dy }; quality = d.quality
    }
    this.prev = pyr
    return { ...this.acc, quality }
  }
  reset(): void { this.prev = null; this.acc = { dx: 0, dy: 0 } }
}

/** Sub-pixel translation of an RGBA image (dx, dy shift the content; bilinear, edges replicate). */
export function translateRgbaSubpixel(src: Uint8ClampedArray, w: number, h: number, dx: number, dy: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length)
  const ix = Math.floor(dx), iy = Math.floor(dy), fx = dx - ix, fy = dy - iy
  const clampX = (x: number) => Math.min(w - 1, Math.max(0, x)), clampY = (y: number) => Math.min(h - 1, Math.max(0, y))
  for (let y = 0; y < h; y++) {
    const r0 = clampY(y - iy) * w, r1 = clampY(y - iy - 1) * w
    for (let x = 0; x < w; x++) {
      const c0 = clampX(x - ix), c1 = clampX(x - ix - 1)
      const p00 = (r0 + c0) * 4, p01 = (r0 + c1) * 4, p10 = (r1 + c0) * 4, p11 = (r1 + c1) * 4, d = (y * w + x) * 4
      for (let k = 0; k < 3; k++) out[d + k] = (src[p00 + k] * (1 - fx) + src[p01 + k] * fx) * (1 - fy) + (src[p10 + k] * (1 - fx) + src[p11 + k] * fx) * fy
      out[d + 3] = 255
    }
  }
  return out
}

/** Sub-pixel translation of float planes (same convention as translateRgbaSubpixel). */
export function translatePlanesSubpixel(planes: [Float32Array, Float32Array, Float32Array], w: number, h: number, dx: number, dy: number): [Float32Array, Float32Array, Float32Array] {
  if (!dx && !dy) return planes
  const ix = Math.floor(dx), iy = Math.floor(dy), fx = dx - ix, fy = dy - iy
  const clampX = (x: number) => Math.min(w - 1, Math.max(0, x)), clampY = (y: number) => Math.min(h - 1, Math.max(0, y))
  return planes.map((src) => {
    const out = new Float32Array(src.length)
    for (let y = 0; y < h; y++) {
      const r0 = clampY(y - iy) * w, r1 = clampY(y - iy - 1) * w
      for (let x = 0; x < w; x++) {
        const c0 = clampX(x - ix), c1 = clampX(x - ix - 1)
        out[y * w + x] = (src[r0 + c0] * (1 - fx) + src[r0 + c1] * fx) * (1 - fy) + (src[r1 + c0] * (1 - fx) + src[r1 + c1] * fx) * fy
      }
    }
    return out
  }) as [Float32Array, Float32Array, Float32Array]
}
