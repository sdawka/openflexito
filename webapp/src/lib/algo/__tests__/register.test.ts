import { describe, expect, it } from 'vitest'
import { register, boxDown } from '../register'
import { makeScene } from './helpers/scene'

// Coarse-to-fine registration: a downscaled integer estimate followed by full-resolution refinement
// on a central crop, the same two-stage idea `SliceAligner` already uses for focus stacks
// (CLAUDE.md). superres-hdr-report.md §3.1 measured 0.36-0.84 px error and outright 44 px failures
// when registering on the whole frame at an 8x downscale; the same estimator on a 410x308
// full-resolution crop gave 0.03-0.07 px. `register()` should recover full-resolution accuracy
// regardless of frame size, by always refining on a full-resolution crop.

describe('register: coarse-to-fine', () => {
  it('recovers sub-pixel shifts to ~0.05 px on a large frame (where the old whole-frame-downscale path failed)', () => {
    const w = 1024, h = 768
    const scene = makeScene(w, h, { seed: 5 })
    const ref = scene.gray(w, h, 0, 0)
    for (const [sx, sy] of [[0.2, 0.1], [0.5, -0.3], [0.75, 0.4], [1.3, -0.9]] as [number, number][]) {
      const img = scene.gray(w, h, sx, sy)
      const r = register(ref, img)
      expect(Math.abs(r.dx - sx)).toBeLessThan(0.05)
      expect(Math.abs(r.dy - sy)).toBeLessThan(0.05)
      expect(r.confident).toBe(true)
    }
  })

  it('handles larger integer-ish shifts via the coarse stage plus fine residual', () => {
    const w = 900, h = 700
    const scene = makeScene(w, h, { seed: 6 })
    const ref = scene.gray(w, h, 0, 0)
    const img = scene.gray(w, h, 22.4, -15.7)
    const r = register(ref, img)
    expect(Math.abs(r.dx - 22.4)).toBeLessThan(0.15)
    expect(Math.abs(r.dy - (-15.7))).toBeLessThan(0.15)
    expect(r.confident).toBe(true)
  })

  it('reports low confidence for an unrelated (mis-registered) pair rather than a silent wrong answer', () => {
    const w = 512, h = 384
    const a = makeScene(w, h, { seed: 30 })
    const b = makeScene(w, h, { seed: 31 })
    const r = register(a.gray(w, h, 0, 0), b.gray(w, h, 0, 0))
    expect(r.confident).toBe(false)
  })

  it('flags a shift beyond maxShiftFrac as not confident', () => {
    const w = 512, h = 384
    const scene = makeScene(w, h, { seed: 40 })
    const ref = scene.gray(w, h, 0, 0)
    const img = scene.gray(w, h, 200, 0)   // > 0.2 * 512
    const r = register(ref, img, { maxShiftFrac: 0.2 })
    expect(r.confident).toBe(false)
  })

  it('throws on mismatched frame sizes', () => {
    const scene = makeScene(64, 64, { seed: 1 })
    expect(() => register(scene.gray(64, 64, 0, 0), scene.gray(32, 32, 0, 0))).toThrow()
  })
})

describe('boxDown', () => {
  it('averages fxf blocks and preserves overall scene mean', () => {
    const w = 40, h = 32
    const data = new Float32Array(w * h)
    for (let i = 0; i < data.length; i++) data[i] = (i * 37) % 251
    const g = { data, width: w, height: h }
    const down = boxDown(g, 4)
    expect(down.width).toBe(10); expect(down.height).toBe(8)
    const mean = (arr: Float32Array): number => { let s = 0; for (const v of arr) s += v; return s / arr.length }
    expect(mean(down.data)).toBeCloseTo(mean(data), 5)
  })

  it('is a no-op for f <= 1', () => {
    const g = { data: new Float32Array([1, 2, 3, 4]), width: 2, height: 2 }
    expect(boxDown(g, 1)).toBe(g)
  })
})
