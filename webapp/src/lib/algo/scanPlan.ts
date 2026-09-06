/** Tile scan planning: grid positions in stage steps from field-of-view and overlap (port of the
 *  ideas in OpenFlexure v3 scan_planners.py: raster and snake orderings). */

import type { Mat2 } from './csm'
import { apply2 } from './csm'

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
