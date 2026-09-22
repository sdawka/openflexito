import { describe, expect, it } from 'vitest'
import { sampleLine, Kymograph } from '../kymograph'

describe('kymograph', () => {
  it('samples a horizontal gradient along a line and scrolls rows', () => {
    const W = 16, H = 8
    const d = new Uint8ClampedArray(W * H * 4)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; d[i] = d[i + 1] = d[i + 2] = x * 10; d[i + 3] = 255 }
    const row = new Float32Array(4 * 3)
    sampleLine(d, W, H, { x0: 0, y0: 4, x1: 15, y1: 4 }, 4, 3, row)
    expect(row[0]).toBeCloseTo(0, 0); expect(row[9]).toBeCloseTo(150, 0)
    const k = new Kymograph(4, 2)
    k.push(row); k.push(row)
    row.fill(7); k.push(row)
    expect(k.rows).toBe(2)
    expect(k.image[(1 * 4 + 0) * 4]).toBe(7)          // newest at the bottom
    expect(k.image[(0 * 4 + 3) * 4]).toBe(150)        // older row scrolled up
  })
})
