import { describe, it, expect } from 'vitest'
import { focusBand, planStack, depthOfFieldUm } from '../stackPlan'

const curve = (zs: number[], f: (z: number) => number) => zs.map((z) => ({ z, s: f(z) }))
const zs = Array.from({ length: 41 }, (_, i) => -500 + i * 25)

describe('focusBand', () => {
  it('spans a thick specimen, not just the width of its sharpest plane', () => {
    // flat-topped sharpness from -150 to +150 (a thick specimen), floor 1, peak 10
    const b = focusBand(curve(zs, (z) => (Math.abs(z) <= 150 ? 10 - Math.abs(z) / 100 : 1)))!
    expect(b.lo).toBeLessThanOrEqual(-150)
    expect(b.hi).toBeGreaterThanOrEqual(150)
    expect(b.lo).toBeGreaterThanOrEqual(-200)   // one sample spacing of margin
    expect(b.clipped).toBe(false)
  })
  it('covers two separate sharpness peaks', () => {
    const b = focusBand(curve(zs, (z) => 1 + 9 * Math.exp(-(((z + 200) / 30) ** 2)) + 8 * Math.exp(-(((z - 150) / 30) ** 2))))!
    expect(b.lo).toBeLessThan(-200)
    expect(b.hi).toBeGreaterThan(150)
    expect(b.peakZ).toBe(-200)
  })
  it('accepts unordered samples and flags a band that runs off the sweep', () => {
    const s = curve(zs, (z) => (z > 300 ? 10 : 1)).reverse()
    const b = focusBand(s)!
    expect(b.hi).toBe(500)
    expect(b.clipped).toBe(true)
  })
})

describe('planStack', () => {
  it('spaces slices at the DOF step and covers the band', () => {
    const p = planStack(-150, 150, 20, 31)
    expect(p.step).toBe(20)
    expect(p.span).toBeGreaterThanOrEqual(300)
    expect(p.slices).toBe(16)
    expect(p.centreZ).toBe(0)
    expect(p.undersampled).toBe(false)
  })
  it('spreads capped slices over the whole band instead of shrinking the range', () => {
    const p = planStack(-150, 150, 20, 9)
    expect(p.slices).toBe(9)
    expect(p.span).toBeGreaterThanOrEqual(300)
    expect(p.undersampled).toBe(true)
  })
  it('keeps at least three slices around a thin specimen', () => {
    const p = planStack(10, 10, 20, 9)
    expect(p.slices).toBe(3)
    expect(p.step).toBe(20)
    expect(p.centreZ).toBe(10)
  })
})

describe('depthOfFieldUm', () => {
  it('is λ/NA² for a 40×/0.65 (≈1.3 µm)', () => {
    expect(depthOfFieldUm(0.65)).toBeCloseTo(1.30, 1)
  })
})
