import { describe, expect, it } from 'vitest'
import { PyramidFuser, translateRgba, hybridFuse, noiseEnergy } from '../pyramidFuse'
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
function boxBlur(img: Rgba, r: number, x0 = 0, x1 = img.width): Rgba {
  const { width: w, height: h } = img, out = new Uint8ClampedArray(img.data)
  for (let y = 0; y < h; y++) for (let x = x0; x < x1; x++) for (let c = 0; c < 3; c++) {
    let s = 0, n = 0
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const yy = Math.min(h - 1, Math.max(0, y + dy)), xx = Math.min(w - 1, Math.max(0, x + dx)); s += img.data[(yy * w + xx) * 4 + c]; n++
    }
    out[(y * w + x) * 4 + c] = s / n
  }
  return { data: out, width: w, height: h }
}
const blurHalf = (img: Rgba, left: boolean, r = 4) => boxBlur(img, r, left ? 0 : W / 2, left ? W / 2 : W)

let seed = 3
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
function flatNoisy(v: number, amp: number, w = W, h = H): Rgba {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) { const n = v + (rnd() - 0.5) * amp, p = i * 4; data[p] = n; data[p + 1] = n; data[p + 2] = n; data[p + 3] = 255 }
  return { data, width: w, height: h }
}
function std(img: Rgba, x0: number, x1: number): number {
  let s = 0, s2 = 0, n = 0
  for (let y = 0; y < img.height; y++) for (let x = x0; x < x1; x++) { const v = img.data[(y * img.width + x) * 4]; s += v; s2 += v * v; n++ }
  return Math.sqrt(s2 / n - (s / n) ** 2)
}

/** Halo fixture: a bright disc on a dark background, sharp in slice A and box-blurred in slice B.
 *  The correct result is slice A everywhere; a per-level argmax takes B's glow in the ring just
 *  outside the disc (B's blurred edge has more coarse-band energy there than A's sharp edge). */
function disc(): { sharp: Rgba; blurred: Rgba; cx: number; cy: number; r: number } {
  const w = 160, h = 160, cx = 80, cy = 80, r = 24
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = Math.hypot(x - cx, y - cy) < r ? 220 : 40, p = (y * w + x) * 4
    data[p] = v; data[p + 1] = v; data[p + 2] = v; data[p + 3] = 255
  }
  const sharp = { data, width: w, height: h }
  return { sharp, blurred: boxBlur(sharp, 7), cx, cy, r }
}
/** Mean brightness error in the ring r+3 .. r+12 px outside the disc (background is 40). */
function ringError(img: Rgba, cx: number, cy: number, r: number): number {
  let s = 0, n = 0
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const d = Math.hypot(x - cx, y - cy)
    if (d > r + 3 && d < r + 12) { s += Math.abs(img.data[(y * img.width + x) * 4] - 40); n++ }
  }
  return s / n
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

  it('halo fixture: consistent weights keep the blurred slice\'s glow out of the ring, per-level argmax does not', () => {
    const { sharp, blurred, cx, cy, r } = disc()
    const run = (opts: ConstructorParameters<typeof PyramidFuser>[2]) => {
      const f = new PyramidFuser(sharp.width, sharp.height, opts)
      f.add(blurred.data, 0); f.add(sharp.data, 1)
      const out = f.result()
      return ringError({ data: out.data, width: sharp.width, height: sharp.height }, cx, cy, r)
    }
    const old = run({ selection: 'perLevelMax' }), fresh = run({})
    expect(old).toBeGreaterThan(3)          // the old code shows a visible glow (≈ several grey levels)
    expect(fresh).toBeLessThan(1)           // the new one is background to within a grey level
    expect(fresh).toBeLessThan(old / 5)
  })

  it('noise floor: featureless slices are averaged (noise reduced), not selected (noise amplified)', () => {
    seed = 3
    const slices = [0, 1, 2, 3].map(() => flatNoisy(120, 30))
    const run = (opts: ConstructorParameters<typeof PyramidFuser>[2]) => {
      const f = new PyramidFuser(W, H, opts)
      slices.forEach((s, i) => f.add(s.data, i))
      const out = f.result()
      return std({ data: out.data, width: W, height: H }, 0, W)
    }
    const one = std(slices[0], 0, W)
    const old = run({ selection: 'perLevelMax' }), fresh = run({})
    expect(old).toBeGreaterThan(0.9 * one)          // hard selection keeps (or amplifies) the noise
    expect(fresh).toBeLessThan(0.6 * one)           // averaging four slices ≈ halves it
  })

  it('noise floor does not swallow real detail next to a flat region', () => {
    // left half: flat + noise in both slices; right half: checkerboard sharp in slice 1 only
    seed = 5
    const sharp = scene(), a = blurHalf(sharp, false, 4), b = { ...sharp, data: new Uint8ClampedArray(sharp.data) }
    for (const img of [a, b]) for (let y = 0; y < H; y++) for (let x = 0; x < W / 2; x++) { const p = (y * W + x) * 4, v = 120 + (rnd() - 0.5) * 20; img.data[p] = v; img.data[p + 1] = v; img.data[p + 2] = v }
    const f = new PyramidFuser(W, H)
    f.add(a.data, 0); f.add(b.data, 1)
    const out = { data: f.result().data, width: W, height: H }
    // right half is taken from the sharp slice
    let err = 0, n = 0
    for (let y = 4; y < H - 4; y++) for (let x = W / 2 + 8; x < W - 4; x++) { err += Math.abs(out.data[(y * W + x) * 4] - b.data[(y * W + x) * 4]); n++ }
    expect(err / n).toBeLessThan(6)
    // left half: noise is averaged down
    expect(std(out, 4, W / 2 - 8)).toBeLessThan(0.85 * std(a, 4, W / 2 - 8))
  })

  it('depth: hard index, soft index and confidence agree on a two-slice split', () => {
    const sharp = scene(), a = blurHalf(sharp, false), b = blurHalf(sharp, true)   // a sharp on the left, b on the right
    const f = new PyramidFuser(W, H)
    f.add(a.data, 0); f.add(b.data, 1)
    f.result()
    const hard = f.depthIndex(), soft = f.depthSoft(), conf = f.depthConfidence()
    let leftSoft = 0, rightSoft = 0, leftConf = 0, n = 0
    for (let y = 8; y < H - 8; y++) for (let x = 8; x < W / 2 - 8; x++) { const i = y * W + x; leftSoft += soft[i]; leftConf += conf[i]; n++; expect(hard[i]).toBe(0) }
    for (let y = 8; y < H - 8; y++) for (let x = W / 2 + 8; x < W - 8; x++) rightSoft += soft[y * W + x]
    expect(leftSoft / n).toBeLessThan(0.1); expect(rightSoft / n).toBeGreaterThan(0.9)
    expect(leftConf / n).toBeGreaterThan(0.9)
    // equal slices: confidence ~0, soft index halfway
    const g = new PyramidFuser(W, H)
    g.add(sharp.data, 0); g.add(sharp.data, 1)
    g.result()
    const s2 = g.depthSoft(), c2 = g.depthConfidence()
    expect(Math.abs(s2[(H / 2) * W + W / 4] - 0.5)).toBeLessThan(0.05)
    expect(c2[(H / 2) * W + W / 4]).toBeLessThan(0.05)
  })

  it('hybrid fusion reads the slices along the depth surface where confident and matches the pyramid elsewhere', () => {
    const sharp = scene(), a = blurHalf(sharp, false), b = blurHalf(sharp, true)
    const f = new PyramidFuser(W, H)
    f.add(a.data, 0); f.add(b.data, 1)
    const pyr = f.resultPlanes()
    // small test canvas: shrink the depth-surface cell/smoothing radius so the transition band (a couple
    // of cells wide either side of the true x = W/2 split) doesn't reach into the checked interior at
    // this resolution; production frames are hundreds of cells wide and the default (16, 2) stays local.
    const hy = hybridFuse(pyr, f.depthSoft(), f.depthConfidence(), [a.data, b.data], { cell: 8, passes: 1 })
    // in the confidently-sharp interior the hybrid output equals the winning slice's pixels
    let dl = 0, dr = 0, n = 0
    for (let y = 16; y < H - 16; y++) for (let x = 16; x < W / 2 - 16; x++) { const i = y * W + x; dl += Math.abs(hy.planes[0][i] - a.data[i * 4]); n++ }
    for (let y = 16; y < H - 16; y++) for (let x = W / 2 + 16; x < W - 16; x++) { const i = y * W + x; dr += Math.abs(hy.planes[0][i] - b.data[i * 4]) }
    expect(dl / n).toBeLessThan(1.5); expect(dr / n).toBeLessThan(1.5)
    // zero confidence everywhere: pure pyramid result
    const same = hybridFuse(pyr, f.depthSoft(), new Float32Array(W * H), [a.data, b.data], { cell: 8, passes: 1 })
    for (let i = 0; i < W * H; i += 97) expect(same.planes[1][i]).toBe(pyr.planes[1][i])
    // fewer than two slices: unchanged
    expect(hybridFuse(pyr, f.depthSoft(), f.depthConfidence(), [a.data])).toBe(pyr)
  })

  it('noiseEnergy is a low percentile of the energies', () => {
    const e = new Float32Array(1000); for (let i = 0; i < 1000; i++) e[i] = i
    expect(noiseEnergy(e, 0.05)).toBe(50)
  })
})
