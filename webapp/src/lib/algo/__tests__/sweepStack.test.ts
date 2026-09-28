import { describe, it, expect } from 'vitest'
import { zAtTime, sweepStepTimeUs, chooseSweepSlices, type SweepSample } from '../sweepStack'

describe('zAtTime', () => {
  const m = { t0: 1000, t1: 2000, z0: -500, z1: 500 }
  it('interpolates linearly inside the move', () => {
    expect(zAtTime(1000, m)).toBe(-500)
    expect(zAtTime(1500, m)).toBe(0)
    expect(zAtTime(2000, m)).toBe(500)
  })
  it('rejects frames outside the move and a degenerate move', () => {
    expect(zAtTime(999, m)).toBeNull()
    expect(zAtTime(2001, m)).toBeNull()
    expect(zAtTime(1000, { ...m, t1: 1000 })).toBeNull()
  })
})

describe('sweepStepTimeUs', () => {
  it('slows the stage to the wanted steps per frame', () => {
    expect(sweepStepTimeUs(30, 8, 1000)).toBe(4167)
  })
  it('never goes below the board minimum', () => {
    expect(sweepStepTimeUs(30, 100, 1000)).toBe(1000)
  })
})

/** a sweep from z=-500 to 500, one sample per 10 steps, with Gaussian peaks of sharpness */
function curve(peaks: { z: number; w: number }[], floor = 1): SweepSample[] {
  const out: SweepSample[] = []
  for (let z = -500; z <= 500; z += 10) out.push({ z, s: floor + peaks.reduce((a, p) => a + 10 * Math.exp(-(((z - p.z) / p.w) ** 2)), 0) })
  return out
}

describe('chooseSweepSlices', () => {
  it('centres a single peak and stays inside its band', () => {
    const s = curve([{ z: 100, w: 40 }])
    const sel = chooseSweepSlices(s, 7)
    expect(s[sel.peak].z).toBe(100)
    expect(sel.indices.length).toBe(7)
    expect(sel.span[0]).toBeGreaterThan(0)
    expect(sel.span[1]).toBeLessThan(200)
    expect(sel.indices).toContain(sel.peak)
    for (let i = 1; i < sel.indices.length; i++) expect(sel.indices[i]).toBeGreaterThan(sel.indices[i - 1])
  })
  it('spans both planes of a thick specimen', () => {
    const s = curve([{ z: -200, w: 30 }, { z: 250, w: 30 }])
    const sel = chooseSweepSlices(s, 15)
    expect(sel.span[0]).toBeLessThanOrEqual(-220)
    expect(sel.span[1]).toBeGreaterThanOrEqual(270)
  })
  it('yields fewer slices when the band holds fewer samples than asked', () => {
    const s = curve([{ z: 0, w: 8 }])
    const sel = chooseSweepSlices(s, 31)
    expect(sel.indices.length).toBeLessThan(31)
    expect(new Set(sel.indices).size).toBe(sel.indices.length)
  })
  it('handles empty and single-slice requests', () => {
    expect(chooseSweepSlices([], 5).indices).toEqual([])
    const s = curve([{ z: 50, w: 40 }])
    const one = chooseSweepSlices(s, 1)
    expect(one.indices).toEqual([one.peak])
  })
})
