/** Enhancement toolbox (`docs/image-pipeline/design.md` WP3): local contrast (CLAHE), sharpening,
 *  microscopy-specific corrections (pseudo-flat-field, vignette, chromatic aberration, colour
 *  deconvolution) and tone/colour adjustments. Multi-channel functions take/return `RgbPlanes`
 *  (re-exported from `exposureFuse.ts`, the same planar float-RGB type `rawdev`/`stack`/`hdr` already
 *  share); single-channel ones take/return a `Plane` (from `denoise.ts`, itself re-exporting
 *  `exposureFuse.ts`'s `Plane`) so `pipeline.ts` can run them directly on a luma or stain plane. */

import type { RgbPlanes } from './exposureFuse'
import type { Plane } from './denoise'
import { boxFilter, gaussianBlur, guidedFilter } from './denoise'

export type { RgbPlanes, Plane }

// ---------------------------------------------------------------------------------------------
// YCbCr <-> RGB (float planes, Rec.601-style, matching denoise.ts's internal split)
// ---------------------------------------------------------------------------------------------

export function rgbToYcbcr(planes: RgbPlanes): { y: Plane; cb: Plane; cr: Plane } {
  const { r, g, b, width, height } = planes
  const n = width * height
  const y = new Float32Array(n), cb = new Float32Array(n), cr = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const R = r[i], G = g[i], B = b[i]
    y[i] = 0.299 * R + 0.587 * G + 0.114 * B
    cb[i] = -0.168736 * R - 0.331264 * G + 0.5 * B
    cr[i] = 0.5 * R - 0.418688 * G - 0.081312 * B
  }
  return { y: { data: y, width, height }, cb: { data: cb, width, height }, cr: { data: cr, width, height } }
}

export function ycbcrToRgb(ycbcr: { y: Plane; cb: Plane; cr: Plane }): RgbPlanes {
  const { y, cb, cr } = ycbcr
  const { width, height } = y
  const n = width * height
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const Y = y.data[i], Cb = cb.data[i], Cr = cr.data[i]
    r[i] = Y + 1.402 * Cr
    g[i] = Y - 0.344136 * Cb - 0.714136 * Cr
    b[i] = Y + 1.772 * Cb
  }
  return { r, g, b, width, height }
}

// ---------------------------------------------------------------------------------------------
// Local contrast: CLAHE (Zuiderveld 1994)
// ---------------------------------------------------------------------------------------------

function identityMap(bins: number): Float32Array {
  const m = new Float32Array(bins)
  for (let i = 0; i < bins; i++) m[i] = (i + 0.5) / bins
  return m
}

/** Contrast-Limited Adaptive Histogram Equalization on a luminance plane (0..1 float). Splits the
 *  plane into `tiles`x`tiles` cells, equalises each cell's clipped histogram (`clip` as a fraction of
 *  the tile's pixel count per bin — excess above the clip is redistributed uniformly across all bins,
 *  the classic Zuiderveld clip-limit redistribution), then bilinearly interpolates between the four
 *  nearest tile mappings per pixel so no tile-boundary seams appear. */
export function clahe(luma: Plane, o: { tiles: number; clip: number; bins?: number }): Plane {
  const { data, width: w, height: h } = luma
  const tiles = Math.max(1, Math.round(o.tiles))
  const bins = o.bins ?? 256
  const tileW = w / tiles, tileH = h / tiles
  const maps: Float32Array[] = []
  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      const x0 = Math.floor(tx * tileW), x1 = Math.max(x0 + 1, Math.floor((tx + 1) * tileW))
      const y0 = Math.floor(ty * tileH), y1 = Math.max(y0 + 1, Math.floor((ty + 1) * tileH))
      const hist = new Float64Array(bins)
      let count = 0
      for (let y = y0; y < Math.min(h, y1); y++) for (let x = x0; x < Math.min(w, x1); x++) {
        const v = Math.min(1, Math.max(0, data[y * w + x]))
        hist[Math.min(bins - 1, Math.floor(v * bins))]++
        count++
      }
      if (count === 0) { maps.push(identityMap(bins)); continue }
      const clipCount = Math.max(1, o.clip * count / bins)
      let excess = 0
      for (let i = 0; i < bins; i++) if (hist[i] > clipCount) { excess += hist[i] - clipCount; hist[i] = clipCount }
      const redistribute = excess / bins
      for (let i = 0; i < bins; i++) hist[i] += redistribute
      const map = new Float32Array(bins)
      let cum = 0
      for (let i = 0; i < bins; i++) { cum += hist[i]; map[i] = cum / count }
      maps.push(map)
    }
  }
  const sample = (tileIdx: number, v: number): number => maps[tileIdx][Math.min(bins - 1, Math.max(0, Math.floor(v * bins)))]
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const tyF = (y - tileH / 2) / tileH
    const ty0u = Math.floor(tyF), fty = tyF - ty0u
    const ty0 = Math.min(tiles - 1, Math.max(0, ty0u)), ty1 = Math.min(tiles - 1, Math.max(0, ty0u + 1))
    for (let x = 0; x < w; x++) {
      const txF = (x - tileW / 2) / tileW
      const tx0u = Math.floor(txF), ftx = txF - tx0u
      const tx0 = Math.min(tiles - 1, Math.max(0, tx0u)), tx1 = Math.min(tiles - 1, Math.max(0, tx0u + 1))
      const v = Math.min(1, Math.max(0, data[y * w + x]))
      const m00 = sample(ty0 * tiles + tx0, v), m10 = sample(ty0 * tiles + tx1, v)
      const m01 = sample(ty1 * tiles + tx0, v), m11 = sample(ty1 * tiles + tx1, v)
      const top = m00 * (1 - ftx) + m10 * ftx, bot = m01 * (1 - ftx) + m11 * ftx
      out[y * w + x] = top * (1 - fty) + bot * fty
    }
  }
  return { data: out, width: w, height: h }
}

// ---------------------------------------------------------------------------------------------
// Sharpening
// ---------------------------------------------------------------------------------------------

/** Classic unsharp mask: `out = p + amount * detail` where `detail = p - gaussianBlur(p, radius)`,
 *  zeroed wherever `|detail| < threshold` (so flat noisy regions are not boosted). */
export function unsharpMask(p: Plane, o: { radius: number; amount: number; threshold: number }): Plane {
  const blurred = gaussianBlur(p, o.radius)
  const out = new Float32Array(p.data.length)
  for (let i = 0; i < out.length; i++) {
    const detail = p.data[i] - blurred.data[i]
    out[i] = p.data[i] + (Math.abs(detail) >= o.threshold ? detail * o.amount : 0)
  }
  return { data: out, width: p.width, height: p.height }
}

/** Guided-filter high-pass sharpen (halo-free unsharp variant): the "blur" is a self-guided edge-aware
 *  smooth (`guidedFilter(p, p, radius, eps)`) instead of a Gaussian, so detail boosted near a strong
 *  edge does not ring past the edge the way a Gaussian-based unsharp mask can. */
export function edgeAwareSharpen(p: Plane, o: { radius: number; amount: number; eps: number }): Plane {
  const base = guidedFilter(p, p, o.radius, o.eps)
  const out = new Float32Array(p.data.length)
  for (let i = 0; i < out.length; i++) out[i] = p.data[i] + (p.data[i] - base.data[i]) * o.amount
  return { data: out, width: p.width, height: p.height }
}

// ---------------------------------------------------------------------------------------------
// Auto-levels (percentile stretch)
// ---------------------------------------------------------------------------------------------

function percentileClip(data: Float32Array, lowPct: number, highPct: number): [number, number] {
  const sorted = Float32Array.from(data).sort()
  const n = sorted.length
  if (n === 0) return [0, 1]
  const lo = sorted[Math.min(n - 1, Math.max(0, Math.floor((lowPct / 100) * n)))]
  const hi = sorted[Math.min(n - 1, Math.max(0, Math.floor((highPct / 100) * n)))]
  return [lo, hi]
}

/** Percentile black/white point stretch. `perChannel: true` clips each channel independently (can
 *  shift colour balance); `false` derives one black/white point from luma and applies it to all three
 *  channels (preserves colour balance, the usual default). */
export function autoLevels(planes: RgbPlanes, o: { lowPct: number; highPct: number; perChannel: boolean }): RgbPlanes {
  const { r, g, b, width, height } = planes
  const stretch = (arr: Float32Array, lo: number, hi: number): Float32Array => {
    const span = Math.max(1e-6, hi - lo)
    const out = new Float32Array(arr.length)
    for (let i = 0; i < arr.length; i++) out[i] = Math.min(1, Math.max(0, (arr[i] - lo) / span))
    return out
  }
  if (o.perChannel) {
    const [rl, rh] = percentileClip(r, o.lowPct, o.highPct)
    const [gl, gh] = percentileClip(g, o.lowPct, o.highPct)
    const [bl, bh] = percentileClip(b, o.lowPct, o.highPct)
    return { r: stretch(r, rl, rh), g: stretch(g, gl, gh), b: stretch(b, bl, bh), width, height }
  }
  const n = width * height
  const luma = new Float32Array(n)
  for (let i = 0; i < n; i++) luma[i] = 0.299 * r[i] + 0.587 * g[i] + 0.114 * b[i]
  const [lo, hi] = percentileClip(luma, o.lowPct, o.highPct)
  return { r: stretch(r, lo, hi), g: stretch(g, lo, hi), b: stretch(b, lo, hi), width, height }
}

// ---------------------------------------------------------------------------------------------
// Pseudo-flat-field, vignette, chromatic aberration
// ---------------------------------------------------------------------------------------------

function downscalePlane(p: Plane, factor: number): Plane {
  const w2 = Math.max(1, Math.round(p.width / factor)), h2 = Math.max(1, Math.round(p.height / factor))
  const sum = new Float32Array(w2 * h2), cnt = new Int32Array(w2 * h2)
  for (let y = 0; y < p.height; y++) {
    const ty = Math.min(h2 - 1, Math.floor((y * h2) / p.height))
    for (let x = 0; x < p.width; x++) {
      const tx = Math.min(w2 - 1, Math.floor((x * w2) / p.width))
      sum[ty * w2 + tx] += p.data[y * p.width + x]; cnt[ty * w2 + tx]++
    }
  }
  const out = new Float32Array(w2 * h2)
  for (let i = 0; i < out.length; i++) out[i] = cnt[i] ? sum[i] / cnt[i] : 0
  return { data: out, width: w2, height: h2 }
}
function upscalePlane(p: Plane, width: number, height: number): Plane {
  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const fy = Math.min(p.height - 1, Math.max(0, ((y + 0.5) * p.height) / height - 0.5))
    const y0 = Math.floor(fy), y1 = Math.min(p.height - 1, y0 + 1), ty = fy - y0
    for (let x = 0; x < width; x++) {
      const fx = Math.min(p.width - 1, Math.max(0, ((x + 0.5) * p.width) / width - 0.5))
      const x0 = Math.floor(fx), x1 = Math.min(p.width - 1, x0 + 1), tx = fx - x0
      out[y * width + x] = (p.data[y0 * p.width + x0] * (1 - tx) + p.data[y0 * p.width + x1] * tx) * (1 - ty)
        + (p.data[y1 * p.width + x0] * (1 - tx) + p.data[y1 * p.width + x1] * tx) * ty
    }
  }
  return { data: out, width, height }
}

/** Divides by a large-sigma Gaussian low-pass of the luma (normalised to keep the mean brightness),
 *  the cheap "pseudo-flat-field" alternative to a measured flat when uneven illumination is gentle.
 *  For speed the blur runs on a downscaled copy (sigma capped per octave, since a 100+ px Gaussian on
 *  a full-res plane is wasteful when the result is upsampled back to the same blur radius) and is
 *  bilinearly upsampled back to full resolution before dividing. */
export function pseudoFlatField(planes: RgbPlanes, sigma: number): RgbPlanes {
  const { r, g, b, width, height } = planes
  const n = width * height
  const luma = new Float32Array(n)
  for (let i = 0; i < n; i++) luma[i] = 0.299 * r[i] + 0.587 * g[i] + 0.114 * b[i]
  const down = Math.max(1, Math.min(8, Math.round(sigma / 8)))
  let work: Plane = { data: luma, width, height }
  if (down > 1) work = downscalePlane(work, down)
  const blurredSmall = gaussianBlur(work, Math.max(1, sigma / down))
  const blurred = down > 1 ? upscalePlane(blurredSmall, width, height) : blurredSmall
  let meanIllum = 0
  for (let i = 0; i < n; i++) meanIllum += blurred.data[i]
  meanIllum /= n
  const outR = new Float32Array(n), outG = new Float32Array(n), outB = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const gain = meanIllum / Math.max(1e-6, blurred.data[i])
    outR[i] = r[i] * gain; outG[i] = g[i] * gain; outB[i] = b[i] * gain
  }
  return { r: outR, g: outG, b: outB, width, height }
}

/** Divides by a polynomial radial vignette model `1 + a*r^2 + b*r^4 + c*r^6`, `r` normalised to the
 *  half-diagonal from the (optionally off-centre) optical axis. */
export function vignetteCorrect(planes: RgbPlanes, o: { a: number; b: number; c: number; cx?: number; cy?: number }): RgbPlanes {
  const { r, g, b, width, height } = planes
  const cx = o.cx ?? width / 2, cy = o.cy ?? height / 2
  const halfDiag = Math.sqrt(cx * cx + cy * cy) || 1
  const n = width * height
  const outR = new Float32Array(n), outG = new Float32Array(n), outB = new Float32Array(n)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const dx = (x - cx) / halfDiag, dy = (y - cy) / halfDiag
      const r2 = dx * dx + dy * dy
      const vig = 1 + o.a * r2 + o.b * r2 * r2 + o.c * r2 * r2 * r2
      const gain = 1 / Math.max(1e-6, vig)
      outR[i] = r[i] * gain; outG[i] = g[i] * gain; outB[i] = b[i] * gain
    }
  }
  return { r: outR, g: outG, b: outB, width, height }
}

function resampleRadial(plane: Float32Array, width: number, height: number, cx: number, cy: number, halfDiag: number, k: number): Float32Array {
  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - cx, dy = y - cy
      const r = Math.sqrt(dx * dx + dy * dy) / halfDiag
      const scale = 1 + k * r * r
      const sx = cx + dx / scale, sy = cy + dy / scale
      const x0 = Math.floor(sx), tx = sx - x0, y0 = Math.floor(sy), ty = sy - y0
      const cx0 = Math.min(width - 1, Math.max(0, x0)), cx1 = Math.min(width - 1, Math.max(0, x0 + 1))
      const cy0 = Math.min(height - 1, Math.max(0, y0)), cy1 = Math.min(height - 1, Math.max(0, y0 + 1))
      const v = (plane[cy0 * width + cx0] * (1 - tx) + plane[cy0 * width + cx1] * tx) * (1 - ty)
        + (plane[cy1 * width + cx0] * (1 - tx) + plane[cy1 * width + cx1] * tx) * ty
      out[y * width + x] = v
    }
  }
  return out
}

/** Lateral chromatic-aberration correction: resamples R and B radially by `1/(1+k*r^2)` (a channel
 *  expanded outward by CA is pulled back toward the optical axis), G left untouched as the reference
 *  channel. `o.red`/`o.blue` are the per-channel `k` coefficients (positive corrects outward CA). */
export function chromaticAberration(planes: RgbPlanes, o: { red: number; blue: number }): RgbPlanes {
  const { r, g, b, width, height } = planes
  const cx = width / 2, cy = height / 2
  const halfDiag = Math.sqrt(cx * cx + cy * cy) || 1
  const outR = o.red !== 0 ? resampleRadial(r, width, height, cx, cy, halfDiag, o.red) : r.slice()
  const outB = o.blue !== 0 ? resampleRadial(b, width, height, cx, cy, halfDiag, o.blue) : b.slice()
  return { r: outR, g: g.slice(), b: outB, width, height }
}

// ---------------------------------------------------------------------------------------------
// Colour deconvolution (Ruifrok & Johnston 2001)
// ---------------------------------------------------------------------------------------------

type Vec3 = [number, number, number]
const STAIN_HE: Vec3[] = [
  [0.650, 0.704, 0.286],  // haematoxylin
  [0.072, 0.990, 0.105],  // eosin
  [0.268, 0.570, 0.776],  // residual/background
]
const STAIN_HDAB_BASE: [Vec3, Vec3] = [
  [0.650, 0.704, 0.286],  // haematoxylin
  [0.268, 0.570, 0.776],  // DAB
]

function normalizeVec(v: Vec3): Vec3 {
  const n = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) || 1
  return [v[0] / n, v[1] / n, v[2] / n]
}
function crossNormalize(a: Vec3, b: Vec3): Vec3 {
  return normalizeVec([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]])
}
function invert3x3(m: number[][]): number[][] {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2]
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  const invDet = 1 / (det || 1e-12)
  return [
    [(e * i - f * h) * invDet, (c * h - b * i) * invDet, (b * f - c * e) * invDet],
    [(f * g - d * i) * invDet, (a * i - c * g) * invDet, (c * d - a * f) * invDet],
    [(d * h - e * g) * invDet, (b * g - a * h) * invDet, (a * e - b * d) * invDet],
  ]
}
function stainVectors(stains: 'he' | 'hdab' | [Vec3, Vec3, Vec3]): Vec3[] {
  if (stains === 'he') return STAIN_HE.map(normalizeVec)
  if (stains === 'hdab') {
    const h = normalizeVec(STAIN_HDAB_BASE[0]), d = normalizeVec(STAIN_HDAB_BASE[1])
    return [h, d, crossNormalize(h, d)]
  }
  return stains.map(normalizeVec)
}

/** Ruifrok & Johnston (2001) colour deconvolution: models optical density `OD = -log10(I)` (I is the
 *  0..1 reflectance, background = white = 1 = OD 0) as a linear mix of up to three stain vectors, and
 *  solves the per-pixel 3x3 system for the stain concentrations. `'he'` (haematoxylin/eosin) and
 *  `'hdab'` (haematoxylin/DAB) use the standard published vectors (the third, unstained "residual"
 *  vector for `'hdab'` is derived as the cross product of the other two, the usual convention when
 *  only two stains are physically present); a custom triple of unit-ish RGB vectors is also accepted. */
export function colourDeconvolve(rgb: RgbPlanes, stains: 'he' | 'hdab' | [Vec3, Vec3, Vec3]): { c1: Plane; c2: Plane; c3: Plane } {
  const vecs = stainVectors(stains)
  const A = [
    [vecs[0][0], vecs[1][0], vecs[2][0]],
    [vecs[0][1], vecs[1][1], vecs[2][1]],
    [vecs[0][2], vecs[1][2], vecs[2][2]],
  ]
  const Ainv = invert3x3(A)
  const { r, g, b, width, height } = rgb
  const n = width * height
  const c1 = new Float32Array(n), c2 = new Float32Array(n), c3 = new Float32Array(n)
  const EPS = 1e-4
  for (let i = 0; i < n; i++) {
    const odR = -Math.log10(Math.max(EPS, r[i])), odG = -Math.log10(Math.max(EPS, g[i])), odB = -Math.log10(Math.max(EPS, b[i]))
    c1[i] = Ainv[0][0] * odR + Ainv[0][1] * odG + Ainv[0][2] * odB
    c2[i] = Ainv[1][0] * odR + Ainv[1][1] * odG + Ainv[1][2] * odB
    c3[i] = Ainv[2][0] * odR + Ainv[2][1] * odG + Ainv[2][2] * odB
  }
  return { c1: { data: c1, width, height }, c2: { data: c2, width, height }, c3: { data: c3, width, height } }
}

/** Rebuilds an RGB image from a subset of `colourDeconvolve`'s stain concentrations (e.g. haematoxylin
 *  only for an "H channel" view): re-mixes OD from the selected stains' vectors and inverts through
 *  `I = 10^-OD`. `select` corresponds to `[c1, c2, c3]`. */
export function stainRecolour(
  c: { c1: Plane; c2: Plane; c3: Plane }, stains: 'he' | 'hdab' | [Vec3, Vec3, Vec3], select: [boolean, boolean, boolean] = [true, true, true],
): RgbPlanes {
  const vecs = stainVectors(stains)
  const { width, height } = c.c1
  const n = width * height
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n)
  const cs = [c.c1.data, c.c2.data, c.c3.data]
  for (let i = 0; i < n; i++) {
    let odR = 0, odG = 0, odB = 0
    for (let s = 0; s < 3; s++) {
      if (!select[s]) continue
      const v = cs[s][i]
      odR += v * vecs[s][0]; odG += v * vecs[s][1]; odB += v * vecs[s][2]
    }
    r[i] = Math.min(1, Math.max(0, Math.pow(10, -odR)))
    g[i] = Math.min(1, Math.max(0, Math.pow(10, -odG)))
    b[i] = Math.min(1, Math.max(0, Math.pow(10, -odB)))
  }
  return { r, g, b, width, height }
}

// ---------------------------------------------------------------------------------------------
// Colour: saturation/vibrance, shadows/highlights, filmic
// ---------------------------------------------------------------------------------------------

/** Luma-preserving saturation + vibrance: `saturation` is a uniform chroma gain; `vibrance` is
 *  weighted by `1 - currentSaturation` (a rough max-min/max proxy) so already-saturated colours are
 *  left mostly alone while muted colours get boosted more. */
export function saturationVibrance(planes: RgbPlanes, o: { saturation: number; vibrance: number }): RgbPlanes {
  const { r, g, b, width, height } = planes
  const n = width * height
  const outR = new Float32Array(n), outG = new Float32Array(n), outB = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const R = r[i], G = g[i], B = b[i]
    const y = 0.299 * R + 0.587 * G + 0.114 * B
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B)
    const sat = mx > 1e-6 ? (mx - mn) / mx : 0
    const gain = (1 + o.saturation) * (1 + o.vibrance * (1 - sat))
    outR[i] = y + (R - y) * gain
    outG[i] = y + (G - y) * gain
    outB[i] = y + (B - y) * gain
  }
  return { r: outR, g: outG, b: outB, width, height }
}

/** Shadows/highlights recovery: a Gaussian-blurred luma mask (`radius`) drives a smooth per-pixel
 *  gain that lifts dark regions (`shadows > 0`) and compresses bright ones (`highlights > 0`), so the
 *  correction follows local brightness rather than the pixel's own value (avoids flattening a dark
 *  edge next to a bright one). */
export function shadowsHighlights(planes: RgbPlanes, o: { shadows: number; highlights: number; radius: number }): RgbPlanes {
  const { r, g, b, width, height } = planes
  const n = width * height
  const luma = new Float32Array(n)
  for (let i = 0; i < n; i++) luma[i] = 0.299 * r[i] + 0.587 * g[i] + 0.114 * b[i]
  const mask = gaussianBlur({ data: luma, width, height }, o.radius).data
  const outR = new Float32Array(n), outG = new Float32Array(n), outB = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const m = Math.min(1, Math.max(0, mask[i]))
    const shadowGain = 1 + o.shadows * (1 - m) * (1 - m)
    const highlightGain = 1 - o.highlights * m * m
    const gain = shadowGain * highlightGain
    outR[i] = Math.min(1, Math.max(0, r[i] * gain))
    outG[i] = Math.min(1, Math.max(0, g[i] * gain))
    outB[i] = Math.min(1, Math.max(0, b[i] * gain))
  }
  return { r: outR, g: outG, b: outB, width, height }
}

function acesFilm(x: number): number {
  const a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14
  return Math.min(1, Math.max(0, (x * (a * x + b)) / (x * (c * x + d) + e)))
}

/** ACES-fitted filmic tone curve (Narkowicz's fit) with a contrast parameter (power curve around
 *  18%-grey pivot before the filmic shoulder) and a white-point divisor. Intended to run on linear
 *  input, just before the display encode (see `pipeline.ts`'s stage ordering note). */
export function filmic(planes: RgbPlanes, o: { contrast: number; white: number }): RgbPlanes {
  const { r, g, b, width, height } = planes
  const n = width * height
  const outR = new Float32Array(n), outG = new Float32Array(n), outB = new Float32Array(n)
  const pivot = 0.18
  const white = Math.max(1e-3, o.white)
  const contrastExp = Math.max(0.05, 1 + o.contrast)
  const apply = (v: number): number => acesFilm(pivot * Math.pow(Math.max(0, v) / pivot, contrastExp) / white)
  for (let i = 0; i < n; i++) { outR[i] = apply(r[i]); outG[i] = apply(g[i]); outB[i] = apply(b[i]) }
  return { r: outR, g: outG, b: outB, width, height }
}
