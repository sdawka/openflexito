import { describe, expect, it } from 'vitest'
import { Stabilizer, defaultStabilizeOptions } from '../stabilize'
import { makeScene } from './helpers/scene'

// A synthetic hand-held pan: a slow, deliberate drift (the trend) with a small high-frequency
// wobble riding on top (the jitter). The stabiliser should let the trend through (the smoothed
// trajectory, `raw - dx`, should track it) while removing most of the wobble.
function run(fps: number, frames: number, trendPerFrame: number, jitterAmp: number, jitterFreq: number) {
  const w = 205, h = 154
  const scene = makeScene(w, h, { seed: 7 })
  const s = new Stabilizer(defaultStabilizeOptions)
  const trend: number[] = [], pos_: number[] = [], raw: number[] = [], smoothed: number[] = []
  for (let i = 0; i < frames; i++) {
    const t = trendPerFrame * i
    const j = jitterAmp * Math.sin(i * jitterFreq)
    const pos = t + j
    const gray = scene.gray(w, h, pos, 0)
    const r = s.track(gray, i / fps)
    trend.push(t); pos_.push(pos); raw.push(r.rawDx); smoothed.push(r.rawDx - r.dx)
  }
  return { trend, pos: pos_, raw, smoothed }
}

describe('Stabilizer', () => {
  it('tracks the raw trajectory accurately (sanity: the underlying displacement measurement works)', () => {
    const { pos, raw } = run(20, 40, 0.4, 3, 1.3)
    // skip the first couple of frames (no reference yet / filter warm-up)
    for (let i = 5; i < pos.length; i++) expect(Math.abs(raw[i] - pos[i])).toBeLessThan(0.5)
  })

  it('the smoothed trajectory follows the slow trend and removes most of the fast jitter', () => {
    const { trend, smoothed } = run(20, 60, 0.4, 4, 1.3)
    // after the filter has settled, the smoothed position should sit close to the trend line...
    let errSum = 0, n = 0
    for (let i = 15; i < trend.length; i++) { errSum += Math.abs(smoothed[i] - trend[i]); n++ }
    expect(errSum / n).toBeLessThan(1.5)
    // ...and the frame-to-frame variation left in the smoothed signal (the residual jitter) should be
    // much smaller than the injected jitter amplitude.
    let maxStep = 0
    for (let i = 16; i < trend.length; i++) maxStep = Math.max(maxStep, Math.abs((smoothed[i] - trend[i]) - (smoothed[i - 1] - trend[i - 1])))
    expect(maxStep).toBeLessThan(2)
  })

  it('reset() drops the reference so the next frame becomes a fresh anchor', () => {
    const w = 128, h = 96
    const scene = makeScene(w, h, { seed: 3 })
    const s = new Stabilizer()
    const r0 = s.track(scene.gray(w, h, 0, 0), 0)
    expect(r0.reanchored).toBe(true)
    s.track(scene.gray(w, h, 5, 0), 0.05)
    s.reset()
    const r1 = s.track(scene.gray(w, h, 50, 0), 1)   // a jump that would exceed reanchorPx against the old reference
    expect(r1.reanchored).toBe(true)
    expect(r1.rawDx).toBe(0)
  })

  it('clamps the correction to maxShiftPx', () => {
    const w = 128, h = 96
    const scene = makeScene(w, h, { seed: 9 })
    const s = new Stabilizer({ ...defaultStabilizeOptions, minCutoff: 0.05, beta: 0, maxShiftPx: 5, reanchorPx: 1000 })
    s.track(scene.gray(w, h, 0, 0), 0)
    // a sudden large jump: the (heavily smoothed) filtered position lags far behind, so the raw
    // correction would be big; it must be clamped.
    const r = s.track(scene.gray(w, h, 60, 0), 0.05)
    expect(Math.hypot(r.dx, r.dy)).toBeLessThanOrEqual(5 + 1e-6)
  })
})
