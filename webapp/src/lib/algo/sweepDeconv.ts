/** Focal-sweep extended depth of field: average every frame of a continuous z sweep, then undo the
 *  sweep's integrated blur with one 2-D deconvolution (Häusler 1972; Nagahara et al., "Flexible
 *  depth of field photography", ECCV 2008).
 *
 *  A point at depth z0 seen in a frame at z is blurred by a defocus disk of radius s·|z − z0| px
 *  (s: px of blur radius per z step, from the objective's aperture). Averaging the frames of a sweep
 *  gives every point the *integrated* PSF: the mean of those disks. At high spatial frequency ρ
 *  (cycles/px) each disk's transfer function 2·J1(2πρr)/(2πρr) dies off within r ≈ 1/ρ, so the
 *  mean is ≈ 2C/(ρ·s·D) for a sweep of D steps whatever z0 is, as long as the point is more than
 *  ≈1/(ρ·s) steps from the sweep's ends. The blur is therefore (nearly) the same at every depth and
 *  one Wiener filter recovers the whole depth range: no per-pixel choice of a sharpest slice, so no
 *  halos or seams where the choice flips, and hundreds of frames average away sensor and H.264
 *  noise. It also removes axial chromatic aberration: R, G and B focus at slightly different z, but
 *  the integrated PSF is the same for all three, so each channel is restored in place (a
 *  per-pixel slice pick on luminance mixes a sharp green with a soft red and blue: coloured edges).
 *
 *  What is modelled is the defocus alone, relative to the in-focus image: the result is the
 *  specimen as an in-focus frame would show it everywhere, not a deconvolution of the optics'
 *  in-focus PSF. Everything runs in linear light (the frames are sRGB-encoded).
 *
 *  `s` scales the high-frequency gain (H ∝ 1/s), so it matters: `estimateDefocusSlope` measures it
 *  from the sweep itself (the disk radius that best turns the sharpest frame into a defocused one),
 *  `theoreticalSlope` gives it from the NA and the calibrations. */

import { fft2d, nextPow2 } from './fft'

export interface Planes { r: Float32Array; g: Float32Array; b: Float32Array; width: number; height: number }
export interface GrayImage { data: Float32Array; width: number; height: number }

// ---- colour ----------------------------------------------------------------------------------------

let linLut: Float32Array | null = null
/** 8-bit sRGB → linear 0..1. */
export function srgbToLinearLut(): Float32Array {
  if (linLut) return linLut
  linLut = new Float32Array(256)
  for (let i = 0; i < 256; i++) { const v = i / 255; linLut[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  return linLut
}

/** Linear 0..1 → 8-bit sRGB (clamped). */
export function linearToSrgb8(v: number): number {
  const c = v <= 0 ? 0 : v >= 1 ? 1 : v
  return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055))
}

// ---- accumulation ----------------------------------------------------------------------------------

/** Running mean of RGBA frames in linear light, each translated by its own (dx, dy) first
 *  (out(x) = frame(x − d), bilinear, same convention as `align.ts#translatePlanesSubpixel`). A
 *  pixel only averages the frames that cover it, so a shifted frame's missing edge is not a dark
 *  band in the mean. */
export class SweepAccumulator {
  readonly sum: [Float32Array, Float32Array, Float32Array]
  readonly weight: Float32Array
  count = 0
  constructor(readonly width: number, readonly height: number) {
    const n = width * height
    this.sum = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]
    this.weight = new Float32Array(n)
  }

  add(rgba: Uint8ClampedArray | Uint8Array, dx = 0, dy = 0): void {
    const { width: w, height: h } = this, lut = srgbToLinearLut()
    const [R, G, B] = this.sum, W = this.weight
    const ix = Math.floor(dx), iy = Math.floor(dy), fx = dx - ix, fy = dy - iy
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy
    for (let y = 0; y < h; y++) {
      // out(x, y) = frame(x − dx, y − dy): taps at x − ix (weight 1 − fx) and x − ix − 1 (weight fx)
      const sy1 = y - iy, sy0 = sy1 - 1
      if (sy0 < 0 || sy1 >= h) continue
      const r1 = sy1 * w, r0 = sy0 * w
      // columns whose four taps are all inside the frame
      const xFrom = Math.max(0, ix + 1), xTo = Math.min(w, w + ix)
      for (let x = xFrom; x < xTo; x++) {
        const sx1 = x - ix, sx0 = sx1 - 1
        const p11 = (r1 + sx1) * 4, p01 = (r1 + sx0) * 4, p10 = (r0 + sx1) * 4, p00 = (r0 + sx0) * 4
        const i = y * w + x
        R[i] += w00 * lut[rgba[p11]] + w10 * lut[rgba[p01]] + w01 * lut[rgba[p10]] + w11 * lut[rgba[p00]]
        G[i] += w00 * lut[rgba[p11 + 1]] + w10 * lut[rgba[p01 + 1]] + w01 * lut[rgba[p10 + 1]] + w11 * lut[rgba[p00 + 1]]
        B[i] += w00 * lut[rgba[p11 + 2]] + w10 * lut[rgba[p01 + 2]] + w01 * lut[rgba[p10 + 2]] + w11 * lut[rgba[p00 + 2]]
        W[i] += 1
      }
    }
    this.count++
  }

  /** Linear mean planes; pixels no frame covered take the nearest covered value along the row. */
  mean(): Planes {
    const { width: w, height: h } = this, n = w * h
    const out = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]
    for (let c = 0; c < 3; c++) for (let i = 0; i < n; i++) out[c][i] = this.weight[i] > 0 ? this.sum[c][i] / this.weight[i] : NaN
    for (const p of out) for (let y = 0; y < h; y++) {
      let last = NaN
      for (let x = 0; x < w; x++) { const i = y * w + x; if (Number.isNaN(p[i])) p[i] = last; else last = p[i] }
      last = NaN
      for (let x = w - 1; x >= 0; x--) { const i = y * w + x; if (Number.isNaN(p[i])) p[i] = last; else last = p[i] }
      for (let x = 0; x < w; x++) if (Number.isNaN(p[y * w + x])) p[y * w + x] = 0
    }
    return { r: out[0], g: out[1], b: out[2], width: w, height: h }
  }
}

// ---- the integrated transfer function --------------------------------------------------------------

/** Bessel J1 (Numerical Recipes rational/asymptotic approximation, |error| < 1e-7). */
export function besselJ1(x: number): number {
  const ax = Math.abs(x)
  if (ax < 8) {
    const y = x * x
    const a = x * (72362614232.0 + y * (-7895059235.0 + y * (242396853.1 + y * (-2972611.439 + y * (15704.48260 + y * -30.16036606)))))
    const b = 144725228442.0 + y * (2300535178.0 + y * (18583304.74 + y * (99447.43394 + y * (376.9991397 + y))))
    return a / b
  }
  const z = 8 / ax, y = z * z, xx = ax - 2.356194491
  const p = 1 + y * (0.183105e-2 + y * (-0.3516396496e-4 + y * (0.2457520174e-5 + y * -0.240337019e-6)))
  const q = 0.04687499995 + y * (-0.2002690873e-3 + y * (0.8449199096e-5 + y * (-0.88228987e-6 + y * 0.105787412e-6)))
  const ans = Math.sqrt(0.636619772 / ax) * (Math.cos(xx) * p - z * Math.sin(xx) * q)
  return x < 0 ? -ans : ans
}

/** Transfer function of a uniform disk of radius `r` px at `rho` cycles/px. */
export function diskOtf(rho: number, r: number): number {
  const u = 2 * Math.PI * rho * r
  return u < 1e-6 ? 1 : (2 * besselJ1(u)) / u
}

/** Radial table of the sweep's transfer function: the mean over the frames' blur radii (px) of
 *  their disk OTFs, `bins` samples from 0 to √2/2 cycles/px (the corner of the frequency plane). */
export function sweepOtfTable(radii: readonly number[], bins = 2048): { table: Float64Array; rhoMax: number } {
  const rhoMax = Math.SQRT1_2, table = new Float64Array(bins + 1)
  const n = Math.max(1, radii.length)
  for (let k = 0; k <= bins; k++) {
    const rho = (k / bins) * rhoMax
    let s = 0
    for (const r of radii) s += diskOtf(rho, r)
    table[k] = s / n
  }
  return { table, rhoMax }
}

function lookup(t: { table: Float64Array; rhoMax: number }, rho: number): number {
  const bins = t.table.length - 1, f = Math.min(bins, (rho / t.rhoMax) * bins), k = Math.floor(f)
  return k >= bins ? t.table[bins] : t.table[k] + (f - k) * (t.table[k + 1] - t.table[k])
}

// ---- deconvolution ---------------------------------------------------------------------------------

/** Pad `w`×`h` into `W`×`H` (powers of two) so the FFT's periodic wrap is smooth: the pad
 *  cross-fades from the image's far edge (mirrored) to its near edge (mirrored, across the wrap). */
function padSmooth(src: Float32Array, w: number, h: number, W: number, H: number): Float64Array {
  const out = new Float64Array(W * H)
  const pw = W - w, ph = H - h
  for (let y = 0; y < h; y++) {
    const row = y * W
    for (let x = 0; x < w; x++) out[row + x] = src[y * w + x]
    for (let k = 0; k < pw; k++) {
      const t = (k + 0.5) / pw
      const a = src[y * w + Math.max(0, w - 1 - Math.min(k, w - 1))], b = src[y * w + Math.min(w - 1, pw - 1 - k)]
      out[row + w + k] = (1 - t) * a + t * b
    }
  }
  for (let k = 0; k < ph; k++) {
    const t = (k + 0.5) / ph, ya = Math.max(0, h - 1 - Math.min(k, h - 1)), yb = Math.min(h - 1, ph - 1 - k)
    for (let x = 0; x < W; x++) out[(h + k) * W + x] = (1 - t) * out[ya * W + x] + t * out[yb * W + x]
  }
  return out
}

/** Real, even filter F(fx, fy) applied to two real planes at once (packed as re + i·im: a real even
 *  filter keeps the two apart), each `w`×`h`. Returns the filtered planes. */
function filterPair(a: Float32Array, b: Float32Array | null, w: number, h: number, F: (fx: number, fy: number) => number): [Float32Array, Float32Array | null] {
  const W = nextPow2(w), H = nextPow2(h)
  const re = padSmooth(a, w, h, W, H), im = b ? padSmooth(b, w, h, W, H) : new Float64Array(W * H)
  fft2d(re, im, W, H)
  const fxs = new Float64Array(W), fys = new Float64Array(H)
  for (let x = 0; x < W; x++) fxs[x] = (x <= W / 2 ? x : x - W) / W
  for (let y = 0; y < H; y++) fys[y] = (y <= H / 2 ? y : y - H) / H
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, f = F(fxs[x], fys[y])
    re[i] *= f; im[i] *= f
  }
  fft2d(re, im, W, H, true)
  const oa = new Float32Array(w * h), ob = b ? new Float32Array(w * h) : null
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    oa[y * w + x] = re[y * W + x]
    if (ob) ob[y * w + x] = im[y * W + x]
  }
  return [oa, ob]
}

export interface DeconvOptions {
  /** blur radius (px) of every averaged frame for a point at the sweep's centre: s·|z_i − z0| */
  radii: readonly number[]
  /** Wiener noise-to-signal ratio: larger is gentler (less noise, less sharpening). Default 0.0015 (best on a synthetic sweep with per-frame noise of 2 % of full scale over 51 frames: 0.0005–0.002). */
  noise?: number
}

/** Wiener filter for the sweep's transfer function, normalised to 1 at DC:
 *  F = H·(1 + K) / (H² + K). */
export function sweepWienerFilter(o: DeconvOptions): (fx: number, fy: number) => number {
  const t = sweepOtfTable(o.radii), K = o.noise ?? 0.0015
  return (fx, fy) => {
    const H = lookup(t, Math.hypot(fx, fy))
    return (H * (1 + K)) / (H * H + K)
  }
}

/** Deconvolve the linear mean planes of a sweep. Output is linear, not clamped. */
export function deconvolveSweep(mean: Planes, o: DeconvOptions): Planes {
  const { width: w, height: h } = mean, F = sweepWienerFilter(o)
  const [r, g] = filterPair(mean.r, mean.g, w, h, F)
  const [b] = filterPair(mean.b, null, w, h, F)
  return { r, g: g!, b, width: w, height: h }
}

/** Linear planes → 8-bit sRGB RGBA. */
export function planesToRgba8(p: Planes): Uint8ClampedArray {
  const n = p.width * p.height, out = new Uint8ClampedArray(n * 4)
  for (let i = 0, q = 0; i < n; i++, q += 4) { out[q] = linearToSrgb8(p.r[i]); out[q + 1] = linearToSrgb8(p.g[i]); out[q + 2] = linearToSrgb8(p.b[i]); out[q + 3] = 255 }
  return out
}

// ---- blur slope ------------------------------------------------------------------------------------

/** Geometric defocus blur (px of disk radius per z step): tan(asin NA) · z µm/step ÷ µm/px. */
export function theoreticalSlope(na: number, zUmPerStep: number, umPerPx: number): number {
  const a = Math.max(0.01, Math.min(0.99, na))
  return (Math.tan(Math.asin(a)) * zUmPerStep) / umPerPx
}

/** Disk blur of `img` for each radius in `radii` (px), one forward FFT shared. */
export function diskBlurs(img: GrayImage, radii: readonly number[]): Float32Array[] {
  const { width: w, height: h } = img, W = nextPow2(w), H = nextPow2(h)
  const re0 = padSmooth(img.data, w, h, W, H), im0 = new Float64Array(W * H)
  fft2d(re0, im0, W, H)
  const out: Float32Array[] = []
  for (const r of radii) {
    const re = new Float64Array(W * H), im = new Float64Array(W * H)
    for (let y = 0; y < H; y++) {
      const fy = (y <= H / 2 ? y : y - H) / H
      for (let x = 0; x < W; x++) {
        const fx = (x <= W / 2 ? x : x - W) / W, i = y * W + x, f = diskOtf(Math.hypot(fx, fy), r)
        re[i] = re0[i] * f; im[i] = im0[i] * f
      }
    }
    fft2d(re, im, W, H, true)
    const o = new Float32Array(w * h)
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) o[yy * w + xx] = re[yy * W + xx]
    out.push(o)
  }
  return out
}

/** Mean-removed sum of squared differences over the interior (a `margin` px border skipped). */
function residual(a: Float32Array, b: Float32Array, w: number, h: number, margin: number): number {
  let ma = 0, mb = 0, n = 0
  for (let y = margin; y < h - margin; y++) for (let x = margin; x < w - margin; x++) { ma += a[y * w + x]; mb += b[y * w + x]; n++ }
  if (!n) return Infinity
  ma /= n; mb /= n
  let s = 0
  for (let y = margin; y < h - margin; y++) for (let x = margin; x < w - margin; x++) { const d = a[y * w + x] - ma - (b[y * w + x] - mb); s += d * d }
  return s / n
}

export interface SlopeEstimate {
  /** px of blur radius per z step, at the images' own scale; null when no pair gave a usable fit */
  slope: number | null
  /** per pair: dz, best radius, and how much of the r = 0 residual the best radius removed (0..1) */
  fits: { dz: number; r: number; gain: number }[]
}

/** Measure the defocus slope from the sweep: for each (defocused frame, dz from the sharpest frame)
 *  pair, the disk radius r that best turns `sharp` into that frame (least squares, mean removed,
 *  coarse 1 px grid up to `maxR` then 0.25 px around the best), and the median r/|dz| over the pairs
 *  whose best disk explains a useful share (`minGain`) of the difference. Linear-light grey images
 *  of the same size, same alignment. */
export function estimateDefocusSlope(sharp: GrayImage, others: readonly { img: GrayImage; dz: number }[], maxR = 40, minGain = 0.3): SlopeEstimate {
  const { width: w, height: h } = sharp
  const margin = Math.min(Math.floor(Math.min(w, h) / 4), Math.ceil(maxR))
  const coarse: number[] = []
  for (let r = 0; r <= maxR; r += 1) coarse.push(r)
  const coarseBlurs = diskBlurs(sharp, coarse)
  const fits: SlopeEstimate['fits'] = []
  for (const o of others) {
    if (!o.dz) continue
    const res = coarseBlurs.map((b) => residual(b, o.img.data, w, h, margin))
    let k = 0
    for (let i = 1; i < res.length; i++) if (res[i] < res[k]) k = i
    const fine: number[] = []
    for (let r = Math.max(0, coarse[k] - 1); r <= coarse[k] + 1 + 1e-9; r += 0.25) fine.push(r)
    const fineRes = diskBlurs(sharp, fine).map((b) => residual(b, o.img.data, w, h, margin))
    let j = 0
    for (let i = 1; i < fineRes.length; i++) if (fineRes[i] < fineRes[j]) j = i
    const gain = res[0] > 0 ? Math.max(0, 1 - fineRes[j] / res[0]) : 0
    fits.push({ dz: o.dz, r: fine[j], gain })
  }
  const ok = fits.filter((f) => f.gain >= minGain && f.r > 0 && f.r < maxR).map((f) => f.r / Math.abs(f.dz)).sort((a, b) => a - b)
  return { slope: ok.length ? ok[ok.length >> 1] : null, fits }
}

// ---- planning --------------------------------------------------------------------------------------

/** Which sweep frames to average: the in-focus band [lo, hi] plus `margin` z steps each side, where
 *  margin ≥ ¼ of the band and ≥ 10/s (so the integrated PSF is depth-invariant down to ≈0.1
 *  cycles/px for every point in the band), within the sweep's own extent. Returns the z range and
 *  the centre z0 the blur radii are measured from. */
export function sweepWindow(lo: number, hi: number, sweepLo: number, sweepHi: number, slope: number): { lo: number; hi: number; z0: number } {
  const margin = Math.max(0.25 * (hi - lo), slope > 0 ? 10 / slope : 0)
  return { lo: Math.max(sweepLo, lo - margin), hi: Math.min(sweepHi, hi + margin), z0: (lo + hi) / 2 }
}

/** The translation aligning a frame at `z`, interpolated linearly between the aligned slices'
 *  (`zs` ascending, `shifts` from the pyramid worker), held constant past either end. A flexure
 *  z move drags the image sideways smoothly, so the few slices the pyramid aligned stand in for
 *  every frame of the sweep (the defocused ones could not be aligned on their own). */
export function shiftAtZ(zs: readonly number[], shifts: readonly { dx: number; dy: number }[], z: number): { dx: number; dy: number } {
  const n = Math.min(zs.length, shifts.length)
  if (!n) return { dx: 0, dy: 0 }
  if (z <= zs[0] || n === 1) return shifts[0]
  if (z >= zs[n - 1]) return shifts[n - 1]
  let k = 0
  while (k < n - 2 && z > zs[k + 1]) k++
  const t = zs[k + 1] > zs[k] ? (z - zs[k]) / (zs[k + 1] - zs[k]) : 0
  return { dx: shifts[k].dx + t * (shifts[k + 1].dx - shifts[k].dx), dy: shifts[k].dy + t * (shifts[k + 1].dy - shifts[k].dy) }
}
