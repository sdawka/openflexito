import { describe, expect, it } from 'vitest'
import { develop, cellColour, toRgba8 } from '../rawdev'
import { encodePng16 } from '../../png16'
import type { RawImage } from '../raw'

function flat(r: number, g: number, b: number, w = 8, h = 6): RawImage {
  const data = new Uint16Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = cellColour('BGGR', x, y)
    data[y * w + x] = 64 + (c === 'R' ? r : c === 'G' ? g : b)
  }
  return { width: w, height: h, bitDepth: 10, blackLevel: 64, bayer: 'BGGR', data }
}

describe('develop', () => {
  it('subtracts black, applies white balance and keeps 16-bit precision (linear)', () => {
    const img = develop(flat(200, 400, 100), { gains: [2, 4], gamma: false })
    const px = (x: number, y: number) => [img.data[(y * img.width + x) * 3], img.data[(y * img.width + x) * 3 + 1], img.data[(y * img.width + x) * 3 + 2]]
    // red 200*2 = 400/959, green 400/959, blue 100*4 = 400/959 -> a neutral grey everywhere
    for (const [x, y] of [[2, 2], [3, 2], [2, 3], [3, 3]] as const) {
      const [r, g, b] = px(x, y)
      expect(Math.abs(r - g)).toBeLessThan(80); expect(Math.abs(b - g)).toBeLessThan(80)
      expect(g).toBeCloseTo(Math.round(400 / 959 * 65535), -2)
    }
  })
  it('gamma lifts the midtones and the preview is 8-bit', () => {
    const lin = develop(flat(200, 200, 200), { gamma: false }), gam = develop(flat(200, 200, 200))
    expect(gam.data[0]).toBeGreaterThan(lin.data[0])
    const p = toRgba8(gam, 2)
    expect(p.width).toBe(4); expect(p.data[0]).toBe(gam.data[0] >> 8); expect(p.data[3]).toBe(255)
  })
})

describe('encodePng16', () => {
  it('writes a valid 16-bit RGB PNG structure', async () => {
    const img = develop(flat(200, 400, 100))
    const blob = await encodePng16(img.data, img.width, img.height)
    const b = new Uint8Array(await blob.arrayBuffer()), dv = new DataView(b.buffer)
    expect(Array.from(b.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(String.fromCharCode(...b.slice(12, 16))).toBe('IHDR')
    expect(dv.getUint32(16)).toBe(8); expect(dv.getUint32(20)).toBe(6)
    expect(b[24]).toBe(16); expect(b[25]).toBe(2)          // bit depth 16, colour type RGB
    expect(String.fromCharCode(...b.slice(b.length - 8, b.length - 4))).toBe('IEND')
    // IHDR CRC check
    const ihdrCrc = dv.getUint32(29)
    expect(ihdrCrc).not.toBe(0)
  })
})
