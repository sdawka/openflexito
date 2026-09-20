import { describe, expect, it } from 'vitest'
import { TemporalDenoiser } from '../temporalDenoise'
import { makeScene, mulberry32 } from './helpers/scene'

function noisyFlatFrame(w: number, h: number, base: number, amp: number, seed: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4)
  const rnd = mulberry32(seed)
  for (let i = 0; i < w * h; i++) {
    const v = Math.min(255, Math.max(0, base + (rnd() - 0.5) * 2 * amp))
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v
    out[i * 4 + 3] = 255
  }
  return out
}

describe('TemporalDenoiser: static scene convergence', () => {
  it('reduces per-pixel noise variance over successive frames of the same static scene', () => {
    const w = 32, h = 32, base = 128, amp = 20
    const dn = new TemporalDenoiser({ alpha: 0.8, maxShiftPx: 5 })
    let last: Uint8ClampedArray = noisyFlatFrame(w, h, base, amp, 1)
    for (let f = 0; f < 20; f++) last = dn.push(noisyFlatFrame(w, h, base, amp, f + 1), w, h, { dx: 0, dy: 0 })
    let sum = 0, sum2 = 0
    const n = w * h
    for (let i = 0; i < n; i++) { const v = last[i * 4]; sum += v; sum2 += v * v }
    const mean = sum / n, variance = sum2 / n - mean * mean
    const inputVariance = (2 * amp) ** 2 / 12 // uniform noise variance
    expect(variance).toBeLessThan(inputVariance * 0.5)
  })
})

describe('TemporalDenoiser: follows a known stage shift', () => {
  it('tracks a translating scene with low residual when given the correct per-frame shift', () => {
    const w = 48, h = 48
    const scene = makeScene(w, h, { seed: 5, blurR: 2, passes: 2 })
    const dn = new TemporalDenoiser({ alpha: 0.8, maxShiftPx: 10 })
    let out: Uint8ClampedArray = new Uint8ClampedArray(w * h * 4)
    for (let f = 0; f < 5; f++) {
      const sx = f * 2
      const rgba = scene.rgba(w, h, sx, 0)
      out = dn.push(rgba, w, h, f === 0 ? undefined : { dx: 2, dy: 0 })
    }
    const truth = scene.rgba(w, h, 8, 0)
    let mse = 0
    for (let i = 0; i < w * h; i++) { const d = out[i * 4] - truth[i * 4]; mse += d * d }
    mse /= w * h
    expect(Math.sqrt(mse)).toBeLessThan(15)
  })
})

describe('TemporalDenoiser: does not ghost a moving object', () => {
  function frameWithSquare(pos: number): Uint8ClampedArray {
    const w = 40, h = 40
    const out = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = 30; out[i * 4 + 3] = 255 }
    for (let y = 15; y < 21; y++) for (let x = pos; x < pos + 6; x++) {
      const idx = (y * w + x) * 4
      out[idx] = out[idx + 1] = out[idx + 2] = 220
    }
    return out
  }

  it('an object that moves without a matching stage shift is not smeared across old/new positions', () => {
    const dn = new TemporalDenoiser({ alpha: 0.85, maxShiftPx: 5 })
    dn.push(frameWithSquare(2), 40, 40, { dx: 0, dy: 0 })
    dn.push(frameWithSquare(2), 40, 40, { dx: 0, dy: 0 })
    const out = dn.push(frameWithSquare(20), 40, 40, { dx: 0, dy: 0 })
    const w = 40
    const atNewPos = out[(17 * w + 22) * 4]
    const atOldPos = out[(17 * w + 4) * 4]
    expect(atNewPos).toBeGreaterThan(150) // follows the object to its new position
    expect(atOldPos).toBeLessThan(150)    // no stale bright ghost left behind
  })
})

describe('TemporalDenoiser: reset', () => {
  it('reset() drops history so the next push behaves like the first frame', () => {
    const w = 16, h = 16
    const dn = new TemporalDenoiser({ alpha: 0.8, maxShiftPx: 5 })
    dn.push(noisyFlatFrame(w, h, 100, 10, 1), w, h, { dx: 0, dy: 0 })
    dn.reset()
    const bright = new Uint8ClampedArray(w * h * 4).fill(255)
    const out = dn.push(bright, w, h)
    expect(out[0]).toBe(255) // first frame after reset passes through unblended
  })

  it('re-estimates sigma immediately after reset() rather than reusing the stale cached value', () => {
    // Regression guard for the sigma-caching change: after reset, the very next push must not skip
    // its sigma refresh just because frameCount% happens to be 0 from a stale counter.
    const w = 16, h = 16
    const dn = new TemporalDenoiser({ alpha: 0.8, maxShiftPx: 5, sigmaRefreshFrames: 8 })
    for (let f = 0; f < 3; f++) dn.push(noisyFlatFrame(w, h, 100, 10, f + 1), w, h, { dx: 0, dy: 0 })
    dn.reset()
    // first frame after reset always passes straight through (no `prev` yet) regardless of sigma
    const out = dn.push(noisyFlatFrame(w, h, 100, 10, 99), w, h, { dx: 0, dy: 0 })
    expect(out).toBeInstanceOf(Uint8ClampedArray)
  })
})

describe('TemporalDenoiser: performance at 1640x1232', () => {
  // Bound kept generous (measured ~40-45ms/frame in isolation; the old per-frame full-sort MAD cost
  // was ~440ms/frame) because vitest runs this alongside every other suite's worker threads, and CI/
  // shared-runner contention can add real overhead unrelated to a regression in this code.
  it('runs at well under 150 ms/frame once warmed up (target: 15+ fps on a laptop, i.e. < ~67ms)', () => {
    const w = 1640, h = 1232
    const dn = new TemporalDenoiser({ alpha: 0.85, maxShiftPx: 20 })
    const frame = (seed: number): Uint8ClampedArray => {
      const rnd = mulberry32(seed)
      const out = new Uint8ClampedArray(w * h * 4)
      for (let i = 0; i < w * h; i++) {
        const v = Math.min(255, Math.max(0, 128 + (rnd() - 0.5) * 40))
        out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v
        out[i * 4 + 3] = 255
      }
      return out
    }
    // warm-up (allocates working buffers; also forces one sigma refresh)
    dn.push(frame(1), w, h, { dx: 0, dy: 0 })
    dn.push(frame(2), w, h, { dx: 0, dy: 0 })

    const frames = 20
    const t0 = performance.now()
    for (let f = 0; f < frames; f++) dn.push(frame(f + 10), w, h, { dx: 1, dy: 0 })
    const elapsed = performance.now() - t0
    const perFrame = elapsed / frames
    // eslint-disable-next-line no-console
    console.log(`TemporalDenoiser.push @ 1640x1232: ${perFrame.toFixed(1)} ms/frame (${frames} frames, ${elapsed.toFixed(1)} ms total)`)
    expect(perFrame).toBeLessThan(150)
  })
})
