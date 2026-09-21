import { describe, expect, it } from 'vitest'
import { buildScanPlan, fovRectNorm, gridCovering, scaleMatrix, stageToPixelOffset, tileRectNorm, planScan, type ScanRegion, type Point } from '../scanPlan'
import type { Mat2 } from '../csm'

const M: Mat2 = [[2, 0], [0, -2]]   // 2 steps per px, y flipped
const region = (over: Partial<ScanRegion> = {}): ScanRegion => ({
  extent: 'centre', cols: 3, rows: 2, cornerA: null, cornerB: null, overlap: 0.25, polygon: [], order: 'snake', ...over,
})

describe('scan plan geometry', () => {
  it('scaleMatrix rescales a matrix measured on a downsampled frame', () => {
    expect(scaleMatrix(M, 820, 1640)).toEqual([[1, 0], [0, -1]])
  })

  it('stageToPixelOffset inverts planScan: a tile\'s stage offset maps back onto its pixel offset', () => {
    const tiles = planScan({ cols: 3, rows: 2, overlap: 0.25 }, 400, 300, M, 'raster')
    for (const t of tiles) {
      const p = stageToPixelOffset(M, t.stage)
      // planScan centres the grid: pixel offset of the tile centre from the grid centre
      expect(p.x).toBeCloseTo((t.col - 1) * 300, 6)
      expect(p.y).toBeCloseTo((t.row - 0.5) * 225, 6)
    }
  })

  it('gridCovering picks the smallest grid whose outer tile centres reach the marked corners', () => {
    expect(gridCovering({ x: 0, y: 0 }, 400, 300, 0.25)).toEqual({ cols: 1, rows: 1 })
    expect(gridCovering({ x: 300, y: 0 }, 400, 300, 0.25)).toEqual({ cols: 3, rows: 1 })   // exactly one pitch each side
    expect(gridCovering({ x: 301, y: 225.5 }, 400, 300, 0.25)).toEqual({ cols: 4, rows: 4 })
    expect(gridCovering({ x: -150, y: 100 }, 400, 300, 0.25)).toEqual({ cols: 2, rows: 2 })
  })

  it('centre extent anchors the grid on the current position', () => {
    const plan = buildScanPlan(region(), 400, 300, M, { x: 1000, y: -500 })
    expect(plan.origin).toEqual({ x: 1000, y: -500 })
    expect(plan.cols).toBe(3); expect(plan.rows).toBe(2)
    expect(plan.tiles.length).toBe(6)
    expect(plan.mosaic).toEqual({ width: 1000, height: 525 })
    // current FoV = the centre of the box
    const r = fovRectNorm(plan, M, { x: 1000, y: -500 })
    expect(r.x + r.w / 2).toBeCloseTo(0.5, 6); expect(r.y + r.h / 2).toBeCloseTo(0.5, 6)
    expect(r.w).toBeCloseTo(0.4, 6)
  })

  it('corner extent centres on the midpoint and covers both corners\' fields of view', () => {
    // corner A is 600 steps (= 300 px) left and 450 steps (= 225 px, y flipped) of B
    const a: Point = { x: 400, y: 900 }, b: Point = { x: 1600, y: 0 }
    const plan = buildScanPlan(region({ extent: 'corners', cornerA: a, cornerB: b }), 400, 300, M, { x: 0, y: 0 })
    expect(plan.origin).toEqual({ x: 1000, y: 450 })
    expect(plan.cols).toBe(3); expect(plan.rows).toBe(3)
    // both corner FoVs fall inside the mosaic box
    for (const c of [a, b]) {
      const r = fovRectNorm(plan, M, c)
      expect(r.x).toBeGreaterThanOrEqual(-1e-6); expect(r.y).toBeGreaterThanOrEqual(-1e-6)
      expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-6); expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-6)
    }
    // A - origin = (-600, +450) steps; p = -M⁻¹·s = (+300, +225) px: corner A's FoV is the bottom-right tile
    const br = plan.tiles.find((t) => t.col === 2 && t.row === 2)!
    const ra = fovRectNorm(plan, M, a), rt = tileRectNorm(plan, br)
    expect(Math.abs(ra.x - rt.x)).toBeLessThan(1e-6)
    expect(Math.abs(ra.y - rt.y)).toBeLessThan(1e-6)
  })

  it('corner extent without both corners falls back to the centre grid', () => {
    const plan = buildScanPlan(region({ extent: 'corners', cornerA: { x: 1, y: 1 } }), 400, 300, M, { x: 5, y: 6 })
    expect(plan.origin).toEqual({ x: 5, y: 6 }); expect(plan.cols).toBe(3)
  })

  it('polygon clip and spiral order compose; the mosaic box stays the full grid', () => {
    const poly: Point[] = [{ x: 0.5, y: 0.05 }, { x: 0.05, y: 0.95 }, { x: 0.95, y: 0.95 }]
    const plan = buildScanPlan(region({ cols: 5, rows: 5, polygon: poly, order: 'spiral' }), 400, 300, M, { x: 0, y: 0 })
    expect(plan.mosaic).toEqual({ width: 1600, height: 1200 })
    expect(plan.tiles.length).toBeLessThan(25); expect(plan.tiles.length).toBeGreaterThan(0)
    expect(plan.tiles[0].col === 2 && plan.tiles[0].row === 2).toBe(true)   // spiral starts at the centre
    expect(plan.tiles.map((t) => t.index)).toEqual(plan.tiles.map((_, i) => i))
  })

  it('fovRectNorm tracks the stage across the box', () => {
    const plan = buildScanPlan(region({ cols: 3, rows: 3 }), 400, 300, M, { x: 0, y: 0 })
    // moving the stage by +600 steps in x shifts the scene by -300 px: the FoV appears one tile LEFT
    const r = fovRectNorm(plan, M, { x: 600, y: 0 })
    expect(r.x).toBeCloseTo(0, 6)
    const r2 = fovRectNorm(plan, M, { x: -600, y: 0 })
    expect(r2.x + r2.w).toBeCloseTo(1, 6)
  })
})
