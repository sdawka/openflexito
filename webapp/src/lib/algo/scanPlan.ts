/** Tile scan planning: grid positions in stage steps from field-of-view and overlap (port of the
 *  ideas in OpenFlexure v3 scan_planners.py: raster and snake orderings), plus programmable regions:
 *  point-in-polygon clipping for non-rectangular samples and a centre-outward spiral visiting order
 *  for round samples (see `filterByPolygon`, `spiralOrder` below). */

import type { Mat2 } from './csm'
import { apply2, invert2 } from './csm'

export interface ScanGrid { cols: number; rows: number; overlap: number }   // overlap 0..0.9 (fraction of FoV)

export interface TilePlan {
  index: number
  col: number
  row: number
  stage: { x: number; y: number }      // relative to the scan origin, in stage steps
  pixel: { x: number; y: number }      // nominal position of the tile's top-left in the mosaic (px)
}

/** Pixel pitch between neighbouring tiles for a given overlap. */
export function tilePitchPx(fovW: number, fovH: number, overlap: number): { dx: number; dy: number } {
  return { dx: Math.round(fovW * (1 - overlap)), dy: Math.round(fovH * (1 - overlap)) }
}

/** Plan a grid centred on the current position. `matrix` maps image px -> stage steps. */
export function planScan(grid: ScanGrid, fovW: number, fovH: number, matrix: Mat2, order: 'raster' | 'snake' = 'snake'): TilePlan[] {
  const { dx, dy } = tilePitchPx(fovW, fovH, grid.overlap)
  const tiles: TilePlan[] = []
  let index = 0
  for (let row = 0; row < grid.rows; row++) {
    const cols = [...Array(grid.cols).keys()]
    if (order === 'snake' && row % 2 === 1) cols.reverse()
    for (const col of cols) {
      // offset of this tile's centre from the grid centre, in pixels
      const px = (col - (grid.cols - 1) / 2) * dx, py = (row - (grid.rows - 1) / 2) * dy
      // moving the stage so that the scene shifts by (-px,-py) brings that region to the centre
      const [sx, sy] = apply2(matrix, [-px, -py])
      tiles.push({ index: index++, col, row, stage: { x: Math.round(sx), y: Math.round(sy) }, pixel: { x: col * dx, y: row * dy } })
    }
  }
  return tiles
}

/** Successive relative moves to visit the tiles in order (first move is from the origin). */
export function relativeMoves(tiles: TilePlan[]): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = []
  let prev = { x: 0, y: 0 }
  for (const t of tiles) { out.push({ x: t.stage.x - prev.x, y: t.stage.y - prev.y }); prev = t.stage }
  return out
}

export function mosaicSize(tiles: TilePlan[], fovW: number, fovH: number): { width: number; height: number } {
  let w = 0, h = 0
  for (const t of tiles) { w = Math.max(w, t.pixel.x + fovW); h = Math.max(h, t.pixel.y + fovH) }
  return { width: w, height: h }
}

// ---- programmable regions: polygon clipping and spiral ordering ------------------------------

export interface Point { x: number; y: number }

/** Point-in-polygon by ray casting (even-odd rule); `polygon` need not be convex. Points exactly on
 *  an edge may go either way, which is fine for keep/drop decisions on tile centres. */
export function pointInPolygon(pt: Point, polygon: Point[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y, xj = polygon[j].x, yj = polygon[j].y
    const intersects = yi > pt.y !== yj > pt.y && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi
    if (intersects) inside = !inside
  }
  return inside
}

/** Tile centre normalised to the mosaic's [0,1] x [0,1] box (independent of any particular preview
 *  image's resolution, so a polygon can be drawn over a coarse overview, a stitched mosaic, or a
 *  single live-view frame stretched to the planned area — see `routes/Scan.svelte`). */
export function tileCentreNorm(t: TilePlan, fovW: number, fovH: number, mosaic: { width: number; height: number }): Point {
  return { x: (t.pixel.x + fovW / 2) / mosaic.width, y: (t.pixel.y + fovH / 2) / mosaic.height }
}

/** Keep only the tiles whose centre lies inside `polygon` (normalised [0,1] x [0,1] coordinates). */
export function filterByPolygon(tiles: TilePlan[], polygon: Point[], fovW: number, fovH: number): TilePlan[] {
  if (polygon.length < 3) return tiles
  const mosaic = mosaicSize(tiles, fovW, fovH)
  const kept = tiles.filter((t) => pointInPolygon(tileCentreNorm(t, fovW, fovH, mosaic), polygon))
  return kept.map((t, index) => ({ ...t, index }))
}

/** Square-spiral traversal of a `cols` x `rows` grid, centre outward (good for round samples: the
 *  centre — usually the most interesting or best-focused area — is imaged first and last). Standard
 *  Ulam-spiral walk on an infinite grid, clipped to the grid bounds. */
function spiralCells(cols: number, rows: number): { col: number; row: number }[] {
  const c0 = Math.round((cols - 1) / 2), r0 = Math.round((rows - 1) / 2)
  const out: { col: number; row: number }[] = []
  const seen = new Set<string>()
  const add = (col: number, row: number) => {
    if (col < 0 || row < 0 || col >= cols || row >= rows) return
    const k = `${col},${row}`
    if (seen.has(k)) return
    seen.add(k); out.push({ col, row })
  }
  add(c0, r0)
  let col = c0, row = r0, leg = 1
  const maxLeg = Math.max(cols, rows) * 2
  while (out.length < cols * rows && leg <= maxLeg) {
    for (let i = 0; i < leg; i++) { col += 1; add(col, row) }
    for (let i = 0; i < leg; i++) { row -= 1; add(col, row) }
    leg += 1
    for (let i = 0; i < leg; i++) { col -= 1; add(col, row) }
    for (let i = 0; i < leg; i++) { row += 1; add(col, row) }
    leg += 1
  }
  return out
}

/** Reorder tiles into a spiral visiting order, centre outward. Tiles missing from `tiles` (e.g.
 *  clipped by a polygon region) are simply skipped, so this composes with `filterByPolygon`. */
export function spiralOrder(tiles: TilePlan[]): TilePlan[] {
  if (!tiles.length) return tiles
  const cols = Math.max(...tiles.map((t) => t.col)) + 1
  const rows = Math.max(...tiles.map((t) => t.row)) + 1
  const byCell = new Map<string, TilePlan>()
  for (const t of tiles) byCell.set(`${t.col},${t.row}`, t)
  const ordered: TilePlan[] = []
  for (const { col, row } of spiralCells(cols, rows)) {
    const t = byCell.get(`${col},${row}`)
    if (t) ordered.push(t)
  }
  return ordered.map((t, index) => ({ ...t, index }))
}

/** Settle time after a stage move of `steps` (Euclidean, motor steps): proportional to the move
 *  length so long hops let the flexure stage ring down, never below `minMs` (the old fixed default)
 *  and capped at `maxMs`. 0.05 ms/step ≈ 150 ms for 3000 steps, 1 s for 20 000 steps. */
export function settleForMove(steps: number, minMs = 150, msPerStep = 0.05, maxMs = 1500): number {
  if (!Number.isFinite(steps) || steps <= 0) return minMs
  return Math.round(Math.max(minMs, Math.min(maxMs, steps * msPerStep)))
}

// ---- whole-plan geometry: extent, mosaic box, and where a stage position sits in it ----------

/** Scale a px->steps matrix measured at `measuredWidth` to frames of `width` px. */
export function scaleMatrix(m: Mat2, measuredWidth: number, width: number): Mat2 {
  const k = measuredWidth / width
  return [[m[0][0] * k, m[0][1] * k], [m[1][0] * k, m[1][1] * k]]
}

/** Pixel offset (in the mosaic, tile px) of a field of view whose stage position is `stage` steps
 *  away from the grid centre. Inverse of `planScan`'s "move the stage so the scene shifts by
 *  (-px,-py)": stage = M·(-p)  ⇒  p = -M⁻¹·stage. */
export function stageToPixelOffset(matrix: Mat2, stage: Point): Point {
  const [x, y] = apply2(invert2(matrix), [stage.x, stage.y])
  return { x: -x, y: -y }
}

/** Smallest grid whose outermost tile *centres* reach ±`halfExtent` px from the grid centre, so
 *  the fields of view the operator marked at the corners are covered in full. Used by the
 *  "between two corners" extent: (cols-1)·dx/2 ≥ halfExtent.x. */
export function gridCovering(halfExtent: Point, fovW: number, fovH: number, overlap: number): { cols: number; rows: number } {
  const { dx, dy } = tilePitchPx(fovW, fovH, overlap)
  const n = (half: number, pitch: number) => Math.max(1, Math.ceil((2 * half) / pitch - 1e-9) + 1)
  return { cols: n(Math.abs(halfExtent.x), dx), rows: n(Math.abs(halfExtent.y), dy) }
}

export type ScanOrder = 'raster' | 'snake' | 'spiral'

/** Everything that decides *which* tiles a scan visits and where they are, independent of focus,
 *  capture or stitching settings. Positions are absolute stage steps. */
export interface ScanRegion {
  /** 'centre': `cols`×`rows` fields around `current`; 'corners': the grid that covers cornerA..cornerB */
  extent: 'centre' | 'corners'
  cols: number
  rows: number
  cornerA: Point | null
  cornerB: Point | null
  overlap: number
  /** normalised to the full grid's mosaic box; fewer than 3 points = keep every tile */
  polygon: Point[]
  order: ScanOrder
}

export interface ScanPlan {
  tiles: TilePlan[]                        // visiting order; `stage` is relative to `origin`
  cols: number
  rows: number
  origin: Point                            // absolute stage position of the grid centre
  fov: { w: number; h: number }            // tile size, px
  mosaic: { width: number; height: number }   // the FULL grid's nominal box (before any polygon clip)
}

/** Build the tile plan for a region. `matrix` maps px (at `fovW` frame width) -> stage steps;
 *  `current` is the stage position the 'centre' extent is anchored on. Corner mode falls back to
 *  centre mode until both corners exist. */
export function buildScanPlan(region: ScanRegion, fovW: number, fovH: number, matrix: Mat2, current: Point): ScanPlan {
  let origin: Point = { x: current.x, y: current.y }
  let cols = Math.max(1, Math.round(region.cols)), rows = Math.max(1, Math.round(region.rows))
  if (region.extent === 'corners' && region.cornerA && region.cornerB) {
    const a = region.cornerA, b = region.cornerB
    origin = { x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) }
    const half = stageToPixelOffset(matrix, { x: a.x - origin.x, y: a.y - origin.y })
    ;({ cols, rows } = gridCovering(half, fovW, fovH, region.overlap))
  }
  let tiles = planScan({ cols, rows, overlap: region.overlap }, fovW, fovH, matrix, region.order === 'snake' ? 'snake' : 'raster')
  const mosaic = mosaicSize(tiles, fovW, fovH)
  if (region.polygon.length >= 3) tiles = filterByPolygon(tiles, region.polygon, fovW, fovH)
  if (region.order === 'spiral') tiles = spiralOrder(tiles)
  return { tiles, cols, rows, origin, fov: { w: fovW, h: fovH }, mosaic }
}

export interface NormRect { x: number; y: number; w: number; h: number }

/** Where the field of view at absolute stage position `pos` sits in the plan's mosaic box, as
 *  fractions of that box (may extend outside 0..1 when the stage is away from the region). */
export function fovRectNorm(plan: ScanPlan, matrix: Mat2, pos: Point): NormRect {
  const p = stageToPixelOffset(matrix, { x: pos.x - plan.origin.x, y: pos.y - plan.origin.y })
  const cx = plan.mosaic.width / 2 + p.x, cy = plan.mosaic.height / 2 + p.y
  const W = plan.mosaic.width || 1, H = plan.mosaic.height || 1
  return { x: (cx - plan.fov.w / 2) / W, y: (cy - plan.fov.h / 2) / H, w: plan.fov.w / W, h: plan.fov.h / H }
}

/** A tile's nominal footprint in the same normalised box. */
export function tileRectNorm(plan: ScanPlan, t: TilePlan): NormRect {
  const W = plan.mosaic.width || 1, H = plan.mosaic.height || 1
  return { x: t.pixel.x / W, y: t.pixel.y / H, w: plan.fov.w / W, h: plan.fov.h / H }
}
