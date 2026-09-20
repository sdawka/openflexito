import { describe, expect, it } from 'vitest'
import {
  boxFilter, gaussianBlur, guidedFilter, bilateral, waveletShrink, nlmFast, denoisePlane, denoiseRgb,
} from '../denoise'
import type { Plane, DenoiseParams } from '../denoise'
import { makeScene, mulberry32 } from './helpers/scene'

function addGaussianNoise(data: Float32Array, sigma: number, seed: number): Float32Array {
  const rnd = mulberry32(seed)
  const out = new Float32Array(data.length)
  for (let i = 0; i < data.length; i += 2) {
    const u1 = Math.max(1e-9, rnd()), u2 = rnd()
    const mag = Math.sqrt(-2 * Math.log(u1))
    out[i] = data[i] + mag * Math.cos(2 * Math.PI * u2) * sigma
    if (i + 1 < data.length) out[i + 1] = data[i + 1] + mag * Math.sin(2 * Math.PI * u2) * sigma
  }
  return out
}

function mse(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2
  return s / a.length
}
function psnr(a: Float32Array, b: Float32Array, peak = 1): number {
  const m = mse(a, b)
  return m <= 1e-12 ? Infinity : 10 * Math.log10((peak * peak) / m)
}

function sceneAndNoisy(seed: number, sigma: number): { truth: Plane; noisy: Plane } {
  const scene = makeScene(64, 64, { seed, blurR: 3, passes: 3 })
  const g = scene.gray(64, 64, 0, 0)
  const truthData = Float32Array.from(g.data, (v) => v / 255)
  const noisyData = addGaussianNoise(truthData, sigma / 255, seed + 100)
  return { truth: { data: truthData, width: 64, height: 64 }, noisy: { data: noisyData, width: 64, height: 64 } }
}

function stepEdgePlane(w: number, h: number, sigma: number, seed: number): { truth: Plane; noisy: Plane } {
  const truth = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) truth[y * w + x] = x < w / 2 ? 0.2 : 0.8
  const noisy = addGaussianNoise(truth, sigma, seed)
  return { truth: { data: truth, width: w, height: h }, noisy: { data: noisy, width: w, height: h } }
}

describe('boxFilter / gaussianBlur', () => {
  it('boxFilter leaves a flat plane unchanged', () => {
    const p: Plane = { data: new Float32Array(32 * 32).fill(0.42), width: 32, height: 32 }
    const out = boxFilter(p, 4)
    for (const v of out.data) expect(v).toBeCloseTo(0.42, 5)
  })
  it('boxFilter preserves the mean of random data (no border darkening)', () => {
    const rnd = mulberry32(1)
    const data = Float32Array.from({ length: 40 * 40 }, () => rnd())
    const p: Plane = { data, width: 40, height: 40 }
    const out = boxFilter(p, 3)
    const meanIn = data.reduce((a, b) => a + b, 0) / data.length
    const meanOut = out.data.reduce((a, b) => a + b, 0) / out.data.length
    expect(meanOut).toBeCloseTo(meanIn, 1)
  })
  it('gaussianBlur leaves a flat plane unchanged', () => {
    const p: Plane = { data: new Float32Array(32 * 32).fill(0.7), width: 32, height: 32 }
    const out = gaussianBlur(p, 2)
    for (const v of out.data) expect(v).toBeCloseTo(0.7, 5)
  })
})

describe('every spatial denoiser: raises PSNR and preserves a sharp edge', () => {
  const sigma = 20
  const { truth, noisy } = sceneAndNoisy(11, sigma)
  const edge = stepEdgePlane(48, 48, sigma / 255, 22)

  const methods: Array<[string, (p: Plane) => Plane]> = [
    ['wavelet', (p) => waveletShrink(p, sigma / 255)],
    ['nlm', (p) => nlmFast(p, sigma / 255, { patch: 2, search: 5 })],
    ['guided', (p) => guidedFilter(p, p, 4, (sigma / 255) ** 2)],
    ['bilateral', (p) => bilateral(p, 2, sigma / 255)],
  ]

  for (const [name, run] of methods) {
    it(`${name}: PSNR improves over the noisy input`, () => {
      const before = psnr(noisy.data, truth.data)
      const denoised = run(noisy)
      const after = psnr(denoised.data, truth.data)
      expect(after).toBeGreaterThan(before)
    })

    it(`${name}: preserves the edge step (denoised straddle difference stays > 60% of the true step)`, () => {
      const denoised = run(edge.noisy)
      const w = edge.noisy.width
      // sample well clear of the edge on each side so the comparison isn't dominated by the transition itself
      const left = denoised.data[24 * w + 16], right = denoised.data[24 * w + 32]
      expect(right - left).toBeGreaterThan(0.6 * 0.6) // true step is 0.6
    })
  }
})

describe('NLM vs wavelet on a repetitive texture', () => {
  it('NLM achieves higher PSNR than wavelet shrinkage on a periodic checker pattern', () => {
    const w = 64, h = 64
    const truth = new Float32Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      truth[y * w + x] = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0 ? 0.25 : 0.75
    }
    const sigma = 25 / 255
    const noisy = addGaussianNoise(truth, sigma, 55)
    const truthPlane: Plane = { data: truth, width: w, height: h }
    const noisyPlane: Plane = { data: noisy, width: w, height: h }
    const nlmOut = nlmFast(noisyPlane, sigma, { patch: 2, search: 8 })
    const waveletOut = waveletShrink(noisyPlane, sigma)
    const psnrNlm = psnr(nlmOut.data, truthPlane.data)
    const psnrWavelet = psnr(waveletOut.data, truthPlane.data)
    expect(psnrNlm).toBeGreaterThan(psnrWavelet)
  })
})

describe('guidedFilter', () => {
  it('converges to a (double) box filter as eps -> infinity: a_k -> 0, b_k -> mean_k(p), so the ' +
    'limit is exactly boxFilter(boxFilter(p)), and approximately boxFilter(p) on smooth data', () => {
    const scene = makeScene(24, 24, { seed: 3, blurR: 3, passes: 3 })
    const g = scene.gray(24, 24, 0, 0)
    const data = Float32Array.from(g.data, (v) => v / 255)
    const p: Plane = { data, width: 24, height: 24 }
    const boxed = boxFilter(p, 3)
    const doubleBoxed = boxFilter(boxed, 3)
    const guided = guidedFilter(p, p, 3, 1e6)
    for (let i = 0; i < data.length; i++) expect(guided.data[i]).toBeCloseTo(doubleBoxed.data[i], 3)
    for (let i = 0; i < data.length; i++) expect(Math.abs(guided.data[i] - boxed.data[i])).toBeLessThan(0.08)
  })
  it('is near identity (self-guided) as eps -> 0', () => {
    const rnd = mulberry32(4)
    const data = Float32Array.from({ length: 24 * 24 }, () => rnd())
    const p: Plane = { data, width: 24, height: 24 }
    const guided = guidedFilter(p, p, 3, 1e-8)
    for (let i = 0; i < data.length; i++) expect(guided.data[i]).toBeCloseTo(data[i], 3)
  })
})

describe('denoisePlane / denoiseRgb dispatch', () => {
  it('denoisePlane("none") is identity', () => {
    const p: Plane = { data: new Float32Array([0.1, 0.5, 0.9]), width: 3, height: 1 }
    const params: DenoiseParams = { method: 'none', strength: 1, chroma: 0 }
    const out = denoisePlane(p, params, 0.05)
    const expected = [0.1, 0.5, 0.9]
    for (let i = 0; i < expected.length; i++) expect(out.data[i]).toBeCloseTo(expected[i], 5)
  })

  it('denoiseRgb reduces per-channel noise on a flat-colour patch', () => {
    const w = 32, h = 32
    const mk = (base: number, seed: number): Plane => ({ data: addGaussianNoise(new Float32Array(w * h).fill(base), 0.05, seed), width: w, height: h })
    const planes = { r: mk(0.6, 1), g: mk(0.4, 2), b: mk(0.3, 3) }
    const params: DenoiseParams = { method: 'wavelet', strength: 1, chroma: 0.5 }
    const out = denoiseRgb(planes, params)
    const variance = (p: Plane, mean: number) => p.data.reduce((s, v) => s + (v - mean) ** 2, 0) / p.data.length
    expect(variance(out.r, 0.6)).toBeLessThan(variance(planes.r, 0.6))
    expect(variance(out.g, 0.4)).toBeLessThan(variance(planes.g, 0.4))
  })
})
