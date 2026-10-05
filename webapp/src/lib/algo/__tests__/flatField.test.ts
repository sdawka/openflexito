import { describe, expect, it } from 'vitest'
import { flatFieldFromRaw, flatFieldToJson, flatFieldFromJson, flatFieldSampler, gridMean, smoothGrid, applyFlatFieldRgb, flatFieldLuminance, flatFieldToIllumination, applyGainMapRgba } from '../flatField'
import { sampleGainMap } from '../stitch'
import type { RawImage } from '../raw'

function vignettedFlat(w: number, h: number, r0: number, g0: number, b0: number, strength: number): RawImage {
  const data = new Uint16Array(w * h)
  const cx = w / 2, cy = h / 2, maxR2 = cx * cx + cy * cy
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const cell = ((y & 1) << 1) | (x & 1)   // BGGR: 0=B,1=G,2=G,3=R
    const v = cell === 3 ? r0 : cell === 0 ? b0 : g0
    const r2 = (x - cx) ** 2 + (y - cy) ** 2
    const shade = 1 - strength * (r2 / maxR2)
    data[y * w + x] = Math.round(64 + v * shade)
  }
  return { width: w, height: h, bitDepth: 10, blackLevel: 64, whiteLevel: 1023, bayer: 'BGGR', data, meta: null }
}

describe('flatFieldFromRaw', () => {
  it('gain maps flatten a synthetic vignette back to (roughly) unity at the reference', () => {
    const raw = vignettedFlat(128, 96, 400, 400, 400, 0.6)
    const field = flatFieldFromRaw(raw, { cols: 32, rows: 24 })
    const sample = flatFieldSampler(field.g, field.cols, field.rows, raw.width, raw.height)
    // centre (reference) gain should be close to 1; corner gain should be well above 1 (it was dimmer)
    expect(sample(64, 48)).toBeCloseTo(1, 1)
    expect(sample(2, 2)).toBeGreaterThan(1.3)
  })

  it('gain × measured luminance is roughly constant across the field (the correction actually flattens it)', () => {
    const w = 128, h = 96
    const raw = vignettedFlat(w, h, 400, 400, 400, 0.6)
    const field = flatFieldFromRaw(raw, { cols: 32, rows: 24 })
    const sample = flatFieldSampler(field.g, field.cols, field.rows, w, h)
    // reconstruct the measured green grid the way flatFieldFromRaw derived it, then correct it
    const grid = gridMean(new Float32Array(w * h), w, h, 1, 1)  // placeholder to keep gridMean exercised
    expect(grid.length).toBe(1)
    const corners = [[2, 2], [w - 2, 2], [2, h - 2], [w - 2, h - 2]] as const
    const centre = 400 * (1 - 0.6 * 0)  // shade at the exact centre
    for (const [x, y] of corners) {
      // the raw green value at (x,y) roughly equals centre * shade(x,y); after multiplying by the
      // inverse gain it should land close to the centre-referenced level
      const cx = w / 2, cy = h / 2, maxR2 = cx * cx + cy * cy
      const shade = 1 - 0.6 * (((x - cx) ** 2 + (y - cy) ** 2) / maxR2)
      const measured = 400 * shade
      // grid smoothing means a corner cell's estimate is not exact, but the correction should still
      // land well within 20% of the reference level (vs. ~70% off before correction)
      const corrected = measured * sample(x, y)
      expect(Math.abs(corrected - centre) / centre).toBeLessThan(0.2)
    }
  })

  it('respects the clamp range so dust/dark corners cannot blow up noise', () => {
    const w = 32, h = 32
    const data = new Uint16Array(w * h).fill(64 + 200)
    // one corner cell near-zero (a dust spot / dead pixel region)
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) data[y * w + x] = 65
    const raw: RawImage = { width: w, height: h, bitDepth: 10, blackLevel: 64, whiteLevel: 1023, bayer: 'BGGR', data, meta: null }
    const field = flatFieldFromRaw(raw, { cols: 8, rows: 8, clamp: [0.5, 4] })
    expect(Math.max(...field.g)).toBeLessThanOrEqual(4)
    expect(Math.max(...field.r)).toBeLessThanOrEqual(4)
  })

  it('round-trips through JSON without losing the field (for calibration-store persistence)', () => {
    const raw = vignettedFlat(64, 48, 300, 350, 250, 0.4)
    const field = flatFieldFromRaw(raw, { cols: 16, rows: 12 })
    const back = flatFieldFromJson(flatFieldToJson(field))
    expect(back.cols).toBe(field.cols); expect(back.rows).toBe(field.rows)
    for (let i = 0; i < field.g.length; i++) expect(back.g[i]).toBeCloseTo(field.g[i], 3)
  })

  it('smoothGrid reduces peak-to-peak noise (separable box blur)', () => {
    const cols = 8, rows = 8
    const g = new Float32Array(cols * rows).fill(1)
    g[cols * (rows >> 1) + (cols >> 1)] = 10   // one spike
    const before = Math.max(...g) - Math.min(...g)
    const after = smoothGrid(g.slice(), cols, rows, 2)
    expect(Math.max(...after) - Math.min(...after)).toBeLessThan(before)
  })

  it('applyFlatFieldRgb multiplies each channel by its own sampled gain', () => {
    const w = 4, h = 4
    const field = { cols: 2, rows: 2, r: new Float32Array(4).fill(2), g: new Float32Array(4).fill(1.5), b: new Float32Array(4).fill(3), reference: 'centre' as const, width: w, height: h }
    const data = new Float32Array(w * h * 3).fill(0.1)
    applyFlatFieldRgb(data, w, h, field)
    expect(data[0]).toBeCloseTo(0.2, 5); expect(data[1]).toBeCloseTo(0.15, 5); expect(data[2]).toBeCloseTo(0.3, 5)
  })

  it('flatFieldLuminance resamples the green map onto an arbitrary grid (for stitch tile equalisation)', () => {
    const raw = vignettedFlat(64, 64, 300, 300, 300, 0.5)
    const field = flatFieldFromRaw(raw, { cols: 16, rows: 16 })
    const resampled = flatFieldLuminance(field, 4, 4)
    expect(resampled.length).toBe(16)
    expect(resampled[0]).toBeGreaterThan(resampled[5])   // corner cell dimmer -> needs more gain than centre
  })

  it('flatFieldToIllumination inverts the gains into a mean-1 RGB illumination map (stitching shading)', () => {
    const raw = vignettedFlat(64, 64, 300, 200, 100, 0.5)
    const field = flatFieldFromRaw(raw, { cols: 16, rows: 16 })
    const ill = flatFieldToIllumination(flatFieldToJson(field), 8, 6)
    expect(ill.width).toBe(8); expect(ill.height).toBe(6); expect(ill.channels).toBe(3); expect(ill.data.length).toBe(8 * 6 * 3)
    for (let ch = 0; ch < 3; ch++) {
      let s = 0
      for (let i = 0; i < 48; i++) s += ill.data[i * 3 + ch]
      expect(s / 48).toBeCloseTo(1, 5)
    }
    const centre = ((3 * 8) + 4) * 3, corner = 0
    expect(ill.data[centre]).toBeGreaterThan(ill.data[corner])   // the corner is darker than the middle
    expect(ill.data[corner + 1]).toBeCloseTo(ill.data[corner], 1)   // the same vignette on every channel
  })

  describe('applyGainMapRgba', () => {
    const W = 64, H = 48
    // a smooth relative-illumination map, per-channel tint, darker towards the rim
    const map = (() => {
      const w = 16, h = 12, data = new Float32Array(w * h * 3)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const r2 = ((x + 0.5) / w - 0.5) ** 2 + ((y + 0.5) / h - 0.5) ** 2
        const o = (y * w + x) * 3
        data[o] = 1.1 - 1.2 * r2; data[o + 1] = 1.05 - 1.6 * r2; data[o + 2] = 0.95 - 1.9 * r2
      }
      return { width: w, height: h, channels: 3 as const, data }
    })()
    const encode = (l: number) => Math.round(255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055))
    // a scene of constant radiance lit through the map, JPEG-style gamma encoded
    const scene = (radiance: [number, number, number]) => {
      const d = new Uint8ClampedArray(W * H * 4)
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let ch = 0; ch < 3; ch++)
        d[(y * W + x) * 4 + ch] = encode(radiance[ch] * sampleGainMap(map, (x + 0.5) / W, (y + 0.5) / H, ch))
      for (let i = 3; i < d.length; i += 4) d[i] = 255
      return d
    }
    const spread = (d: Uint8ClampedArray, ch: number) => { let lo = 255, hi = 0; for (let i = ch; i < d.length; i += 4) { lo = Math.min(lo, d[i]); hi = Math.max(hi, d[i]) } return hi - lo }

    it('flattens a vignetted gamma-encoded field within one level when working in linear light', () => {
      const d = scene([0.4, 0.4, 0.4])
      expect(spread(d, 1)).toBeGreaterThan(20)   // the vignette is visible to start with
      const alpha = d[3]
      applyGainMapRgba(d, W, H, map)
      for (let ch = 0; ch < 3; ch++) expect(spread(d, ch)).toBeLessThanOrEqual(1)
      expect(d[3]).toBe(alpha)
    })

    it('dividing the encoded values (linear = false) over-corrects the dim rim', () => {
      const lin = scene([0.4, 0.4, 0.4]), enc = scene([0.4, 0.4, 0.4])
      const target = encode(0.4)
      applyGainMapRgba(lin, W, H, map)
      applyGainMapRgba(enc, W, H, map, { linear: false })
      expect(Math.abs(lin[1] - target)).toBeLessThanOrEqual(1)
      expect(enc[1]).toBeGreaterThan(target + 8)   // corner (0,0) is far brighter than the centre target
    })

    it('strength 0 leaves the image alone and tile offsets sample the right part of the map', () => {
      const d = scene([0.3, 0.3, 0.3]), copy = d.slice()
      applyGainMapRgba(d, W, H, map, { strength: 0 })
      expect(Array.from(d)).toEqual(Array.from(copy))
      // a window of the left half of a frame twice as wide must match correcting the full frame's left half
      const full = scene([0.3, 0.3, 0.3])
      const half = new Uint8ClampedArray((W / 2) * H * 4)
      for (let y = 0; y < H; y++) for (let x = 0; x < W / 2; x++) for (let c = 0; c < 4; c++) half[(y * (W / 2) + x) * 4 + c] = full[(y * W + x) * 4 + c]
      applyGainMapRgba(half, W / 2, H, map, { tileW: W, tileH: H, offX: 0, offY: 0 })
      applyGainMapRgba(full, W, H, map)
      for (let y = 0; y < H; y++) for (let x = 0; x < W / 2; x++) expect(half[(y * (W / 2) + x) * 4 + 1]).toBe(full[(y * W + x) * 4 + 1])
    })
  })
})
