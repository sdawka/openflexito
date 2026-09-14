import { describe, expect, it } from 'vitest'
import {
  solvePositions, solvePositionsRobust, pairResiduals, overlapGains, solveGains,
  normaliseGainMap, sampleGainMap, applyFlatField, applyFlatFieldRGBA, pairwiseOffsets,
  BandAccumulator, bandRows, blendMultiband, pyrDown, pyrUp, featherWeight,
  type StitchTile, type PairOffset, type GainMap, type BlendStrip, type PlacedTile,
} from '../stitch'
import type { Gray } from '../sharpness'

const tile = (id: number, x: number, y: number, w = 100, h = 80): StitchTile => ({ id, x, y, width: w, height: h })

function scene(x: number, y: number): number {
  return 128 + 50 * Math.sin(x * 0.13) * Math.cos(y * 0.11) + 30 * Math.sin((x - y) * 0.07) + 20 * Math.cos(x * 0.31 + y * 0.23) + 15 * Math.sin(x * 0.9 - y * 0.7)
}
function grayTile(x0: number, y0: number, w: number, h: number, gain = 1): Gray {
  const data = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = gain * scene(x0 + x, y0 + y)
  return { data, width: w, height: h }
}
function constRGBA(w: number, h: number, v: number, alpha = 255): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) { d[i * 4] = v; d[i * 4 + 1] = v; d[i * 4 + 2] = v; d[i * 4 + 3] = alpha }
  return d
}

describe('robust position solve', () => {
  // 2×2 grid, truth positions, pairs derived from the truth plus one badly wrong pair
  const truth = [{ x: 0, y: 0 }, { x: 70, y: 3 }, { x: -2, y: 48 }, { x: 72, y: 50 }]
  const tiles = [tile(0, 0, 0), tile(1, 72, 0), tile(2, 0, 48), tile(3, 72, 48)]
  const pairOf = (a: number, b: number, ex = 0, ey = 0): PairOffset => ({ a, b, dx: truth[b].x - truth[a].x + ex, dy: truth[b].y - truth[a].y + ey, weight: 2 })

  it('drops the pair whose residual is far above the MAD and recovers the truth', () => {
    const pairs = [pairOf(0, 1), pairOf(0, 2), pairOf(1, 3), pairOf(2, 3), pairOf(0, 3, 25, -18), pairOf(1, 2)]
    const naive = solvePositions(tiles, pairs)
    const naiveErr = Math.max(...truth.map((t, i) => Math.hypot(naive[i].x - (t.x + 2), naive[i].y - t.y)))
    expect(naiveErr).toBeGreaterThan(2)   // the wrong diagonal pulls the plain solve off
    const r = solvePositionsRobust(tiles, pairs)
    expect(r.dropped.length).toBe(1)
    expect(r.dropped[0]).toMatchObject({ a: 0, b: 3 })
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(r.positions[i].x - (truth[i].x + 2))).toBeLessThan(0.05)
      expect(Math.abs(r.positions[i].y - truth[i].y)).toBeLessThan(0.05)
    }
    expect(Math.max(...pairResiduals(r.positions, r.kept))).toBeLessThan(0.05)
  })

  it('keeps honest sub-pixel scatter (threshold floor) and never drops with fewer than three pairs', () => {
    const noisy = [pairOf(0, 1, 0.3, -0.2), pairOf(0, 2, -0.4, 0.1), pairOf(1, 3, 0.2, 0.3), pairOf(2, 3, -0.1, -0.3)]
    const r = solvePositionsRobust(tiles, noisy)
    expect(r.dropped.length).toBe(0)
    const two = solvePositionsRobust(tiles, [pairOf(0, 1), pairOf(0, 2, 40, 0)])
    expect(two.dropped.length).toBe(0)
  })
})

describe('luminance gain equalisation', () => {
  it('solves per-tile gains that undo brightness differences seen in the overlaps', () => {
    const w = 96, h = 64
    const truth = [{ x: 0, y: 0 }, { x: 70, y: 0 }, { x: 0, y: 46 }, { x: 70, y: 46 }]
    const tiles = truth.map((p, id) => tile(id, p.x, p.y, w, h))
    const factors = [1, 0.8, 1.25, 1]
    const images = truth.map((p, i) => grayTile(p.x, p.y, w, h, factors[i]))
    const pairs = overlapGains(tiles, truth, images, 8)
    expect(pairs.length).toBeGreaterThanOrEqual(4)
    const gains = solveGains(4, pairs)
    // gain_i × factor_i should be the same for every tile
    const products = gains.map((g, i) => g * factors[i])
    const mean = products.reduce((a, b) => a + b, 0) / 4
    for (const p of products) expect(Math.abs(p / mean - 1)).toBeLessThan(0.02)
    // geometric mean 1
    expect(Math.abs(gains.reduce((a, b) => a * b, 1) - 1)).toBeLessThan(0.02)
  })
  it('returns unit gains without overlaps and clamps extreme ratios', () => {
    expect(solveGains(3, [])).toEqual([1, 1, 1])
    const g = solveGains(2, [{ a: 0, b: 1, logRatio: Math.log(10), weight: 1 }], 2)
    expect(g[0] / g[1]).toBeLessThanOrEqual(4.0001)
  })
})

describe('flat field', () => {
  const vignette = (u: number, v: number) => 1 - 0.4 * ((u - 0.5) ** 2 + (v - 0.5) ** 2) * 2
  const map: GainMap = (() => {
    const mw = 32, mh = 24, data = new Float32Array(mw * mh)
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) data[y * mw + x] = vignette((x + 0.5) / mw, (y + 0.5) / mh)
    return { width: mw, height: mh, channels: 1, data }
  })()

  it('normalises to mean 1 and samples bilinearly', () => {
    const n = normaliseGainMap(map)
    let s = 0
    for (const v of n.data) s += v
    expect(Math.abs(s / n.data.length - 1)).toBeLessThan(1e-6)
    expect(sampleGainMap(n, 0.5, 0.5)).toBeGreaterThan(sampleGainMap(n, 0.02, 0.02))
  })

  it('divides a vignetted tile back to flat (grey and RGBA, including a strip of a tile)', () => {
    const w = 64, h = 48
    const g: Gray = { data: new Float32Array(w * h), width: w, height: h }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g.data[y * w + x] = 100 * vignette((x + 0.5) / w, (y + 0.5) / h)
    const flat = applyFlatField(g, map)
    let min = Infinity, max = -Infinity
    // interior only: the map is not extrapolated beyond its outermost cell centres
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) { const v = flat.data[y * w + x]; min = Math.min(min, v); max = Math.max(max, v) }
    expect(max - min).toBeLessThan(1.5)
    // RGBA strip: rows 24..48 of the same tile must match the bottom half of the grey result
    const strip = new Uint8ClampedArray(w * 24 * 4)
    for (let y = 0; y < 24; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, v = g.data[(y + 24) * w + x]; strip[i] = v; strip[i + 1] = v; strip[i + 2] = v; strip[i + 3] = 255 }
    applyFlatFieldRGBA(strip, w, 24, map, w, h, 0, 24)
    for (let y = 0; y < 24; y += 7) for (let x = 3; x < w - 3; x += 9) expect(Math.abs(strip[(y * w + x) * 4] - flat.data[(y + 24) * w + x])).toBeLessThan(1.5)
  })

  it('a flat-fielded pair still correlates (positions unaffected)', () => {
    const w = 96, h = 64
    const truth = [{ x: 0, y: 0 }, { x: 70, y: 3 }]
    const tiles = [tile(0, 0, 0, w, h), tile(1, 72, 0, w, h)]
    const images = truth.map((p) => applyFlatField(grayTile(p.x, p.y, w, h), map))
    const pairs = pairwiseOffsets(tiles, images, 16, 1.1)
    expect(pairs.length).toBe(1)
    expect(Math.abs(pairs[0].dx - 70)).toBeLessThan(1)
    expect(Math.abs(pairs[0].dy - 3)).toBeLessThan(1)
  })
})

describe('normalised feather blending in bands', () => {
  const W = 60, H = 30
  const strips = (band: { y0: number; rows: number }): BlendStrip[] => {
    // tile A covers x 0..40, tile B covers x 20..60, both full height, constant 100 and 200
    const mk = (tileX: number, v: number, gain?: number): BlendStrip => {
      const y = band.y0, height = Math.min(band.rows, H - band.y0)
      return { data: constRGBA(40, height, v), width: 40, height, x: tileX, y, tileX, tileY: 0, tileW: 40, tileH: H, gain }
    }
    return [mk(0, 100), mk(20, 200)]
  }

  it('averages every tile with feather weights: monotonic ramp in the overlap, exact outside', () => {
    const acc = new BandAccumulator(W, H)
    acc.reset(0)
    for (const s of strips({ y0: 0, rows: H })) acc.add(s, 10)
    const out = acc.toRGBA()
    const px = (x: number, y = 15) => out[(y * W + x) * 4]
    expect(px(5)).toBe(100); expect(px(55)).toBe(200)
    expect(px(30)).toBeGreaterThan(140); expect(px(30)).toBeLessThan(160)   // symmetric overlap centre -> 150
    for (let x = 21; x < 40; x++) expect(px(x)).toBeGreaterThanOrEqual(px(x - 1))
    expect(out[(15 * W + 30) * 4 + 3]).toBe(255)
  })

  it('renders identically band by band and applies per-tile gains', () => {
    const whole = new BandAccumulator(W, H)
    whole.reset(0)
    for (const s of strips({ y0: 0, rows: H })) whole.add({ ...s, gain: s.tileX === 0 ? 2 : 1 }, 10)
    const ref = whole.toRGBA()
    const rows = 7
    const banded = new BandAccumulator(W, rows)
    const out = new Uint8ClampedArray(W * H * 4)
    for (let y0 = 0; y0 < H; y0 += rows) {
      banded.reset(y0)
      for (const s of strips({ y0, rows })) banded.add({ ...s, gain: s.tileX === 0 ? 2 : 1 }, 10)
      const n = Math.min(rows, H - y0)
      out.set(banded.toRGBA(n), y0 * W * 4)
    }
    expect(Array.from(out)).toEqual(Array.from(ref))
    expect(ref[(15 * W + 5) * 4]).toBe(200)   // tile A × gain 2
  })

  it('band size respects the memory budget', () => {
    expect(bandRows(8192, 8192, 128e6)).toBe(976)
    expect(bandRows(100, 50)).toBe(50)
  })
})

describe('multi-band blending', () => {
  it('pyramid down/up round-trip preserves a smooth plane', () => {
    const w = 16, h = 12, src = new Float32Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) src[y * w + x] = 10 + x + 2 * y
    const d = pyrDown(src, w, h)
    expect(d.width).toBe(8); expect(d.height).toBe(6)
    const up = pyrUp(d.data, d.width, d.height, w, h)
    for (let y = 2; y < h - 2; y++) for (let x = 2; x < w - 2; x++) expect(Math.abs(up[y * w + x] - src[y * w + x])).toBeLessThan(0.6)
  })

  it('reproduces a shared scene from two aligned tiles and ramps smoothly between constants', () => {
    const W = 64, H = 32, tw = 40
    const sceneRGBA = (x0: number) => {
      const d = new Uint8ClampedArray(tw * H * 4)
      for (let y = 0; y < H; y++) for (let x = 0; x < tw; x++) { const v = scene(x0 + x, y), i = (y * tw + x) * 4; d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255 }
      return d
    }
    const tiles: PlacedTile[] = [{ data: sceneRGBA(0), width: tw, height: H, x: 0, y: 0 }, { data: sceneRGBA(24), width: tw, height: H, x: 24, y: 0 }]
    const out = blendMultiband(tiles, W, H, 8, 3)
    let maxErr = 0
    for (let y = 4; y < H - 4; y++) for (let x = 4; x < W - 4; x++) maxErr = Math.max(maxErr, Math.abs(out[(y * W + x) * 4] - scene(x, y)))
    expect(maxErr).toBeLessThan(6)
    const flat: PlacedTile[] = [{ data: constRGBA(tw, H, 100), width: tw, height: H, x: 0, y: 0 }, { data: constRGBA(tw, H, 200), width: tw, height: H, x: 24, y: 0 }]
    const o2 = blendMultiband(flat, W, H, 8, 2)
    const px = (x: number) => o2[(16 * W + x) * 4]
    expect(px(2)).toBeGreaterThan(95); expect(px(2)).toBeLessThan(105)
    expect(px(61)).toBeGreaterThan(195); expect(px(61)).toBeLessThan(205)
    expect(px(32)).toBeGreaterThan(120); expect(px(32)).toBeLessThan(180)
    expect(o2[(16 * W + 32) * 4 + 3]).toBe(255)
  })

  it('feather weights taper at the edges', () => {
    expect(featherWeight(50, 50, 100, 100, 10)).toBe(1)
    expect(featherWeight(0, 50, 100, 100, 10)).toBeCloseTo(0.05)
  })
})
