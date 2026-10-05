/** Per-channel flat-field gain maps from a blank-field RAW (sample removed, LED on): the measured
 *  vignetting and colour shading of this particular objective/illumination, at a coarse grid so it is
 *  cheap to store, smooth to apply and equally usable as the ALSC replacement in `rawdev.develop`, as a
 *  brightness field for stitching, and as DNG GainMap opcodes (`dng.ts`).
 *
 *  gain(x, y) = reference / measured(x, y), so multiplying the mosaic by the map flattens the field.
 *  The reference is the centre value (default: the field stays at unity in the middle, the corners are
 *  lifted) or the mean. Maps are smoothed (separable box passes) and clamped so dust or a dark corner
 *  cannot blow up noise. */

import type { RawImage } from './raw'
import { splitBayer } from './raw'
import { sampleGainMap, type GainMap } from './stitch'

export interface FlatField {
  cols: number
  rows: number
  /** gain maps, row-major cols×rows, one per colour (green = mean of both green planes) */
  r: Float32Array
  g: Float32Array
  b: Float32Array
  /** what the maps were normalised to */
  reference: 'centre' | 'mean'
  /** sensor size the field was measured on (the maps are in normalised image coordinates) */
  width: number
  height: number
}

/** JSON-safe form (IndexedDB/localStorage cannot hold typed arrays inside Svelte state comfortably). */
export interface FlatFieldJson { cols: number; rows: number; r: number[]; g: number[]; b: number[]; reference: 'centre' | 'mean'; width: number; height: number; when?: string }

export function flatFieldToJson(f: FlatField, when = new Date().toISOString()): FlatFieldJson {
  const round = (a: Float32Array) => Array.from(a, (v) => Math.round(v * 1e4) / 1e4)
  return { cols: f.cols, rows: f.rows, r: round(f.r), g: round(f.g), b: round(f.b), reference: f.reference, width: f.width, height: f.height, when }
}
export function flatFieldFromJson(j: FlatFieldJson): FlatField {
  return { cols: j.cols, rows: j.rows, r: Float32Array.from(j.r), g: Float32Array.from(j.g), b: Float32Array.from(j.b), reference: j.reference, width: j.width, height: j.height }
}

export interface FlatFieldOptions {
  cols?: number          // grid size (default 64×48)
  rows?: number
  reference?: 'centre' | 'mean'
  smoothPasses?: number  // 3×3 box passes on the grid (default 2)
  clamp?: [number, number]  // gain limits (default 0.5..8)
}

/** Grid mean of a plane: each cell averages the pixels that fall in it. */
export function gridMean(plane: Float32Array, w: number, h: number, cols: number, rows: number): Float32Array {
  const sum = new Float64Array(cols * rows), cnt = new Uint32Array(cols * rows)
  for (let y = 0; y < h; y++) {
    const cy = Math.min(rows - 1, Math.floor((y * rows) / h))
    for (let x = 0; x < w; x++) {
      const cx = Math.min(cols - 1, Math.floor((x * cols) / w))
      sum[cy * cols + cx] += plane[y * w + x]; cnt[cy * cols + cx]++
    }
  }
  const out = new Float32Array(cols * rows)
  for (let i = 0; i < out.length; i++) out[i] = cnt[i] ? sum[i] / cnt[i] : 0
  return out
}

/** Separable 3×3 box smoothing of a cols×rows grid (edges clamped), `passes` times. */
export function smoothGrid(g: Float32Array, cols: number, rows: number, passes = 1): Float32Array {
  let cur = g
  for (let p = 0; p < passes; p++) {
    const tmp = new Float32Array(cur.length), out = new Float32Array(cur.length)
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const x0 = Math.max(0, x - 1), x1 = Math.min(cols - 1, x + 1)
      tmp[y * cols + x] = (cur[y * cols + x0] + cur[y * cols + x] + cur[y * cols + x1]) / 3
    }
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const y0 = Math.max(0, y - 1), y1 = Math.min(rows - 1, y + 1)
      out[y * cols + x] = (tmp[y0 * cols + x] + tmp[y * cols + x] + tmp[y1 * cols + x]) / 3
    }
    cur = out
  }
  return cur
}

function gainMap(plane: Float32Array, w: number, h: number, o: Required<FlatFieldOptions>): Float32Array {
  const grid = smoothGrid(gridMean(plane, w, h, o.cols, o.rows), o.cols, o.rows, o.smoothPasses)
  let ref: number
  if (o.reference === 'centre') {
    // mean of the central 2×2 cells (robust to an odd/even grid)
    const cx = o.cols >> 1, cy = o.rows >> 1
    ref = (grid[(cy - 1) * o.cols + cx - 1] + grid[(cy - 1) * o.cols + cx] + grid[cy * o.cols + cx - 1] + grid[cy * o.cols + cx]) / 4
  } else {
    let s = 0; for (let i = 0; i < grid.length; i++) s += grid[i]; ref = s / grid.length
  }
  const out = new Float32Array(grid.length)
  for (let i = 0; i < grid.length; i++) {
    const v = grid[i] > 1e-6 ? ref / grid[i] : o.clamp[1]
    out[i] = Math.min(o.clamp[1], Math.max(o.clamp[0], v))
  }
  return out
}

/** Build the gain maps from one (ideally averaged, see `raw.ts averageRaws`) blank-field capture. */
export function flatFieldFromRaw(raw: RawImage, opts: FlatFieldOptions = {}): FlatField {
  const o: Required<FlatFieldOptions> = { cols: opts.cols ?? 64, rows: opts.rows ?? 48, reference: opts.reference ?? 'centre', smoothPasses: opts.smoothPasses ?? 2, clamp: opts.clamp ?? [0.5, 8] }
  const p = splitBayer(raw)
  const g = new Float32Array(p.g1.length)
  for (let i = 0; i < g.length; i++) g[i] = (p.g1[i] + p.g2[i]) / 2
  return {
    cols: o.cols, rows: o.rows, reference: o.reference, width: raw.width, height: raw.height,
    r: gainMap(p.r, p.width, p.height, o), g: gainMap(g, p.width, p.height, o), b: gainMap(p.b, p.width, p.height, o),
  }
}

/** Bilinear sampler of one gain map over an image of size w×h (cell centres at (i+0.5)/cols). */
export function flatFieldSampler(map: Float32Array, cols: number, rows: number, w: number, h: number): (x: number, y: number) => number {
  return (x, y) => {
    const fx = Math.min(cols - 1, Math.max(0, ((x + 0.5) / w) * cols - 0.5)), fy = Math.min(rows - 1, Math.max(0, ((y + 0.5) / h) * rows - 0.5))
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(cols - 1, x0 + 1), y1 = Math.min(rows - 1, y0 + 1)
    const tx = fx - x0, ty = fy - y0
    return (map[y0 * cols + x0] * (1 - tx) + map[y0 * cols + x1] * tx) * (1 - ty) + (map[y1 * cols + x0] * (1 - tx) + map[y1 * cols + x1] * tx) * ty
  }
}

/** Luminance gain (green map) resampled to an arbitrary grid, e.g. for stitching's per-tile brightness
 *  equalisation. Row-major cols×rows Float32Array. */
export function flatFieldLuminance(f: FlatField, cols: number, rows: number): Float32Array {
  const s = flatFieldSampler(f.g, f.cols, f.rows, cols, rows)
  const out = new Float32Array(cols * rows)
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) out[y * cols + x] = s(x, y)
  return out
}

/** Multiply an RGBA (8-bit) or RGB float image by the flat field (used before stitching). */
export function applyFlatFieldRgb(data: Float32Array, w: number, h: number, f: FlatField): void {
  const sr = flatFieldSampler(f.r, f.cols, f.rows, w, h), sg = flatFieldSampler(f.g, f.cols, f.rows, w, h), sb = flatFieldSampler(f.b, f.cols, f.rows, w, h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 3
    data[o] *= sr(x, y); data[o + 1] *= sg(x, y); data[o + 2] *= sb(x, y)
  }
}

/** Relative illumination of the blank field, the shape stitching divides its tiles by
 *  (`algo/stitch.ts` `GainMap`, channels 3): illumination = 1 / gain per channel, resampled to
 *  `cols`×`rows` (default the field's own grid) and scaled to mean 1 per channel. Accepts the live
 *  `FlatField` or its JSON form straight from the calibration store. */
export function flatFieldToIllumination(f: FlatField | FlatFieldJson, cols = f.cols, rows = f.rows): { width: number; height: number; channels: 3; data: Float32Array } {
  const planes = [f.r, f.g, f.b].map((p) => (p instanceof Float32Array ? p : Float32Array.from(p)))
  const n = cols * rows, data = new Float32Array(n * 3)
  for (let ch = 0; ch < 3; ch++) {
    const s = flatFieldSampler(planes[ch], f.cols, f.rows, cols, rows)
    let sum = 0
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
      const v = 1 / Math.max(1e-3, s(x, y))
      data[(y * cols + x) * 3 + ch] = v; sum += v
    }
    const m = sum / n || 1
    for (let i = 0; i < n; i++) data[i * 3 + ch] /= m
  }
  return { width: cols, height: rows, channels: 3, data }
}

// ---------------------------------------------------------------------------------------------
// Applying a relative-illumination map to 8-bit RGBA (live view, recordings, JPEG stills)
// ---------------------------------------------------------------------------------------------

/** A relative-illumination map as stored in the calibration store (plain arrays) or built by the
 *  stitcher (`Float32Array`); `GainMap` shape, `data` may be a plain array. */
export type IlluminationMap = Omit<GainMap, 'data'> & { data: ArrayLike<number> }

export interface ApplyGainMapOptions {
  /** Default true: decode sRGB to linear light, divide by the map, re-encode. The illumination is a
   *  linear-light multiplier on the scene, but a JPEG is gamma-encoded: dividing the encoded values
   *  (`false`) applies the full 1/ill to a value that only fell by ill^(1/2.2), so the dim rim ends up
   *  brighter than the centre (E(L·ill)/ill = E(L)·ill^-0.55 > E(L)). `false` is kept for comparison. */
  linear?: boolean
  /** 0..1: how much of the correction to apply (multiplier = ill^-strength). Default 1. */
  strength?: number
  /** The image is a window of a frame of `tileW`×`tileH` (default: the image's own size) whose
   *  top-left is at (`offX`, `offY`); the map is sampled over the whole frame. */
  tileW?: number
  tileH?: number
  offX?: number
  offY?: number
}

/** Per-pixel, per-channel multiplier (1 / illumination^strength), `w*h*3` floats, bilinear in the map. */
export function buildShadingMultiplier(w: number, h: number, map: IlluminationMap, opts: ApplyGainMapOptions = {}): Float32Array {
  const tw = opts.tileW ?? w, th = opts.tileH ?? h, ox = opts.offX ?? 0, oy = opts.offY ?? 0
  const strength = Math.min(1, Math.max(0, opts.strength ?? 1))
  const m = map as GainMap
  const out = new Float32Array(w * h * 3)
  const mono = m.channels === 1
  for (let y = 0; y < h; y++) {
    const v = (oy + y + 0.5) / th
    for (let x = 0; x < w; x++) {
      const u = (ox + x + 0.5) / tw
      const o = (y * w + x) * 3
      for (let ch = 0; ch < 3; ch++) {
        const ill = Math.max(1e-3, sampleGainMap(m, u, v, mono ? 0 : ch))
        out[o + ch] = strength === 1 ? 1 / ill : Math.pow(ill, -strength)
      }
    }
  }
  return out
}

const SRGB_DECODE = (() => {
  const t = new Float32Array(256)
  for (let i = 0; i < 256; i++) { const c = i / 255; t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
  return t
})()
const ENCODE_N = 4096
const SRGB_ENCODE = (() => {
  const t = new Uint8ClampedArray(ENCODE_N + 1)
  for (let i = 0; i <= ENCODE_N; i++) { const l = i / ENCODE_N; t[i] = Math.round(255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055)) }
  return t
})()

/** Multiply an RGBA buffer in place by a per-pixel multiplier (`buildShadingMultiplier`). Alpha untouched. */
export function applyMultiplierRgba(data: Uint8ClampedArray, mult: Float32Array, linear = true): void {
  const n = mult.length / 3
  if (linear) {
    for (let i = 0; i < n; i++) {
      const p = i * 4, m = i * 3
      data[p] = SRGB_ENCODE[Math.min(ENCODE_N, Math.round(SRGB_DECODE[data[p]] * mult[m] * ENCODE_N))]
      data[p + 1] = SRGB_ENCODE[Math.min(ENCODE_N, Math.round(SRGB_DECODE[data[p + 1]] * mult[m + 1] * ENCODE_N))]
      data[p + 2] = SRGB_ENCODE[Math.min(ENCODE_N, Math.round(SRGB_DECODE[data[p + 2]] * mult[m + 2] * ENCODE_N))]
    }
  } else {
    for (let i = 0; i < n; i++) {
      const p = i * 4, m = i * 3
      data[p] *= mult[m]; data[p + 1] *= mult[m + 1]; data[p + 2] *= mult[m + 2]   // Uint8ClampedArray clamps and rounds
    }
  }
}

/** Divide an 8-bit RGBA image by a relative-illumination map, in place (see `ApplyGainMapOptions`). */
export function applyGainMapRgba(data: Uint8ClampedArray, w: number, h: number, map: IlluminationMap, opts: ApplyGainMapOptions = {}): void {
  applyMultiplierRgba(data, buildShadingMultiplier(w, h, map, opts), opts.linear ?? true)
}
