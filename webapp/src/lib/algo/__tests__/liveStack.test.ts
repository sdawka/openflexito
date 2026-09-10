import { describe, expect, it } from 'vitest'
import { LiveStacker, LiveAverager } from '../liveStack'
import { totalSharpness, type Rgba } from '../stack'
import { translateRgba } from '../pyramidFuse'
import { translateRgbaSubpixel } from '../align'

const W = 128, H = 96
let seed = 7
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
/** Aperiodic texture (blurred noise) so the alignment has something to lock on to. */
function scene(): Rgba {
  seed = 7
  const n = new Float32Array(W * H); for (let i = 0; i < n.length; i++) n[i] = rnd()
  const data = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0, k = 0
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const yy = Math.min(H - 1, Math.max(0, y + dy)), xx = Math.min(W - 1, Math.max(0, x + dx)); s += n[yy * W + xx]; k++ }
    const v = 30 + (s / k) * 400 - 100, p = (y * W + x) * 4; data[p] = v; data[p + 1] = v; data[p + 2] = v; data[p + 3] = 255
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
function noisy(base: Rgba, amp: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(base.data)
  for (let i = 0; i < d.length; i += 4) { const v = (rnd() - 0.5) * amp; d[i] += v; d[i + 1] += v; d[i + 2] += v }
  return d
}
function rms(a: Uint8ClampedArray, b: Uint8ClampedArray): number { let s = 0; for (let i = 0; i < a.length; i += 4) s += (a[i] - b[i]) ** 2; return Math.sqrt(s / (a.length / 4)) }

describe('LiveStacker', () => {
  it('accumulates the sharp half of alternating frames into one sharp composite', () => {
    const sharp = scene(), a = blurHalf(sharp, true), b = blurHalf(sharp, false)
    const st = new LiveStacker(W, H, 16)
    const s1 = st.update(a.data)
    expect(s1.coverage).toBe(1); expect(s1.replaced).toBe(1)
    const s2 = st.update(b.data)
    expect(s2.replaced).toBeGreaterThan(0.3); expect(s2.replaced).toBeLessThan(0.8)   // only the left half improved
    for (let i = 0; i < 6; i++) st.update(i % 2 ? a.data : b.data)
    const comp = { data: st.composite, width: W, height: H }
    expect(totalSharpness(comp)).toBeGreaterThan(0.9 * totalSharpness(sharp))
    expect(totalSharpness(comp)).toBeGreaterThan(1.3 * totalSharpness(a))
    expect(rms(st.composite, sharp.data)).toBeLessThan(0.3 * rms(a.data, sharp.data))
  })
  it('averages the noise away while the focus is steady', () => {
    const sharp = scene(), st = new LiveStacker(W, H, 16)
    const one = noisy(sharp, 40)
    st.update(one)
    for (let k = 0; k < 15; k++) st.update(noisy(sharp, 40))
    expect(rms(st.composite, sharp.data)).toBeLessThan(0.5 * rms(one, sharp.data))
  })
  it('follows a scene change thanks to the floor and the decays', () => {
    const sharp = scene(), st = new LiveStacker(W, H, 16)
    st.forget = 0.8; st.bestDecay = 0.9
    st.update(sharp.data)
    const dim = new Uint8ClampedArray(sharp.data); for (let i = 0; i < dim.length; i += 4) { dim[i] = dim[i] * 0.5; dim[i + 1] = dim[i]; dim[i + 2] = dim[i] }
    for (let i = 0; i < 16; i++) st.update(dim)
    expect(rms(st.composite, dim)).toBeLessThan(0.3 * rms(sharp.data, dim))   // the dimmer (lower-energy) scene takes over
  })
  it('restarts when the scene shifts by more than the alignment range', () => {
    const sharp = scene(), st = new LiveStacker(W, H, 16)
    st.update(sharp.data); st.update(sharp.data)
    const small = translateRgba(sharp.data, W, H, 3, 1)
    expect(st.update(small).frames).toBe(3)                     // jitter: aligned, composite kept
    const big = translateRgba(sharp.data, W, H, Math.round(W * 0.2), 0)
    expect(st.update(big).frames).toBe(1)                       // moved: composite restarted from this frame
    expect(st.update(big).frames).toBe(2)
  })
  it('translates by fractions of a pixel', () => {
    const sharp = scene()
    const half = translateRgbaSubpixel(sharp.data, W, H, 0.5, 0)
    const mid = (x: number, y: number) => (sharp.data[(y * W + x) * 4] + sharp.data[(y * W + x - 1) * 4]) / 2
    expect(Math.abs(half[(40 * W + 60) * 4] - mid(60, 40))).toBeLessThanOrEqual(1)
    expect(rms(translateRgbaSubpixel(sharp.data, W, H, 2, -1), translateRgba(sharp.data, W, H, 2, -1))).toBe(0)
  })
  it('reset clears everything', () => {
    const st = new LiveStacker(W, H); st.update(scene().data); st.reset()
    expect(st.frames).toBe(0); expect(st.composite[3]).toBe(0)
  })
})

describe('LiveAverager', () => {
  it('halves independent noise after a few frames', () => {
    const av = new LiveAverager(W, H)
    seed = 7
    const flat = () => { const d = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < d.length; i += 4) { const v = 128 + (rnd() - 0.5) * 40; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255 } return d }
    const one = flat(); let s1 = 0; for (let i = 0; i < one.length; i += 4) s1 += (one[i] - 128) ** 2
    for (let k = 0; k < 12; k++) av.update(flat())
    let s2 = 0; for (let i = 0; i < av.composite.length; i += 4) s2 += (av.composite[i] - 128) ** 2
    expect(Math.sqrt(s2 / s1)).toBeLessThan(0.55)
  })
})
