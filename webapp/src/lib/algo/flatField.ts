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
