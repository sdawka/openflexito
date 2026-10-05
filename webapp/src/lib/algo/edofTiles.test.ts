import { describe, expect, it } from 'vitest'
import { clampEdofRange, edofSweepPlan, edofTileSeconds, EDOF_MAX_RANGE, EDOF_MIN_RANGE } from './edofTiles'

/** gaussian sharpness curve peaking at `c` with width `w`, sampled every `d` steps over [lo, hi] */
const curve = (c: number, w: number, lo: number, hi: number, d = 20) => {
  const out = []
  for (let z = lo; z <= hi; z += d) out.push({ z, s: 1 + 100 * Math.exp(-((z - c) ** 2) / (2 * w * w)) })
  return out
}

describe('edofSweepPlan', () => {
  it('centres on the band and doubles its width', () => {
    const p = edofSweepPlan(curve(40, 40, -300, 300), 40, 600)
    expect(p.fromBand).toBe(true)
    expect(Math.abs(p.centreZ - 40)).toBeLessThanOrEqual(25)
    expect(p.range).toBeGreaterThan(EDOF_MIN_RANGE)
    expect(p.range).toBeLessThan(600)
  })
  it('falls back to the configured range around the tile z when the band touches the sweep end', () => {
    const p = edofSweepPlan(curve(300, 200, -300, 300), 12, 500)
    expect(p).toEqual({ centreZ: 12, range: 500, fromBand: false })
  })
  it('falls back without a curve or with too few samples', () => {
    expect(edofSweepPlan(undefined, 7, 400)).toEqual({ centreZ: 7, range: 400, fromBand: false })
    expect(edofSweepPlan(curve(0, 30, -20, 20, 20), 7, 400).fromBand).toBe(false)
  })
  it('clamps the range', () => {
    expect(clampEdofRange(5)).toBe(EDOF_MIN_RANGE)
    expect(clampEdofRange(1e6)).toBe(EDOF_MAX_RANGE)
    expect(clampEdofRange(NaN)).toBeGreaterThanOrEqual(EDOF_MIN_RANGE)
    expect(edofSweepPlan(curve(0, 5, -300, 300), 0, 600).range).toBeGreaterThanOrEqual(EDOF_MIN_RANGE)
  })
})

describe('edofTileSeconds', () => {
  it('grows with the range', () => {
    expect(edofTileSeconds(1200)).toBeGreaterThan(edofTileSeconds(300))
    expect(edofTileSeconds(600)).toBeGreaterThan(8)
  })
})
