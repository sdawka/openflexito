import { describe, expect, it } from 'vitest'
import { binRgba, binnedSize } from '../binning'

function img(w: number, h: number, f: (x: number, y: number) => number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; d[i] = d[i + 1] = d[i + 2] = f(x, y); d[i + 3] = 255 }
  return d
}

describe('binRgba', () => {
  it('mean of a 2x2 block; size floors', () => {
    expect(binnedSize(9, 7, 2)).toEqual({ w: 4, h: 3 })
    const r = binRgba(img(4, 2, (x) => x * 10), 4, 2, 2, 'mean')
    expect(r.width).toBe(2); expect([...r.data].filter((_, i) => i % 4 === 0)).toEqual([5, 25])
  })
  it('edge kernel keeps a vertical edge a step where the mean would smear it', () => {
    const w = 8, h = 4
    const src = img(w, h, (x) => (x >= 3 ? 200 : 20))   // edge cuts the block at x = 2..3
    const mean = binRgba(src, w, h, 2, 'mean'), edge = binRgba(src, w, h, 2, 'edge')
    expect(mean.data[4]).toBe(110)                        // block x=2,3 → (20+200)/2
    expect(Math.abs(edge.data[4] - 200)).toBeLessThan(5) // centre pixel (x=3) is on the bright side
    expect(edge.data[0]).toBe(20); expect(edge.data[8]).toBe(200)
  })
})
