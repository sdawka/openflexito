import { describe, expect, it } from 'vitest'
import { PyramidFuser, translateRgba } from '../pyramidFuse'
import { totalSharpness, type Rgba } from '../stack'

const W = 128, H = 96
function scene(): Rgba {
  const data = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = ((Math.floor(x / 3) + Math.floor(y / 3)) % 2 ? 210 : 50) + (x < W / 2 ? 0 : 20)
    const p = (y * W + x) * 4; data[p] = v; data[p + 1] = v * 0.8; data[p + 2] = v * 0.6; data[p + 3] = 255
  }
  return { data, width: W, height: H }
}
function blurHalf(img: Rgba, left: boolean, r = 4): Rgba {
  const out = new Uint8ClampedArray(img.data)
  for (let y = 0; y < H; y++) for (let x = left ? 0 : W / 2; x < (left ? W / 2 : W); x++) for (let c = 0; c < 3; c++) {
    let s = 0, n = 0
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const yy = Math.min(H - 1, Math.max(0, y + dy)), xx = Math.min(W - 1, Math.max(0, x + dx)); s += img.data[(yy * W + xx) * 4 + c]; n++
    }
    out[(y * W + x) * 4 + c] = s / n
  }
  return { data: out, width: W, height: H }
}

describe('PyramidFuser', () => {
  it('reassembles a sharp image from two half-blurred slices and reports contributions', () => {
    const sharp = scene(), a = blurHalf(sharp, true), b = blurHalf(sharp, false)
    const f = new PyramidFuser(W, H)
    f.add(a.data, 0); f.add(b.data, 1)
    const r = f.result()
    expect(totalSharpness({ data: r.data, width: W, height: H })).toBeGreaterThan(0.9 * totalSharpness(sharp))
    expect(r.contributions[0]).toBeGreaterThan(0.3); expect(r.contributions[1]).toBeGreaterThan(0.3)
    // colours preserved: mean of each channel close to the sharp original
    let dr = 0
    for (let i = 0; i < W * H * 4; i += 4) dr += Math.abs(r.data[i] - sharp.data[i])
    expect(dr / (W * H)).toBeLessThan(12)
  })
  it('a single slice comes back essentially unchanged', () => {
    const s = scene(), f = new PyramidFuser(W, H)
    f.add(s.data, 0)
    const r = f.result()
    let d = 0
    for (let i = 0; i < s.data.length; i += 4) d = Math.max(d, Math.abs(r.data[i] - s.data[i]))
    expect(d).toBeLessThan(3)
  })
  it('translateRgba shifts content', () => {
    const s = scene()
    const t = translateRgba(s.data, W, H, 3, -2)
    expect(t[((10) * W + 13) * 4]).toBe(s.data[((12) * W + 10) * 4])
  })
})
