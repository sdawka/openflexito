import { describe, expect, it } from 'vitest'
import {
  clahe, unsharpMask, edgeAwareSharpen, autoLevels, pseudoFlatField, vignetteCorrect,
  chromaticAberration, colourDeconvolve, saturationVibrance, shadowsHighlights, filmic,
} from '../enhance'
import type { RgbPlanes, Plane } from '../enhance'
import { laplacianVariance } from '../sharpness'
import { makeScene, mulberry32 } from './helpers/scene'

function mse(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2
  return s / a.length
}
function variance(a: Float32Array): number {
  let m = 0
  for (const v of a) m += v
  m /= a.length
  let s = 0
  for (const v of a) s += (v - m) ** 2
  return s / a.length
}
function flatPlanes(w: number, h: number, r: number, g: number, b: number): RgbPlanes {
  return { r: new Float32Array(w * h).fill(r), g: new Float32Array(w * h).fill(g), b: new Float32Array(w * h).fill(b), width: w, height: h }
}

describe('clahe', () => {
  it('increases overall contrast on a low-contrast image', () => {
    const w = 64, h = 64
    const rnd = mulberry32(9)
    const data = Float32Array.from({ length: w * h }, () => 0.48 + rnd() * 0.04) // narrow 0.48..0.52 band
    const out = clahe({ data, width: w, height: h }, { tiles: 8, clip: 3 })
    expect(variance(out.data)).toBeGreaterThan(variance(data) * 2)
  })
  it('leaves a perfectly flat plane flat', () => {
    const p: Plane = { data: new Float32Array(32 * 32).fill(0.5), width: 32, height: 32 }
    const out = clahe(p, { tiles: 8, clip: 3 })
    expect(variance(out.data)).toBeLessThan(1e-6)
  })
})

describe('unsharpMask', () => {
  it('raises Laplacian variance on a textured image', () => {
    const scene = makeScene(48, 48, { seed: 2, blurR: 2, passes: 2 })
    const g = scene.gray(48, 48, 0, 0)
    const p: Plane = { data: Float32Array.from(g.data, (v) => v / 255), width: 48, height: 48 }
    const before = laplacianVariance(p)
    const out = unsharpMask(p, { radius: 1, amount: 1.5, threshold: 0 })
    const after = laplacianVariance(out)
    expect(after).toBeGreaterThan(before)
  })
  it('a high threshold suppresses boosting low-amplitude noise', () => {
    const rnd = mulberry32(6)
    const flat = 0.5
    const data = Float32Array.from({ length: 32 * 32 }, () => flat + (rnd() - 0.5) * 0.01)
    const p: Plane = { data, width: 32, height: 32 }
    const boosted = unsharpMask(p, { radius: 1, amount: 2, threshold: 0 })
    const suppressed = unsharpMask(p, { radius: 1, amount: 2, threshold: 0.5 })
    expect(variance(suppressed.data)).toBeLessThan(variance(boosted.data))
    expect(variance(suppressed.data)).toBeCloseTo(variance(data), 4)
  })
})

describe('edgeAwareSharpen', () => {
  it('raises Laplacian variance without needing a Gaussian radius', () => {
    const scene = makeScene(48, 48, { seed: 8, blurR: 2, passes: 2 })
    const g = scene.gray(48, 48, 0, 0)
    const p: Plane = { data: Float32Array.from(g.data, (v) => v / 255), width: 48, height: 48 }
    const before = laplacianVariance(p)
    const out = edgeAwareSharpen(p, { radius: 3, amount: 1.5, eps: 0.001 })
    expect(laplacianVariance(out)).toBeGreaterThan(before)
  })
})

describe('autoLevels', () => {
  it('maps the low/high percentiles close to 0/1', () => {
    const n = 1000
    const r = Float32Array.from({ length: n }, (_, i) => i / (n - 1))
    const planes: RgbPlanes = { r, g: r.slice(), b: r.slice(), width: n, height: 1 }
    const out = autoLevels(planes, { lowPct: 1, highPct: 99, perChannel: true })
    expect(out.r[10]).toBeCloseTo(0, 1)      // ~1st percentile
    expect(out.r[990]).toBeCloseTo(1, 1)     // ~99th percentile
  })
})

describe('pseudoFlatField', () => {
  it('flattens a synthetic linear illumination gradient', () => {
    const w = 128, h = 32
    const sample = new Float32Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) sample[y * w + x] = 0.4 + 0.1 * Math.sin(x * 0.9) // fine "specimen" texture
    const illum = new Float32Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) illum[y * w + x] = 0.3 + 0.6 * (x / w) // coarse gradient 0.3..0.9
    const lit = Float32Array.from(sample, (v, i) => v * illum[i])
    const planes: RgbPlanes = { r: lit, g: lit.slice(), b: lit.slice(), width: w, height: h }
    const before = variance(lit)
    const out = pseudoFlatField(planes, 12)
    // low-frequency gradient variance should drop a lot; compare against a per-column mean trend
    const colMeanBefore = new Float32Array(w), colMeanAfter = new Float32Array(w)
    for (let x = 0; x < w; x++) {
      let sb = 0, sa = 0
      for (let y = 0; y < h; y++) { sb += lit[y * w + x]; sa += out.r[y * w + x] }
      colMeanBefore[x] = sb / h; colMeanAfter[x] = sa / h
    }
    expect(variance(colMeanAfter)).toBeLessThan(variance(colMeanBefore) * 0.5)
    expect(before).toBeGreaterThan(0) // sanity: lit image wasn't already flat
  })
})

describe('vignetteCorrect', () => {
  it('inverts a synthetic polynomial vignette exactly', () => {
    const w = 40, h = 40
    const a = -0.5, b = -0.2, c = 0
    const cx = w / 2, cy = h / 2, halfDiag = Math.sqrt(cx * cx + cy * cy)
    const original = new Float32Array(w * h).fill(0.6)
    const vignetted = new Float32Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = (x - cx) / halfDiag, dy = (y - cy) / halfDiag, r2 = dx * dx + dy * dy
      const vig = 1 + a * r2 + b * r2 * r2 + c * r2 * r2 * r2
      vignetted[y * w + x] = original[y * w + x] * vig
    }
    const planes: RgbPlanes = { r: vignetted, g: vignetted.slice(), b: vignetted.slice(), width: w, height: h }
    const corrected = vignetteCorrect(planes, { a, b, c })
    for (let i = 0; i < original.length; i++) expect(corrected.r[i]).toBeCloseTo(original[i], 3)
  })
})

describe('chromaticAberration', () => {
  it('reduces channel misalignment introduced by an equal-and-opposite radial scale', () => {
    const scene = makeScene(56, 56, { seed: 13, blurR: 2, passes: 2 })
    const g = scene.gray(56, 56, 0, 0)
    const truthR = Float32Array.from(g.data, (v) => v / 255)
    const truth: RgbPlanes = { r: truthR, g: truthR.slice(), b: truthR.slice(), width: 56, height: 56 }
    const kd = 0.08
    const distorted = chromaticAberration(truth, { red: kd, blue: 0 })
    const mseBefore = mse(distorted.r, truthR)
    const corrected = chromaticAberration(distorted, { red: -kd, blue: 0 })
    const mseAfter = mse(corrected.r, truthR)
    expect(mseAfter).toBeLessThan(mseBefore * 0.5)
  })
})

describe('colourDeconvolve', () => {
  it('recovers known stain concentrations from a synthetically stained flat patch', () => {
    const norm = (v: [number, number, number]): [number, number, number] => {
      const n = Math.hypot(v[0], v[1], v[2]) || 1
      return [v[0] / n, v[1] / n, v[2] / n]
    }
    const H = norm([0.65, 0.70, 0.29]), E = norm([0.07, 0.99, 0.11]), R = norm([0.27, 0.57, 0.78])
    const stains: [[number, number, number], [number, number, number], [number, number, number]] = [H, E, R]
    const c1 = 0.5, c2 = 0.3, c3 = 0
    const odR = c1 * H[0] + c2 * E[0] + c3 * R[0]
    const odG = c1 * H[1] + c2 * E[1] + c3 * R[1]
    const odB = c1 * H[2] + c2 * E[2] + c3 * R[2]
    const I: [number, number, number] = [Math.pow(10, -odR), Math.pow(10, -odG), Math.pow(10, -odB)]
    const w = 8, h = 8
    const planes: RgbPlanes = {
      r: new Float32Array(w * h).fill(I[0]), g: new Float32Array(w * h).fill(I[1]), b: new Float32Array(w * h).fill(I[2]), width: w, height: h,
    }
    const { c1: out1, c2: out2, c3: out3 } = colourDeconvolve(planes, stains)
    expect(out1.data[0]).toBeCloseTo(c1, 2)
    expect(out2.data[0]).toBeCloseTo(c2, 2)
    expect(out3.data[0]).toBeCloseTo(c3, 2)
  })
})

describe('saturationVibrance / shadowsHighlights / filmic: sanity', () => {
  it('saturationVibrance with zero gains is identity', () => {
    const planes = flatPlanes(8, 8, 0.6, 0.3, 0.2)
    const out = saturationVibrance(planes, { saturation: 0, vibrance: 0 })
    for (let i = 0; i < 64; i++) { expect(out.r[i]).toBeCloseTo(planes.r[i], 5); expect(out.g[i]).toBeCloseTo(planes.g[i], 5) }
  })
  it('shadowsHighlights lifts a dark region', () => {
    const w = 32, h = 32
    const data = new Float32Array(w * h).fill(0.1)
    const planes: RgbPlanes = { r: data, g: data.slice(), b: data.slice(), width: w, height: h }
    const out = shadowsHighlights(planes, { shadows: 0.8, highlights: 0, radius: 4 })
    expect(out.r[0]).toBeGreaterThan(0.1)
  })
  it('filmic compresses values toward the white point without exceeding 1', () => {
    const w = 8, h = 8
    const data = new Float32Array(w * h).fill(2.0) // over-exposed linear value
    const planes: RgbPlanes = { r: data, g: data.slice(), b: data.slice(), width: w, height: h }
    const out = filmic(planes, { contrast: 0, white: 4 })
    for (const v of out.r) { expect(v).toBeLessThanOrEqual(1); expect(v).toBeGreaterThan(0) }
  })
})
