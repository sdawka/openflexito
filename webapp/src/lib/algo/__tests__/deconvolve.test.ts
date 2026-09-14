import { describe, expect, it } from 'vitest'
import { makePsf, wiener, richardsonLucy } from '../deconvolve'
import { fft2d } from '../fft'
import { makeScene, mulberry32 } from './helpers/scene'

function convolve(data: Float32Array, N: number, psf: Float64Array): Float32Array {
  const re = new Float64Array(N * N), im = new Float64Array(N * N)
  re.set(data)
  fft2d(re, im, N, N)
  const half = N / 2
  const hre = new Float64Array(N * N), him = new Float64Array(N * N)
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) hre[((y + half) % N) * N + (x + half) % N] = psf[y * N + x]
  fft2d(hre, him, N, N)
  const or_ = new Float64Array(N * N), oi = new Float64Array(N * N)
  for (let i = 0; i < re.length; i++) { or_[i] = re[i] * hre[i] - im[i] * him[i]; oi[i] = re[i] * him[i] + im[i] * hre[i] }
  fft2d(or_, oi, N, N, true)
  const out = new Float32Array(N * N)
  for (let i = 0; i < out.length; i++) out[i] = or_[i]
  return out
}

function correlation(a: Float32Array, b: Float32Array): number {
  const n = a.length
  let ma = 0, mb = 0
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i] }
  ma /= n; mb /= n
  let sab = 0, saa = 0, sbb = 0
  for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db }
  return sab / Math.sqrt(saa * sbb)
}

function addNoise(data: Float32Array, amplitude: number, seed: number): Float32Array {
  const rnd = mulberry32(seed)
  const out = new Float32Array(data.length)
  for (let i = 0; i < data.length; i++) out[i] = data[i] + (rnd() - 0.5) * 2 * amplitude
  return out
}

describe('makePsf', () => {
  it('sums to 1 and is symmetric about its centre', () => {
    const N = 64
    const psf = makePsf(N, { sigma: 2 })
    let sum = 0
    for (const v of psf) sum += v
    expect(sum).toBeCloseTo(1, 5)
    const half = N / 2
    // symmetric: psf(half+k, half) ~= psf(half-k, half)
    for (const k of [1, 3, 5]) expect(psf[half * N + half + k]).toBeCloseTo(psf[half * N + half - k], 3)
  })

  it('degenerates to a delta (all energy at the centre) with no blur terms', () => {
    const N = 32
    const psf = makePsf(N)
    const half = N / 2
    expect(psf[half * N + half]).toBeGreaterThan(0.99)
  })

  it('a wider box/gaussian spreads more energy away from the centre', () => {
    const N = 64, half = N / 2
    const narrow = makePsf(N, { sigma: 1 })
    const wide = makePsf(N, { sigma: 4 })
    expect(wide[half * N + half]).toBeLessThan(narrow[half * N + half])
  })
})

describe('deconvolution: correlation with truth rises, noise stays bounded', () => {
  const N = 64
  const scene = makeScene(N, N, { seed: 9, blurR: 1, passes: 2 })
  const truthImg = scene.gray(N, N, 0, 0)
  const psf = makePsf(N, { sigma: 2.2 })
  const blurred = convolve(truthImg.data, N, psf)
  const noisy = addNoise(blurred, 3, 42)

  it('wiener deconvolution improves correlation with the truth over the blurred input', () => {
    const before = correlation(noisy, truthImg.data)
    const deconv = wiener({ data: noisy, width: N, height: N }, psf, N, 0.02)
    const after = correlation(deconv, truthImg.data)
    expect(after).toBeGreaterThan(before)
    // noise stays bounded: no blow-up to huge values
    let maxAbs = 0
    for (const v of deconv) maxAbs = Math.max(maxAbs, Math.abs(v))
    expect(maxAbs).toBeLessThan(2000)
    expect(deconv.every((v) => Number.isFinite(v))).toBe(true)
  })

  it('richardson-lucy improves correlation with the truth and stays non-negative', () => {
    const before = correlation(noisy, truthImg.data)
    const deconv = richardsonLucy({ data: noisy, width: N, height: N }, psf, N, 8)
    const after = correlation(deconv, truthImg.data)
    expect(after).toBeGreaterThan(before)
    expect(deconv.every((v) => v >= 0)).toBe(true)
    expect(deconv.every((v) => Number.isFinite(v))).toBe(true)
  })

  it('richardson-lucy over-iterating on noisy data does not diverge to NaN/Infinity', () => {
    const deconv = richardsonLucy({ data: noisy, width: N, height: N }, psf, N, 40)
    expect(deconv.every((v) => Number.isFinite(v))).toBe(true)
  })

  it('a larger wiener noise parameter is gentler (closer to the blurred input, less sharpening)', () => {
    const gentle = wiener({ data: noisy, width: N, height: N }, psf, N, 0.5)
    const aggressive = wiener({ data: noisy, width: N, height: N }, psf, N, 0.001)
    const gentleDiff = correlation(gentle, blurred)
    const aggressiveDiff = correlation(aggressive, blurred)
    expect(gentleDiff).toBeGreaterThan(aggressiveDiff)
  })
})
