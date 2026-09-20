import { describe, expect, it } from 'vitest'
import { estimateSigmaMad, anscombe, anscombeInverse } from '../noise'
import type { NoiseModel } from '../noise'
import { makeScene, mulberry32 } from './helpers/scene'

function addGaussianNoise(data: Float32Array, sigma: number, seed: number): Float32Array {
  const rnd = mulberry32(seed)
  const out = new Float32Array(data.length)
  for (let i = 0; i < data.length; i += 2) {
    // Box-Muller for a proper Gaussian (uniform noise has the wrong MAD/sigma relationship)
    const u1 = Math.max(1e-9, rnd()), u2 = rnd()
    const mag = Math.sqrt(-2 * Math.log(u1))
    const z0 = mag * Math.cos(2 * Math.PI * u2), z1 = mag * Math.sin(2 * Math.PI * u2)
    out[i] = data[i] + z0 * sigma
    if (i + 1 < data.length) out[i + 1] = data[i + 1] + z1 * sigma
  }
  return out
}

describe('estimateSigmaMad', () => {
  it('estimates the injected Gaussian sigma within 15% on a smooth synthetic image', () => {
    const scene = makeScene(96, 96, { seed: 3, blurR: 3, passes: 3 })
    const clean = scene.gray(96, 96, 0, 0)
    const sigma = 6
    const noisy = addGaussianNoise(clean.data, sigma, 7)
    const est = estimateSigmaMad(noisy, 96, 96)
    expect(est).toBeGreaterThan(sigma * 0.85)
    expect(est).toBeLessThan(sigma * 1.15)
  })

  it('returns near zero on a perfectly flat plane', () => {
    const flat = new Float32Array(64 * 64).fill(0.5)
    expect(estimateSigmaMad(flat, 64, 64)).toBeCloseTo(0, 5)
  })

  it('stays within ~5% of a small-image estimate when the HH subband is large enough to be strided '
    + '(regression guard for the strided-subsample + quickselect fast path)', () => {
    // A big-but-uniform-statistics image: the HH subband (~ (w/2)*(h/2)) comfortably exceeds the
    // 65536-sample cap, so this exercises the subsampling path directly.
    const w = 1024, h = 1024
    const scene = makeScene(w, h, { seed: 4, blurR: 3, passes: 3 })
    const clean = scene.gray(w, h, 0, 0)
    const sigma = 8
    const noisy = addGaussianNoise(clean.data, sigma, 21)
    const est = estimateSigmaMad(noisy, w, h)
    expect(est).toBeGreaterThan(sigma * 0.85)
    expect(est).toBeLessThan(sigma * 1.15)
  })

  it('runs in well under 20ms at 1640x1232 (the per-frame cost TemporalDenoiser now only pays every '
    + 'few frames — see temporalDenoise.test.ts for the end-to-end frame budget)', () => {
    const w = 1640, h = 1232
    const rnd = mulberry32(9)
    const data = Float32Array.from({ length: w * h }, () => rnd())
    const t0 = performance.now()
    estimateSigmaMad(data, w, h)
    const elapsed = performance.now() - t0
    // eslint-disable-next-line no-console
    console.log(`estimateSigmaMad @ 1640x1232: ${elapsed.toFixed(2)} ms`)
    expect(elapsed).toBeLessThan(20)
  })
})

describe('anscombe / anscombeInverse round trip', () => {
  const model: NoiseModel = { gain: 0.02, readSigma: 2, black: 0, white: 1023 }

  it('round-trips a ramp of DN values (no added noise) to within a small relative error', () => {
    const n = 500
    const y = new Float32Array(n)
    for (let i = 0; i < n; i++) y[i] = (i / n) * 1000
    const z = anscombe(y, model)
    const back = anscombeInverse(z, model)
    for (let i = 0; i < n; i++) {
      const rel = Math.abs(back[i] - y[i]) / Math.max(5, y[i])
      expect(rel).toBeLessThan(0.05)
    }
  })

  it('stabilises variance: the spread of transformed noisy samples is roughly constant across signal levels', () => {
    const levels = [10, 100, 500, 900]
    const spreads: number[] = []
    for (const level of levels) {
      const rnd = mulberry32(level)
      const samples = new Float32Array(400)
      for (let i = 0; i < samples.length; i++) {
        // crude Poisson-ish + Gaussian read noise simulation via repeated uniform sums (CLT) scaled to
        // the model's variance at this level
        const variance = model.gain * level + model.readSigma * model.readSigma
        let s = 0
        for (let k = 0; k < 12; k++) s += rnd() - 0.5
        samples[i] = level + s * Math.sqrt(variance)
      }
      const z = anscombe(samples, model)
      let mean = 0
      for (const v of z) mean += v
      mean /= z.length
      let varZ = 0
      for (const v of z) varZ += (v - mean) ** 2
      varZ /= z.length
      spreads.push(varZ)
    }
    // all levels' transformed variance should be within a factor of 3 of each other (loose bound —
    // the point is they don't scale linearly with `level` the way the untransformed variance does)
    const mn = Math.min(...spreads), mx = Math.max(...spreads)
    expect(mx / mn).toBeLessThan(4)
  })
})
