/** Develop a 10-bit Bayer capture into 16-bit RGB in the browser, the way the camera's ISP would but
 *  without any lossy step: black level, lens shading (a measured flat field if there is one, else the
 *  tuning file's 16×12 luminance and colour tables, bilinearly interpolated, with `luminance_strength`
 *  and colour-temperature interpolation), white balance, demosaic (Malvar-He-Cutler or the directional
 *  RCD-style method, `demosaic.ts`), the tuning file's colour matrix (interpolated by colour temperature
 *  when several are present), highlight handling so clipped regions come out white instead of coloured,
 *  and the tuning file's gamma curve (or sRGB) through a linearly interpolated LUT. Every intermediate
 *  is float (`developLinear` exposes the linear planes); the result is meant for a lossless 16-bit PNG. */

import type { RawImage } from './raw'
import { findAlgo, type Tuning } from './tuning'
import { demosaic, cellColour, demosaicMalvar, demosaicBilinear, type DemosaicMethod } from './demosaic'
import { flatFieldSampler, type FlatField } from './flatField'

export { cellColour, demosaicMalvar, demosaicBilinear }

export interface Rgb16 { data: Uint16Array; width: number; height: number }
export interface RgbF { data: Float32Array; width: number; height: number }

export interface LensShadingTables { luminance: ArrayLike<number>; cr: ArrayLike<number>; cb: ArrayLike<number>; cols: number; rows: number }

export interface DevelopOptions {
  gains?: [number, number]      // red, blue white-balance gains (from the still's metadata)
  gamma?: boolean               // apply a transfer curve (default true; false = linear)
  gammaCurve?: ArrayLike<number> // tuning-file curve: flat [in0, out0, in1, out1, ...] on a 16-bit scale
  exposure?: number             // linear multiplier before the curve (default 1)
  lsc?: LensShadingTables | null
  /** measured flat field (algo/flatField.ts); when present it replaces `lsc` */
  flatField?: FlatField | null
  ccm?: ArrayLike<number> | null // 3×3 row-major, camera RGB -> output RGB (tuning rpi.ccm)
  demosaic?: DemosaicMethod
  /** 'desaturate' (default): pixels whose white-balanced value exceeds the sensor white are pulled
   *  towards neutral in proportion to how far over they are, so a blown highlight ends up white;
   *  'clip': plain per-channel clip (coloured highlights, as before) */
  highlights?: 'desaturate' | 'clip'
}

/** Linear interpolation of a per-entry table between the two calibration entries bracketing `ct`
 *  (nearest entry outside the range, single entry as is). Entries need `ct` and a numeric array under
 *  `key`; entries with the wrong length are ignored. */
export function interpolateByCt<T extends Record<string, any>>(entries: T[], key: string, length: number, ct: number | undefined): number[] | null {
  const ok = entries.filter((e) => Array.isArray(e?.[key]) && e[key].length === length && typeof e.ct === 'number').sort((a, b) => a.ct - b.ct)
  if (!ok.length) return null
  if (ok.length === 1 || ct === undefined || !(ct > 0)) {
    const target = ct && ct > 0 ? ct : 5000
    const best = ok.reduce((a, b) => (Math.abs(b.ct - target) < Math.abs(a.ct - target) ? b : a))
    return Array.from(best[key] as number[])
  }
  if (ct <= ok[0].ct) return Array.from(ok[0][key] as number[])
  if (ct >= ok[ok.length - 1].ct) return Array.from(ok[ok.length - 1][key] as number[])
  let k = 0
  while (k < ok.length - 2 && ok[k + 1].ct <= ct) k++
  const a = ok[k], b = ok[k + 1], t = (ct - a.ct) / (b.ct - a.ct)
  const out = new Array<number>(length)
  for (let i = 0; i < length; i++) out[i] = a[key][i] * (1 - t) + b[key][i] * t
  return out
}

/** Pull the development parameters out of a libcamera tuning file. `ct` (kelvin, e.g. libcamera's
 *  ColourTemperature or `tuning.ts estimateColourTemperature`) selects/interpolates the CCM and the
 *  ALSC colour tables; without it the entry nearest 5000 K is used. */
export function developParamsFromTuning(t: Tuning, ct?: number): Pick<DevelopOptions, 'lsc' | 'ccm' | 'gammaCurve'> {
  const alsc = findAlgo(t, 'rpi.alsc')
  const lum = alsc?.luminance_lut
  const strength = typeof alsc?.luminance_strength === 'number' ? alsc.luminance_strength : 1
  let lsc: LensShadingTables | null = null
  if (Array.isArray(lum) && lum.length === 192) {
    const cr = interpolateByCt(Array.isArray(alsc.calibrations_Cr) ? alsc.calibrations_Cr : [], 'table', 192, ct)
    const cb = interpolateByCt(Array.isArray(alsc.calibrations_Cb) ? alsc.calibrations_Cb : [], 'table', 192, ct)
    // libcamera applies the luminance table as 1 + (lut - 1) * luminance_strength
    const luminance = Array.from(lum as number[], (v) => 1 + (v - 1) * strength)
    lsc = { luminance, cr: cr ?? new Array(192).fill(1), cb: cb ?? new Array(192).fill(1), cols: 16, rows: 12 }
  }
  const ccms = findAlgo(t, 'rpi.ccm')?.ccms
  const ccm = Array.isArray(ccms) ? interpolateByCt(ccms, 'ccm', 9, ct) : null
  const gammaCurve = findAlgo(t, 'rpi.contrast')?.gamma_curve
  return { lsc, ccm, gammaCurve: Array.isArray(gammaCurve) && gammaCurve.length >= 4 ? gammaCurve : undefined }
}

function srgb(v: number): number {  // v in 0..1
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

const LUT_N = 4096

/** Transfer curve sampled on LUT_N+1 knots (input 0..1); looked up with linear interpolation. */
export function transferLut(opts: DevelopOptions): Float32Array {
  const lut = new Float32Array(LUT_N + 1)
  const curve = opts.gammaCurve
  if (opts.gamma === false) { for (let i = 0; i <= LUT_N; i++) lut[i] = i / LUT_N; return lut }
  if (curve && curve.length >= 4) {
    const n = curve.length >> 1
    for (let i = 0; i <= LUT_N; i++) {
      const x = (i / LUT_N) * 65535
      let k = 0
      while (k < n - 2 && curve[2 * (k + 1)] <= x) k++
      const x0 = curve[2 * k], y0 = curve[2 * k + 1], x1 = curve[2 * k + 2], y1 = curve[2 * k + 3]
      lut[i] = Math.min(1, Math.max(0, (x1 === x0 ? y1 : y0 + ((x - x0) * (y1 - y0)) / (x1 - x0)) / 65535))
    }
    return lut
  }
  for (let i = 0; i <= LUT_N; i++) lut[i] = srgb(i / LUT_N)
  return lut
}

/** Encode one linear value (0..1) through the LUT with linear interpolation between knots -> 0..65535. */
export function encodeValue(lut: Float32Array, v: number): number {
  if (v <= 0) return Math.round(lut[0] * 65535)
  if (v >= 1) return Math.round(lut[LUT_N] * 65535)
  const t = v * LUT_N, i = Math.floor(t), f = t - i
  return Math.round((lut[i] * (1 - f) + lut[i + 1] * f) * 65535)
}

/** Bilinear sample of a cols×rows table covering the whole frame (cell centres at (i+0.5)/cols). */
function tableSampler(table: ArrayLike<number>, cols: number, rows: number, w: number, h: number): (x: number, y: number) => number {
  return flatFieldSampler(table as Float32Array, cols, rows, w, h)
}

/** Black level, lens shading (flat field or ALSC tables) and white balance -> float mosaic
 *  (1.0 = sensor white before the gains; a clipped channel comes out at its gain). */
export function prepareMosaic(raw: RawImage, opts: DevelopOptions): Float32Array {
  const { width: w, height: h, data, blackLevel: bl } = raw
  const white = (1 << raw.bitDepth) - 1 - bl
  const [gr, gb] = opts.gains ?? [1, 1]
  const exposure = opts.exposure ?? 1
  const order = raw.bayer.toUpperCase().padEnd(4, 'G')
  const wb = [order[0], order[1], order[2], order[3]].map((c) => (c === 'R' ? gr : c === 'B' ? gb : 1))
  const m = new Float32Array(w * h)
  // shading gains are smooth: evaluate the tables once per block (8×8 on the full sensor)
  const block = Math.max(1, Math.floor(w / 400)), mask = ~(block - 1), half = block >> 1
  let shade: ((cell: number, bx: number, by: number) => number) | null = null
  const ff = opts.flatField
  if (ff) {
    const sr = flatFieldSampler(ff.r, ff.cols, ff.rows, w, h), sg = flatFieldSampler(ff.g, ff.cols, ff.rows, w, h), sb = flatFieldSampler(ff.b, ff.cols, ff.rows, w, h)
    shade = (cell, bx, by) => (order[cell] === 'R' ? sr(bx, by) : order[cell] === 'B' ? sb(bx, by) : sg(bx, by))
  } else if (opts.lsc) {
    const lsc = opts.lsc
    const lum = tableSampler(lsc.luminance, lsc.cols, lsc.rows, w, h), cr = tableSampler(lsc.cr, lsc.cols, lsc.rows, w, h), cb = tableSampler(lsc.cb, lsc.cols, lsc.rows, w, h)
    shade = (cell, bx, by) => lum(bx, by) * (order[cell] === 'R' ? cr(bx, by) : order[cell] === 'B' ? cb(bx, by) : 1)
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, cell = ((y & 1) << 1) | (x & 1)
      let g = wb[cell] * exposure / white
      if (shade) {
        const bx = block === 1 ? x : (x & mask) + half, by = block === 1 ? y : (y & mask) + half
        g *= shade(cell, bx, by)
      }
      m[i] = Math.max(0, data[i] - bl) * g
    }
  }
  return m
}

/** Highlight handling in place on interleaved linear RGB (before the colour matrix). A channel that
 *  clipped on the sensor reads 1.0 × its white-balance gain after balancing, so anything above 1.0
 *  is a clipped highlight: pull the pixel towards neutral by how far its maximum is over 1.0 relative
 *  to the largest possible overshoot (max gain × exposure), then let the encoder clip to white. */
export function desaturateHighlights(rgb: Float32Array, gains: [number, number], exposure = 1): void {
  const over = Math.max(1.0001, Math.max(gains[0], 1, gains[1]) * exposure)  // value of a fully clipped pixel's brightest channel
  const range = over - 1
  for (let i = 0; i < rgb.length; i += 3) {
    const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2]
    const mx = Math.max(r, g, b)
    if (mx <= 1) continue
    const f = Math.min(1, (mx - 1) / range)
    // towards white (mx, mx, mx), which the encoder clips to 1
    rgb[i] = r + f * (mx - r); rgb[i + 1] = g + f * (mx - g); rgb[i + 2] = b + f * (mx - b)
  }
}

/** Apply a 3×3 row-major colour matrix (camera RGB -> output RGB) to interleaved float RGB, in place.
 *  Pulled out of `developLinear` so `algo/drizzle.ts`'s raw-plane super-resolution path (which drizzles
 *  Bayer planes with no demosaic step, then runs the same downstream colour pipeline on the drizzled
 *  planes) can reuse the exact matrix step instead of duplicating it. */
export function applyCcm(rgb: Float32Array, ccm: ArrayLike<number>): void {
  for (let i = 0; i < rgb.length; i += 3) {
    const r = rgb[i], g = rgb[i + 1], b = rgb[i + 2]
    rgb[i] = ccm[0] * r + ccm[1] * g + ccm[2] * b
    rgb[i + 1] = ccm[3] * r + ccm[4] * g + ccm[5] * b
    rgb[i + 2] = ccm[6] * r + ccm[7] * g + ccm[8] * b
  }
}

/** Everything up to (and including) the colour matrix, as float linear RGB (1.0 = white). */
export function developLinear(raw: RawImage, opts: DevelopOptions = {}): RgbF {
  const { width: w, height: h } = raw
  const m = prepareMosaic(raw, opts)
  const rgb = demosaic(m, w, h, raw.bayer, opts.demosaic ?? 'malvar')
  if ((opts.highlights ?? 'desaturate') === 'desaturate') desaturateHighlights(rgb, opts.gains ?? [1, 1], opts.exposure ?? 1)
  if (opts.ccm) applyCcm(rgb, opts.ccm)
  return { data: rgb, width: w, height: h }
}

/** Apply the transfer curve to linear float RGB -> 16-bit. */
export function encodeRgb16(lin: RgbF, opts: DevelopOptions = {}): Rgb16 {
  const lut = transferLut(opts)
  const out = new Uint16Array(lin.data.length)
  for (let i = 0; i < out.length; i++) out[i] = encodeValue(lut, lin.data[i])
  return { data: out, width: lin.width, height: lin.height }
}

export function develop(raw: RawImage, opts: DevelopOptions = {}): Rgb16 {
  return encodeRgb16(developLinear(raw, opts), opts)
}

/** 8-bit RGBA view of a 16-bit image, optionally downscaled by an integer factor (for previews). The
 *  downscale averages every factor×factor block rather than picking one pixel. */
export function toRgba8(img: Rgb16, factor = 1): { data: Uint8ClampedArray; width: number; height: number } {
  const w = Math.floor(img.width / factor), h = Math.floor(img.height / factor)
  const out = new Uint8ClampedArray(w * h * 4)
  if (factor <= 1) {
    for (let i = 0, d = 0; i < w * h; i++, d += 4) { const s = i * 3; out[d] = img.data[s] >> 8; out[d + 1] = img.data[s + 1] >> 8; out[d + 2] = img.data[s + 2] >> 8; out[d + 3] = 255 }
    return { data: out, width: w, height: h }
  }
  const nn = factor * factor * 256
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0
    for (let dy = 0; dy < factor; dy++) {
      let s = ((y * factor + dy) * img.width + x * factor) * 3
      for (let dx = 0; dx < factor; dx++, s += 3) { r += img.data[s]; g += img.data[s + 1]; b += img.data[s + 2] }
    }
    const d = (y * w + x) * 4
    out[d] = Math.round(r / nn); out[d + 1] = Math.round(g / nn); out[d + 2] = Math.round(b / nn); out[d + 3] = 255
  }
  return { data: out, width: w, height: h }
}
