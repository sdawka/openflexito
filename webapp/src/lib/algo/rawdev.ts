/** Develop a 10-bit Bayer capture into 16-bit RGB in the browser, the way the camera's ISP would but
 *  without any lossy step: black level, lens shading (the tuning file's 16×12 luminance and colour
 *  tables, bilinearly interpolated), white balance, Malvar-He-Cutler 5×5 demosaic, the tuning file's
 *  colour correction matrix, and the tuning file's gamma curve (or sRGB). Every intermediate is float;
 *  the result is meant for a lossless 16-bit PNG. */

import type { RawImage } from './raw'
import { findAlgo, type Tuning } from './tuning'

export interface Rgb16 { data: Uint16Array; width: number; height: number }

export interface LensShadingTables { luminance: ArrayLike<number>; cr: ArrayLike<number>; cb: ArrayLike<number>; cols: number; rows: number }

export interface DevelopOptions {
  gains?: [number, number]      // red, blue white-balance gains (from the live camera metadata)
  gamma?: boolean               // apply a transfer curve (default true; false = linear)
  gammaCurve?: ArrayLike<number> // tuning-file curve: flat [in0, out0, in1, out1, ...] on a 16-bit scale
  exposure?: number             // linear multiplier before the curve (default 1)
  lsc?: LensShadingTables | null
  ccm?: ArrayLike<number> | null // 3×3 row-major, camera RGB -> output RGB (tuning rpi.ccm)
  demosaic?: 'malvar' | 'bilinear'
}

/** Pull the development parameters out of a libcamera tuning file. */
export function developParamsFromTuning(t: Tuning): Pick<DevelopOptions, 'lsc' | 'ccm' | 'gammaCurve'> {
  const alsc = findAlgo(t, 'rpi.alsc')
  const lum = alsc?.luminance_lut, cr = alsc?.calibrations_Cr?.[0]?.table, cb = alsc?.calibrations_Cb?.[0]?.table
  const lsc = Array.isArray(lum) && lum.length === 192 ? { luminance: lum, cr: Array.isArray(cr) && cr.length === 192 ? cr : new Array(192).fill(1), cb: Array.isArray(cb) && cb.length === 192 ? cb : new Array(192).fill(1), cols: 16, rows: 12 } : null
  const ccms = findAlgo(t, 'rpi.ccm')?.ccms
  let ccm: number[] | null = null
  if (Array.isArray(ccms) && ccms.length) {
    // the calibrated illuminant is stored at 5000 K; take the entry nearest to it
    const best = ccms.reduce((a: any, b: any) => (Math.abs((b.ct ?? 0) - 5000) < Math.abs((a.ct ?? 0) - 5000) ? b : a))
    if (Array.isArray(best.ccm) && best.ccm.length === 9) ccm = best.ccm
  }
  const gammaCurve = findAlgo(t, 'rpi.contrast')?.gamma_curve
  return { lsc, ccm, gammaCurve: Array.isArray(gammaCurve) && gammaCurve.length >= 4 ? gammaCurve : undefined }
}

function srgb(v: number): number {  // v in 0..1
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

/** Transfer curve lookup on 4097 entries (input 0..1). */
function transferLut(opts: DevelopOptions): Float32Array {
  const lut = new Float32Array(4097)
  const curve = opts.gammaCurve
  if (opts.gamma === false) { for (let i = 0; i <= 4096; i++) lut[i] = i / 4096; return lut }
  if (curve && curve.length >= 4) {
    const n = curve.length >> 1
    for (let i = 0; i <= 4096; i++) {
      const x = (i / 4096) * 65535
      let k = 0
      while (k < n - 2 && curve[2 * (k + 1)] <= x) k++
      const x0 = curve[2 * k], y0 = curve[2 * k + 1], x1 = curve[2 * k + 2], y1 = curve[2 * k + 3]
      lut[i] = Math.min(1, Math.max(0, (x1 === x0 ? y1 : y0 + ((x - x0) * (y1 - y0)) / (x1 - x0)) / 65535))
    }
    return lut
  }
  for (let i = 0; i <= 4096; i++) lut[i] = srgb(i / 4096)
  return lut
}

/** Colour of the mosaic cell at (x, y) for a 2×2 Bayer order string such as 'BGGR'. */
export function cellColour(bayer: string, x: number, y: number): 'R' | 'G' | 'B' {
  const o = bayer.toUpperCase().padEnd(4, 'G')
  return o[((y & 1) << 1) | (x & 1)] as 'R' | 'G' | 'B'
}

/** Bilinear sample of a cols×rows table covering the whole frame (cell centres at (i+0.5)/cols). */
function tableSampler(table: ArrayLike<number>, cols: number, rows: number, w: number, h: number): (x: number, y: number) => number {
  return (x, y) => {
    const fx = Math.min(cols - 1, Math.max(0, ((x + 0.5) / w) * cols - 0.5)), fy = Math.min(rows - 1, Math.max(0, ((y + 0.5) / h) * rows - 0.5))
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(cols - 1, x0 + 1), y1 = Math.min(rows - 1, y0 + 1)
    const tx = fx - x0, ty = fy - y0
    return (table[y0 * cols + x0] * (1 - tx) + table[y0 * cols + x1] * tx) * (1 - ty) + (table[y1 * cols + x0] * (1 - tx) + table[y1 * cols + x1] * tx) * ty
  }
}

/** Black level, lens shading and white balance -> float mosaic (1.0 = sensor white). */
export function prepareMosaic(raw: RawImage, opts: DevelopOptions): Float32Array {
  const { width: w, height: h, data, blackLevel: bl } = raw
  const white = (1 << raw.bitDepth) - 1 - bl
  const [gr, gb] = opts.gains ?? [1, 1]
  const exposure = opts.exposure ?? 1
  const order = raw.bayer.toUpperCase().padEnd(4, 'G')
  const wb = [order[0], order[1], order[2], order[3]].map((c) => (c === 'R' ? gr : c === 'B' ? gb : 1))
  const m = new Float32Array(w * h)
  const lsc = opts.lsc
  // shading gains are smooth: evaluate the tables once per block (8×8 on the full sensor)
  const block = Math.max(1, Math.floor(w / 400)), mask = ~(block - 1), half = block >> 1
  const lum = lsc ? tableSampler(lsc.luminance, lsc.cols, lsc.rows, w, h) : null
  const cr = lsc ? tableSampler(lsc.cr, lsc.cols, lsc.rows, w, h) : null
  const cb = lsc ? tableSampler(lsc.cb, lsc.cols, lsc.rows, w, h) : null
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, cell = ((y & 1) << 1) | (x & 1)
      let g = wb[cell] * exposure / white
      if (lum) {
        const bx = block === 1 ? x : (x & mask) + half, by = block === 1 ? y : (y & mask) + half
        g *= lum(bx, by) * (order[cell] === 'R' ? cr!(bx, by) : order[cell] === 'B' ? cb!(bx, by) : 1)
      }
      m[i] = Math.max(0, data[i] - bl) * g
    }
  }
  return m
}

/** Malvar-He-Cutler (2004) 5×5 linear demosaic. Returns float RGB planes interleaved. */
export function demosaicMalvar(m: Float32Array, w: number, h: number, bayer: string): Float32Array {
  const out = new Float32Array(w * h * 3)
  const at = (x: number, y: number) => m[(y < 0 ? -y : y >= h ? 2 * h - 2 - y : y) * w + (x < 0 ? -x : x >= w ? 2 * w - 2 - x : x)]
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = cellColour(bayer, x, y), o = (y * w + x) * 3
    const p = at(x, y)
    const n4 = at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)
    const d4 = at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1)
    const far4 = at(x - 2, y) + at(x + 2, y) + at(x, y - 2) + at(x, y + 2)
    const farH = at(x - 2, y) + at(x + 2, y), farV = at(x, y - 2) + at(x, y + 2)
    const nH = at(x - 1, y) + at(x + 1, y), nV = at(x, y - 1) + at(x, y + 1)
    if (c !== 'G') {
      // green at a red/blue site
      const g = (4 * p + 2 * n4 - far4) / 8
      // the opposite colour at this site (diagonal neighbours)
      const other = (6 * p + 2 * d4 - 1.5 * far4) / 8
      out[o + 1] = g
      if (c === 'R') { out[o] = p; out[o + 2] = other } else { out[o + 2] = p; out[o] = other }
    } else {
      // at a green site: the row neighbours are one colour, the column neighbours the other
      const rowColour = cellColour(bayer, x + 1, y)   // colour of horizontal neighbours
      const horiz = (5 * p + 4 * nH - farH * 1 + 0.5 * farV - d4) / 8   // Malvar: G at R/B row: 5, 4 (row nbrs), -1 (row far), 1/2 (col far), -1 (diag)
      const vert = (5 * p + 4 * nV - farV * 1 + 0.5 * farH - d4) / 8
      out[o + 1] = p
      if (rowColour === 'R') { out[o] = horiz; out[o + 2] = vert } else { out[o + 2] = horiz; out[o] = vert }
    }
  }
  return out
}

export function demosaicBilinear(m: Float32Array, w: number, h: number, bayer: string): Float32Array {
  const out = new Float32Array(w * h * 3)
  const at = (x: number, y: number) => m[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = cellColour(bayer, x, y), o = (y * w + x) * 3, here = at(x, y)
    const cross = (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) / 4
    const diag = (at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1)) / 4
    const horiz = (at(x - 1, y) + at(x + 1, y)) / 2, vert = (at(x, y - 1) + at(x, y + 1)) / 2
    if (c === 'G') { out[o + 1] = here; if (cellColour(bayer, x + 1, y) === 'R') { out[o] = horiz; out[o + 2] = vert } else { out[o + 2] = horiz; out[o] = vert } }
    else if (c === 'R') { out[o] = here; out[o + 1] = cross; out[o + 2] = diag }
    else { out[o + 2] = here; out[o + 1] = cross; out[o] = diag }
  }
  return out
}

export function develop(raw: RawImage, opts: DevelopOptions = {}): Rgb16 {
  const { width: w, height: h } = raw
  const m = prepareMosaic(raw, opts)
  const rgb = (opts.demosaic ?? 'malvar') === 'malvar' ? demosaicMalvar(m, w, h, raw.bayer) : demosaicBilinear(m, w, h, raw.bayer)
  const lut = transferLut(opts)
  const enc = (v: number) => { const c = v <= 0 ? 0 : v >= 1 ? 4096 : Math.round(v * 4096); return Math.round(lut[c] * 65535) }
  const out = new Uint16Array(w * h * 3)
  const c = opts.ccm
  for (let i = 0; i < w * h * 3; i += 3) {
    let r = rgb[i], g = rgb[i + 1], b = rgb[i + 2]
    if (c) { const r2 = c[0] * r + c[1] * g + c[2] * b, g2 = c[3] * r + c[4] * g + c[5] * b, b2 = c[6] * r + c[7] * g + c[8] * b; r = r2; g = g2; b = b2 }
    out[i] = enc(r); out[i + 1] = enc(g); out[i + 2] = enc(b)
  }
  return { data: out, width: w, height: h }
}

/** 8-bit RGBA view of a 16-bit image, optionally downscaled by an integer factor (for previews). */
export function toRgba8(img: Rgb16, factor = 1): { data: Uint8ClampedArray; width: number; height: number } {
  const w = Math.floor(img.width / factor), h = Math.floor(img.height / factor)
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = ((y * factor) * img.width + x * factor) * 3, d = (y * w + x) * 4
    out[d] = img.data[s] >> 8; out[d + 1] = img.data[s + 1] >> 8; out[d + 2] = img.data[s + 2] >> 8; out[d + 3] = 255
  }
  return { data: out, width: w, height: h }
}
