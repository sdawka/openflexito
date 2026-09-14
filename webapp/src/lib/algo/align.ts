/** Sub-pixel alignment of focus-stack slices.
 *
 *  A z move on a flexure stage shifts the image a little, and every slice of a focus stack has a
 *  different amount of defocus. The previous alignment correlated each slice against the first (the
 *  most defocused one) on a ≤410 px luminance and rounded to whole pixels: at full resolution that
 *  is a ±4 px error even when the correlation was good, and correlating a sharp slice against a
 *  badly defocused one often is not. This module instead
 *    - chains: each slice is aligned to its neighbour (similar defocus, strong correlation) and the
 *      shifts are accumulated, so every slice ends up in one common frame;
 *    - refines coarse-to-fine: phase correlation on the coarsest pyramid level finds the shift to
 *      the pixel there; each finer level searches ±2 px around the doubled estimate by normalised
 *      cross-correlation on a central crop (contrast-invariant, so a blurrier slice still matches);
 *    - ends sub-pixel: a parabolic fit through the correlation at the finest level, then a
 *      translation of the slice.
 *
 *  Reference frame: the common frame is that of a *reference* slice (`chooseReference`: the middle
 *  slice, or the sharpest by Laplacian energy), never slice 0. Slice 0 is the bottom of the stack
 *  and usually the most defocused, and with it as the reference every sharper slice was resampled.
 *  The chain still runs neighbour to neighbour; the shifts are re-expressed relative to the
 *  reference (`alignStack`, or `SliceAligner.relativeTo`), which is the same as chaining outward
 *  from the reference in both directions.
 *
 *  Resampling: bilinear interpolation at a half-pixel shift is a [½,½] box (MTF 0 at Nyquist, ≈0.7
 *  at half Nyquist), which softens exactly the sharp slices a stack should keep. The default for
 *  stacking is therefore a separable Lanczos-3 kernel (`'lanczos3'`); `'bilinear'` remains for the
 *  live paths where speed matters more than the last bit of MTF.
 *
 *  Similarity (scale + translation) alignment is available as an OPTIONAL path (`alignSimilarity`,
 *  `scaleImage`), off by default: it estimates the magnification change between two slices by a
 *  coarse-to-fine NCC search over scale factors around 1 and refines the translation at each scale.
 *  Whether focus breathing on the OpenFlexure is large enough to need it is unmeasured.
 */

import { displacement } from './fftTrack'
import type { Gray } from './sharpness'

export interface Shift { dx: number; dy: number; quality: number }
export type Resample = 'bilinear' | 'lanczos3'

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

/** Mean squared 4-neighbour Laplacian of a greyscale image: the sharpness figure used to pick the
 *  reference slice (the same quantity the fusers select on, so "sharpest" means "most fine detail"). */
export function laplacianEnergy(g: Gray): number {
  const { data, width: w, height: h } = g
  let s = 0, n = 0
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, l = 4 * data[i] - data[i - 1] - data[i + 1] - data[i - w] - data[i + w]
    s += l * l; n++
  }
  return n ? s / n : 0
}

/** Which slice the others are aligned to: the middle one (default, known before any pixel is seen,
 *  so streaming callers can use it) or the sharpest by Laplacian energy. */
export function chooseReference(count: number, mode: 'middle' | 'sharpest' = 'middle', lums?: Gray[]): number {
  if (count <= 0) return 0
  if (mode === 'sharpest' && lums && lums.length === count) {
    let best = 0, bestE = -Infinity
    lums.forEach((g, i) => { const e = laplacianEnergy(g); if (e > bestE) { bestE = e; best = i } })
    return best
  }
  return count >> 1
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
 *  cumulative shift that brings a slice into the first slice's frame (apply with translateXxxSubpixel(-dx, -dy)).
 *  `relativeTo(i, r)` re-expresses a recorded slice's shift in the frame of slice `r` (the reference),
 *  so a streaming caller can chain in arrival order and still resample everything into the middle
 *  slice's frame once that slice has been seen. */
export class SliceAligner {
  private prev: Gray[] | null = null
  private acc = { dx: 0, dy: 0 }
  private history: Shift[] = []
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
    const s = { ...this.acc, quality }
    this.history.push(s)
    return s
  }
  /** Shift of slice `i` relative to slice `r` (both already fed): apply translate(-dx, -dy) to bring i into r's frame. */
  relativeTo(i: number, r: number): Shift {
    const a = this.history[i], b = this.history[r]
    if (!a || !b) throw new Error(`SliceAligner: slice ${!a ? i : r} not aligned yet`)
    return { dx: a.dx - b.dx, dy: a.dy - b.dy, quality: a.quality }
  }
  get count(): number { return this.history.length }
  reset(): void { this.prev = null; this.acc = { dx: 0, dy: 0 }; this.history = [] }
}

/** Align a whole stack (luminances of every slice) to the reference slice, chaining outward from it
 *  in both directions: slice r±1 is correlated against r, r±2 against r±1, and so on, so every pair
 *  correlated has similar defocus. Returns, per slice, its displacement from the reference (the
 *  reference itself gets 0): apply translate(-dx, -dy) to bring the slice into the reference frame. */
export function alignStack(lums: Gray[], reference: number, opts: { crop?: number; maxFrac?: number; coarseW?: number } = {}): Shift[] {
  const n = lums.length
  const out: Shift[] = lums.map(() => ({ dx: 0, dy: 0, quality: Infinity }))
  if (n === 0) return out
  const r = Math.min(n - 1, Math.max(0, reference))
  let prev = lumPyramid(lums[r], opts.coarseW)
  for (let i = r + 1; i < n; i++) {
    const pyr = lumPyramid(lums[i], opts.coarseW), d = alignPyramids(prev, pyr, opts)
    out[i] = { dx: out[i - 1].dx + d.dx, dy: out[i - 1].dy + d.dy, quality: d.quality }
    prev = pyr
  }
  prev = lumPyramid(lums[r], opts.coarseW)
  for (let i = r - 1; i >= 0; i--) {
    const pyr = lumPyramid(lums[i], opts.coarseW), d = alignPyramids(prev, pyr, opts)
    out[i] = { dx: out[i + 1].dx + d.dx, dy: out[i + 1].dy + d.dy, quality: d.quality }
    prev = pyr
  }
  return out
}

// ---- resampling ------------------------------------------------------------------------------------

function lanczos3(t: number): number {
  const a = Math.abs(t)
  if (a < 1e-6) return 1
  if (a >= 3) return 0
  const pt = Math.PI * t
  return 3 * Math.sin(pt) * Math.sin(pt / 3) / (pt * pt)
}

/** Six Lanczos-3 taps for a fractional source offset: the source sample index for output x is
 *  `x - int + k` (k = -2..3) with weight `w[k+2]`; weights are normalised to sum 1. For an integer
 *  shift the taps reduce to a single 1 (exact copy). */
function lanczosTaps(shift: number): { int: number; w: Float64Array } {
  // output x reads source u = x - shift; u = floor(u) + frac
  const fl = Math.floor(-shift), frac = -shift - fl
  const w = new Float64Array(6)
  let s = 0
  for (let k = -2; k <= 3; k++) { const v = lanczos3(frac - k); w[k + 2] = v; s += v }
  for (let k = 0; k < 6; k++) w[k] /= s
  return { int: fl, w }
}

/** Sub-pixel translation of an interleaved float image with `ch` channels (dx, dy shift the content
 *  so that out(x, y) = src(x − dx, y − dy); edges replicate). Separable: rows then columns. */
export function translateFloat(src: Float32Array, w: number, h: number, ch: number, dx: number, dy: number, method: Resample = 'bilinear'): Float32Array {
  if (!dx && !dy) return src
  const n = w * h * ch
  if (method === 'bilinear') {
    const out = new Float32Array(n)
    const ix = Math.floor(dx), iy = Math.floor(dy), fx = dx - ix, fy = dy - iy
    const clampX = (x: number) => Math.min(w - 1, Math.max(0, x)), clampY = (y: number) => Math.min(h - 1, Math.max(0, y))
    for (let y = 0; y < h; y++) {
      const r0 = clampY(y - iy) * w, r1 = clampY(y - iy - 1) * w
      for (let x = 0; x < w; x++) {
        const c0 = clampX(x - ix), c1 = clampX(x - ix - 1)
        const p00 = (r0 + c0) * ch, p01 = (r0 + c1) * ch, p10 = (r1 + c0) * ch, p11 = (r1 + c1) * ch, d = (y * w + x) * ch
        for (let k = 0; k < ch; k++) out[d + k] = (src[p00 + k] * (1 - fx) + src[p01 + k] * fx) * (1 - fy) + (src[p10 + k] * (1 - fx) + src[p11 + k] * fx) * fy
      }
    }
    return out
  }
  // Lanczos-3, separable
  const tx = lanczosTaps(dx), ty = lanczosTaps(dy)
  let cur = src
  if (dx) {
    const tmp = new Float32Array(n)
    const idx = new Int32Array(w * 6)
    for (let x = 0; x < w; x++) for (let k = 0; k < 6; k++) idx[x * 6 + k] = Math.min(w - 1, Math.max(0, x + tx.int + k - 2))
    for (let y = 0; y < h; y++) {
      const row = y * w
      for (let x = 0; x < w; x++) {
        const d = (row + x) * ch, b = x * 6
        for (let c = 0; c < ch; c++) {
          let s = 0
          for (let k = 0; k < 6; k++) s += tx.w[k] * cur[(row + idx[b + k]) * ch + c]
          tmp[d + c] = s
        }
      }
    }
    cur = tmp
  }
  if (dy) {
    const out = new Float32Array(n)
    const rows = new Int32Array(6)
    for (let y = 0; y < h; y++) {
      for (let k = 0; k < 6; k++) rows[k] = Math.min(h - 1, Math.max(0, y + ty.int + k - 2)) * w
      for (let x = 0; x < w; x++) {
        const d = (y * w + x) * ch
        for (let c = 0; c < ch; c++) {
          let s = 0
          for (let k = 0; k < 6; k++) s += ty.w[k] * cur[(rows[k] + x) * ch + c]
          out[d + c] = s
        }
      }
    }
    cur = out
  }
  return cur
}

/** Sub-pixel translation of an RGBA image (dx, dy shift the content; edges replicate). */
export function translateRgbaSubpixel(src: Uint8ClampedArray, w: number, h: number, dx: number, dy: number, method: Resample = 'bilinear'): Uint8ClampedArray {
  const out = new Uint8ClampedArray(src.length)
  if (method === 'bilinear') {
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
  const f = new Float32Array(w * h * 3)
  for (let i = 0, p = 0, q = 0; i < w * h; i++, p += 4, q += 3) { f[q] = src[p]; f[q + 1] = src[p + 1]; f[q + 2] = src[p + 2] }
  const t = translateFloat(f, w, h, 3, dx, dy, 'lanczos3')
  for (let i = 0, p = 0, q = 0; i < w * h; i++, p += 4, q += 3) { out[p] = t[q]; out[p + 1] = t[q + 1]; out[p + 2] = t[q + 2]; out[p + 3] = 255 }
  return out
}

/** Sub-pixel translation of float planes (same convention as translateRgbaSubpixel). */
export function translatePlanesSubpixel(planes: [Float32Array, Float32Array, Float32Array], w: number, h: number, dx: number, dy: number, method: Resample = 'bilinear'): [Float32Array, Float32Array, Float32Array] {
  if (!dx && !dy) return planes
  return planes.map((src) => translateFloat(src, w, h, 1, dx, dy, method)) as [Float32Array, Float32Array, Float32Array]
}

// ---- optional similarity (scale + translation) alignment -------------------------------------------

export interface Similarity { scale: number; dx: number; dy: number; quality: number }

/** Resample a greyscale image scaled by `s` about the image centre (bilinear; content magnified for
 *  s > 1; edges replicate). Used to test scale hypotheses and to undo focus breathing. */
export function scaleGray(g: Gray, s: number): Gray {
  if (s === 1) return g
  const { width: w, height: h, data } = g, out = new Float32Array(w * h)
  const cx = (w - 1) / 2, cy = (h - 1) / 2
  for (let y = 0; y < h; y++) {
    const sy = Math.min(h - 1, Math.max(0, cy + (y - cy) / s)), y0 = Math.floor(sy), y1 = Math.min(h - 1, y0 + 1), ty = sy - y0
    for (let x = 0; x < w; x++) {
      const sx = Math.min(w - 1, Math.max(0, cx + (x - cx) / s)), x0 = Math.floor(sx), x1 = Math.min(w - 1, x0 + 1), tx = sx - x0
      out[y * w + x] = (data[y0 * w + x0] * (1 - tx) + data[y0 * w + x1] * tx) * (1 - ty) + (data[y1 * w + x0] * (1 - tx) + data[y1 * w + x1] * tx) * ty
    }
  }
  return { data: out, width: w, height: h }
}

/** Scale (about the centre) and translate an interleaved float image: out(x) = src((x − c)/s + c − d). */
export function scaleTranslateFloat(src: Float32Array, w: number, h: number, ch: number, s: number, dx: number, dy: number): Float32Array {
  if (s === 1) return translateFloat(src, w, h, ch, dx, dy, 'lanczos3')
  const out = new Float32Array(src.length), cx = (w - 1) / 2, cy = (h - 1) / 2
  for (let y = 0; y < h; y++) {
    const sy = Math.min(h - 1, Math.max(0, cy + (y - dy - cy) / s)), y0 = Math.floor(sy), y1 = Math.min(h - 1, y0 + 1), ty = sy - y0
    for (let x = 0; x < w; x++) {
      const sx = Math.min(w - 1, Math.max(0, cx + (x - dx - cx) / s)), x0 = Math.floor(sx), x1 = Math.min(w - 1, x0 + 1), tx = sx - x0
      const d = (y * w + x) * ch, p00 = (y0 * w + x0) * ch, p01 = (y0 * w + x1) * ch, p10 = (y1 * w + x0) * ch, p11 = (y1 * w + x1) * ch
      for (let c = 0; c < ch; c++) out[d + c] = (src[p00 + c] * (1 - tx) + src[p01 + c] * tx) * (1 - ty) + (src[p10 + c] * (1 - tx) + src[p11 + c] * tx) * ty
    }
  }
  return out
}

/** NCC over the *whole* frame (scale differences show at the edges, which the central crop of the
 *  translation refinement ignores on purpose). Sub-sampled by `step` for speed. */
function nccFull(a: Gray, b: Gray, step: number): number {
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, n = 0
  for (let y = 0; y < a.height; y += step) for (let x = 0; x < a.width; x += step) {
    const i = y * a.width + x, p = a.data[i], q = b.data[i]
    sa += p; sb += q; saa += p * p; sbb += q * q; sab += p * q; n++
  }
  const va = saa - sa * sa / n, vb = sbb - sb * sb / n
  return va > 0 && vb > 0 ? (sab - sa * sb / n) / Math.sqrt(va * vb) : NaN
}

/** Estimate the similarity transform (isotropic scale about the centre, then translation) that maps
 *  `img` onto `ref`: `img` ≈ scaleTranslate(ref, 1/scale, ...) i.e. `img` is magnified by `scale`
 *  relative to `ref` and shifted by (dx, dy) in ref pixels. Coarse-to-fine: on a ≤`coarseW` luminance
 *  the scale is searched over ±`maxScale` in `steps` and refined twice around the best (each time a
 *  third of the previous step), the translation being re-estimated by phase correlation for every
 *  candidate. Off by default in the stack pipelines; intended for focus breathing once measured. */
export function alignSimilarity(ref: Gray, img: Gray, opts: { maxScale?: number; steps?: number; coarseW?: number } = {}): Similarity {
  const maxScale = opts.maxScale ?? 0.03, steps = opts.steps ?? 7, coarseW = opts.coarseW ?? 410
  const rp = lumPyramid(ref, coarseW), ip = lumPyramid(img, coarseW)
  const r = rp[rp.length - 1], i = ip[ip.length - 1], f = ref.width / r.width
  const evaluate = (s: number): Similarity => {
    const scaled = scaleGray(i, 1 / s)             // undo the hypothesised magnification
    const d = displacement(r, scaled)
    const ok = Number.isFinite(d.quality) && d.quality > 1.15
    const dx = ok ? d.dx : 0, dy = ok ? d.dy : 0
    const back = { data: translateFloat(scaled.data, r.width, r.height, 1, -dx, -dy, 'bilinear'), width: r.width, height: r.height }
    const q = nccFull(r, back, 2)
    return { scale: s, dx: dx * f, dy: dy * f, quality: Number.isFinite(q) ? q : -1 }
  }
  let lo = 1 - maxScale, hi = 1 + maxScale, best: Similarity = { scale: 1, dx: 0, dy: 0, quality: -Infinity }
  for (let round = 0; round < 3; round++) {
    const step = (hi - lo) / (steps - 1)
    for (let k = 0; k < steps; k++) {
      const c = evaluate(lo + k * step)
      if (c.quality > best.quality) best = c
    }
    lo = best.scale - step; hi = best.scale + step
  }
  // translation at full resolution given the scale: undo the scale, then the usual pyramid refinement
  const undone = scaleGray(img, 1 / best.scale)
  const t = alignPyramids(lumPyramid(ref, coarseW), lumPyramid(undone, coarseW))
  return { scale: best.scale, dx: t.dx, dy: t.dy, quality: best.quality }
}
