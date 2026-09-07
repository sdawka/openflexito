import { describe, expect, it } from 'vitest'
import { exposureFuse, focusStack, totalSharpness, type Rgba } from '../stack'

const W = 96, H = 64
function checker(scale: number): Rgba {
  const data = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = ((Math.floor(x / 4) + Math.floor(y / 4)) % 2 ? 200 : 60) * scale
    const p = (y * W + x) * 4; data[p] = data[p + 1] = data[p + 2] = v; data[p + 3] = 255
  }
  return { data, width: W, height: H }
}
/** Blur the left or right half with a wide box filter. */
function blurHalf(img: Rgba, left: boolean): Rgba {
  const out = new Uint8ClampedArray(img.data)
  for (let y = 0; y < H; y++) for (let x = left ? 0 : W / 2; x < (left ? W / 2 : W); x++) {
    let s = 0, n = 0
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const yy = Math.min(H - 1, Math.max(0, y + dy)), xx = Math.min(W - 1, Math.max(0, x + dx))
      s += img.data[(yy * W + xx) * 4]; n++
    }
    const p = (y * W + x) * 4; out[p] = out[p + 1] = out[p + 2] = s / n
  }
  return { data: out, width: W, height: H }
}

describe('focusStack', () => {
  it('recovers the sharp half from each source', () => {
    const sharp = checker(1)
    const a = blurHalf(sharp, true), b = blurHalf(sharp, false)
    const { image: out, contributions } = focusStack([a, b])
    expect(contributions[0]).toBeGreaterThan(0.3); expect(contributions[1]).toBeGreaterThan(0.3)   // each half comes from one source
    expect(contributions[0] + contributions[1]).toBeCloseTo(1, 5)
    const ref = totalSharpness(sharp), sa = totalSharpness(a), so = totalSharpness(out)
    expect(sa).toBeLessThan(ref * 0.7)          // each source really is half blurred
    expect(so).toBeGreaterThan(ref * 0.85)      // the stack is close to the all-sharp reference
    expect(out.data[(32 * W + 8) * 4]).toBeCloseTo(sharp.data[(32 * W + 8) * 4], -1)   // left half taken from b (sharp there)
  })
  it('returns the single image unchanged', () => {
    const a = checker(1)
    expect(focusStack([a]).image).toBe(a)
  })
})

describe('exposureFuse', () => {
  it('keeps detail that is clipped in one frame and buried in the other', () => {
    const dark = checker(0.25)            // 15 / 50: low contrast, nothing clipped
    const bright = checker(1.6)           // 96 / 255: the light squares clip
    const out = exposureFuse([dark, bright])
    const light = out.data[(0 * W + 0) * 4], shade = out.data[(0 * W + 4) * 4]
    expect(Math.abs(light - shade)).toBeGreaterThan(40)   // the checker survives
    expect(Math.max(light, shade)).toBeLessThan(250)      // and is not clipped
    expect(Math.min(light, shade)).toBeGreaterThan(20)
  })
})
