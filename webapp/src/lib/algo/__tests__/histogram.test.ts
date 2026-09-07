import { describe, expect, it } from 'vitest'
import { computeHistogram, suggestExposureStep } from '../histogram'

function solidFrame(r: number, g: number, b: number, n: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(n * 4)
  for (let i = 0; i < n; i++) { data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = 255 }
  return data
}

describe('histogram maths', () => {
  it('bins a mid-grey frame with no clipping', () => {
    const h = computeHistogram(solidFrame(128, 128, 128, 100))
    expect(h.n).toBe(100)
    expect(h.mean).toBeCloseTo(128, 0)
    expect(h.lum[128]).toBe(100)
    expect(h.clippedHigh).toBe(0)
    expect(h.clippedLow).toBe(0)
  })

  it('reports clipped highlights and shadows', () => {
    const data = new Uint8ClampedArray(4 * 10)
    for (let i = 0; i < 10; i++) {
      const v = i < 3 ? 255 : i < 5 ? 0 : 128
      data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255
    }
    const h = computeHistogram(data)
    expect(h.clippedHigh).toBeCloseTo(0.3, 6)
    expect(h.clippedLow).toBeCloseTo(0.2, 6)
  })

  it('honours stride sampling', () => {
    const data = solidFrame(200, 200, 200, 100)
    const h = computeHistogram(data, 4)
    expect(h.n).toBe(25)
  })

  it('suggests scaling exposure time toward the target mean', () => {
    const step = suggestExposureStep(60, 153, { exposureUs: 10000, gain: 1 }, { exposureUs: [50, 500000], gain: [1, 10.67] })!
    expect(step.exposureUs).toBeGreaterThan(10000)
    expect(step.gain).toBe(1)
  })

  it('returns null once close enough to target', () => {
    expect(suggestExposureStep(152, 153, { exposureUs: 10000, gain: 1 }, { exposureUs: [50, 500000], gain: [1, 10.67] })).toBeNull()
  })

  it('falls back to gain once exposure hits its ceiling', () => {
    const step = suggestExposureStep(10, 153, { exposureUs: 400000, gain: 1 }, { exposureUs: [50, 500000], gain: [1, 10.67] })!
    expect(step.exposureUs).toBe(500000)
    expect(step.gain).toBeGreaterThan(1)
  })
})
