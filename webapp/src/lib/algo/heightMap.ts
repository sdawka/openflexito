/** Height-map maths for scan autofocus: given focused z measured at a coarse sub-grid of tiles
 *  (corners + every Nth tile), predict z for the remaining tiles so the scan only needs to
 *  autofocus at the sub-grid points. Pure maths, no device I/O — see `services/autofocusService`
 *  for the actual autofocus call and `routes/Scan.svelte` for how this is wired into a scan. */

import { stepsToUm } from './depthMap'

export interface HeightSample { col: number; row: number; z: number }

export interface Plane { a: number; b: number; c: number }   // z = a*col + b*row + c

/** Least-squares plane through (col, row, z) samples (normal equations, 3x3 solve). */
export function fitPlane(samples: HeightSample[]): Plane {
  if (samples.length < 3) {
    // not enough points for a plane: fall back to the mean (flat) or a single point
    const z = samples.reduce((s, p) => s + p.z, 0) / Math.max(1, samples.length)
    return { a: 0, b: 0, c: z }
  }
  let Sc = 0, Sr = 0, Scc = 0, Srr = 0, Scr = 0, Sz = 0, Scz = 0, Srz = 0
  const n = samples.length
  for (const { col, row, z } of samples) {
    Sc += col; Sr += row; Scc += col * col; Srr += row * row; Scr += col * row
    Sz += z; Scz += col * z; Srz += row * z
  }
  // solve [[Scc,Scr,Sc],[Scr,Srr,Sr],[Sc,Sr,n]] [a,b,c] = [Scz,Srz,Sz]
  const M = [[Scc, Scr, Sc], [Scr, Srr, Sr], [Sc, Sr, n]]
  const v = [Scz, Srz, Sz]
  const sol = solve3(M, v)
  if (!sol) { const z = Sz / n; return { a: 0, b: 0, c: z } }
  const [a, b, c] = sol
  return { a, b, c }
}

export function planeZ(p: Plane, col: number, row: number): number {
  return p.a * col + p.b * row + p.c
}

function solve3(m: number[][], v: number[]): number[] | null {
  const [[a, b, c], [d, e, f], [g, h, i]] = m
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-12) return null
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g)
  const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d
  const inv = [[A / det, D / det, G / det], [B / det, E / det, H / det], [C / det, F / det, I / det]]
  return [
    inv[0][0] * v[0] + inv[0][1] * v[1] + inv[0][2] * v[2],
    inv[1][0] * v[0] + inv[1][1] * v[1] + inv[1][2] * v[2],
    inv[2][0] * v[0] + inv[2][1] * v[1] + inv[2][2] * v[2],
  ]
}

/** Median absolute deviation, scaled to be a consistent estimator of sigma for a normal distribution. */
function robustSigma(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y)
  const median = sorted[Math.floor(sorted.length / 2)]
  const dev = sorted.map((v) => Math.abs(v - median)).sort((x, y) => x - y)
  const mad = dev[Math.floor(dev.length / 2)]
  return mad * 1.4826
}

/** Drop samples whose residual from a plane fit is far outside the spread of everyone else's
 *  residual, one at a time, and refit. A single bad autofocus reading (e.g. dust on the coverslip)
 *  has enough leverage to tilt an ordinary least-squares fit towards itself — a global MAD of the
 *  contaminated fit's residuals can then look tiny and hide the very point that caused it — so each
 *  round measures the worst point's residual against the spread of the *other* residuals only,
 *  removes it if that stands out, and stops as soon as no more outliers are found. */
export function rejectOutliers(samples: HeightSample[], k = 3.5): HeightSample[] {
  if (samples.length < 4) return samples
  let current = samples
  const maxRemovals = Math.max(1, Math.floor(samples.length * 0.3))
  for (let round = 0; round < maxRemovals && current.length >= 4; round++) {
    const plane = fitPlane(current)
    const abs = current.map((s) => Math.abs(s.z - planeZ(plane, s.col, s.row)))
    let worst = 0
    for (let i = 1; i < abs.length; i++) if (abs[i] > abs[worst]) worst = i
    const rest = abs.filter((_, i) => i !== worst)
    const sigma = robustSigma(rest)
    const isOutlier = sigma < 1e-9 ? abs[worst] > 1e-9 : abs[worst] > k * sigma
    if (!isOutlier) break
    current = current.filter((_, i) => i !== worst)
  }
  return current.length >= 3 ? current : samples
}

/** A coarse sub-grid of measured heights: `step` tiles apart in both col and row, `subCols` x
 *  `subRows` nodes covering a `cols` x `rows` full grid (subCols = ceil(cols / step) + 1, etc). Missing
 *  nodes (not sampled, e.g. because the corner tile was clipped by a polygon region) are filled from
 *  the robust plane fit so bilinear interpolation always has four corners to work with. */
export interface SubGrid { step: number; subCols: number; subRows: number; z: number[][] }   // z[subRow][subCol]

export function buildSubGrid(cols: number, rows: number, step: number, samples: HeightSample[]): SubGrid {
  const subCols = Math.floor((cols - 1) / step) + 1
  const subRows = Math.floor((rows - 1) / step) + 1
  const clean = rejectOutliers(samples)
  const plane = fitPlane(clean)
  const z: number[][] = []
  for (let sr = 0; sr < subRows; sr++) {
    const rowArr: number[] = []
    const row = Math.min(sr * step, rows - 1)
    for (let sc = 0; sc < subCols; sc++) {
      const col = Math.min(sc * step, cols - 1)
      const hit = clean.find((s) => s.col === col && s.row === row)
      rowArr.push(hit ? hit.z : planeZ(plane, col, row))
    }
    z.push(rowArr)
  }
  return { step, subCols, subRows, z }
}

/** Bilinear interpolation of a sub-grid at an arbitrary (col, row) of the full grid. */
export function bilinearZ(grid: SubGrid, col: number, row: number): number {
  const fc = col / grid.step, fr = row / grid.step
  const c0 = Math.max(0, Math.min(grid.subCols - 1, Math.floor(fc)))
  const r0 = Math.max(0, Math.min(grid.subRows - 1, Math.floor(fr)))
  const c1 = Math.min(grid.subCols - 1, c0 + 1), r1 = Math.min(grid.subRows - 1, r0 + 1)
  const u = c1 > c0 ? Math.min(1, Math.max(0, fc - c0)) : 0
  const v = r1 > r0 ? Math.min(1, Math.max(0, fr - r0)) : 0
  const z00 = grid.z[r0][c0], z10 = grid.z[r0][c1], z01 = grid.z[r1][c0], z11 = grid.z[r1][c1]
  return z00 * (1 - u) * (1 - v) + z10 * u * (1 - v) + z01 * (1 - u) * v + z11 * u * v
}

/** Predict z for every (col, row) of a `cols` x `rows` grid from sparse measured samples.
 *  'bilinear' interpolates a coarse sub-grid (needs `step`, the sub-grid spacing used to measure);
 *  'plane' fits one global plane, robust to a stray bad reading either way. */
export function predictHeightMap(
  cols: number, rows: number, samples: HeightSample[], method: 'plane' | 'bilinear' = 'bilinear', step = 2,
): number[][] {
  if (method === 'plane' || samples.length < 3) {
    const plane = fitPlane(rejectOutliers(samples))
    return Array.from({ length: rows }, (_, row) => Array.from({ length: cols }, (_, col) => planeZ(plane, col, row)))
  }
  const grid = buildSubGrid(cols, rows, step, samples)
  return Array.from({ length: rows }, (_, row) => Array.from({ length: cols }, (_, col) => bilinearZ(grid, col, row)))
}

/** Indices 0..n-1 spaced `step` apart, always including the last one (so the far edge is measured
 *  even when it does not land on a multiple of `step`). */
export function subGridIndices(n: number, step: number): number[] {
  const s = Math.max(1, Math.floor(step))
  const idx: number[] = []
  for (let i = 0; i < n; i += s) idx.push(i)
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1)
  return idx
}

/** Whether (col, row) is one of the coarse sub-grid points ("corners + every Nth tile") for a
 *  `cols` x `rows` grid measured at `step` spacing. */
export function isSubGridCell(col: number, row: number, cols: number, rows: number, step: number): boolean {
  return subGridIndices(cols, step).includes(col) && subGridIndices(rows, step).includes(row)
}

/** Colour for a height-map legend/overlay: a blue (low) -> red (high) ramp over the z range. Always
 *  fed raw z steps (unit-agnostic, like `heightLegend` below) — colour position is a ratio, not a
 *  measurement, so it doesn't matter which unit z is in as long as zMin/zMax are the same unit. */
export function heightColor(z: number, zMin: number, zMax: number): string {
  const t = zMax > zMin ? Math.min(1, Math.max(0, (z - zMin) / (zMax - zMin))) : 0.5
  const hue = 220 - 220 * t   // 220 (blue) -> 0 (red)
  return `hsl(${hue.toFixed(0)} 80% 50%)`
}

export interface HeightLegend { min: number; max: number; unit: 'µm' | 'steps' }

/** Legend for a scan height-map's z range: µm if a z µm/step factor is supplied, plain z steps
 *  otherwise. Mirrors `algo/depthMap.ts#depthLegend` — pass the scan's own persisted
 *  `GalleryItem.scan.zUmPerStep` where present (µm/step *at scan time*) so the legend keeps its scale
 *  even if the stage calibration changes later; only fall back to Settings' current `stageStepUm.z`
 *  for scans saved before that field existed. */
export function heightLegend(zMin: number, zMax: number, umPerStep?: number): HeightLegend {
  if (umPerStep && umPerStep > 0) {
    const [min, max] = stepsToUm([zMin, zMax], umPerStep)
    return { min, max, unit: 'µm' }
  }
  return { min: zMin, max: zMax, unit: 'steps' }
}
