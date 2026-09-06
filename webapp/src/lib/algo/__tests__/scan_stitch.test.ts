import { describe, expect, it } from 'vitest'
import { planScan, relativeMoves, mosaicSize, tilePitchPx } from '../scanPlan'
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
