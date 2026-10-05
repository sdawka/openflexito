import { describe, expect, it } from 'vitest'
import { normalisedVariance, brenner, tileMetric, laplacianVariance, focusMetric, type Gray } from '../sharpness'
import { curveQuality, samplesFromSweep } from '../autofocus'

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296) }

function scene(w = 96, h = 96, seed = 7): Gray {
  const r = rng(seed), d = new Float32Array(w * h)
  for (let i = 0; i < d.length; i++) d[i] = 40 + 160 * r()
  return { data: d, width: w, height: h }
}

function blur(g: Gray, sigma: number): Gray {
  if (sigma <= 0) return g
  const rad = Math.ceil(sigma * 3), k: number[] = []
  let t = 0
  for (let i = -rad; i <= rad; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k.push(v); t += v }
  const { width: w, height: h } = g
  const pass = (src: Float32Array, horiz: boolean) => {
    const out = new Float32Array(src.length)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let a = 0
      for (let i = -rad; i <= rad; i++) {
        const xx = horiz ? Math.min(w - 1, Math.max(0, x + i)) : x, yy = horiz ? y : Math.min(h - 1, Math.max(0, y + i))
        a += k[i + rad] * src[yy * w + xx]
      }
      out[y * w + x] = a / t
    }
    return out
  }
  return { data: pass(pass(g.data, true), false), width: w, height: h }
}

describe('focus metrics', () => {
  const base = scene()
  const sigmas = [0, 1, 2, 3, 4]
  const stack = sigmas.map((s) => blur(base, s))
  for (const name of ['laplacian', 'nv', 'brenner'] as const) {
    it(`${name} peaks at sigma 0 and falls monotonically to sigma 4`, () => {
      const m = focusMetric(name), v = stack.map((g) => m(g))
      for (let i = 1; i < v.length; i++) expect(v[i]).toBeLessThan(v[i - 1])
    })
  }
  it('NV is gain invariant, Laplacian variance is not', () => {
    const g2: Gray = { ...base, data: base.data.map((x) => x * 1.5) }
    expect(Math.abs(normalisedVariance(g2) - normalisedVariance(base))).toBeLessThan(1e-6)
    expect(laplacianVariance(g2) / laplacianVariance(base)).toBeCloseTo(2.25, 3)
  })
  it('tileMetric ignores empty glass: a sparse specimen (3 of 16 tiles textured) still scores by its texture', () => {
    const w = 64, h = 64, data = new Float32Array(w * h).fill(128)
    // texture in three tiles of a 4×4 grid (16×16 px each), flat everywhere else
    for (const [tx, ty] of [[0, 0], [2, 1], [3, 3]]) for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) data[(ty * 16 + y) * w + tx * 16 + x] = ((x + y) & 1) ? 200 : 60
    const g: Gray = { data, width: w, height: h }
    const tile = new Float32Array(16 * 16)
    for (let y = 0; y < 16; y++) tile.set(data.subarray(y * w, y * w + 16), y * 16)
    const textured = laplacianVariance({ data: tile, width: 16, height: 16 })
    expect(tileMetric(g, laplacianVariance, 4)).toBeGreaterThan(0.5 * textured)
  })

  it('tileMetric ignores one saturated tile', () => {
    const g: Gray = { data: new Float32Array(base.data), width: base.width, height: base.height }
    const clean = tileMetric(g, laplacianVariance, 4)
    // saturate one 24x24 tile with a hard checkerboard
    for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) g.data[y * g.width + x] = (x + y) % 2 ? 255 : 0
    expect(laplacianVariance(g)).toBeGreaterThan(clean * 1.2)
    expect(tileMetric(g, laplacianVariance, 4) / clean).toBeLessThan(1.1)
  })
  it('brenner of a constant image is 0', () => {
    expect(brenner({ data: new Float32Array(100).fill(5), width: 10, height: 10 })).toBe(0)
  })
})

const curve = (f: (i: number) => number, n = 21) => Array.from({ length: n }, (_, i) => ({ z: i * 10, s: f(i) }))

describe('curveQuality', () => {
  it('accepts a clean Gaussian peak', () => {
    const q = curveQuality(curve((i) => 1 + 9 * Math.exp(-((i - 10) ** 2) / (2 * 2.5 ** 2))))
    expect(q.ok).toBe(true)
    expect(q.contrast).toBeGreaterThan(1.3)
    expect(q.turningPoints).toBe(1)
    expect(q.peakIndex).toBe(10)
    // FWHM of sigma 2.5 is 5.89 samples
    expect(q.widthSamples).toBeGreaterThan(4.5)
    expect(q.widthSamples).toBeLessThan(7.5)
  })
  it('accepts a FoM curve on a large baseline via SNR', () => {
    const q = curveQuality([4100, 4120, 4090, 4180, 4350, 4800, 5050, 4930, 5180, 4650, 4380, 4250, 4170, 4130, 4100].map((s, i) => ({ z: i, s })))
    expect(q.contrast).toBeLessThan(1.3)
    expect(q.snr).toBeGreaterThan(6)
    expect(q.ok).toBe(true)
  })
  it('rejects flat noise', () => {
    const r = rng(3)
    const q = curveQuality(curve(() => 100 + r() * 2))
    expect(q.ok).toBe(false)
    expect(q.reason).toBe('flat')
  })
  it('rejects two peaks as multimodal', () => {
    const g = (i: number, c: number) => 9 * Math.exp(-((i - c) ** 2) / (2 * 1.5 ** 2))
    const q = curveQuality(curve((i) => 1 + g(i, 5) + g(i, 15)))
    expect(q.reason).toBe('multimodal')
    expect(q.turningPoints).toBeGreaterThan(1)
  })
  it('flags a peak at the end as edge', () => {
    const q = curveQuality(curve((i) => 1 + 9 * Math.exp(-((i - 20) ** 2) / (2 * 4 ** 2))))
    expect(q.reason).toBe('edge')
    expect(q.ok).toBe(false)
  })
  it('drops NaN samples and reports few when under 5 remain', () => {
    const c = curve((i) => 1 + 9 * Math.exp(-((i - 10) ** 2) / (2 * 2.5 ** 2)))
    const withNaN = c.map((p, i) => (i % 5 === 0 ? { ...p, s: NaN } : p))
    expect(curveQuality(withNaN).ok).toBe(true)
    const q = curveQuality(c.map((p, i) => (i < 17 ? { ...p, s: NaN } : p)))
    expect(q.ok).toBe(false)
    expect(q.reason).toBe('few')
  })
  it('samplesFromSweep drops null/NaN focus_fom', () => {
    const f = (t: number, fom: number | null) => ({ seq: t, size: 1, stream: 'main', ts: t, t, focus_fom: fom }) as never
    const s = samplesFromSweep([f(1, 5), f(2, null), f(3, NaN), f(4, 7)], 0, 10, 0, 10, 'fom')
    expect(s.map((x) => x.s)).toEqual([5, 7])
  })
})
