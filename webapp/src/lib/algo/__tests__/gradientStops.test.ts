import { describe, expect, it } from 'vitest'
import {
  evenlySpace, insertStop, moveStop, removeStop, reverseStops, sampleLutToStops, sampleStopsColor,
  setStopColor, stopsToLut1D, type Stop,
} from '../gradientStops'
import { identity1D } from '../lut'

describe('sampleLutToStops', () => {
  it('samples an identity (grey ramp) LUT into n evenly spaced grey stops', () => {
    const stops = sampleLutToStops(identity1D(256), 4)
    expect(stops).toHaveLength(4)
    expect(stops[0].pos).toBe(0)
    expect(stops[3].pos).toBe(1)
    expect(stops[1].pos).toBeCloseTo(1 / 3, 5)
    for (const s of stops) {
      expect(s.color[0]).toBeCloseTo(s.pos, 2)
      expect(s.color[1]).toBeCloseTo(s.pos, 2)
      expect(s.color[2]).toBeCloseTo(s.pos, 2)
    }
  })
})

describe('sampleStopsColor', () => {
  const stops: Stop[] = [{ pos: 0, color: [0, 0, 0] }, { pos: 1, color: [1, 1, 1] }]
  it('interpolates linearly between stops', () => {
    expect(sampleStopsColor(stops, 0.5)).toEqual([0.5, 0.5, 0.5])
  })
  it('holds the ends constant past the first/last stop', () => {
    expect(sampleStopsColor(stops, -1)).toEqual([0, 0, 0])
    expect(sampleStopsColor(stops, 2)).toEqual([1, 1, 1])
  })
})

describe('insertStop', () => {
  it('inserts a stop coloured to match the existing gradient at that position', () => {
    const base: Stop[] = [{ pos: 0, color: [0, 0, 0] }, { pos: 1, color: [1, 1, 1] }]
    const next = insertStop(base, 0.25)
    expect(next).toHaveLength(3)
    expect(next[1].pos).toBe(0.25)
    expect(next[1].color[0]).toBeCloseTo(0.25, 5)
  })
  it('keeps stops sorted by position', () => {
    const base: Stop[] = [{ pos: 0, color: [0, 0, 0] }, { pos: 1, color: [1, 1, 1] }]
    const next = insertStop(base, 0.1)
    expect(next.map((s) => s.pos)).toEqual([0, 0.1, 1])
  })
})

describe('moveStop / setStopColor', () => {
  it('moves a stop to a new clamped position without touching its colour', () => {
    const base: Stop[] = [{ pos: 0, color: [0, 0, 0] }, { pos: 0.5, color: [0.2, 0.3, 0.4] }, { pos: 1, color: [1, 1, 1] }]
    const moved = moveStop(base, 1, 1.5)
    expect(moved[1].pos).toBe(1)
    expect(moved[1].color).toEqual([0.2, 0.3, 0.4])
  })
  it('recolours a stop without moving it', () => {
    const base: Stop[] = [{ pos: 0, color: [0, 0, 0] }, { pos: 1, color: [1, 1, 1] }]
    const out = setStopColor(base, 0, [0.5, 0.5, 0.5])
    expect(out[0]).toEqual({ pos: 0, color: [0.5, 0.5, 0.5] })
  })
})

describe('removeStop', () => {
  it('removes an interior stop', () => {
    const base: Stop[] = [{ pos: 0, color: [0, 0, 0] }, { pos: 0.5, color: [0.5, 0.5, 0.5] }, { pos: 1, color: [1, 1, 1] }]
    expect(removeStop(base, 1)).toHaveLength(2)
  })
  it('refuses to go below two stops', () => {
    const base: Stop[] = [{ pos: 0, color: [0, 0, 0] }, { pos: 1, color: [1, 1, 1] }]
    expect(removeStop(base, 0)).toBe(base)
  })
})

describe('reverseStops', () => {
  it('mirrors positions and flips order', () => {
    const base: Stop[] = [{ pos: 0, color: [1, 0, 0] }, { pos: 0.25, color: [0, 1, 0] }, { pos: 1, color: [0, 0, 1] }]
    const rev = reverseStops(base)
    expect(rev.map((s) => s.pos)).toEqual([0, 0.75, 1])
    expect(rev[0].color).toEqual([0, 0, 1])
    expect(rev[2].color).toEqual([1, 0, 0])
  })
})

describe('evenlySpace', () => {
  it('respaces stops evenly while keeping colour order', () => {
    const base: Stop[] = [{ pos: 0, color: [1, 0, 0] }, { pos: 0.1, color: [0, 1, 0] }, { pos: 1, color: [0, 0, 1] }]
    const out = evenlySpace(base)
    expect(out.map((s) => s.pos)).toEqual([0, 0.5, 1])
    expect(out.map((s) => s.color)).toEqual([[1, 0, 0], [0, 1, 0], [0, 0, 1]])
  })
})

describe('stopsToLut1D', () => {
  it('builds a Lut1D that reproduces the stop colours at their positions', () => {
    const stops: Stop[] = [{ pos: 0, color: [1, 0, 0] }, { pos: 1, color: [0, 0, 1] }]
    const lut = stopsToLut1D(stops, 256)
    expect(lut.r[0]).toBeCloseTo(1, 2)
    expect(lut.b[0]).toBeCloseTo(0, 2)
    expect(lut.r[255]).toBeCloseTo(0, 2)
    expect(lut.b[255]).toBeCloseTo(1, 2)
  })
})
