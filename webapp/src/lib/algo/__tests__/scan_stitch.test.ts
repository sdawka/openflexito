import { describe, expect, it } from 'vitest'
import { planScan, relativeMoves, mosaicSize, tilePitchPx, pointInPolygon, filterByPolygon, spiralOrder, tileCentreNorm, type Point } from '../scanPlan'
import { pairwiseOffsets, solvePositions, featherWeight } from '../stitch'
import type { Gray } from '../sharpness'

describe('scan planning', () => {
  const M: [[number, number], [number, number]] = [[2, 0], [0, -2]]   // 2 steps per px, y flipped
  it('plans a snake grid around the centre', () => {
    const tiles = planScan({ cols: 3, rows: 2, overlap: 0.25 }, 400, 300, M, 'snake')
    expect(tiles.length).toBe(6)
    expect(tilePitchPx(400, 300, 0.25)).toEqual({ dx: 300, dy: 225 })
    expect(tiles.map((t) => t.col)).toEqual([0, 1, 2, 2, 1, 0])
    // first tile: px offset (-300, -112.5) -> stage = M * (300, 112.5) = (600, -225)
    expect(tiles[0].stage).toEqual({ x: 600, y: -225 })
    expect(tiles[1].stage).toEqual({ x: 0, y: -225 })
    const moves = relativeMoves(tiles)
    expect(moves[0]).toEqual({ x: 600, y: -225 })
    expect(moves[1]).toEqual({ x: -600, y: 0 })
    expect(mosaicSize(tiles, 400, 300)).toEqual({ width: 1000, height: 525 })
  })
})

describe('programmable regions: polygon clipping', () => {
  const square: Point[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
  it('point-in-polygon: inside, outside and a concave shape', () => {
    expect(pointInPolygon({ x: 0.5, y: 0.5 }, square)).toBe(true)
    expect(pointInPolygon({ x: 1.5, y: 0.5 }, square)).toBe(false)
    const notch: Point[] = [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 1, y: 1 }, { x: 0, y: 2 }]   // concave notch cut into the top edge, down to (1,1)
    expect(pointInPolygon({ x: 1, y: 0.2 }, notch)).toBe(true)     // near the bottom, well clear of the notch
    expect(pointInPolygon({ x: 1, y: 1.8 }, notch)).toBe(false)    // inside the carved-out notch near the top
  })

  it('a circular polygon keeps a round sample and drops the corner tiles', () => {
    const M: [[number, number], [number, number]] = [[1, 0], [0, 1]]
    const tiles = planScan({ cols: 5, rows: 5, overlap: 0 }, 100, 100, M, 'raster')
    const circle: Point[] = Array.from({ length: 32 }, (_, i) => {
      const a = (i / 32) * Math.PI * 2
      return { x: 0.5 + 0.5 * Math.cos(a), y: 0.5 + 0.5 * Math.sin(a) }
    })
    const kept = filterByPolygon(tiles, circle, 100, 100)
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(tiles.length)
    // the very corner tile (0,0) sits outside the inscribed circle
    expect(kept.some((t) => t.col === 0 && t.row === 0)).toBe(false)
    // the centre tile is well inside
    expect(kept.some((t) => t.col === 2 && t.row === 2)).toBe(true)
    // indices are renumbered contiguously
    expect(kept.map((t) => t.index)).toEqual(kept.map((_, i) => i))
  })

  it('an all-covering polygon keeps every tile', () => {
    const M: [[number, number], [number, number]] = [[1, 0], [0, 1]]
    const tiles = planScan({ cols: 3, rows: 3, overlap: 0.2 }, 100, 100, M, 'raster')
    const big: Point[] = [{ x: -1, y: -1 }, { x: 2, y: -1 }, { x: 2, y: 2 }, { x: -1, y: 2 }]
    expect(filterByPolygon(tiles, big, 100, 100).length).toBe(tiles.length)
  })

  it('tileCentreNorm places the first and last tile near the mosaic corners', () => {
    const M: [[number, number], [number, number]] = [[1, 0], [0, 1]]
    const tiles = planScan({ cols: 2, rows: 2, overlap: 0 }, 100, 100, M, 'raster')
    const mosaic = mosaicSize(tiles, 100, 100)
    const c0 = tileCentreNorm(tiles[0], 100, 100, mosaic)
    expect(c0.x).toBeGreaterThan(0); expect(c0.x).toBeLessThan(0.5)
    expect(c0.y).toBeGreaterThan(0); expect(c0.y).toBeLessThan(0.5)
  })
})

describe('programmable regions: spiral order', () => {
  it('starts at the centre tile of an odd-sized grid', () => {
    const M: [[number, number], [number, number]] = [[1, 0], [0, 1]]
    const tiles = planScan({ cols: 3, rows: 3, overlap: 0 }, 100, 100, M, 'raster')
    const spiral = spiralOrder(tiles)
    expect(spiral.length).toBe(tiles.length)
    expect(spiral[0].col).toBe(1); expect(spiral[0].row).toBe(1)
    expect(spiral[spiral.length - 1].col === 0 || spiral[spiral.length - 1].row === 0 ||
      spiral[spiral.length - 1].col === 2 || spiral[spiral.length - 1].row === 2).toBe(true)   // ends on the outer ring
    // reindexed sequentially for the moves calculation
    expect(spiral.map((t) => t.index)).toEqual(spiral.map((_, i) => i))
  })

  it('visits every tile exactly once, even for a non-square grid', () => {
    const M: [[number, number], [number, number]] = [[1, 0], [0, 1]]
    const tiles = planScan({ cols: 4, rows: 3, overlap: 0 }, 100, 100, M, 'raster')
    const spiral = spiralOrder(tiles)
    const seen = new Set(spiral.map((t) => `${t.col},${t.row}`))
    expect(seen.size).toBe(tiles.length)
    for (const t of tiles) expect(seen.has(`${t.col},${t.row}`)).toBe(true)
  })

  it('composes with polygon clipping: only the kept tiles appear, still centre-outward', () => {
    const M: [[number, number], [number, number]] = [[1, 0], [0, 1]]
    const tiles = planScan({ cols: 5, rows: 5, overlap: 0 }, 100, 100, M, 'raster')
    const circle: Point[] = Array.from({ length: 32 }, (_, i) => {
      const a = (i / 32) * Math.PI * 2
      return { x: 0.5 + 0.5 * Math.cos(a), y: 0.5 + 0.5 * Math.sin(a) }
    })
    const kept = filterByPolygon(tiles, circle, 100, 100)
    const spiral = spiralOrder(kept)
    expect(spiral.length).toBe(kept.length)
    expect(spiral[0].col).toBe(2); expect(spiral[0].row).toBe(2)
  })
})

function scene(x: number, y: number): number {
  return 128 + 50 * Math.sin(x * 0.13) * Math.cos(y * 0.11) + 30 * Math.sin((x - y) * 0.07) + 20 * Math.cos(x * 0.31 + y * 0.23) + 15 * Math.sin(x * 0.9 - y * 0.7)
}
function tileImage(x0: number, y0: number, w: number, h: number): Gray {
  const data = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = scene(x0 + x, y0 + y)
  return { data, width: w, height: h }
}

describe('stitching', () => {
  it('recovers true tile positions from nominal ones with error', () => {
    const w = 96, h = 64
    const truth = [{ x: 0, y: 0 }, { x: 70, y: 3 }, { x: -2, y: 48 }, { x: 72, y: 50 }]   // ~27 % overlap
    const nominal = [{ x: 0, y: 0 }, { x: 72, y: 0 }, { x: 0, y: 48 }, { x: 72, y: 48 }]
    const tiles = nominal.map((p, id) => ({ id, ...p, width: w, height: h }))
    const images = truth.map((p) => tileImage(p.x, p.y, w, h))
    const pairs = pairwiseOffsets(tiles, images, 16, 1.1)
    expect(pairs.length).toBeGreaterThanOrEqual(3)
    const pos = solvePositions(tiles, pairs)
    const minX = Math.min(...truth.map((p) => p.x)), minY = Math.min(...truth.map((p) => p.y))
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(pos[i].x - (truth[i].x - minX))).toBeLessThan(2.0)
      expect(Math.abs(pos[i].y - (truth[i].y - minY))).toBeLessThan(2.0)
    }
  })
  it('feather weights taper at the edges', () => {
    expect(featherWeight(50, 50, 100, 100, 10)).toBe(1)
    expect(featherWeight(0, 50, 100, 100, 10)).toBeCloseTo(0.05)
    expect(featherWeight(99, 99, 100, 100, 10)).toBeCloseTo(0.0025)
  })
})
