/** Mosaic stitching maths (pure TS, no DOM): refine nominal tile positions with pairwise FFT
 *  correlation on overlaps, solve the positions globally with outlier rejection, equalise per-tile
 *  luminance gains from overlap statistics, optionally divide tiles by a flat-field gain map, and blend
 *  tiles as a normalised weighted average (Σw·rgb / Σw) with feather weights, either directly (in row
 *  bands, so an 8192² mosaic never needs a full-size float accumulator) or with a 2-3 level Laplacian
 *  multi-band blend. Approach after openflexure-stitching, simplified. */

import { displacement } from './fftTrack'
import type { Gray } from './sharpness'

export interface StitchTile { id: number; x: number; y: number; width: number; height: number }   // nominal px positions
export interface PairOffset { a: number; b: number; dx: number; dy: number; weight: number }
export interface Vec { x: number; y: number }

function crop(g: Gray, x0: number, y0: number, w: number, h: number): Gray {
  const data = new Float32Array(w * h)
  for (let y = 0; y < h; y++) data.set(g.data.subarray((y0 + y) * g.width + x0, (y0 + y) * g.width + x0 + w), y * w)
  return { data, width: w, height: h }
}

/** Overlap rectangle of two placed tiles in mosaic px, or null when they do not overlap. */
function overlapRect(a: StitchTile, pa: Vec, b: StitchTile, pb: Vec): { x0: number; y0: number; x1: number; y1: number } | null {
  const x0 = Math.max(pa.x, pb.x), y0 = Math.max(pa.y, pb.y)
  const x1 = Math.min(pa.x + a.width, pb.x + b.width), y1 = Math.min(pa.y + a.height, pb.y + b.height)
  return x1 > x0 && y1 > y0 ? { x0, y0, x1, y1 } : null
}

/** For every overlapping pair, measure the actual offset (b relative to a) from the overlap region.
 *  `images` are downsampled greyscale versions of the tiles (scale = image width / tile width). */
export function pairwiseOffsets(tiles: StitchTile[], images: Gray[], minOverlapPx = 24, minQuality = 1.3): PairOffset[] {
  const out: PairOffset[] = []
  for (let i = 0; i < tiles.length; i++) for (let j = i + 1; j < tiles.length; j++) {
    const a = tiles[i], b = tiles[j], ia = images[i], ib = images[j]
    const s = ia.width / a.width
    const r = overlapRect(a, a, b, b)
    if (!r) continue
    const ow = Math.floor((r.x1 - r.x0) * s), oh = Math.floor((r.y1 - r.y0) * s)
    if (ow < minOverlapPx || oh < minOverlapPx) continue
    const ca = crop(ia, Math.floor((r.x0 - a.x) * s), Math.floor((r.y0 - a.y) * s), ow, oh)
    const cb = crop(ib, Math.floor((r.x0 - b.x) * s), Math.floor((r.y0 - b.y) * s), ow, oh)
    const d = displacement(ca, cb)
    if (!Number.isFinite(d.quality) || d.quality < minQuality) continue
    // content in b appears shifted by (dx,dy) relative to a -> b's true position is nominal minus the shift
    out.push({ a: i, b: j, dx: (b.x - a.x) - d.dx / s, dy: (b.y - a.y) - d.dy / s, weight: Math.min(d.quality, 10) })
  }
  return out
}

/** Solve for positions p minimising sum w (p_b - p_a - d)^2 with p_0 fixed (Gauss-Seidel iterations).
 *  The result is shifted so the mosaic starts at (0,0). */
export function solvePositions(tiles: StitchTile[], pairs: PairOffset[], iterations = 200): Vec[] {
  const pos = tiles.map((t) => ({ x: t.x, y: t.y }))
  if (!pairs.length) return normaliseOrigin(pos)
  const adj: { other: number; dx: number; dy: number; w: number }[][] = tiles.map(() => [])
  for (const p of pairs) {
    adj[p.b].push({ other: p.a, dx: p.dx, dy: p.dy, w: p.weight })
    adj[p.a].push({ other: p.b, dx: -p.dx, dy: -p.dy, w: p.weight })
  }
  for (let it = 0; it < iterations; it++) {
    for (let i = 1; i < tiles.length; i++) {
      if (!adj[i].length) continue
      let sx = 0, sy = 0, sw = 0
      for (const e of adj[i]) { sx += e.w * (pos[e.other].x + e.dx); sy += e.w * (pos[e.other].y + e.dy); sw += e.w }
      pos[i] = { x: sx / sw, y: sy / sw }
    }
  }
  return normaliseOrigin(pos)
}

function normaliseOrigin(pos: Vec[]): Vec[] {
  let minX = Infinity, minY = Infinity
  for (const p of pos) { if (p.x < minX) minX = p.x; if (p.y < minY) minY = p.y }
  return pos.map((p) => ({ x: p.x - minX, y: p.y - minY }))
}

/** Residual |p_b - p_a - d| of every pair for a set of positions. Positions may be origin-shifted:
 *  only differences matter. */
export function pairResiduals(pos: Vec[], pairs: PairOffset[]): number[] {
  return pairs.map((p) => Math.hypot(pos[p.b].x - pos[p.a].x - p.dx, pos[p.b].y - pos[p.a].y - p.dy))
}

function median(v: number[]): number {
  if (!v.length) return 0
  const s = [...v].sort((a, b) => a - b), m = s.length >> 1
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m])
}

export interface RobustSolve {
  positions: Vec[]
  kept: PairOffset[]
  dropped: PairOffset[]
  /** the rejection threshold in px (median + k·MAD, never below `floorPx`) */
  threshold: number
}

/** Position solve with MAD-based outlier rejection: solve once with every pair, compute each pair's
 *  residual, drop pairs whose residual exceeds median + k·MAD (MAD scaled by 1.4826 to estimate σ; the
 *  threshold never drops below `floorPx` so honest sub-pixel scatter is kept), and re-solve with the
 *  rest. Pairs are only dropped when at least three remain, otherwise nothing can be called an outlier. */
export function solvePositionsRobust(tiles: StitchTile[], pairs: PairOffset[], k = 3, floorPx = 1.5, iterations = 200): RobustSolve {
  const first = solvePositions(tiles, pairs, iterations)
  if (pairs.length < 3) return { positions: first, kept: pairs, dropped: [], threshold: Infinity }
  const r = pairResiduals(first, pairs)
  const med = median(r), mad = 1.4826 * median(r.map((x) => Math.abs(x - med)))
  const threshold = Math.max(floorPx, med + k * mad)
  const kept: PairOffset[] = [], dropped: PairOffset[] = []
  pairs.forEach((p, i) => (r[i] <= threshold ? kept : dropped).push(p))
  if (!dropped.length) return { positions: first, kept, dropped, threshold }
  return { positions: solvePositions(tiles, kept, iterations), kept, dropped, threshold }
}

// ---- luminance gain equalisation ----------------------------------------------------------------

export interface PairGain { a: number; b: number; logRatio: number; weight: number }   // ln(mean_b / mean_a) over the overlap

/** Mean luminance of each tile over every pairwise overlap (using the solved positions), as log
 *  ratios. `images` are the downsampled greys used for correlation (or flat-field-corrected copies). */
export function overlapGains(tiles: StitchTile[], positions: Vec[], images: Gray[], minOverlapPx = 8): PairGain[] {
  const out: PairGain[] = []
  for (let i = 0; i < tiles.length; i++) for (let j = i + 1; j < tiles.length; j++) {
    const a = tiles[i], b = tiles[j], ia = images[i], ib = images[j]
    const s = ia.width / a.width
    const r = overlapRect(a, positions[i], b, positions[j])
    if (!r) continue
    const ow = Math.floor((r.x1 - r.x0) * s), oh = Math.floor((r.y1 - r.y0) * s)
    if (ow < minOverlapPx || oh < minOverlapPx) continue
    const ax = Math.max(0, Math.floor((r.x0 - positions[i].x) * s)), ay = Math.max(0, Math.floor((r.y0 - positions[i].y) * s))
    const bx = Math.max(0, Math.floor((r.x0 - positions[j].x) * s)), by = Math.max(0, Math.floor((r.y0 - positions[j].y) * s))
    const w = Math.min(ow, ia.width - ax, ib.width - bx), h = Math.min(oh, ia.height - ay, ib.height - by)
    if (w < minOverlapPx || h < minOverlapPx) continue
    const ma = meanOf(ia, ax, ay, w, h), mb = meanOf(ib, bx, by, w, h)
    if (!(ma > 1) || !(mb > 1)) continue
    out.push({ a: i, b: j, logRatio: Math.log(mb / ma), weight: Math.sqrt(w * h) })
  }
  return out
}

function meanOf(g: Gray, x0: number, y0: number, w: number, h: number): number {
  let s = 0
  for (let y = 0; y < h; y++) { const row = (y0 + y) * g.width + x0; for (let x = 0; x < w; x++) s += g.data[row + x] }
  return s / (w * h)
}

/** Least-squares log gains: minimise Σ w (g_b - g_a + logRatio)² + λ Σ g² over all tiles (the small
 *  ridge term anchors disconnected components), Gauss-Seidel like `solvePositions`, then the gains
 *  are normalised to a geometric mean of 1 and clamped to [1/maxGain, maxGain]. Returns multiplicative
 *  gains per tile: multiply tile b by gains[b] so overlapping tiles agree in brightness. */
export function solveGains(n: number, pairs: PairGain[], maxGain = 2, iterations = 200): number[] {
  const g = new Float64Array(n)
  if (!pairs.length || n === 0) return Array.from({ length: n }, () => 1)
  const adj: { other: number; d: number; w: number }[][] = Array.from({ length: n }, () => [])
  let wsum = 0
  for (const p of pairs) {
    // want g_b - g_a = -logRatio
    adj[p.b].push({ other: p.a, d: -p.logRatio, w: p.weight })
    adj[p.a].push({ other: p.b, d: p.logRatio, w: p.weight })
    wsum += p.weight
  }
  const lambda = 1e-3 * (wsum / pairs.length)
  for (let it = 0; it < iterations; it++) {
    for (let i = 0; i < n; i++) {
      if (!adj[i].length) continue
      let s = 0, sw = lambda
      for (const e of adj[i]) { s += e.w * (g[e.other] + e.d); sw += e.w }
      g[i] = s / sw
    }
  }
  let mean = 0
  for (let i = 0; i < n; i++) mean += g[i]
  mean /= n
  const lim = Math.log(maxGain)
  return Array.from(g, (v) => Math.exp(Math.max(-lim, Math.min(lim, v - mean))))
}

// ---- flat field -----------------------------------------------------------------------------------

/** Relative illumination of a blank field, downscaled: 1 = average, < 1 = darker (vignetted) corners.
 *  Tiles are divided by it. `channels` 1 = luminance gain, 3 = per-channel RGB. */
export interface GainMap { width: number; height: number; channels: 1 | 3; data: Float32Array }

/** Scale a map so its mean is 1 per channel (so dividing by it preserves overall brightness). */
export function normaliseGainMap(map: GainMap): GainMap {
  const n = map.width * map.height, c = map.channels
  const out = new Float32Array(map.data.length)
  for (let ch = 0; ch < c; ch++) {
    let s = 0
    for (let i = 0; i < n; i++) s += map.data[i * c + ch]
    const m = s / n || 1
    for (let i = 0; i < n; i++) out[i * c + ch] = Math.max(0.05, map.data[i * c + ch] / m)
  }
  return { ...map, data: out }
}

/** Bilinear sample of channel `ch` at normalised coordinates (u, v) in [0, 1] (pixel centres). */
export function sampleGainMap(map: GainMap, u: number, v: number, ch = 0): number {
  const c = map.channels
  const fx = Math.min(map.width - 1, Math.max(0, u * map.width - 0.5)), fy = Math.min(map.height - 1, Math.max(0, v * map.height - 0.5))
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(map.width - 1, x0 + 1), y1 = Math.min(map.height - 1, y0 + 1)
  const tx = fx - x0, ty = fy - y0
  const d = map.data
  const top = d[(y0 * map.width + x0) * c + ch] * (1 - tx) + d[(y0 * map.width + x1) * c + ch] * tx
  const bot = d[(y1 * map.width + x0) * c + ch] * (1 - tx) + d[(y1 * map.width + x1) * c + ch] * tx
  return top * (1 - ty) + bot * ty
}

/** Divide a greyscale tile by the (luminance or mean-RGB) gain map, resampled to the tile's size. */
export function applyFlatField(g: Gray, map: GainMap): Gray {
  const out = new Float32Array(g.data.length)
  for (let y = 0; y < g.height; y++) {
    const v = (y + 0.5) / g.height
    for (let x = 0; x < g.width; x++) {
      const u = (x + 0.5) / g.width
      let k = sampleGainMap(map, u, v, 0)
      if (map.channels === 3) k = (k + sampleGainMap(map, u, v, 1) + sampleGainMap(map, u, v, 2)) / 3
      out[y * g.width + x] = g.data[y * g.width + x] / k
    }
  }
  return { data: out, width: g.width, height: g.height }
}

/** Divide RGBA pixels in place by the gain map. `data` is a `w`×`h` strip of a tile of size
 *  `tileW`×`tileH` whose top-left is at (offX, offY) within the tile (so strips of a banded render
 *  sample the right part of the map). Values are clamped to 0..255. */
export function applyFlatFieldRGBA(data: Uint8ClampedArray, w: number, h: number, map: GainMap, tileW = w, tileH = h, offX = 0, offY = 0): void {
  for (let y = 0; y < h; y++) {
    const v = (offY + y + 0.5) / tileH
    for (let x = 0; x < w; x++) {
      const u = (offX + x + 0.5) / tileW, i = (y * w + x) * 4
      if (map.channels === 1) {
        const k = 1 / sampleGainMap(map, u, v, 0)
        data[i] = data[i] * k; data[i + 1] = data[i + 1] * k; data[i + 2] = data[i + 2] * k
      } else {
        data[i] = data[i] / sampleGainMap(map, u, v, 0); data[i + 1] = data[i + 1] / sampleGainMap(map, u, v, 1); data[i + 2] = data[i + 2] / sampleGainMap(map, u, v, 2)
      }
    }
  }
}

// ---- blending -------------------------------------------------------------------------------------

/** Per-pixel feather weight for blending: 1 in the middle, tapering to 0 over `feather` px at the edges. */
export function featherWeight(x: number, y: number, w: number, h: number, feather: number): number {
  const fx = Math.min(1, Math.min(x + 0.5, w - x - 0.5) / feather)
  const fy = Math.min(1, Math.min(y + 0.5, h - y - 0.5) / feather)
  return Math.max(0, fx) * Math.max(0, fy)
}

/** A horizontal strip of one placed tile, ready to be accumulated: RGBA pixels of `width`×`height`
 *  whose top-left sits at mosaic (x, y); the whole tile is at (tileX, tileY) with size tileW×tileH,
 *  so feather weights can be computed for the strip's pixels. `gain` multiplies the colour. */
export interface BlendStrip {
  data: Uint8ClampedArray; width: number; height: number
  x: number; y: number
  tileX: number; tileY: number; tileW: number; tileH: number
  gain?: number
}

/** Normalised weighted-average accumulator (Σw·rgb / Σw) for one row band of the mosaic, in Float32
 *  planes. Memory is 16 bytes per band pixel, so a 8192-wide band of 512 rows is 64 MB regardless
 *  of the mosaic height: render a large mosaic band by band. Pixels no tile covers come out black. */
export class BandAccumulator {
  readonly r: Float32Array; readonly g: Float32Array; readonly b: Float32Array; readonly w: Float32Array
  y0 = 0
  constructor(public readonly width: number, public readonly bandHeight: number) {
    const n = width * bandHeight
    this.r = new Float32Array(n); this.g = new Float32Array(n); this.b = new Float32Array(n); this.w = new Float32Array(n)
  }
  /** Start a new band whose first mosaic row is `y0`. */
  reset(y0: number): void { this.y0 = y0; this.r.fill(0); this.g.fill(0); this.b.fill(0); this.w.fill(0) }
  /** Accumulate a strip that lies (at least partly) inside the current band. */
  add(s: BlendStrip, feather: number): void {
    const gain = s.gain ?? 1
    const yStart = Math.max(s.y, this.y0), yEnd = Math.min(s.y + s.height, this.y0 + this.bandHeight)
    const xStart = Math.max(s.x, 0), xEnd = Math.min(s.x + s.width, this.width)
    for (let y = yStart; y < yEnd; y++) {
      const ty = y - s.tileY, sy = y - s.y, by = y - this.y0
      for (let x = xStart; x < xEnd; x++) {
        const i = (sy * s.width + (x - s.x)) * 4
        const a = s.data[i + 3] / 255
        if (a === 0) continue
        const wgt = featherWeight(x - s.tileX, ty, s.tileW, s.tileH, feather) * a
        if (wgt <= 0) continue
        const o = by * this.width + x
        this.r[o] += wgt * gain * s.data[i]; this.g[o] += wgt * gain * s.data[i + 1]; this.b[o] += wgt * gain * s.data[i + 2]; this.w[o] += wgt
      }
    }
  }
  /** Normalised 8-bit RGBA of the band (rows beyond `rows` are left untouched). */
  toRGBA(rows = this.bandHeight, out?: Uint8ClampedArray): Uint8ClampedArray {
    const n = this.width * rows
    const o = out ?? new Uint8ClampedArray(n * 4)
    for (let i = 0; i < n; i++) {
      const w = this.w[i]
      if (w > 0) { o[i * 4] = this.r[i] / w; o[i * 4 + 1] = this.g[i] / w; o[i * 4 + 2] = this.b[i] / w } else { o[i * 4] = 0; o[i * 4 + 1] = 0; o[i * 4 + 2] = 0 }
      o[i * 4 + 3] = 255
    }
    return o
  }
}

/** Rows per band so the accumulator stays under `budgetBytes` (16 B per pixel), at least `minRows`. */
export function bandRows(width: number, height: number, budgetBytes = 128e6, minRows = 32): number {
  return Math.max(minRows, Math.min(height, Math.floor(budgetBytes / 16 / Math.max(1, width))))
}

// ---- multi-band (Laplacian) blending ---------------------------------------------------------------

/** 2× downsample with the separable [1 3 3 1]/8 kernel centred on the half-pixel between samples
 *  (so sample i of the result sits at 2i + 0.5 of the source, matching `pyrUp`); edges reflected.
 *  Output size ceil(w/2)×ceil(h/2). */
export function pyrDown(src: Float32Array, w: number, h: number): { data: Float32Array; width: number; height: number } {
  const ow = Math.ceil(w / 2), oh = Math.ceil(h / 2)
  const tmp = new Float32Array(ow * h)
  const k = [1 / 8, 3 / 8, 3 / 8, 1 / 8]
  const refl = (i: number, n: number) => (i < 0 ? -i - 1 : i >= n ? 2 * n - 1 - i : i)
  for (let y = 0; y < h; y++) for (let x = 0; x < ow; x++) {
    let s = 0
    for (let t = -1; t <= 2; t++) s += k[t + 1] * src[y * w + refl(2 * x + t, w)]
    tmp[y * ow + x] = s
  }
  const out = new Float32Array(ow * oh)
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    let s = 0
    for (let t = -1; t <= 2; t++) s += k[t + 1] * tmp[refl(2 * y + t, h) * ow + x]
    out[y * ow + x] = s
  }
  return { data: out, width: ow, height: oh }
}

/** 2× bilinear upsample of a `w`×`h` plane to `ow`×`oh` (the size of the level below). */
export function pyrUp(src: Float32Array, w: number, h: number, ow: number, oh: number): Float32Array {
  const out = new Float32Array(ow * oh)
  for (let y = 0; y < oh; y++) {
    const fy = Math.min(h - 1, Math.max(0, (y + 0.5) / 2 - 0.5)), y0 = Math.floor(fy), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0
    for (let x = 0; x < ow; x++) {
      const fx = Math.min(w - 1, Math.max(0, (x + 0.5) / 2 - 0.5)), x0 = Math.floor(fx), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0
      out[y * ow + x] = (src[y0 * w + x0] * (1 - tx) + src[y0 * w + x1] * tx) * (1 - ty) + (src[y1 * w + x0] * (1 - tx) + src[y1 * w + x1] * tx) * ty
    }
  }
  return out
}

export interface PlacedTile { data: Uint8ClampedArray; width: number; height: number; x: number; y: number; gain?: number }

interface Level { r: Float32Array; g: Float32Array; b: Float32Array; w: Float32Array; width: number; height: number }

/** Multi-band blend: each tile's RGB is decomposed into a Laplacian pyramid of `levels` levels and its
 *  feather mask into a Gaussian pyramid; per level the mosaic accumulates Σ w_k·L_k / Σ w_k, then the
 *  pyramid is collapsed. Low frequencies (exposure, vignetting residue) are blended over wide
 *  regions while fine detail keeps a sharp transition. Tile origins are integer mosaic px; tiles are
 *  padded on the left/top so every pyramid level aligns exactly on the mosaic grid. Memory is about
 *  21 bytes per mosaic pixel of Float32 planes: cap the mosaic size before calling this. */
export function blendMultiband(tiles: PlacedTile[], W: number, H: number, feather: number, levels = 3): Uint8ClampedArray {
  levels = Math.max(1, Math.min(4, levels))
  const align = 1 << levels
  // mosaic pyramid dimensions (padded so every level halves exactly)
  const PW = Math.ceil(W / align) * align, PH = Math.ceil(H / align) * align
  const dims: { width: number; height: number }[] = []
  for (let k = 0, w = PW, h = PH; k < levels; k++, w = Math.ceil(w / 2), h = Math.ceil(h / 2)) dims.push({ width: w, height: h })
  const acc: Level[] = dims.map((d) => ({ r: new Float32Array(d.width * d.height), g: new Float32Array(d.width * d.height), b: new Float32Array(d.width * d.height), w: new Float32Array(d.width * d.height), ...d }))

  for (const t of tiles) {
    const gain = t.gain ?? 1
    const padX = ((t.x % align) + align) % align, padY = ((t.y % align) + align) % align
    const ox = t.x - padX, oy = t.y - padY   // aligned origin
    const tw = Math.ceil((t.width + padX) / align) * align, th = Math.ceil((t.height + padY) / align) * align
    let r = new Float32Array(tw * th), g = new Float32Array(tw * th), b = new Float32Array(tw * th), w = new Float32Array(tw * th)
    for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) {
      const i = (y * t.width + x) * 4, o = (y + padY) * tw + x + padX
      const wgt = featherWeight(x, y, t.width, t.height, feather) * (t.data[i + 3] / 255)
      r[o] = gain * t.data[i]; g[o] = gain * t.data[i + 1]; b[o] = gain * t.data[i + 2]; w[o] = wgt
    }
    // outside the tile (padding) fill colour by nearest tile pixel so the Laplacian does not ring at the tile edge
    fillPadding(r, tw, th, padX, padY, t.width, t.height); fillPadding(g, tw, th, padX, padY, t.width, t.height); fillPadding(b, tw, th, padX, padY, t.width, t.height)
    let cw = tw, ch = th
    for (let k = 0; k < levels; k++) {
      const last = k === levels - 1
      let lr = r, lg = g, lb = b
      let nr: ReturnType<typeof pyrDown> | null = null, ng: ReturnType<typeof pyrDown> | null = null, nb: ReturnType<typeof pyrDown> | null = null, nw: ReturnType<typeof pyrDown> | null = null
      if (!last) {
        nr = pyrDown(r, cw, ch); ng = pyrDown(g, cw, ch); nb = pyrDown(b, cw, ch); nw = pyrDown(w, cw, ch)
        const ur = pyrUp(nr.data, nr.width, nr.height, cw, ch), ug = pyrUp(ng.data, ng.width, ng.height, cw, ch), ub = pyrUp(nb.data, nb.width, nb.height, cw, ch)
        lr = new Float32Array(cw * ch); lg = new Float32Array(cw * ch); lb = new Float32Array(cw * ch)
        for (let i = 0; i < lr.length; i++) { lr[i] = r[i] - ur[i]; lg[i] = g[i] - ug[i]; lb[i] = b[i] - ub[i] }
      }
      // accumulate into the mosaic level at offset (ox, oy) >> k
      const L = acc[k], sx = ox >> k, sy = oy >> k
      for (let y = 0; y < ch; y++) {
        const my = sy + y
        if (my < 0 || my >= L.height) continue
        for (let x = 0; x < cw; x++) {
          const mx = sx + x
          if (mx < 0 || mx >= L.width) continue
          const wi = w[y * cw + x]
          if (wi <= 0) continue
          const o = my * L.width + mx, i = y * cw + x
          L.r[o] += wi * lr[i]; L.g[o] += wi * lg[i]; L.b[o] += wi * lb[i]; L.w[o] += wi
        }
      }
      if (!last) { r = nr!.data as Float32Array<ArrayBuffer>; g = ng!.data as Float32Array<ArrayBuffer>; b = nb!.data as Float32Array<ArrayBuffer>; w = nw!.data as Float32Array<ArrayBuffer>; cw = nr!.width; ch = nr!.height }
    }
  }
  // normalise each level, then collapse from the top
  for (const L of acc) for (let i = 0; i < L.w.length; i++) { const w = L.w[i]; if (w > 0) { L.r[i] /= w; L.g[i] /= w; L.b[i] /= w } }
  let top = acc[levels - 1], cr = top.r, cg = top.g, cb = top.b
  for (let k = levels - 2; k >= 0; k--) {
    const L = acc[k], up = acc[k + 1]
    const ur = pyrUp(cr, up.width, up.height, L.width, L.height), ug = pyrUp(cg, up.width, up.height, L.width, L.height), ub = pyrUp(cb, up.width, up.height, L.width, L.height)
    for (let i = 0; i < ur.length; i++) { ur[i] += L.r[i]; ug[i] += L.g[i]; ub[i] += L.b[i] }
    cr = ur; cg = ug; cb = ub
  }
  const out = new Uint8ClampedArray(W * H * 4)
  const cover = acc[0].w
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * PW + x, o = (y * W + x) * 4
    if (cover[i] > 0) { out[o] = cr[i]; out[o + 1] = cg[i]; out[o + 2] = cb[i] }
    out[o + 3] = 255
  }
  return out
}

/** Replicate the tile's edge pixels into the padding region of an aligned plane. */
function fillPadding(p: Float32Array, tw: number, th: number, padX: number, padY: number, w: number, h: number): void {
  for (let y = 0; y < th; y++) {
    const sy = Math.min(padY + h - 1, Math.max(padY, y))
    for (let x = 0; x < tw; x++) {
      if (y >= padY && y < padY + h && x >= padX && x < padX + w) continue
      const sx = Math.min(padX + w - 1, Math.max(padX, x))
      p[y * tw + x] = p[sy * tw + sx]
    }
  }
}
