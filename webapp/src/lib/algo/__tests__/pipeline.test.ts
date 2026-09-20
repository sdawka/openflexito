import { describe, expect, it } from 'vitest'
import { developPipeline, DEFAULT_ENHANCE } from '../pipeline'
import type { EnhanceParams } from '../pipeline'
import { richardsonLucy, makePsf } from '../deconvolve'

function make8bit(w: number, h: number, seed = 1): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4)
  let s = seed
  for (let i = 0; i < w * h; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    const v = s % 256
    data[i * 4] = v; data[i * 4 + 1] = (v + 40) % 256; data[i * 4 + 2] = (v + 90) % 256; data[i * 4 + 3] = 255
  }
  return data
}
function make16bit(w: number, h: number, seed = 2): Uint16Array {
  const data = new Uint16Array(w * h * 3)
  let s = seed
  for (let i = 0; i < w * h * 3; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    data[i] = s % 65536
  }
  return data
}

describe('developPipeline: DEFAULT_ENHANCE is identity', () => {
  it('8-bit RGBA input passes through byte-for-byte', () => {
    const w = 12, h = 10
    const data = make8bit(w, h)
    const out = developPipeline({ data, width: w, height: h }, DEFAULT_ENHANCE)
    expect(out.width).toBe(w)
    expect(out.height).toBe(h)
    expect(out.data).toBeInstanceOf(Uint8ClampedArray)
    expect(Array.from(out.data as Uint8ClampedArray)).toEqual(Array.from(data))
  })

  it('16-bit linear RGB input passes through sample-for-sample', () => {
    const w = 9, h = 7
    const data = make16bit(w, h)
    const out = developPipeline({ data, width: w, height: h, linear: true }, DEFAULT_ENHANCE)
    expect(out.data).toBeInstanceOf(Uint16Array)
    expect(Array.from(out.data as Uint16Array)).toEqual(Array.from(data))
  })

  it('an empty-but-distinct params object ({}) is also identity', () => {
    const w = 6, h = 6
    const data = make8bit(w, h, 3)
    const out = developPipeline({ data, width: w, height: h }, {})
    expect(Array.from(out.data as Uint8ClampedArray)).toEqual(Array.from(data))
  })
})

describe('developPipeline: progress reporting', () => {
  it('reports each executed stage once, in canonical order, with non-decreasing cumulative fraction', () => {
    const w = 24, h = 24
    const data = make8bit(w, h, 5)
    const params: EnhanceParams = {
      vignette: { a: -0.1, b: 0, c: 0 },
      denoise: { method: 'guided', strength: 1, chroma: 0.2 },
      autoLevels: { lowPct: 0.5, highPct: 99.5, perChannel: false },
      sharpen: { mode: 'unsharp', radius: 1, amount: 1, threshold: 0.02 },
    }
    const stages: string[] = []
    const fracs: number[] = []
    developPipeline({ data, width: w, height: h }, params, (stage, frac) => { stages.push(stage); fracs.push(frac) })
    expect(stages).toEqual(['vignette', 'denoise', 'autoLevels', 'sharpen'])
    for (let i = 1; i < fracs.length; i++) expect(fracs[i]).toBeGreaterThan(fracs[i - 1])
    expect(fracs[fracs.length - 1]).toBeCloseTo(1, 5)
  })

  it('produces no progress calls when every stage is skipped', () => {
    const w = 6, h = 6
    const data = make8bit(w, h, 4)
    const calls: string[] = []
    developPipeline({ data, width: w, height: h }, DEFAULT_ENHANCE, (stage) => calls.push(stage))
    expect(calls).toEqual([])
  })
})

describe('developPipeline: runs end-to-end without throwing and preserves shape', () => {
  it('8-bit path with several stages active', () => {
    const w = 20, h = 16
    const data = make8bit(w, h, 9)
    const out = developPipeline({ data, width: w, height: h }, {
      flatField: { sigma: 8 },
      vignette: { a: -0.05, b: 0, c: 0 },
      denoise: { method: 'wavelet', strength: 0.5, chroma: 0.3 },
      colour: { saturation: 0.1, vibrance: 0.1 },
      clahe: { tiles: 4, clip: 2 },
    })
    expect(out.width).toBe(w)
    expect(out.height).toBe(h)
    expect((out.data as Uint8ClampedArray).length).toBe(w * h * 4)
    for (const v of out.data) expect(Number.isFinite(v)).toBe(true)
  })

  it('16-bit linear path with deconvolve active', () => {
    const w = 18, h = 18
    const data = make16bit(w, h, 11)
    const out = developPipeline({ data, width: w, height: h, linear: true }, {
      deconvolve: { method: 'wiener', sigma: 1.2, iterations: 3, noise: 0.02 },
    })
    expect((out.data as Uint16Array).length).toBe(w * h * 3)
    for (const v of out.data) expect(Number.isFinite(v)).toBe(true)
  })
})

// Smooth-ramp-plus-texture pattern kept comfortably inside 0.2..0.8 so RL's non-negative-but-unbounded
// output never needs clamping at the developPipeline output boundary — that would otherwise make the
// tiled-vs-untiled comparison compare two different clamped values instead of the raw RL output.
function syntheticLinearPlane(w: number, h: number): Float32Array {
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    out[y * w + x] = 0.5 + 0.15 * Math.sin(x * 0.05) * Math.cos(y * 0.07) + 0.08 * Math.sin(x * 0.31 + y * 0.19)
  }
  return out
}
function toUint16Rgb(plane: Float32Array): Uint16Array {
  const out = new Uint16Array(plane.length * 3)
  for (let i = 0, p = 0; i < plane.length; i++, p += 3) { const v = Math.round(Math.min(1, Math.max(0, plane[i])) * 65535); out[p] = v; out[p + 1] = v; out[p + 2] = v }
  return out
}

describe('developPipeline: tiled deconvolution matches the untiled reference', () => {
  it('RL at 1300x900 (above the 512px tiling threshold) agrees with a direct full-plane richardsonLucy call, away from the true image border', () => {
    const w = 1300, h = 900, sigma = 1.5, iterations = 3
    const plane = syntheticLinearPlane(w, h)
    const psf = makePsf(64, { sigma })
    const reference = richardsonLucy({ data: plane, width: w, height: h }, psf, 64, iterations)

    // developPipeline with only `deconvolve` set, on a `linear: true` input, never leaves linear space
    // (no sRGB stages run), so its planes stay directly comparable to the raw richardsonLucy output.
    const out = developPipeline({ data: toUint16Rgb(plane), width: w, height: h, linear: true }, { deconvolve: { method: 'rl', sigma, iterations } })
    const data16 = out.data as Uint16Array

    const margin = 100 // clear of the true image border, where reflect-padding vs the untiled FFT's
    // implicit zero-padding-to-next-pow2 disagree for reasons unrelated to tiling correctness
    let maxAbsDiff = 0, sumAbsDiff = 0, n = 0
    for (let y = margin; y < h - margin; y++) {
      for (let x = margin; x < w - margin; x++) {
        const tiled = data16[(y * w + x) * 3] / 65535
        const ref = reference[y * w + x]
        const d = Math.abs(tiled - ref)
        maxAbsDiff = Math.max(maxAbsDiff, d); sumAbsDiff += d; n++
      }
    }
    expect(maxAbsDiff).toBeLessThan(0.02)
    expect(sumAbsDiff / n).toBeLessThan(0.005)
  })
})

describe('developPipeline: tiled deconvolution performance at 3280x2464', () => {
  it('3 RL iterations finish well under 10s per channel (target ~2s)', () => {
    const w = 3280, h = 2464, sigma = 1.5, iterations = 3
    const plane = syntheticLinearPlane(w, h)
    const t0 = performance.now()
    developPipeline({ data: toUint16Rgb(plane), width: w, height: h, linear: true }, { deconvolve: { method: 'rl', sigma, iterations } })
    const elapsedMs = performance.now() - t0
    const perChannelMs = elapsedMs / 3
    // eslint-disable-next-line no-console
    console.log(`developPipeline RL deconvolve @ 3280x2464, 3 iterations: ${elapsedMs.toFixed(0)} ms total, ~${perChannelMs.toFixed(0)} ms/channel`)
    expect(perChannelMs).toBeLessThan(10000)
  }, 30000)
})
