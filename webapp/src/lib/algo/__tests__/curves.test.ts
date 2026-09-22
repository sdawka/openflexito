import { describe, expect, it } from 'vitest'
import { bakeAdjustments, catmullRom, composeLut1D, curveToLut1D, levelsToLut1D, monotoneCubic } from '../curves'
import { identity3D, sample1D, sampleTetra } from '../lut'

describe('monotoneCubic', () => {
  it('passes through control points exactly', () => {
    const f = monotoneCubic([[0, 0], [0.5, 0.8], [1, 1]])
    expect(f(0)).toBeCloseTo(0, 5)
    expect(f(0.5)).toBeCloseTo(0.8, 5)
    expect(f(1)).toBeCloseTo(1, 5)
  })

  it('never overshoots a monotone set of points', () => {
    const f = monotoneCubic([[0, 0], [0.2, 0.1], [0.6, 0.9], [1, 1]])
    let prev = -Infinity
    for (let i = 0; i <= 100; i++) {
      const y = f(i / 100)
      expect(y).toBeGreaterThanOrEqual(prev - 1e-6)
      expect(y).toBeGreaterThanOrEqual(-1e-6)
      expect(y).toBeLessThanOrEqual(1 + 1e-6)
      prev = y
    }
  })

  it('clamps outside the point range', () => {
    const f = monotoneCubic([[0.2, 0.3], [0.8, 0.7]])
    expect(f(-1)).toBeCloseTo(0.3, 5)
    expect(f(2)).toBeCloseTo(0.7, 5)
  })
})

describe('catmullRom', () => {
  it('passes through control points exactly', () => {
    const f = catmullRom([[0, 0], [0.3, 0.6], [0.7, 0.4], [1, 1]])
    expect(f(0)).toBeCloseTo(0, 5)
    expect(f(0.3)).toBeCloseTo(0.6, 5)
    expect(f(0.7)).toBeCloseTo(0.4, 5)
    expect(f(1)).toBeCloseTo(1, 5)
  })
})

describe('curveToLut1D', () => {
  it('samples three evaluators into a Lut1D', () => {
    const lut = curveToLut1D((x) => x, (x) => 1 - x, (x) => 0.5, 5)
    expect(lut.size).toBe(5)
    expect(lut.r[0]).toBeCloseTo(0)
    expect(lut.r[4]).toBeCloseTo(1)
    expect(lut.g[0]).toBeCloseTo(1)
    expect(lut.b[2]).toBeCloseTo(0.5)
  })
})

describe('levelsToLut1D', () => {
  it('maps black to 0 and white to 1', () => {
    const lut = levelsToLut1D(0.2, 0.8, 1, 256)
    const out = new Float32Array(3)
    sample1D(lut, 0.2, 0.2, 0.2, out)
    expect(out[0]).toBeCloseTo(0, 1)
    sample1D(lut, 0.8, 0.8, 0.8, out)
    expect(out[0]).toBeCloseTo(1, 1)
  })

  it('identity levels (0,1,1) leave values unchanged', () => {
    const lut = levelsToLut1D(0, 1, 1, 256)
    const out = new Float32Array(3)
    sample1D(lut, 0.42, 0.42, 0.42, out)
    expect(out[0]).toBeCloseTo(0.42, 2)
  })
})

describe('composeLut1D', () => {
  it('composes two levels adjustments', () => {
    const a = levelsToLut1D(0, 0.5, 1, 256) // doubles (clamped)
    const b = levelsToLut1D(0, 1, 2, 256) // sqrt-ish
    const composed = composeLut1D(a, b)
    const outA = new Float32Array(3), outB = new Float32Array(3), outC = new Float32Array(3)
    const x = 0.3
    sample1D(a, x, x, x, outA)
    sample1D(b, outA[0], outA[0], outA[0], outB)
    sample1D(composed, x, x, x, outC)
    expect(outC[0]).toBeCloseTo(outB[0], 2)
  })
})

describe('bakeAdjustments', () => {
  it('with no options set, equals identity3D', () => {
    const lut = bakeAdjustments({}, 9)
    const id = identity3D(9)
    expect(lut.size).toBe(id.size)
    for (let i = 0; i < lut.data.length; i++) expect(lut.data[i]).toBeCloseTo(id.data[i], 5)
  })

  it('saturation 0 keeps grey pixels grey and unsaturated', () => {
    const lut = bakeAdjustments({ saturation: 0.8 }, 9)
    const out = new Float32Array(3)
    sampleTetra(lut, 0.5, 0.5, 0.5, out)
    expect(out[0]).toBeCloseTo(0.5, 2)
    expect(out[1]).toBeCloseTo(0.5, 2)
    expect(out[2]).toBeCloseTo(0.5, 2)
  })

  it('increases the spread between channels for a saturated colour', () => {
    const lut = bakeAdjustments({ saturation: 0.5 }, 17)
    const out = new Float32Array(3)
    sampleTetra(lut, 0.8, 0.4, 0.2, out)
    const spreadBefore = 0.8 - 0.2
    const spreadAfter = Math.max(out[0], out[1], out[2]) - Math.min(out[0], out[1], out[2])
    expect(spreadAfter).toBeGreaterThan(spreadBefore)
  })

  it('a 180 degree hue rotation swaps a saturated colour toward its complement', () => {
    const lut = bakeAdjustments({ hue: 180 }, 17)
    const out = new Float32Array(3)
    sampleTetra(lut, 1, 0, 0, out) // pure red
    // red rotated 180deg in HSL becomes cyan-ish: low R, high G/B
    expect(out[0]).toBeLessThan(0.3)
    expect(out[1]).toBeGreaterThan(0.6)
    expect(out[2]).toBeGreaterThan(0.6)
  })

  it('channel mixer swaps red and green', () => {
    const lut = bakeAdjustments({ channelMixer: [[0, 1, 0], [1, 0, 0], [0, 0, 1]] }, 5)
    const out = new Float32Array(3)
    sampleTetra(lut, 1, 0, 0, out)
    expect(out[0]).toBeCloseTo(0, 1)
    expect(out[1]).toBeCloseTo(1, 1)
  })
})

describe('filmic presets', () => {
  it('neutral is identity; soft and flat are monotone with 0 → 0 and top ≤ 1', async () => {
    const { filmicCurve, filmicLut1D } = await import('../curves')
    expect(filmicCurve('neutral')(0.37)).toBe(0.37)
    for (const preset of ['soft', 'flat'] as const) {
      const f = filmicCurve(preset)
      expect(f(0)).toBeCloseTo(0, 6)
      expect(f(1)).toBeLessThanOrEqual(1)
      expect(f(1)).toBeGreaterThan(0.9)
      let prev = -1
      for (let i = 0; i <= 256; i++) { const y = f(i / 256); expect(y).toBeGreaterThanOrEqual(prev - 1e-9); prev = y }
      const l = filmicLut1D(preset)
      expect(l.size).toBe(256)
      expect(l.r[128]).toBeCloseTo(f(128 / 255), 6)
      expect(l.g[200]).toBe(l.r[200])
    }
  })

  it('soft compresses the top: the last stop gains less than the identity, mids stay near identity', async () => {
    const { filmicCurve } = await import('../curves')
    const f = filmicCurve('soft', 1.15)
    expect(f(1) - f(0.85)).toBeLessThan(0.15 * 0.7) // top 15 % of input maps to < 70 % of its identity span
    expect(Math.abs(f(0.5) - 0.5)).toBeLessThan(0.2) // the ACES fit lifts mids a little by design
    expect(filmicCurve('soft', 2)(0.5)).toBeGreaterThan(f(0.5)) // more exposure = brighter
  })

  it('flat lifts shadows more than soft', async () => {
    const { filmicCurve } = await import('../curves')
    expect(filmicCurve('flat')(0.1)).toBeGreaterThan(filmicCurve('soft')(0.1))
  })
})
