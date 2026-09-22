import { describe, it, expect } from 'vitest'
import { VideoFlat } from '../videoFlat'

const W = 64, H = 48
function img(f: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, g, b] = f(x, y), i = (y * W + x) * 4
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255
  }
  return d
}
/** a blank field that falls off toward the right edge (vignetting) */
const vignette = (x: number) => 1 - 0.4 * (x / (W - 1))
const blank = img((x) => [220 * vignette(x), 200 * vignette(x), 180 * vignette(x)])
const px = (d: Uint8ClampedArray, x: number, y: number, c = 0) => d[(y * W + x) * 4 + c]

describe('VideoFlat', () => {
  it('builds a gain map that flattens the reference field itself', () => {
    const vf = new VideoFlat(8)
    for (let k = 0; k < 4; k++) vf.addReference(blank, W, H)
    expect(vf.finalize()).toBe(true)
    expect(vf.ready).toBe(true)
    const out = new Uint8ClampedArray(W * H * 4)
    vf.apply(blank, W, H, out)
    // left and right edges (which differed by 40 %) now agree within a few codes; alpha intact.
    // (This synthetic fall-off is far steeper per grid cell than a real objective's, so the grid
    // smoothing's convexity bias is visible here: ~3 % at the darkest cells.)
    for (let c = 0; c < 3; c++) expect(Math.abs(px(out, 4, 20, c) - px(out, W - 5, 20, c))).toBeLessThan(12)
    expect(px(out, 10, 10, 3)).toBe(255)
    // gain rises toward the dark side and stays in the clamp
    const g = vf.gain!
    const cols = Math.ceil(W / 8)
    expect(g[(2 * cols + 0) * 3]).toBeLessThan(g[(2 * cols + cols - 1) * 3])
    for (const v of g) { expect(v).toBeGreaterThanOrEqual(0.5); expect(v).toBeLessThanOrEqual(4) }
  })

  it('strength 0 is the identity; a specimen darker than the field stays darker', () => {
    const vf = new VideoFlat(8)
    vf.addReference(blank, W, H); vf.finalize()
    const scene = img((x, y) => { const v = vignette(x) * (x > 30 && x < 40 && y > 20 && y < 30 ? 0.5 : 1); return [220 * v, 200 * v, 180 * v] })
    const out = new Uint8ClampedArray(W * H * 4)
    vf.apply(scene, W, H, out, 0)
    for (let i = 0; i < out.length; i += 4) for (let c = 0; c < 3; c++) expect(Math.abs(out[i + c] - scene[i + c])).toBeLessThanOrEqual(1)
    vf.apply(scene, W, H, out, 1)
    expect(px(out, 35, 25)).toBeLessThan(px(out, 20, 25) - 40)
    // the background around the specimen is flat after correction
    expect(Math.abs(px(out, 20, 25) - px(out, 50, 25))).toBeLessThan(8)
  })

  it('finds hot pixels in the dark frame and replaces them each frame; dark offset is subtracted', () => {
    const vf = new VideoFlat(8)
    const dark = img((x, y) => (x === 17 && y === 9 ? [255, 255, 255] : [12, 12, 12]))
    for (let k = 0; k < 3; k++) vf.addDark(dark, W, H)
    for (let k = 0; k < 3; k++) vf.addReference(blank, W, H)
    expect(vf.finalize()).toBe(true)
    expect(Array.from(vf.hot)).toEqual([9 * W + 17])
    const scene = img((x, y) => (x === 17 && y === 9 ? [255, 255, 255] : [100, 100, 100]))
    const out = new Uint8ClampedArray(W * H * 4)
    vf.apply(scene, W, H, out)
    // the hot pixel now looks like its neighbours
    for (let c = 0; c < 3; c++) expect(Math.abs(px(out, 17, 9, c) - px(out, 16, 9, c))).toBeLessThanOrEqual(1)
    // out = D + (cur − D)·G keeps the pedestal: a frame at the dark level comes back at the dark level
    // everywhere, however uneven the gain map (nothing above the dark to amplify)
    vf.apply(img(() => [12, 12, 12]), W, H, out)
    expect(Math.abs(px(out, 4, 30) - 12)).toBeLessThanOrEqual(2)
    expect(Math.abs(px(out, W - 5, 30) - 12)).toBeLessThanOrEqual(2)
  })

  it('finalize() without a reference fails; JSON round-trips the maps and the hot list', () => {
    expect(new VideoFlat().finalize()).toBe(false)
    const vf = new VideoFlat(8)
    vf.addDark(img((x, y) => (x === 3 && y === 40 ? [200, 0, 0] : [0, 0, 0])), W, H)
    vf.addReference(blank, W, H)
    vf.finalize()
    const j = vf.toJson()!
    expect(j.cols * j.rows * 3).toBe(j.gain.length)
    expect(j.hot).toEqual([3, 40])
    const back = VideoFlat.fromJson(JSON.parse(JSON.stringify(j)))
    expect(back.ready).toBe(true)
    expect(Array.from(back.hot)).toEqual([40 * W + 3])
    const a = new Uint8ClampedArray(W * H * 4), b = new Uint8ClampedArray(W * H * 4)
    vf.apply(blank, W, H, a); back.apply(blank, W, H, b)
    for (let i = 0; i < a.length; i++) expect(Math.abs(a[i] - b[i])).toBeLessThanOrEqual(1)
  })

  it('applies at a different frame size (maps are normalised); hot list is dropped there', () => {
    const vf = new VideoFlat(8)
    vf.addDark(img((x, y) => (x === 3 && y === 40 ? [200, 0, 0] : [0, 0, 0])), W, H)
    vf.addReference(blank, W, H); vf.finalize()
    const w2 = W * 2, h2 = H * 2
    const big = new Uint8ClampedArray(w2 * h2 * 4)
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) { const i = (y * w2 + x) * 4, v = vignette(x / 2); big[i] = 220 * v; big[i + 1] = 200 * v; big[i + 2] = 180 * v; big[i + 3] = 255 }
    const out = new Uint8ClampedArray(w2 * h2 * 4)
    vf.apply(big, w2, h2, out)
    expect(Math.abs(out[(40 * w2 + 8) * 4] - out[(40 * w2 + w2 - 9) * 4])).toBeLessThan(12)
    expect(Math.abs(out[(40 * w2 + 8) * 4] - out[(40 * w2 + w2 - 9) * 4])).toBeLessThan(Math.abs(big[(40 * w2 + 8) * 4] - big[(40 * w2 + w2 - 9) * 4]) / 5)
  })
})

import { VideoFlat as VF2 } from '../videoFlat'
describe('VideoFlat dark after reference', () => {
  it('a dark captured after the reference is folded in by a second finalize()', () => {
    const W = 32, H = 32
    const f = new VF2()
    const frame = (v: number) => { const d = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255 } return d }
    for (let k = 0; k < 4; k++) f.addReference(frame(180), W, H)
    expect(f.finalize()).toBe(true)
    for (let k = 0; k < 4; k++) f.addDark(frame(20), W, H)
    expect(f.finalize()).toBe(true)
    expect(f.darkFrames).toBe(4)
    const out = new Uint8ClampedArray(W * H * 4)
    f.apply(frame(20), W, H, out)
    expect(out[0]).toBeLessThan(30)   // the dark level maps to (near) black once the dark map is in
  })
})
