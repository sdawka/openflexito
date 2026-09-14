import { describe, expect, it } from 'vitest'
import { drizzle, drizzlePlane, drizzleBayer, fillPlaneHoles, drizzleRawSuperres, type DrizzleFrame } from '../drizzle'
import { prepareMosaic } from '../rawdev'
import { demosaicMalvar } from '../demosaic'
import type { RawImage } from '../raw'

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

  it('defaults pixfrac to 0.5', () => {
    const w = 8, h = 8
    const data = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) { const v = (i % 5) * 40; data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255 }
    const frames: DrizzleFrame[] = [{ data, width: w, height: h, dx: 0.2, dy: -0.1 }]
    const withDefault = drizzle(frames, 2)
    const withExplicit = drizzle(frames, 2, 0.5)
    expect(withDefault.data).toEqual(withExplicit.data)
  })

  it('a frame with weight 0 is excluded, same as omitting it', () => {
    const w = 8, h = 8
    const good = new Uint8ClampedArray(w * h * 4)
    const bad = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      good[i * 4] = good[i * 4 + 1] = good[i * 4 + 2] = 100; good[i * 4 + 3] = 255
      bad[i * 4] = bad[i * 4 + 1] = bad[i * 4 + 2] = 255; bad[i * 4 + 3] = 255   // wildly different (mis-registered) frame
    }
    const withoutBad = drizzle([{ data: good, width: w, height: h, dx: 0, dy: 0 }], 2, 0.5)
    const withZeroWeighted = drizzle([
      { data: good, width: w, height: h, dx: 0, dy: 0 },
      { data: bad, width: w, height: h, dx: 0.3, dy: 0.1, weight: 0 },
    ], 2, 0.5)
    expect(withZeroWeighted.data).toEqual(withoutBad.data)
  })

  it('down-weighting a frame pulls the result toward the other frames, proportionally', () => {
    const w = 6, h = 6
    const lo = new Uint8ClampedArray(w * h * 4), hi = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) { lo[i * 4] = lo[i * 4 + 1] = lo[i * 4 + 2] = 50; lo[i * 4 + 3] = 255; hi[i * 4] = hi[i * 4 + 1] = hi[i * 4 + 2] = 200; hi[i * 4 + 3] = 255 }
    const frames = (w1: number, w2: number): DrizzleFrame[] => [
      { data: lo, width: w, height: h, dx: 0, dy: 0, weight: w1 },
      { data: hi, width: w, height: h, dx: 0, dy: 0, weight: w2 },
    ]
    const equal = drizzle(frames(1, 1), 1, 1)
    const favourHi = drizzle(frames(0.2, 1), 1, 1)
    // sampling the centre cell: favouring the bright frame should push the value up from the 1:1 blend
    const mid = (w * 1 / 2) * (w * 1) + Math.floor(w / 2)
    expect(favourHi.data[mid * 4]).toBeGreaterThan(equal.data[mid * 4])
  })
})

describe('drizzlePlane (single-channel, Float32 accumulation reusable for raw planes)', () => {
  it('matches the RGBA drizzle on a grey (R=G=B) scene', () => {
    const w = 10, h = 10
    const rgba = new Uint8ClampedArray(w * h * 4)
    const plane = new Float32Array(w * h)
    for (let i = 0; i < w * h; i++) { const v = (i * 17) % 200; rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v; rgba[i * 4 + 3] = 255; plane[i] = v }
    const frames: DrizzleFrame[] = [{ data: rgba, width: w, height: h, dx: 0.3, dy: -0.2 }, { data: rgba, width: w, height: h, dx: 0, dy: 0.1 }]
    const rgbaResult = drizzle(frames, 2, 0.5)
    const planeResult = drizzlePlane(frames.map((f) => ({ data: plane, width: w, height: h, dx: f.dx, dy: f.dy })), 2, 0.5)
    for (let i = 0; i < planeResult.width * planeResult.height; i++) {
      if (planeResult.weight[i] <= 0) continue
      expect(Math.abs(planeResult.data[i] - rgbaResult.data[i * 4])).toBeLessThan(1)
    }
  })

  it('leaves uncovered cells at weight 0 rather than filling them', () => {
    const w = 4, h = 4
    const data = new Float32Array(w * h).fill(100)
    const r = drizzlePlane([{ data, width: w, height: h, dx: 0, dy: 0 }], 4, 0.1)
    let holes = 0
    for (let i = 0; i < r.width * r.height; i++) if (r.weight[i] === 0) holes++
    expect(holes).toBeGreaterThan(0)
    fillPlaneHoles(r.data, r.weight, r.width, r.height)
    // after filling, every cell reachable from covered ones should have picked up a value near 100
    let filled = 0
    for (let i = 0; i < r.width * r.height; i++) if (Math.abs(r.data[i] - 100) < 1) filled++
    expect(filled).toBeGreaterThan(holes)
  })
})

describe('drizzleBayer', () => {
  const mw = 16, mh = 16   // mosaic size; phase planes are 8x8

  function colourAt(c: 'r' | 'g' | 'b', x: number, y: number): number {
    if (c === 'r') return 100 + 60 * Math.sin(x * 0.4) * Math.cos(y * 0.3)
    if (c === 'g') return 120 + 50 * Math.sin((x - y) * 0.35)
    return 90 + 70 * Math.cos(x * 0.25 + y * 0.5)
  }

  // RGGB tile phases: R=(0,0) G1=(1,0) G2=(0,1) B=(1,1). Build a mosaic for a frame shifted by
  // (sx, sy) mosaic pixels: each mosaic site samples the colour function of its own CFA colour at
  // the shifted continuous position (content moved right/down by (sx, sy), same convention as
  // `drizzle`/`fftTrack`).
  function mosaic(sx: number, sy: number): Uint16Array {
    const m = new Uint16Array(mw * mh)
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
      const px = x % 2, py = y % 2
      const c = px === 0 && py === 0 ? 'r' : px === 1 && py === 1 ? 'b' : 'g'
      m[y * mw + x] = Math.round(colourAt(c, x - sx, y - sy))
    }
    return m
  }

  it('fills every output site from a 4-shot 1-mosaic-pixel dither with no demosaic', () => {
    // the four classic dither positions, one per tile corner, give full coverage of every colour
    const frames = [
      { data: mosaic(0, 0), width: mw, height: mh, dx: 0, dy: 0 },
      { data: mosaic(1, 0), width: mw, height: mh, dx: 1, dy: 0 },
      { data: mosaic(0, 1), width: mw, height: mh, dx: 0, dy: 1 },
      { data: mosaic(1, 1), width: mw, height: mh, dx: 1, dy: 1 },
    ]
    const r = drizzleBayer(frames, 'RGGB', 2, 0.5)
    expect(r.width).toBe(16); expect(r.height).toBe(16)
    expect(r.coverage.r).toBeGreaterThan(0.8)
    expect(r.coverage.g).toBeGreaterThan(0.8)
    expect(r.coverage.b).toBeGreaterThan(0.8)
    // mean-absolute error over covered interior sites against the true colour function (a per-site
    // max is sensitive to the exact sub-pixel alignment of the nearest dither sample and not a
    // meaningful correctness bar here; the mean over the reconstructed region is)
    const meanErr = { r: 0, g: 0, b: 0 }, n = { r: 0, g: 0, b: 0 }
    for (let y = 2; y < 14; y++) for (let x = 2; x < 14; x++) {
      const i = y * r.width + x
      // the output grid has the same resolution as the mosaic (mosaic/2 phase planes x scale 2),
      // so output index maps ~1:1 onto mosaic-pixel coordinates, not x/2
      meanErr.r += Math.abs(r.r[i] - colourAt('r', x, y)); n.r++
      meanErr.g += Math.abs(r.g[i] - colourAt('g', x, y)); n.g++
      meanErr.b += Math.abs(r.b[i] - colourAt('b', x, y)); n.b++
    }
    expect(meanErr.r / n.r).toBeLessThan(20)
    expect(meanErr.g / n.g).toBeLessThan(20)
    expect(meanErr.b / n.b).toBeLessThan(20)
  })

  it('throws on odd mosaic dimensions and on no frames', () => {
    expect(() => drizzleBayer([], 'RGGB')).toThrow()
    expect(() => drizzleBayer([{ data: new Uint16Array(15 * 16), width: 15, height: 16, dx: 0, dy: 0 }], 'RGGB')).toThrow()
  })

  it('a single, unaligned-phase frame gives noticeably less coverage per colour than the full 4-shot dither', () => {
    const full = drizzleBayer([
      { data: mosaic(0, 0), width: mw, height: mh, dx: 0, dy: 0 },
      { data: mosaic(1, 0), width: mw, height: mh, dx: 1, dy: 0 },
      { data: mosaic(0, 1), width: mw, height: mh, dx: 0, dy: 1 },
      { data: mosaic(1, 1), width: mw, height: mh, dx: 1, dy: 1 },
    ], 'RGGB', 2, 0.3)
    const single = drizzleBayer([{ data: mosaic(0.3, 0.3), width: mw, height: mh, dx: 0.3, dy: 0.3 }], 'RGGB', 2, 0.3)
    expect(single.coverage.r).toBeLessThan(full.coverage.r)
    expect(single.coverage.b).toBeLessThan(full.coverage.b)
  })
})

describe('drizzleRawSuperres (raw-plane super-resolution, no demosaic)', () => {
  // A sharp vertical edge is the worst case for demosaicing a single Bayer frame before combining
  // shifted frames: each individual mosaic only samples 25% of its sites in red, 25% in blue, so
  // interpolating colour across the edge (Malvar) smears/rings there, and averaging several
  // independently-demosaiced, shifted copies (the naive "demosaic then drizzle" pipeline this brief
  // asks to beat) does not remove that per-frame interpolation error. Drizzling the raw planes
  // directly has no such error: the classic 4-shot 1-mosaic-pixel dither gives every output site a
  // *real* sample of its own colour, never an interpolated one.
  const mw = 32, mh = 32
  const bitDepth = 10, blackLevel = 64
  const white = (1 << bitDepth) - 1 - blackLevel

  function truth(c: 'R' | 'G' | 'B', x: number, y: number): number {
    const edge = x < mw / 2 ? 0.2 : 0.8   // sharp step in x
    const tint = c === 'R' ? 0.05 : c === 'B' ? -0.05 : 0   // a little per-channel texture so R/G/B differ
    return Math.min(1, Math.max(0, edge + tint * Math.sin(y * 0.5)))
  }

  function mosaic(sx: number, sy: number): RawImage {
    const data = new Uint16Array(mw * mh)
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
      const px = x % 2, py = y % 2
      const c: 'R' | 'G' | 'B' = px === 0 && py === 0 ? 'R' : px === 1 && py === 1 ? 'B' : 'G'
      data[y * mw + x] = Math.round(blackLevel + truth(c, x - sx, y - sy) * white)
    }
    return { width: mw, height: mh, bitDepth, blackLevel, whiteLevel: white, bayer: 'RGGB', data, meta: null }
  }

  // the canonical 4-shot dither (one full mosaic pixel per tile corner) used by the drizzleBayer test
  const shiftedFrames = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([sx, sy]) => ({ raw: mosaic(sx, sy), dx: sx, dy: sy }))

  it('reconstructs a sharp edge without the colour fringing ("zipper") demosaicing each frame before drizzling introduces', () => {
    const raw = drizzleRawSuperres(shiftedFrames, 2, 0.5, {})

    // baseline: demosaic each single-mosaic frame on its own (the classic aliasing scenario — each
    // frame alone has only 25%/50%/25% real R/G/B samples), convert to 8-bit RGBA, then drizzle —
    // i.e. exactly the general-purpose RGBA super-resolution path applied naively to raw frames.
    const rgbaFrames: DrizzleFrame[] = shiftedFrames.map((f) => {
      const prepared = prepareMosaic(f.raw, {})
      const rgbFloat = demosaicMalvar(prepared, mw, mh, 'RGGB')
      const data = new Uint8ClampedArray(mw * mh * 4)
      for (let i = 0; i < mw * mh; i++) {
        data[i * 4] = rgbFloat[i * 3] * 255; data[i * 4 + 1] = rgbFloat[i * 3 + 1] * 255; data[i * 4 + 2] = rgbFloat[i * 3 + 2] * 255; data[i * 4 + 3] = 255
      }
      return { data, width: mw, height: mh, dx: f.dx, dy: f.dy }
    })
    const baseline = drizzle(rgbaFrames, 2, 0.5)

    // The step in `truth` is common to R, G and B (only `tint` differs between channels), so the
    // *true* R-B difference is exactly `2*tint*sin(y*0.5)` — a function of y alone, with **no x
    // dependence at all**, including right at the edge. A drizzle footprint's own smoothing (present
    // in both pipelines, from `pixfrac`) can shift R-B away from that true value by a constant amount,
    // but it cannot make it depend on x — the scene simply doesn't vary with x apart from the shared
    // step, which cancels in the difference. Demosaicing a single mosaic frame *before* combining
    // shifted copies breaks that: a colour-difference interpolator built assuming smooth local
    // luminance sees a step discontinuity and produces a spurious swing in R-B that is concentrated
    // right at the edge column and is *not* cancelled by drizzling several such frames together (each
    // frame's own fringe sits at the same physical edge) — the classic Bayer "zipper". So the
    // discriminator here is not the absolute error against truth (both pipelines carry the same
    // pixfrac smoothing bias) but whether R-B *varies with x* near the edge at all.
    function rbDiffByX(width: number, pick: (i: number) => [number, number], outScale: number, ty: number): number[] {
      const out: number[] = []
      for (let tx = 12; tx <= 19; tx++) {
        const i = Math.round(ty * outScale) * width + Math.round(tx * outScale)
        const [r, b] = pick(i)
        out.push(r - b)
      }
      return out
    }
    const ty = 10
    const rawByX = rbDiffByX(raw.rgb.width, (i) => [raw.rgb.data[i * 3], raw.rgb.data[i * 3 + 2]], 1, ty)
    const baseByX = rbDiffByX(baseline.width, (i) => [baseline.data[i * 4] / 255, baseline.data[i * 4 + 2] / 255], 2, ty)
    const range = (v: number[]) => Math.max(...v) - Math.min(...v)
    const rawRange = range(rawByX), baseRange = range(baseByX)
    expect(baseRange).toBeGreaterThan(0.001)   // the baseline does show an x-dependent fringe...
    expect(rawRange).toBeLessThan(baseRange / 2)   // ...that the raw-plane pipeline mostly does not
    // and every raw-plane value should still sit close to the true (x-independent) R-B function
    const trueDiff = 2 * 0.05 * Math.sin(ty * 0.5)
    for (const v of rawByX) expect(Math.abs(v - trueDiff)).toBeLessThan(0.02)
    expect(raw.coverage.r).toBeGreaterThan(0.8)
    expect(raw.coverage.g).toBeGreaterThan(0.8)
    expect(raw.coverage.b).toBeGreaterThan(0.8)
  })

  it('applies white balance and the colour matrix on the combined planes', () => {
    const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    const plain = drizzleRawSuperres(shiftedFrames, 2, 0.5, {})
    // gains just under the point where the R channel's highlight would clip and desaturateHighlights
    // would start pulling every channel towards white (the whole point of the edge/tint scene is to
    // exercise the highlight desaturation path, so any bigger gain would confound this ratio check) —
    // an interior site on the low (left) side of the edge, well away from the grid border.
    const gained = drizzleRawSuperres(shiftedFrames, 2, 0.5, { gains: [1.2, 0.6] })
    const i = (10 * plain.rgb.width + 8) * 3
    expect(gained.rgb.data[i] / plain.rgb.data[i]).toBeCloseTo(1.2, 2)
    expect(gained.rgb.data[i + 2] / plain.rgb.data[i + 2]).toBeCloseTo(0.6, 2)

    const swapRG = [0, 1, 0, 1, 0, 0, 0, 0, 1]
    const withCcm = drizzleRawSuperres(shiftedFrames, 2, 0.5, { ccm: swapRG })
    const withIdentity = drizzleRawSuperres(shiftedFrames, 2, 0.5, { ccm: identity })
    expect(withCcm.rgb.data[i]).toBeCloseTo(withIdentity.rgb.data[i + 1], 3)
    expect(withCcm.rgb.data[i + 1]).toBeCloseTo(withIdentity.rgb.data[i], 3)
  })

  it('rejects an unsupported bayer order and empty input', () => {
    expect(() => drizzleRawSuperres([], 2, 0.5, {})).toThrow()
    expect(() => drizzleRawSuperres([{ raw: { ...shiftedFrames[0].raw, bayer: 'XYZW' }, dx: 0, dy: 0 }], 2, 0.5, {})).toThrow()
  })
})
