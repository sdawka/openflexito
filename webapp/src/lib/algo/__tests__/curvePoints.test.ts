import { describe, expect, it } from 'vitest'
import {
  curveChannelsToFns, curveChannelsToLut1D, identityCurve, identityCurveChannels, insertPoint,
  isIdentityCurve, isIdentityCurveChannels, movePoint, nearestPoint, removePoint,
} from '../curvePoints'

describe('identity helpers', () => {
  it('identityCurve is the two-point diagonal', () => {
    expect(identityCurve()).toEqual([[0, 0], [1, 1]])
  })
  it('isIdentityCurve recognises it and rejects anything else', () => {
    expect(isIdentityCurve(identityCurve())).toBe(true)
    expect(isIdentityCurve([[0, 0], [0.5, 0.6], [1, 1]])).toBe(false)
    expect(isIdentityCurve([[0, 0.1], [1, 1]])).toBe(false)
  })
  it('isIdentityCurveChannels is true only when all four channels are identity', () => {
    const ch = identityCurveChannels()
    expect(isIdentityCurveChannels(ch)).toBe(true)
    expect(isIdentityCurveChannels({ ...ch, r: [[0, 0], [0.5, 0.4], [1, 1]] })).toBe(false)
  })
})

describe('insertPoint', () => {
  it('inserts in sorted x order', () => {
    const pts = insertPoint(insertPoint(identityCurve(), 0.7, 0.3), 0.3, 0.8)
    expect(pts.map((p) => p[0])).toEqual([0, 0.3, 0.7, 1])
  })
  it('clamps y to 0..1 and keeps x away from the endpoints', () => {
    const pts = insertPoint(identityCurve(), 1.5, -1)
    const inserted = pts[pts.length - 2]
    expect(inserted[0]).toBeLessThan(1)
    expect(inserted[1]).toBe(0)
  })
})

describe('movePoint', () => {
  it('moves an interior point freely in x and y, then re-sorts', () => {
    const pts = insertPoint(insertPoint(identityCurve(), 0.3, 0.3), 0.7, 0.7)
    // move the point near x=0.3 past the one near x=0.7
    const moved = movePoint(pts, 1, 0.9, 0.5)
    expect(moved.map((p) => p[0])).toEqual([0, 0.7, 0.9, 1])
  })
  it('locks the left endpoint x at 0, only y moves', () => {
    const moved = movePoint(identityCurve(), 0, 0.4, 0.2)
    expect(moved[0]).toEqual([0, 0.2])
  })
  it('locks the right endpoint x at 1, only y moves', () => {
    const moved = movePoint(identityCurve(), 1, 0.4, 0.8)
    expect(moved[1]).toEqual([1, 0.8])
  })
  it('is a no-op out of range', () => {
    const pts = identityCurve()
    expect(movePoint(pts, 5, 0.5, 0.5)).toBe(pts)
  })
})

describe('removePoint', () => {
  it('removes an interior point', () => {
    const pts = insertPoint(identityCurve(), 0.5, 0.5)
    const out = removePoint(pts, 1)
    expect(out).toEqual(identityCurve())
  })
  it('never removes an endpoint', () => {
    const pts = insertPoint(identityCurve(), 0.5, 0.5)
    expect(removePoint(pts, 0)[0]).toEqual([0, 0])
    expect(removePoint(pts, 2)[2]).toEqual([1, 1])
  })
  it('leaves a two-point curve alone', () => {
    const pts = identityCurve()
    expect(removePoint(pts, 0)).toBe(pts)
  })
})

describe('nearestPoint', () => {
  it('finds the closest point within threshold', () => {
    const pts = insertPoint(identityCurve(), 0.5, 0.5)
    expect(nearestPoint(pts, 0.52, 0.48, 0.05)).toBe(1)
  })
  it('returns -1 when nothing is close enough', () => {
    const pts = identityCurve()
    expect(nearestPoint(pts, 0.5, 0.5, 0.05)).toBe(-1)
  })
})

describe('curveChannelsToFns / curveChannelsToLut1D', () => {
  it('is identity when all channels are identity', () => {
    const fns = curveChannelsToFns(identityCurveChannels())
    expect(fns.r!(0.37)).toBeCloseTo(0.37, 5)
    expect(fns.g!(0.9)).toBeCloseTo(0.9, 5)
    expect(fns.b!(0.1)).toBeCloseTo(0.1, 5)
  })
  it('applies master before the per-channel curve', () => {
    // master maps everything to 0.5; a per-channel curve on r that's otherwise identity should still
    // see 0.5 as its input, not the raw x
    const ch = identityCurveChannels()
    ch.master = [[0, 0.5], [1, 0.5]]
    ch.r = [[0, 0], [0.5, 0.9], [1, 1]]
    const fns = curveChannelsToFns(ch)
    expect(fns.r!(0.1)).toBeCloseTo(0.9, 2)
    expect(fns.r!(0.9)).toBeCloseTo(0.9, 2)
  })
  it('bakes into a Lut1D of the requested size', () => {
    const lut = curveChannelsToLut1D(identityCurveChannels(), 16)
    expect(lut.size).toBe(16)
    expect(lut.r[0]).toBeCloseTo(0, 5)
    expect(lut.r[15]).toBeCloseTo(1, 5)
  })
})
