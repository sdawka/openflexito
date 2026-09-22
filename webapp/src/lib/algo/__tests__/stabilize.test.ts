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

  it('tracks a known sub-pixel shift accurately (register.ts integration, not a reinvented downscale-then-correlate)', () => {
    const w = 205, h = 154
    const scene = makeScene(w, h, { seed: 11 })
    const s = new Stabilizer({ ...defaultStabilizeOptions, minCutoff: 50, beta: 0 })  // near-zero smoothing lag
    s.track(scene.gray(w, h, 0, 0), 0)
    const r = s.track(scene.gray(w, h, 3.37, -1.2), 0.05)
    expect(r.rawDx).toBeCloseTo(3.37, 0)
    expect(r.rawDy).toBeCloseTo(-1.2, 0)
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

// ---- rotation (docs/video-research/motion.md proposal 2(d)) ----

import { rotationMargin, stabilizeOptionsFor, STABILIZE_STRENGTH_HZ } from '../stabilize'
import type { Scene } from './helpers/scene'
import type { Gray } from '../sharpness'

/** The scene rotated by `deg` about the frame centre (positive = clockwise on screen, canvas y-down
 *  convention) and then translated by (sx, sy): output(x) = scene(R⁻¹(x − c) + c − s). */
function rotatedGray(scene: Scene, w: number, h: number, deg: number, sx = 0, sy = 0): Gray {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a)
  const cx = (w - 1) / 2, cy = (h - 1) / 2
  const data = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const u = x - cx, v = y - cy
    data[y * w + x] = scene.at(cx + u * c + v * s - sx, cy - u * s + v * c - sy)
  }
  return { data, width: w, height: h }
}

const deg = (rad: number): number => rad * 180 / Math.PI

describe('Stabilizer rotation', () => {
  const w = 320, h = 240

  it('recovers a ~1° rotation of a textured frame within 0.2° (raw θ) and returns a correction of the opposite sign', () => {
    const scene = makeScene(w, h, { seed: 21 })
    const s = new Stabilizer({ ...defaultStabilizeOptions, rotation: true })
    s.track(rotatedGray(scene, w, h, 0), 0)
    const r = s.track(rotatedGray(scene, w, h, 1.0), 0.05)
    expect(r.rotationConfident).toBe(true)
    expect(Math.abs(deg(r.rawTheta) - 1.0)).toBeLessThan(0.2)
    // the smoothed path (0.5 Hz) lags far behind a 1° step in 50 ms: most of the step is jitter, and
    // the correction rotates the frame back (opposite sign to the measured rotation)
    expect(r.theta).toBeLessThan(0)
    expect(Math.abs(deg(r.theta))).toBeGreaterThan(0.5)
    expect(Math.abs(deg(r.theta))).toBeLessThan(1.0)
  })

  it('measures rotation and translation together (rotation about the centre plus a shift)', () => {
    const scene = makeScene(w, h, { seed: 22 })
    const s = new Stabilizer({ ...defaultStabilizeOptions, rotation: true, minCutoff: 50, beta: 0 })
    s.track(rotatedGray(scene, w, h, 0), 0)
    const r = s.track(rotatedGray(scene, w, h, -0.8, 4.3, -2.1), 0.05)
    expect(r.rotationConfident).toBe(true)
    expect(Math.abs(deg(r.rawTheta) - (-0.8))).toBeLessThan(0.2)
    expect(Math.abs(r.rawDx - 4.3)).toBeLessThan(0.3)
    expect(Math.abs(r.rawDy - (-2.1))).toBeLessThan(0.3)
  })

  it('applies a dead band: a still scene gets theta 0 exactly', () => {
    const scene = makeScene(w, h, { seed: 23 })
    const s = new Stabilizer({ ...defaultStabilizeOptions, rotation: true })
    s.track(rotatedGray(scene, w, h, 0), 0)
    const r = s.track(rotatedGray(scene, w, h, 0.01), 0.05)
    expect(r.theta).toBe(0)
    expect(Math.abs(deg(r.rawTheta))).toBeLessThan(0.05)
  })

  it('accumulates θ across a re-anchor', () => {
    const scene = makeScene(w, h, { seed: 24 })
    const s = new Stabilizer({ ...defaultStabilizeOptions, rotation: true, reanchorPx: 5 })
    s.track(rotatedGray(scene, w, h, 0), 0)
    const r1 = s.track(rotatedGray(scene, w, h, 0.5, 8, 0), 0.05)   // > reanchorPx: re-anchors here
    expect(r1.reanchored).toBe(true)
    const r2 = s.track(rotatedGray(scene, w, h, 1.0, 8, 0), 0.10)
    expect(Math.abs(deg(r2.rawTheta) - 1.0)).toBeLessThan(0.25)
  })

  it('translation-only mode is unaffected: theta is 0 and dx/dy match a rotation-enabled run on the same frames', () => {
    const scene = makeScene(w, h, { seed: 25 })
    const a = new Stabilizer({ ...defaultStabilizeOptions, rotation: false })
    const b = new Stabilizer({ ...defaultStabilizeOptions, rotation: true })
    const frames = [rotatedGray(scene, w, h, 0), rotatedGray(scene, w, h, 0.6, 1.2, 0.4), rotatedGray(scene, w, h, 0.3, 2.5, -0.7)]
    frames.forEach((g, i) => {
      const ra = a.track(g, i / 18), rb = b.track(g, i / 18)
      expect(ra.theta).toBe(0); expect(ra.rawTheta).toBe(0); expect(ra.rotationConfident).toBe(false)
      expect(ra.dx).toBe(rb.dx); expect(ra.dy).toBe(rb.dy)
      expect(ra.rawDx).toBe(rb.rawDx); expect(ra.rawDy).toBe(rb.rawDy)
    })
  })

  it('reset() clears the rotation state too', () => {
    const scene = makeScene(w, h, { seed: 26 })
    const s = new Stabilizer({ ...defaultStabilizeOptions, rotation: true })
    s.track(rotatedGray(scene, w, h, 0), 0)
    s.track(rotatedGray(scene, w, h, 1), 0.05)
    s.reset()
    const r = s.track(rotatedGray(scene, w, h, 1), 1)
    expect(r.rawTheta).toBe(0); expect(r.theta).toBe(0)
  })
})

describe('rotationMargin', () => {
  it('is 0 for no rotation and grows with the angle and the longer side', () => {
    expect(rotationMargin(1640, 1232, 0)).toBe(0)
    const m1 = rotationMargin(1640, 1232, 1 * Math.PI / 180)
    const m2 = rotationMargin(1640, 1232, 2 * Math.PI / 180)
    // ≈ 0.5·max(w,h)·sin θ = 14.3 px at 1° (the report's 0.5·h·sin θ ≈ 11 px covers only the
    // left/right edges of a landscape frame)
    expect(m1).toBeGreaterThanOrEqual(14); expect(m1).toBeLessThanOrEqual(15)
    expect(m2).toBeGreaterThan(m1)
    expect(rotationMargin(1232, 1640, 1 * Math.PI / 180)).toBe(m1)
  })

  it('is sufficient: the crop corner stays inside the rotated source', () => {
    const w = 1640, h = 1232, t = 1.5 * Math.PI / 180, m = rotationMargin(w, h, t)
    const c = Math.cos(t), s = Math.sin(t)
    for (const [x, y] of [[w / 2 - m, h / 2 - m], [w / 2 - m, -(h / 2 - m)]]) {
      // rotate the crop corner back into source coordinates (either direction: symmetric)
      expect(Math.abs(x * c - y * s)).toBeLessThanOrEqual(w / 2 + 1e-9)
      expect(Math.abs(x * s + y * c)).toBeLessThanOrEqual(h / 2 + 1e-9)
    }
  })
})

describe('stabilizeOptionsFor', () => {
  it('maps the strength presets onto minCutoff and keeps everything else', () => {
    const base = { ...defaultStabilizeOptions, maxShiftPx: 77, rotation: true }
    expect(stabilizeOptionsFor('light', base)).toEqual({ ...base, minCutoff: 3 })
    expect(stabilizeOptionsFor('normal', base).minCutoff).toBe(1)
    expect(stabilizeOptionsFor('strong', base).minCutoff).toBe(0.3)
    expect(stabilizeOptionsFor('normal').minCutoff).toBe(STABILIZE_STRENGTH_HZ.normal)
  })

  it('strong smooths more than light on the same jitter', () => {
    const out = (strength: 'light' | 'strong') => {
      const w = 205, h = 154
      const scene = makeScene(w, h, { seed: 8 })
      const s = new Stabilizer(stabilizeOptionsFor(strength))
      let sumAbs = 0
      for (let i = 0; i < 40; i++) {
        const r = s.track(scene.gray(w, h, 3 * Math.sin(i * 1.3), 0), i / 20)
        if (i >= 10) sumAbs += Math.abs(r.dx)
      }
      return sumAbs
    }
    // the correction removes more of the jitter with the lower cutoff
    expect(out('strong')).toBeGreaterThan(out('light'))
  })
})
