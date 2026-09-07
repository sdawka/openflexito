import { describe, expect, it } from 'vitest'
import { develop, cellColour, toRgba8, developParamsFromTuning } from '../rawdev'
import { encodePng16 } from '../../png16'
import { encodeDng, colorMatrixFromCcm, invert3 } from '../../dng'
import type { RawImage } from '../raw'

function flat(r: number, g: number, b: number, w = 16, h = 12, vignette = 0): RawImage {
  const data = new Uint16Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = cellColour('BGGR', x, y)
    const v = c === 'R' ? r : c === 'G' ? g : b
    const f = 1 - vignette * (((x - w / 2) / (w / 2)) ** 2 + ((y - h / 2) / (h / 2)) ** 2) / 2
    data[y * w + x] = 64 + Math.round(v * f)
  }
  return { width: w, height: h, bitDepth: 10, blackLevel: 64, bayer: 'BGGR', data }
}
const px = (img: { data: Uint16Array; width: number }, x: number, y: number) => [img.data[(y * img.width + x) * 3], img.data[(y * img.width + x) * 3 + 1], img.data[(y * img.width + x) * 3 + 2]]

describe('develop', () => {
  it('subtracts black, applies white balance and keeps 16-bit precision (linear, malvar)', () => {
    const img = develop(flat(200, 400, 100), { gains: [2, 4], gamma: false })
    for (const [x, y] of [[6, 6], [7, 6], [6, 7], [7, 7]] as const) {
      const [r, g, b] = px(img, x, y)
      expect(Math.abs(r - g)).toBeLessThan(80); expect(Math.abs(b - g)).toBeLessThan(80)
      expect(g).toBeCloseTo(Math.round(400 / 959 * 65535), -2)
    }
  })
  it('lens shading tables flatten a vignetted field', () => {
    const raw = flat(300, 300, 300, 32, 24, 0.6)
    const plain = develop(raw, { gamma: false })
    const corner = px(plain, 2, 2)[1], centre = px(plain, 16, 12)[1]
    expect(corner / centre).toBeLessThan(0.8)
    // table = 1/f sampled on the 16x12 grid
    const lum: number[] = []
    for (let j = 0; j < 12; j++) for (let i = 0; i < 16; i++) {
      const x = ((i + 0.5) / 16) * 32, y = ((j + 0.5) / 12) * 24
      lum.push(1 / (1 - 0.6 * (((x - 16) / 16) ** 2 + ((y - 12) / 12) ** 2) / 2))
    }
    const fixed = develop(raw, { gamma: false, lsc: { luminance: lum, cr: new Array(192).fill(1), cb: new Array(192).fill(1), cols: 16, rows: 12 } })
    expect(px(fixed, 2, 2)[1] / px(fixed, 16, 12)[1]).toBeGreaterThan(0.93)
  })
  it('applies the colour matrix and the tuning gamma curve', () => {
    const raw = flat(300, 300, 300)
    const identity = develop(raw, { gamma: false })
    const swapped = develop(raw, { gamma: false, ccm: [0, 0, 2, 0, 1, 0, 1, 0, 0] })
    const [r0, g0] = px(identity, 6, 6), [r1] = px(swapped, 6, 6)
    expect(r1).toBeCloseTo(Math.min(65535, 2 * r0), -2); expect(g0).toBeGreaterThan(0)
    const curved = develop(raw, { gammaCurve: [0, 0, 65535, 32767] })   // half-brightness line
    expect(curved.data[0]).toBeCloseTo(identity.data[0] / 2, -2)
    const p = developParamsFromTuning({ algorithms: [{ 'rpi.ccm': { ccms: [{ ct: 5000, ccm: [1, 0, 0, 0, 1, 0, 0, 0, 1] }] } }, { 'rpi.contrast': { gamma_curve: [0, 0, 65535, 65535] } }] })
    expect(p.ccm).toHaveLength(9); expect(p.gammaCurve).toHaveLength(4); expect(p.lsc).toBeNull()
  })
  it('preview is 8-bit', () => {
    const gam = develop(flat(200, 200, 200))
    const p = toRgba8(gam, 2)
    expect(p.width).toBe(8); expect(p.data[0]).toBe(gam.data[0] >> 8); expect(p.data[3]).toBe(255)
  })
})

describe('encodePng16', () => {
  it('writes a valid 16-bit RGB PNG structure', async () => {
    const img = develop(flat(200, 400, 100))
    const blob = await encodePng16(img.data, img.width, img.height)
    const b = new Uint8Array(await blob.arrayBuffer()), dv = new DataView(b.buffer)
    expect(Array.from(b.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(String.fromCharCode(...b.slice(12, 16))).toBe('IHDR')
    expect(dv.getUint32(16)).toBe(16); expect(dv.getUint32(20)).toBe(12)
    expect(b[24]).toBe(16); expect(b[25]).toBe(2)
    expect(String.fromCharCode(...b.slice(b.length - 8, b.length - 4))).toBe('IEND')
  })
})

describe('encodeDng', () => {
  it('writes a little-endian TIFF with the CFA tags and the pixel data', async () => {
    const raw = flat(200, 400, 100)
    const blob = encodeDng(raw, { gains: [1.5, 2], ccm: [1, 0, 0, 0, 1, 0, 0, 0, 1] })
    const b = new Uint8Array(await blob.arrayBuffer()), dv = new DataView(b.buffer)
    expect(b[0]).toBe(0x49); expect(dv.getUint16(2, true)).toBe(42)
    const n = dv.getUint16(8, true)
    const tags: Record<number, { type: number; count: number; off: number }> = {}
    for (let i = 0; i < n; i++) { const p = 10 + i * 12; tags[dv.getUint16(p, true)] = { type: dv.getUint16(p + 2, true), count: dv.getUint32(p + 4, true), off: p + 8 } }
    expect(tags[262]).toBeDefined(); expect(dv.getUint16(tags[262].off, true)).toBe(32803)
    expect(dv.getUint32(tags[256].off, true)).toBe(16)
    expect(Array.from(b.slice(tags[33422].off, tags[33422].off + 4))).toEqual([2, 1, 1, 0])  // BGGR
    expect(tags[50721].count).toBe(9); expect(tags[50728].count).toBe(3)
    const strip = dv.getUint32(tags[273].off, true), bytes = dv.getUint32(tags[279].off, true)
    expect(bytes).toBe(16 * 12 * 2); expect(strip + bytes).toBe(b.length)
    expect(dv.getUint16(strip, true)).toBe(raw.data[0])
    const cm = colorMatrixFromCcm([2, 0, 0, 0, 2, 0, 0, 0, 2])!
    expect(cm[0]).toBeCloseTo(3.2404542 / 2, 5)
    expect(invert3([1, 2, 3, 4, 5, 6, 7, 8, 9])).toBeNull()
  })
})
