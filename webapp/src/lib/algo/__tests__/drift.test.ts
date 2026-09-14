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

import { shiftToFrame, playbackShift, LEGACY_MEASURE_WIDTH, nextSlot, sharpnessDropped, meanAbsLaplacian } from '../drift'

describe('drift shift units (D2)', () => {
  it('scales a shift measured on the downsample to full-frame pixels', () => {
    expect(shiftToFrame({ dx: 10, dy: -4 }, 410, 820)).toEqual({ dx: 20, dy: -8 })
    expect(shiftToFrame({ dx: 10, dy: -4 }, 410, 3280)).toEqual({ dx: 80, dy: -32 })
  })
  it('playback: items with measureWidth are already in frame px; legacy items are rescaled', () => {
    expect(playbackShift({ shift: { dx: 20, dy: 8 }, measureWidth: 410 }, 820)).toEqual({ dx: 20, dy: 8 })
    expect(playbackShift({ shift: { dx: 10, dy: 4 } }, 820)).toEqual({ dx: 20, dy: 8 })
    expect(playbackShift({ shift: { dx: 10, dy: 4 } }, 3280)).toEqual({ dx: 80, dy: 32 })
    // a legacy frame narrower than the analysis width was measured at its own width: no scaling
    expect(playbackShift({ shift: { dx: 3, dy: 1 } }, 320)).toEqual({ dx: 3, dy: 1 })
    expect(LEGACY_MEASURE_WIDTH).toBe(410)
  })
})

describe('time-lapse scheduling', () => {
  it('keeps the next slot on the absolute clock and skips missed ones', () => {
    expect(nextSlot(1000, 0, 1000, 0)).toEqual({ slot: 1, dueAt: 1000, skipped: 0 })   // exactly on time
    expect(nextSlot(1400, 0, 1000, 0)).toEqual({ slot: 2, dueAt: 2000, skipped: 1 })   // slot 1 already 400 ms late: skip it
    expect(nextSlot(3500, 0, 1000, 0)).toEqual({ slot: 4, dueAt: 4000, skipped: 3 })
    expect(nextSlot(200, 0, 1000, 0)).toEqual({ slot: 1, dueAt: 1000, skipped: 0 })    // early: wait for slot 1
  })
  it('refocus trigger on a sharpness drop', () => {
    expect(sharpnessDropped(60, 100, 30)).toBe(true)
    expect(sharpnessDropped(75, 100, 30)).toBe(false)
    expect(sharpnessDropped(10, 100, 0)).toBe(false)
  })
  it('mean |Laplacian| is larger for a sharp edge than a blurred one', () => {
    const w = 32, h = 8
    const sharp = new Float32Array(w * h), soft = new Float32Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { sharp[y * w + x] = x < 16 ? 0 : 100; soft[y * w + x] = 50 + 50 * Math.tanh((x - 16) / 4) }
    expect(meanAbsLaplacian({ data: sharp, width: w, height: h })).toBeGreaterThan(meanAbsLaplacian({ data: soft, width: w, height: h }))
  })
})
