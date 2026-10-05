/** Self-calibrating illumination shading from scan tiles (pure TS, no DOM).
 *
 *  A stitched mosaic shows a repeated per-tile pattern when the illumination is not flat: radial
 *  vignetting plus a colour tint that changes across the field (a yellow corner, a magenta corner).
 *  One scalar gain per tile cannot remove it and a captured blank-field map is rarely at hand, so this
 *  module recovers the per-channel relative illumination field S(u, v) from the tiles themselves,
 *  using the overlaps (Goldman & Chen, "Vignette and exposure calibration and compensation", ICCV 2005,
 *  simplified to a log-linear least squares).
 *
 *  Model: a tile pixel is I = R · S(u, v) · G_t with R the scene radiance, (u, v) the normalised
 *  position in the tile and G_t a per-tile exposure gain. A scene point seen by tile a at (u1, v1) and
 *  by tile b at (u2, v2) gives, per channel,
 *      log Ia − log Ib = log S(u1, v1) − log S(u2, v2) + g_a − g_b
 *  which is linear in the unknowns once log S is a polynomial in (u − ½, v − ½) without constant term
 *  (a constant is indistinguishable from the gains). Pixel pairs are sampled on every overlap, the
 *  polynomial coefficients and the tile log gains are solved by iteratively reweighted least squares
 *  (Huber), so specimen mismatch and small misregistrations are down-weighted instead of biasing the
 *  fit. S = exp(poly) is sampled on a small grid and normalised to mean 1 per channel, ready to divide
 *  tiles by (`GainMap`, same convention as the stitcher's flat field).
 *
 *  Limits: the overlaps need texture that is seen by both tiles, a blank or saturated overlap carries no
 *  information (such samples are skipped). Only differences of S are observed, so a global colour cast
 *  or brightness is not separable from the scene; the mean-1 normalisation leaves it to the scene. With
 *  tiles overlapping along one axis only, the shading along the other axis is unobservable; a small
 *  ridge then returns zero for those terms (no correction) rather than failing. A polynomial of order
 *  4 models smooth vignetting; it cannot model dust shadows or sharp illumination edges.
 *
 *  `medianShading` is the crude alternative: the per-cell median across many tiles of a textured,
 *  non-repeating scene approaches the shading field. It needs no overlap and no positions but many
 *  tiles (≥ ~20) and a specimen that fills the field without large empty areas, otherwise the scene
 *  bleeds into the map. Callers should prefer `estimateShading` whenever the overlap fit succeeds
 *  (`ok`), and fall back to `medianShading` for scans with many tiles and little or no overlap. */

import type { GainMap, StitchTile, Vec } from './stitch'
import { normaliseGainMap } from './stitch'

/** Analysis-size RGB tile: interleaved r, g, b in 0..255 (floats). */
export interface RgbTile { data: Float32Array; width: number; height: number }

export interface ShadingOptions {
  /** Polynomial order of log S in (u − ½, v − ½); 2 = quadratic bowl, 4 (default) also fits the flatter centre of real vignetting. */
  order?: 2 | 4
  /** Size of the returned gain map (default 32×24). */
  grid?: { width: number; height: number }
  /** Minimum overlap extent in nominal tile px on both axes for a pair to be used (default 8). */
  minOverlapPx?: number
  /** Pixel pairs sampled per overlapping pair, on a regular grid (default 600). */
  maxSamplesPerPair?: number
  /** IRLS iterations after the initial unweighted solve (default 6). */
  iterations?: number
  /** Minimum number of accepted pixel pairs overall for a fit to be attempted (default 200). */
  minSamples?: number
  /** Robust log residual above which the result is flagged `ok: false` (default 0.12 ≈ 12 %). */
  maxRms?: number
}

export interface ShadingEstimate {
  /** Relative illumination, 3 channels, mean 1 per channel, in [0.3, 3]. Divide tiles by it. */
  map: GainMap
  /** Per-tile per-channel multiplicative gains (geometric mean 1 per channel) that also came out of the fit. */
  gains: [number, number, number][]
  /** Accepted pixel pairs. */
  samples: number
  /** Overlapping tile pairs that contributed samples. */
  pairs: number
  /** Robust (MAD-based) log residual of the final fit, averaged over channels. */
  rms: number
  /** False when the fit converged to an implausible residual: do not apply the map blindly. */
  ok: boolean
}

const GRID_W = 32, GRID_H = 24
const SAT = 250, DARK = 8
const CLAMP_LO = 0.3, CLAMP_HI = 3

/** Polynomial basis without constant term, in p = u − ½, q = v − ½. */
function basis(order: 2 | 4, u: number, v: number, out: Float64Array, off: number): void {
  const p = u - 0.5, q = v - 0.5
  out[off] = p; out[off + 1] = q; out[off + 2] = p * p; out[off + 3] = p * q; out[off + 4] = q * q
  if (order === 4) {
    const p2 = p * p, q2 = q * q
    out[off + 5] = p2 * p; out[off + 6] = p2 * q; out[off + 7] = p * q2; out[off + 8] = q2 * q
    out[off + 9] = p2 * p2; out[off + 10] = p2 * p * q; out[off + 11] = p2 * q2; out[off + 12] = p * q2 * q; out[off + 13] = q2 * q2
  }
}
const basisSize = (order: 2 | 4) => (order === 4 ? 14 : 5)

/** Bilinear sample of channel `ch` at image px coordinates (x, y) measured from the top-left corner (pixel centres at +0.5). */
function sampleRgb(img: RgbTile, x: number, y: number, out: Float64Array): void {
  const fx = Math.min(img.width - 1, Math.max(0, x - 0.5)), fy = Math.min(img.height - 1, Math.max(0, y - 0.5))
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(img.width - 1, x0 + 1), y1 = Math.min(img.height - 1, y0 + 1)
  const tx = fx - x0, ty = fy - y0
  const d = img.data, i00 = (y0 * img.width + x0) * 3, i01 = (y0 * img.width + x1) * 3, i10 = (y1 * img.width + x0) * 3, i11 = (y1 * img.width + x1) * 3
  for (let c = 0; c < 3; c++) {
    const top = d[i00 + c] * (1 - tx) + d[i01 + c] * tx, bot = d[i10 + c] * (1 - tx) + d[i11 + c] * tx
    out[c] = top * (1 - ty) + bot * ty
  }
}

/** Solve the symmetric positive (semi-)definite system A x = b in place by Cholesky; null when a pivot collapses. */
function choleskySolve(A: Float64Array, b: Float64Array, n: number): Float64Array | null {
  const L = A   // overwritten by the lower factor
  for (let j = 0; j < n; j++) {
    let d = L[j * n + j]
    for (let k = 0; k < j; k++) d -= L[j * n + k] * L[j * n + k]
    if (!(d > 1e-14)) return null
    d = Math.sqrt(d); L[j * n + j] = d
    for (let i = j + 1; i < n; i++) {
      let s = L[i * n + j]
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k]
      L[i * n + j] = s / d
    }
  }
  const x = new Float64Array(n)
  for (let i = 0; i < n; i++) {     // L y = b
    let s = b[i]
    for (let k = 0; k < i; k++) s -= L[i * n + k] * x[k]
    x[i] = s / L[i * n + i]
  }
  for (let i = n - 1; i >= 0; i--) { // Lᵀ x = y
    let s = x[i]
    for (let k = i + 1; k < n; k++) s -= L[k * n + i] * x[k]
    x[i] = s / L[i * n + i]
  }
  return x
}

function median(a: Float64Array | number[]): number {
  const s = Float64Array.from(a).sort()
  const m = s.length >> 1
  return s.length === 0 ? 0 : s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m])
}

/** Estimate the per-channel relative illumination field from the overlaps of placed tiles.
 *  `tiles` give the nominal tile size, `positions` the solved mosaic positions (same units), `images`
 *  the analysis-size RGB tiles (scale = image.width / tile.width, per tile). Returns null when there are
 *  too few usable pixel pairs or the system is degenerate; `ok: false` when the fit is implausible. */
export function estimateShading(tiles: StitchTile[], positions: Vec[], images: RgbTile[], opts: ShadingOptions = {}): ShadingEstimate | null {
  const order = opts.order ?? 4, K = basisSize(order), N = tiles.length
  const minOverlap = opts.minOverlapPx ?? 8, maxPer = Math.max(16, opts.maxSamplesPerPair ?? 600)
  const iterations = opts.iterations ?? 6, minSamples = opts.minSamples ?? 200, maxRms = opts.maxRms ?? 0.12
  const gw = opts.grid?.width ?? GRID_W, gh = opts.grid?.height ?? GRID_H
  if (N < 2 || positions.length !== N || images.length !== N) return null

  // ---- 1. sample pixel pairs on every overlap -------------------------------------------------
  const ua: number[] = [], va: number[] = [], ub: number[] = [], vb: number[] = [], ta: number[] = [], tb: number[] = []
  const rhs: number[][] = [[], [], []]
  const pa = new Float64Array(3), pb = new Float64Array(3)
  let pairs = 0
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
    const A = tiles[i], B = tiles[j], PA = positions[i], PB = positions[j]
    const x0 = Math.max(PA.x, PB.x), y0 = Math.max(PA.y, PB.y)
    const x1 = Math.min(PA.x + A.width, PB.x + B.width), y1 = Math.min(PA.y + A.height, PB.y + B.height)
    if (x1 - x0 < minOverlap || y1 - y0 < minOverlap) continue
    const ia = images[i], ib = images[j]
    if (ia.width < 2 || ia.height < 2 || ib.width < 2 || ib.height < 2) continue
    const sa = ia.width / A.width, sb = ib.width / B.width
    const s = Math.min(sa, sb)                              // coarser of the two analysis scales
    const areaPx = (x1 - x0) * (y1 - y0) * s * s
    const step = Math.max(1 / s, Math.sqrt(areaPx / maxPer) / s)   // mosaic px between samples
    const nx = Math.max(1, Math.floor((x1 - x0) / step)), ny = Math.max(1, Math.floor((y1 - y0) / step))
    const sx = (x1 - x0) / nx, sy = (y1 - y0) / ny
    const before = ua.length
    for (let yy = 0; yy < ny; yy++) for (let xx = 0; xx < nx; xx++) {
      const X = x0 + (xx + 0.5) * sx, Y = y0 + (yy + 0.5) * sy
      const u1 = (X - PA.x) / A.width, v1 = (Y - PA.y) / A.height, u2 = (X - PB.x) / B.width, v2 = (Y - PB.y) / B.height
      sampleRgb(ia, u1 * ia.width, v1 * ia.height, pa)
      sampleRgb(ib, u2 * ib.width, v2 * ib.height, pb)
      let good = true
      for (let c = 0; c < 3 && good; c++) good = pa[c] > DARK && pa[c] < SAT && pb[c] > DARK && pb[c] < SAT
      if (!good) continue
      ua.push(u1); va.push(v1); ub.push(u2); vb.push(v2); ta.push(i); tb.push(j)
      for (let c = 0; c < 3; c++) rhs[c].push(Math.log(pa[c]) - Math.log(pb[c]))
    }
    if (ua.length > before) pairs++
  }
  const M = ua.length
  if (pairs < 1 || M < minSamples) return null

  // ---- 2. per-channel IRLS on the sparse rows [basis(a) − basis(b) | +1 at a, −1 at b] -----------
  const n = K + N
  const rowVal = new Float64Array(M * K)
  const ba = new Float64Array(K), bb = new Float64Array(K)
  for (let m = 0; m < M; m++) {
    basis(order, ua[m], va[m], ba, 0); basis(order, ub[m], vb[m], bb, 0)
    for (let k = 0; k < K; k++) rowVal[m * K + k] = ba[k] - bb[k]
  }
  const coeffs: Float64Array[] = [], gains: Float64Array[] = [], rmsCh: number[] = []
  const Amat = new Float64Array(n * n), bvec = new Float64Array(n), w = new Float64Array(M), res = new Float64Array(M)
  const idx = new Int32Array(K + 2), val = new Float64Array(K + 2)
  for (let k = 0; k < K; k++) idx[k] = k
  for (let c = 0; c < 3; c++) {
    const y = rhs[c]
    w.fill(1)
    let x: Float64Array | null = null, scale = 0
    for (let it = 0; it <= iterations; it++) {
      Amat.fill(0); bvec.fill(0)
      for (let m = 0; m < M; m++) {
        const wm = w[m]
        if (wm <= 0) continue
        for (let k = 0; k < K; k++) val[k] = rowVal[m * K + k]
        idx[K] = K + ta[m]; val[K] = 1; idx[K + 1] = K + tb[m]; val[K + 1] = -1
        for (let p = 0; p < K + 2; p++) {
          const ip = idx[p], vp = val[p] * wm
          bvec[ip] += vp * y[m]
          for (let q = 0; q < K + 2; q++) Amat[ip * n + idx[q]] += vp * val[q]
        }
      }
      // gauge: Σ g_t = 0 (a soft row with the weight of the whole sample set)
      for (let t = 0; t < N; t++) for (let t2 = 0; t2 < N; t2++) Amat[(K + t) * n + K + t2] += M
      // ridge: keeps unobservable directions (tiles without overlaps, one-axis scans) at zero
      let maxDiag = 0
      for (let i = 0; i < n; i++) maxDiag = Math.max(maxDiag, Amat[i * n + i])
      const ridge = 1e-7 * maxDiag + 1e-12
      for (let i = 0; i < n; i++) Amat[i * n + i] += ridge
      x = choleskySolve(Amat, bvec, n)
      if (!x) return null
      // residuals and Huber weights
      for (let m = 0; m < M; m++) {
        let dot = x[K + ta[m]] - x[K + tb[m]]
        for (let k = 0; k < K; k++) dot += rowVal[m * K + k] * x[k]
        res[m] = y[m] - dot
      }
      const abs = new Float64Array(M)
      for (let m = 0; m < M; m++) abs[m] = Math.abs(res[m])
      scale = Math.max(1.4826 * median(abs), 1e-3)
      if (it === iterations) break
      const k = 1.345 * scale
      for (let m = 0; m < M; m++) w[m] = abs[m] <= k ? 1 : k / abs[m]
    }
    if (!x) return null
    coeffs.push(x.slice(0, K)); gains.push(x.slice(K)); rmsCh.push(scale)
  }

  // ---- 3. sample the field on the grid, normalise, clamp --------------------------------------
  const data = new Float32Array(gw * gh * 3)
  const bg = new Float64Array(K)
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    basis(order, (gx + 0.5) / gw, (gy + 0.5) / gh, bg, 0)
    for (let c = 0; c < 3; c++) {
      let s = 0
      for (let k = 0; k < K; k++) s += coeffs[c][k] * bg[k]
      data[(gy * gw + gx) * 3 + c] = Math.exp(s)
    }
  }
  let map = normaliseGainMap({ width: gw, height: gh, channels: 3, data })
  let finite = true
  for (let i = 0; i < map.data.length; i++) {
    const v = map.data[i]
    if (!Number.isFinite(v)) { finite = false; break }
    map.data[i] = Math.min(CLAMP_HI, Math.max(CLAMP_LO, v))
  }
  if (!finite) return null
  map = normaliseGainMap(map)

  const outGains: [number, number, number][] = []
  const meanG = [0, 0, 0]
  for (let c = 0; c < 3; c++) { let s = 0; for (let t = 0; t < N; t++) s += gains[c][t]; meanG[c] = s / N }
  for (let t = 0; t < N; t++) outGains.push([Math.exp(gains[0][t] - meanG[0]), Math.exp(gains[1][t] - meanG[1]), Math.exp(gains[2][t] - meanG[2])])
  const rms = (rmsCh[0] + rmsCh[1] + rmsCh[2]) / 3
  return { map, gains: outGains, samples: M, pairs, rms, ok: Number.isFinite(rms) && rms <= maxRms }
}

/** Crude shading from the per-cell median across tiles: each tile is box-averaged onto the grid and
 *  divided by its own mean (removing the per-tile gain), the median over tiles is taken per cell and
 *  channel, lightly smoothed and normalised to mean 1. Needs many tiles of a textured, non-repeating
 *  scene; returns null below 3 tiles. No positions or overlap required. */
export function medianShading(images: RgbTile[], grid: { width: number; height: number } = { width: GRID_W, height: GRID_H }): GainMap | null {
  const gw = grid.width, gh = grid.height, T = images.length
  if (T < 3 || gw < 1 || gh < 1) return null
  const cells = new Float64Array(T * gw * gh * 3)
  const cnt = new Float64Array(gw * gh)
  let used = 0
  for (let t = 0; t < T; t++) {
    const img = images[t]
    if (img.width < gw || img.height < gh) continue
    const base = used * gw * gh * 3
    cnt.fill(0)
    for (let y = 0; y < img.height; y++) {
      const gy = Math.min(gh - 1, Math.floor(y * gh / img.height))
      for (let x = 0; x < img.width; x++) {
        const gx = Math.min(gw - 1, Math.floor(x * gw / img.width)), ci = gy * gw + gx, pi = (y * img.width + x) * 3
        cells[base + ci * 3] += img.data[pi]; cells[base + ci * 3 + 1] += img.data[pi + 1]; cells[base + ci * 3 + 2] += img.data[pi + 2]
        cnt[ci]++
      }
    }
    const mean = [0, 0, 0]
    for (let ci = 0; ci < gw * gh; ci++) for (let c = 0; c < 3; c++) { cells[base + ci * 3 + c] /= cnt[ci] || 1; mean[c] += cells[base + ci * 3 + c] }
    for (let c = 0; c < 3; c++) mean[c] /= gw * gh
    if (mean.some((m) => !(m > DARK))) continue      // an (almost) black tile carries no shading
    for (let ci = 0; ci < gw * gh; ci++) for (let c = 0; c < 3; c++) cells[base + ci * 3 + c] /= mean[c]
    used++
  }
  if (used < 3) return null
  const med = new Float32Array(gw * gh * 3)
  const col = new Float64Array(used)
  for (let ci = 0; ci < gw * gh; ci++) for (let c = 0; c < 3; c++) {
    for (let t = 0; t < used; t++) col[t] = cells[(t * gw * gh + ci) * 3 + c]
    med[ci * 3 + c] = median(col)
  }
  // two passes of a 3×3 box blur, edges replicated
  let src = med
  for (let pass = 0; pass < 2; pass++) {
    const dst = new Float32Array(src.length)
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) for (let c = 0; c < 3; c++) {
      let s = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = Math.min(gh - 1, Math.max(0, gy + dy)), xx = Math.min(gw - 1, Math.max(0, gx + dx))
        s += src[(yy * gw + xx) * 3 + c]
      }
      dst[(gy * gw + gx) * 3 + c] = s / 9
    }
    src = dst
  }
  const map = normaliseGainMap({ width: gw, height: gh, channels: 3, data: src })
  for (let i = 0; i < map.data.length; i++) map.data[i] = Math.min(CLAMP_HI, Math.max(CLAMP_LO, map.data[i]))
  return normaliseGainMap(map)
}
