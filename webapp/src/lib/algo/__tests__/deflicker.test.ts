import { describe, expect, it } from 'vitest'
import { Deflicker, applyGainRgba, defaultDeflickerOptions, frameLuma } from '../deflicker'

function solidFrame(luma: number, n = 64): Uint8ClampedArray {
  const data = new Uint8ClampedArray(n * 4)
  for (let i = 0; i < data.length; i += 4) { data[i] = luma; data[i + 1] = luma; data[i + 2] = luma; data[i + 3] = 255 }
  return data
}

describe('frameLuma', () => {
  it('mean matches a solid grey frame', () => {
    expect(frameLuma(solidFrame(120))).toBeCloseTo(120, 0)
  })
  it('percentile (median) matches a solid frame too', () => {
    expect(frameLuma(solidFrame(80), true)).toBeCloseTo(80, 0)
  })
})

describe('applyGainRgba', () => {
  it('scales RGB and leaves alpha untouched', () => {
    const d = new Uint8ClampedArray([100, 100, 100, 200])
    applyGainRgba(d, 1.5)
    expect(d[0]).toBe(150); expect(d[1]).toBe(150); expect(d[2]).toBe(150)
    expect(d[3]).toBe(200)
  })
  it('is a no-op at gain 1', () => {
    const d = new Uint8ClampedArray([10, 20, 30, 40])
    applyGainRgba(d, 1)
    expect([...d]).toEqual([10, 20, 30, 40])
  })
})

describe('Deflicker', () => {
  it('first frame is unchanged (gain 1) and becomes the reference', () => {
    const d = new Deflicker()
    expect(d.nextGain(100)).toBe(1)
  })

  it('normalises an oscillating brightness sequence toward the reference', () => {
    const d = new Deflicker({ alpha: 0.9, maxGainDelta: 0.6, usePercentile: false })
    const lumas = [100, 150, 100, 150, 100, 150, 100, 150]
    const corrected = lumas.map((l) => l * d.nextGain(l))
    // after the transient, the corrected sequence should vary much less than the raw one
    const rawSpread = Math.max(...lumas.slice(4)) - Math.min(...lumas.slice(4))
    const correctedSpread = Math.max(...corrected.slice(4)) - Math.min(...corrected.slice(4))
    expect(correctedSpread).toBeLessThan(rawSpread * 0.5)
  })

  it('clamps a single extreme frame to maxGainDelta instead of fully correcting it', () => {
    const d = new Deflicker({ ...defaultDeflickerOptions, maxGainDelta: 0.25 })
    d.nextGain(100)                       // establishes the reference
    const gain = d.nextGain(10)           // a sudden near-black flash
    expect(gain).toBeCloseTo(1.25, 5)     // clamped, not the raw 10x correction
  })

  it('reset() drops the reference so the next frame is a fresh anchor', () => {
    const d = new Deflicker()
    d.nextGain(100)
    d.nextGain(150)
    d.reset()
    expect(d.nextGain(30)).toBe(1)
  })
})

import { backgroundLuma, gainLut } from '../deflicker'

describe('backgroundLuma / gainLut', () => {
  it('measures the bright background, ignoring a dark object and clipped pixels', () => {
    const d = new Uint8ClampedArray(1000 * 4)
    for (let p = 0; p < 1000; p++) { const v = p < 300 ? 40 : p < 900 ? 200 : 255; d[p * 4] = d[p * 4 + 1] = d[p * 4 + 2] = v; d[p * 4 + 3] = 255 }
    expect(backgroundLuma(d)).toBeCloseTo(200, 0)
  })
  it('gain table is identity at 1 and rolls off softly into 255', () => {
    const one = gainLut(1)
    expect(one[128]).toBe(128); expect(one[255]).toBe(255)
    const up = gainLut(1.3)
    expect(up[128]).toBeGreaterThan(128); expect(up[250]).toBeLessThanOrEqual(255); expect(up[240]).toBeLessThan(up[250] + 1)
  })
})
