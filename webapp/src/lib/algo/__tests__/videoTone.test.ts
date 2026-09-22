import { describe, expect, it } from 'vitest'
import { StableLevels, applyLut, localContrast, relief } from '../videoTone'

const W = 32, H = 32
function img(f: (x: number, y: number) => number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; d[i] = d[i + 1] = d[i + 2] = f(x, y); d[i + 3] = 255 }
  return d
}

describe('StableLevels', () => {
  it('stretches a low-contrast frame to full range and then moves slowly', () => {
    const lv = new StableLevels(0.5, 99.5, 0.1, 2, 40)
    const lut = new Uint8ClampedArray(256)
    lv.update(img((x) => 100 + (x % 2) * 20), lut, 1)
    expect(lut[100]).toBeLessThan(10); expect(lut[120]).toBeGreaterThan(245)
    const b0 = lv.black
    lv.update(img((x) => 110 + (x % 2) * 20), lut, 1)   // +10: within the jump threshold → eased
    expect(lv.black - b0).toBeGreaterThan(0); expect(lv.black - b0).toBeLessThan(3)
    lv.update(img((x) => 200 + (x % 2) * 20), lut, 1)   // +90: scene change → snaps
    expect(Math.abs(lv.black - 200)).toBeLessThan(2)
  })
  it('maxStretch caps the gain and widens the window about its centre', () => {
    const lv = new StableLevels(0.5, 99.5, 0.1, 2, 40)
    lv.maxStretch = 0.25
    const lut = new Uint8ClampedArray(256)
    lv.update(img((x) => 100 + (x % 2) * 20), lut, 1)
    const { black, white } = lv.window()
    expect(white - black).toBeCloseTo(255 * 0.75, 5)
    expect((black + white) / 2).toBeCloseTo(110, 5)
    // gain ≤ 1/(1 − 0.25): 100..120 spans at most 20 · 1.333 ≈ 27 output codes
    expect(lut[120] - lut[100]).toBeLessThan(28); expect(lut[120] - lut[100]).toBeGreaterThan(24)
    // a window near an edge is slid back inside 0..255 rather than clipped
    lv.reset(); lv.update(img((x) => 5 + (x % 2) * 20), lut, 1)
    expect(lv.window().black).toBe(0); expect(lv.window().white).toBeCloseTo(255 * 0.75, 5)
    // maxStretch 1 is the unbounded behaviour
    lv.maxStretch = 1; lv.reset(); lv.update(img((x) => 100 + (x % 2) * 20), lut, 1)
    expect(lut[100]).toBeLessThan(10); expect(lut[120]).toBeGreaterThan(245)
  })
  it('strength mixes the table with identity', () => {
    const lv = new StableLevels(0.5, 99.5, 0.1, 2, 40)
    const full = new Uint8ClampedArray(256), half = new Uint8ClampedArray(256), off = new Uint8ClampedArray(256)
    const frame = img((x) => 100 + (x % 2) * 20)
    lv.update(frame, full, 1)
    lv.strength = 0.5; lv.update(frame, half, 1)
    lv.strength = 0; lv.update(frame, off, 1)
    for (let v = 0; v < 256; v++) {
      expect(off[v]).toBe(v)
      expect(Math.abs(half[v] - (v + full[v]) / 2)).toBeLessThanOrEqual(1)
    }
  })
  it('applyLut maps every channel and keeps alpha', () => {
    const lut = new Uint8ClampedArray(256).map((_, i) => 255 - i)
    const out = new Uint8ClampedArray(4)
    applyLut(new Uint8ClampedArray([0, 100, 255, 7]), lut, out)
    expect([...out]).toEqual([255, 155, 0, 255])
  })
})

describe('localContrast', () => {
  it('boosts a small bright spot but not a smooth gradient', () => {
    const out = new Uint8ClampedArray(W * H * 4)
    localContrast(img((x, y) => (x === 16 && y === 16 ? 200 : 100)), W, H, 8, 1, out)
    expect(out[(16 * W + 16) * 4]).toBeGreaterThan(250)
    const grad = img((x) => 60 + x * 4)
    localContrast(grad, W, H, 8, 1, out)
    expect(Math.abs(out[(16 * W + 16) * 4] - grad[(16 * W + 16) * 4])).toBeLessThan(12)
  })
})

describe('relief', () => {
  it('shades a vertical edge light on one side and dark on the other, grey elsewhere', () => {
    const out = new Uint8ClampedArray(W * H * 4)
    relief(img((x) => (x >= 16 ? 200 : 50)), W, H, 0, 1, 0, out)
    expect(out[(8 * W + 15) * 4]).toBeGreaterThan(160)   // gradient rises to the right of x=15
    expect(out[(8 * W + 4) * 4]).toBe(128)
    relief(img((x) => (x >= 16 ? 200 : 50)), W, H, 180, 1, 0, out)
    expect(out[(8 * W + 15) * 4]).toBeLessThan(96)
  })
})

import { AnchoredWhiteBalance, BackgroundFlattener, highPassView } from '../videoTone'

describe('AnchoredWhiteBalance', () => {
  it('drives a drifting bright background back to the anchor colour, and idles without one', () => {
    const wb = new AnchoredWhiteBalance(0.5)
    const d = new Uint8ClampedArray(W * H * 4)
    const fill = (r: number, g: number, b: number) => { for (let i = 0; i < d.length; i += 4) { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255 } }
    fill(200, 200, 200); wb.update(d, 1)
    fill(220, 200, 180); for (let k = 0; k < 20; k++) wb.update(d, 1)
    expect(wb.gains[0]).toBeLessThan(0.95); expect(wb.gains[2]).toBeGreaterThan(1.05)
    fill(20, 20, 20); wb.update(d, 1)
    expect(wb.active).toBe(false)
  })
})

describe('BackgroundFlattener', () => {
  it('evens out a horizontal illumination gradient', () => {
    const fl = new BackgroundFlattener(4, 1)
    const src = img((x) => 80 + x * 4)
    const out = new Uint8ClampedArray(W * H * 4)
    fl.update(src, W, H, out)
    const left = out[(16 * W + 6) * 4], right = out[(16 * W + 25) * 4]
    expect(Math.abs(left - right)).toBeLessThan(16)
    expect(src[(16 * W + 25) * 4] - src[(16 * W + 6) * 4]).toBe(76)
  })
})

describe('highPassView', () => {
  it('dark-field shows an edge bright on black; phase shows it around mid-grey', () => {
    const src = img((x) => (x >= 16 ? 200 : 50))
    const out = new Uint8ClampedArray(W * H * 4)
    highPassView(src, W, H, 8, 1, 'darkfield', out)
    expect(out[(8 * W + 16) * 4]).toBeGreaterThan(20); expect(out[(8 * W + 2) * 4]).toBeLessThan(10)
    highPassView(src, W, H, 8, 1, 'phase', out)
    expect(out[(8 * W + 2) * 4]).toBeGreaterThan(110); expect(out[(8 * W + 2) * 4]).toBeLessThan(146)
  })
})
