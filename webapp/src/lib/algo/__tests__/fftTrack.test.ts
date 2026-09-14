import { describe, expect, it } from 'vitest'
import { displacement, trackFrame, centralCrop } from '../fftTrack'
import { makeScene, makeLcgScene } from './helpers/scene'

// Sub-pixel accuracy of `displacement()`. The auditor's report (superres-hdr-report.md §3.1)
// measured 0.18-0.84 px error for 0.25-1 px shifts with the old thresholded-centroid/parabola
// average, and two outright 44 px outliers from a near-periodic LCG test scene. The current
// estimator (local-DFT upsampling of the un-thresholded peak neighbourhood, fftTrack.ts
// `refinePeak`) is checked here at both full resolution and the downscaled sizes the coarse stage
// of `register()` actually runs at (registration itself always happens on a real image, never on a
// scene generator, but the frame *size* after an 4x/8x box downscale of a 3280 px sensor is what
// matters for the FFT patch geometry, so the scenes below are generated directly at those sizes).
const SHIFTS: [number, number][] = [
  [0.1, 0], [0, 0.1], [0.2, 0.1], [0.3, -0.2], [0.4, 0.25], [-0.35, 0.4], [0.5, 0.5], [-0.5, -0.3],
]

function checkSubpixel(w: number, h: number, seed: number) {
  const scene = makeScene(w, h, { seed })
  const template = scene.gray(w, h, 0, 0)
  for (const [sx, sy] of SHIFTS) {
    const image = scene.gray(w, h, sx, sy)
    const d = displacement(template, image)
    expect(Math.abs(d.dx - sx)).toBeLessThan(0.05)
    expect(Math.abs(d.dy - sy)).toBeLessThan(0.05)
  }
}

describe('displacement: sub-pixel accuracy', () => {
  it('full resolution (410x308, register()\'s coarseW default)', () => checkSubpixel(410, 308, 1))
  it('4x-downscaled-sized frame (205x154, the 1640px stream / 4)', () => checkSubpixel(205, 154, 2))
  it('8x-downscaled-sized frame (128x96, the 3280px sensor / 8, near register()\'s coarse stage)', () => checkSubpixel(128, 96, 3))

  it('does not produce the 44 px outlier the report measured, across a dense shift grid', () => {
    // The report's failure came from the LCG scene's near-periodicity at lag (-8, 44); reproduce it
    // with makeLcgScene (kept specifically for this) and confirm the refined estimator does not fail.
    const w = 96, h = 96
    const scene = makeLcgScene(w, h)
    const template = scene.gray(w, h, 0, 0)
    const grid: [number, number][] = []
    for (let sx = -2; sx <= 2; sx += 0.25) for (let sy = -2; sy <= 2; sy += 0.37) grid.push([sx, sy])
    let maxErr = 0
    for (const [sx, sy] of grid) {
      const d = displacement(template, scene.gray(w, h, sx, sy))
      maxErr = Math.max(maxErr, Math.hypot(d.dx - sx, d.dy - sy))
    }
    expect(maxErr).toBeLessThan(1)
  })

  it('integer and larger shifts remain accurate too', () => {
    const w = 200, h = 160
    const scene = makeScene(w, h, { seed: 7 })
    const template = scene.gray(w, h, 0, 0)
    for (const [sx, sy] of [[8, 0], [0, -8], [4, 4], [12.5, -6.25]] as [number, number][]) {
      const d = displacement(template, scene.gray(w, h, sx, sy))
      expect(Math.abs(d.dx - sx)).toBeLessThan(0.1)
      expect(Math.abs(d.dy - sy)).toBeLessThan(0.1)
    }
  })
})

describe('displacement: quality separates good from failed registrations', () => {
  it('scores a correct match much higher than an unrelated pair', () => {
    const w = 128, h = 128
    const a = makeScene(w, h, { seed: 11 })
    const b = makeScene(w, h, { seed: 12 })
    const good = displacement(a.gray(w, h, 0, 0), a.gray(w, h, 1.3, -0.7))
    const bad = displacement(a.gray(w, h, 0, 0), b.gray(w, h, 0, 0))
    expect(Number.isFinite(good.quality) ? good.quality : 1e6).toBeGreaterThan(2)
    expect(bad.quality).toBeLessThan(good.quality)
    expect(bad.quality).toBeLessThan(2)
  })

  it('never throws or returns NaN on a featureless (zero-information) frame', () => {
    const w = 128, h = 128
    const scene = makeScene(w, h, { seed: 13 })
    const template = scene.gray(w, h, 0, 0)
    // a perfectly flat frame carries no registration information at all; the estimator must
    // degrade to *some* well-defined number (Infinity is a legitimate "no ambiguity found" answer
    // here, since there is no sidelobe either) rather than NaN or a thrown error.
    const flat = { data: new Float32Array(w * h).fill(128), width: w, height: h }
    const d = displacement(template, flat)
    expect(Number.isNaN(d.quality)).toBe(false)
    expect(Number.isNaN(d.dx)).toBe(false)
    expect(Number.isNaN(d.dy)).toBe(false)
  })
})

describe('trackFrame / centralCrop', () => {
  it('measures the same shift via a central-crop template as full-frame displacement', () => {
    const w = 160, h = 128
    const scene = makeScene(w, h, { seed: 21 })
    const frame0 = scene.gray(w, h, 0, 0)
    const template = centralCrop(frame0, 0.5)
    const frame1 = scene.gray(w, h, 0.4, -0.3)
    const d = trackFrame(template, frame1, 0.5)
    expect(Math.abs(d.dx - 0.4)).toBeLessThan(0.1)
    expect(Math.abs(d.dy - (-0.3))).toBeLessThan(0.1)
  })
})
