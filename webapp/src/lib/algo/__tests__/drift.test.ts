import { describe, expect, it } from 'vitest'
import { DriftTracker, driftBounds } from '../drift'

describe('DriftTracker', () => {
  it('does not correct while drift stays under the threshold', () => {
    const t = new DriftTracker(20)
    const r1 = t.record({ dx: 3, dy: 2 })
    expect(r1.offset).toEqual({ x: 3, y: 2 })
    expect(r1.shouldCorrect).toBe(false)
    const r2 = t.record({ dx: 5, dy: -1 })   // origin is unchanged between calls without a rebase
    expect(r2.offset).toEqual({ x: 5, y: -1 })
    expect(r2.shouldCorrect).toBe(false)
  })

  it('flags a correction once the accumulated drift exceeds the threshold', () => {
    const t = new DriftTracker(10)
    const r = t.record({ dx: 8, dy: 8 })   // hypot(8,8) ≈ 11.3 > 10
    expect(r.shouldCorrect).toBe(true)
    expect(r.offset).toEqual({ x: 8, y: 8 })
  })

  it('rebase carries over any shortfall as the new origin', () => {
    const t = new DriftTracker(10)
    const r = t.record({ dx: 20, dy: 0 })
    expect(r.shouldCorrect).toBe(true)
    // the stage only corrected 15 of the 20 px owed
    t.rebase(r.offset, { x: 15, y: 0 })
    const next = t.record({ dx: 0, dy: 0 })   // fresh template, no new measured shift yet
    expect(next.offset).toEqual({ x: 5, y: 0 })
    expect(next.shouldCorrect).toBe(false)
  })

  it('rebase with the full offset resets the origin to zero', () => {
    const t = new DriftTracker(10)
    const r = t.record({ dx: 12, dy: 9 })
    t.rebase(r.offset, r.offset)
    const next = t.record({ dx: 1, dy: 1 })
    expect(next.offset).toEqual({ x: 1, y: 1 })
  })

  it('reset clears the origin', () => {
    const t = new DriftTracker(10)
    t.record({ dx: 5, dy: 5 })
    t.rebase({ x: 5, y: 5 }, { x: 0, y: 0 })   // origin becomes {5,5}
    t.reset()
    expect(t.record({ dx: 0, dy: 0 }).offset).toEqual({ x: 0, y: 0 })
  })
})

describe('driftBounds', () => {
  it('returns the largest absolute x/y offset', () => {
    const b = driftBounds([{ dx: 2, dy: -3 }, { dx: -7, dy: 1 }, { dx: 4, dy: 5 }])
    expect(b).toEqual({ x: 7, y: 5 })
  })
  it('is zero for no shifts', () => {
    expect(driftBounds([])).toEqual({ x: 0, y: 0 })
  })
})
