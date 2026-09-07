import { describe, expect, it } from 'vitest'
import { LiveStacker } from '../liveStack'
import { totalSharpness, type Rgba } from '../stack'

const W = 128, H = 96
function scene(): Rgba {
  const data = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = ((Math.floor(x / 3) + Math.floor(y / 3)) % 2 ? 210 : 50)
    const p = (y * W + x) * 4; data[p] = v; data[p + 1] = v; data[p + 2] = v; data[p + 3] = 255
  }
  return { data, width: W, height: H }
}
function blurHalf(img: Rgba, left: boolean, r = 4): Rgba {
  const out = new Uint8ClampedArray(img.data)
  for (let y = 0; y < H; y++) for (let x = left ? 0 : W / 2; x < (left ? W / 2 : W); x++) {
    let s = 0, n = 0
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const yy = Math.min(H - 1, Math.max(0, y + dy)), xx = Math.min(W - 1, Math.max(0, x + dx)); s += img.data[(yy * W + xx) * 4]; n++ }
    const p = (y * W + x) * 4; out[p] = out[p + 1] = out[p + 2] = s / n
  }
  return { data: out, width: W, height: H }
}

describe('LiveStacker', () => {
  it('accumulates the sharp half of alternating frames into one sharp composite', () => {
    const sharp = scene(), a = blurHalf(sharp, true), b = blurHalf(sharp, false)
    const st = new LiveStacker(W, H, 16)
    const s1 = st.update(a.data)
    expect(s1.coverage).toBe(1); expect(s1.replaced).toBe(1)
    const s2 = st.update(b.data)
    expect(s2.replaced).toBeGreaterThan(0.3); expect(s2.replaced).toBeLessThan(0.8)   // only the left half improved
    for (let i = 0; i < 4; i++) st.update(i % 2 ? a.data : b.data)
    const comp = { data: st.composite, width: W, height: H }
    expect(totalSharpness(comp)).toBeGreaterThan(0.9 * totalSharpness(sharp))
    expect(totalSharpness(comp)).toBeGreaterThan(1.3 * totalSharpness(a))
  })
  it('follows a scene change thanks to the decay', () => {
    const sharp = scene(), st = new LiveStacker(W, H, 16)
    st.decay = 0.8
    st.update(sharp.data)
    const dim = new Uint8ClampedArray(sharp.data); for (let i = 0; i < dim.length; i += 4) { dim[i] = dim[i] * 0.5; dim[i + 1] = dim[i]; dim[i + 2] = dim[i] }
    let replaced = 0
    for (let i = 0; i < 12; i++) replaced = st.update(dim).replaced
    expect(replaced).toBeGreaterThan(0.5)   // the dimmer (lower-energy) scene eventually takes over
    expect(st.composite[0]).toBeLessThan(sharp.data[0] * 0.7)
  })
  it('reset clears everything', () => {
    const st = new LiveStacker(W, H); st.update(scene().data); st.reset()
    expect(st.frames).toBe(0); expect(st.composite[3]).toBe(0)
  })
})
