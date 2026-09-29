import { describe, it, expect } from 'vitest'
import { besselJ1, diskOtf, SweepAccumulator, deconvolveSweep, diskBlurs, estimateDefocusSlope, linearToSrgb8, srgbToLinearLut, sweepWindow, theoreticalSlope, shiftAtZ, type GrayImage } from '../sweepDeconv'

const W = 128, H = 96

/** Deterministic linear-light texture: sparse bright dots and thin lines on a mid grey. */
function texture(seed = 1): GrayImage {
  let s = seed
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  const d = new Float32Array(W * H).fill(0.25)
  for (let k = 0; k < 90; k++) { const x = Math.floor(rnd() * W), y = Math.floor(rnd() * H); d[y * W + x] = 0.9 }
  for (let x = 0; x < W; x++) d[40 * W + x] = 0.05
  for (let y = 0; y < H; y++) d[y * W + 70] = 0.7
  return { data: d, width: W, height: H }
}

function toRgba(gray: Float32Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < W * H; i++) { const v = linearToSrgb8(gray[i]); out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255 }
  return out
}

const rms = (a: Float32Array, b: Float32Array, m = 12) => {
  let s = 0, n = 0
  for (let y = m; y < H - m; y++) for (let x = m; x < W - m; x++) { const d = a[y * W + x] - b[y * W + x]; s += d * d; n++ }
  return Math.sqrt(s / n)
}

describe('besselJ1 / diskOtf', () => {
  it('matches tabulated J1', () => {
    expect(besselJ1(1)).toBeCloseTo(0.4400505857, 6)
    expect(besselJ1(5)).toBeCloseTo(-0.3275791376, 6)
    expect(besselJ1(10)).toBeCloseTo(0.0434727462, 6)
    expect(besselJ1(-1)).toBeCloseTo(-0.4400505857, 6)
  })
  it('is 1 at DC and for a zero radius', () => {
    expect(diskOtf(0, 5)).toBe(1)
    expect(diskOtf(0.3, 0)).toBe(1)
  })
})

describe('SweepAccumulator', () => {
  it('averages in linear light and translates by (dx, dy)', () => {
    const t = texture()
    const acc = new SweepAccumulator(W, H)
    acc.add(toRgba(t.data), 3, 2)
    const m = acc.mean()
    const lut = srgbToLinearLut()
    // out(x, y) = frame(x − 3, y − 2)
    for (const [x, y] of [[20, 30], [70, 50], [100, 42]]) expect(m.g[y * W + x]).toBeCloseTo(lut[linearToSrgb8(t.data[(y - 2) * W + (x - 3)])], 5)
  })
})

describe('focal sweep deconvolution', () => {
  // a thick specimen: the left half in focus at z = −30, the right half at z = +30
  const s = 0.15, zs: number[] = []
  for (let z = -100; z <= 100; z += 4) zs.push(z)
  const sharp = texture()
  const left = (x: number) => x < W / 2
  const frameAt = (z: number): Float32Array => {
    const [a, b] = diskBlurs(sharp, [s * Math.abs(z + 30), s * Math.abs(z - 30)])
    const out = new Float32Array(W * H)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = left(x) ? a[y * W + x] : b[y * W + x]
    return out
  }
  const frames = zs.map(frameAt)
  const acc = new SweepAccumulator(W, H)
  for (const f of frames) acc.add(toRgba(f))
  const mean = acc.mean()

  it('recovers both depths better than the plain average or any single frame', () => {
    const out = deconvolveSweep(mean, { radii: zs.map((z) => s * Math.abs(z)), noise: 0.002 })
    const eDeconv = rms(out.g, sharp.data), eMean = rms(mean.g, sharp.data)
    const eBest = Math.min(...frames.map((f) => rms(f, sharp.data)))
    console.log("rms deconv/mean/best", eDeconv, eMean, eBest)
    expect(eDeconv).toBeLessThan(0.6 * eMean)
    expect(eDeconv).toBeLessThan(eBest)
    // colour stays grey: the channels see the same filter
    let d = 0; for (let i = 0; i < W * H; i++) d = Math.max(d, Math.abs(out.r[i] - out.g[i]), Math.abs(out.b[i] - out.g[i]))
    expect(d).toBeLessThan(1e-4)
  })

  it('measures the defocus slope from a sharp frame and defocused ones', () => {
    const thin = diskBlurs(sharp, [s * 40, s * 80, s * 60])
    const est = estimateDefocusSlope(sharp, [{ img: { data: thin[0], width: W, height: H }, dz: 40 }, { img: { data: thin[1], width: W, height: H }, dz: -80 }, { img: { data: thin[2], width: W, height: H }, dz: 60 }], 20)
    console.log("slope", est)
    expect(est.slope).not.toBeNull()
    expect(est.slope!).toBeGreaterThan(0.13)
    expect(est.slope!).toBeLessThan(0.17)
  })
})

describe('theoreticalSlope / sweepWindow', () => {
  it('gives ≈0.12 px/step for 40×/0.65 at 0.05 µm/step and 0.36 µm/px', () => {
    expect(theoreticalSlope(0.65, 0.05, 0.36)).toBeCloseTo(0.119, 2)
  })
  it('widens the band by at least 10/s, inside the sweep', () => {
    const w = sweepWindow(-50, 50, -500, 500, 0.1)
    expect(w.lo).toBe(-150); expect(w.hi).toBe(150); expect(w.z0).toBe(0)
    expect(sweepWindow(-50, 50, -80, 500, 0.1).lo).toBe(-80)
  })
})

describe('shiftAtZ', () => {
  const zs = [0, 100, 200], sh = [{ dx: 0, dy: 0 }, { dx: 2, dy: -1 }, { dx: 3, dy: -3 }]
  it('interpolates between aligned slices and holds past the ends', () => {
    expect(shiftAtZ(zs, sh, 50)).toEqual({ dx: 1, dy: -0.5 })
    expect(shiftAtZ(zs, sh, 150)).toEqual({ dx: 2.5, dy: -2 })
    expect(shiftAtZ(zs, sh, -40)).toEqual({ dx: 0, dy: 0 })
    expect(shiftAtZ(zs, sh, 999)).toEqual({ dx: 3, dy: -3 })
    expect(shiftAtZ([], [], 5)).toEqual({ dx: 0, dy: 0 })
  })
})
