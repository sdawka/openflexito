import { describe, expect, it } from 'vitest'
import { drizzle, type DrizzleFrame } from '../drizzle'

// A fine grating just above the classic Nyquist limit for point sampling at 1x (period 1.8
// low-res pixels) cannot be told apart from a slower beat pattern by any single frame's sampling
// grid. A 3x3 pattern of frames dithered by roughly a third of a low-res pixel in x and y
// (irregular, non-half-integer offsets, as real sub-pixel stage steps would give), registered to
// their known offsets and drizzled onto a 2x grid, sample the scene densely enough to reconstruct
// it far more faithfully than any single frame upsampled — the point of pixel-shift super-resolution.
const WW = 24, HW = 24
const PERIOD = 1.8   // low-res-pixel units
const PHASES = [0, 0.35, 0.7]   // low-res-pixel offsets in x and y (irregular thirds, not halves)

function squareWave(u: number): number { return Math.floor(u / (PERIOD / 2)) % 2 ? 235 : 20 }

/** Ground truth at the 2x output resolution: the continuous grating evaluated at each output
 *  pixel's centre. */
function truth2x(): Uint8ClampedArray {
  const w = WW * 2, h = HW * 2
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = squareWave((x + 0.5) / 2)
    const p = (y * w + x) * 4; data[p] = v; data[p + 1] = v; data[p + 2] = v; data[p + 3] = 255
  }
  return data
}

/** A low-res frame whose pixel x point-samples the scene at its own centre (x + 0.5), offset by
 *  `phase` low-res pixels (a small point-like photosite, so no extra pixel-footprint blur — the
 *  limiting factor here is purely the sampling grid's pitch, the case dithering can recover from). */
function frame(phase: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(WW * HW * 4)
  for (let y = 0; y < HW; y++) for (let x = 0; x < WW; x++) {
    const v = squareWave(x + 0.5 + phase)
    const p = (y * WW + x) * 4; data[p] = v; data[p + 1] = v; data[p + 2] = v; data[p + 3] = 255
  }
  return data
}

/** Nearest-neighbour 2x upsample: the naive "single frame at 2x" baseline. */
function upsample2x(data: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * 2 * h * 2 * 4)
  for (let y = 0; y < h * 2; y++) for (let x = 0; x < w * 2; x++) {
    const s = (Math.floor(y / 2) * w + Math.floor(x / 2)) * 4, d = (y * w * 2 + x) * 4
    out[d] = data[s]; out[d + 1] = data[s + 1]; out[d + 2] = data[s + 2]; out[d + 3] = 255
  }
  return out
}

function meanAbsError(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sum = 0, n = 0
  for (let i = 0; i < a.length; i += 4) { sum += Math.abs(a[i] - b[i]); n++ }
  return sum / n
}

describe('drizzle', () => {
  it('a 3x3 dithered pattern reconstructs a fine grating far more faithfully than any single frame', () => {
    const hi = truth2x()
    const frames: DrizzleFrame[] = []
    for (const py of PHASES) for (const px of PHASES) {
      frames.push({ data: frame(px), width: WW, height: HW, dx: -px, dy: -py })
    }
    const r = drizzle(frames, 2, 0.3)
    expect(r.width).toBe(WW * 2); expect(r.height).toBe(HW * 2)
    expect(r.coverage).toBeGreaterThan(0.9)

    const naive = upsample2x(frames[0].data, WW, HW)
    const errDrizzle = meanAbsError(r.data, hi), errNaive = meanAbsError(naive, hi)
    expect(errDrizzle).toBeLessThan(0.6 * errNaive)
  })

  it('a single frame drizzled just resamples to the finer grid (no new detail, no crash)', () => {
    const w = 6, h = 6
    const data = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) { const v = (i % 3) * 80; data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255 }
    const r = drizzle([{ data, width: w, height: h, dx: 0, dy: 0 }], 2)
    expect(r.width).toBe(12); expect(r.height).toBe(12)
    expect(r.coverage).toBeGreaterThan(0.5)
  })
})
