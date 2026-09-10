import { describe, expect, it } from 'vitest'
import { SliceAligner, alignPyramids, lumPyramid, luminance, translatePlanesSubpixel, translateRgbaSubpixel } from '../align'
import type { Gray } from '../sharpness'

const W = 640, H = 480
let seed = 11
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
/** Blobby texture: a few hundred soft discs on a gradient, aperiodic and locally distinctive. */
function texture(): Gray {
  seed = 11
  const d = new Float32Array(W * H)
  for (let i = 0; i < d.length; i++) d[i] = 60 + 40 * ((i % W) / W)
  for (let k = 0; k < 400; k++) {
    const cx = rnd() * W, cy = rnd() * H, r = 3 + rnd() * 12, a = (rnd() - 0.5) * 160
    for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(H, cy + r); y++) for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(W, cx + r); x++) {
      const q = ((x - cx) ** 2 + (y - cy) ** 2) / (r * r); if (q < 1) d[y * W + x] += a * (1 - q)
    }
  }
  return { data: d, width: W, height: H }
}
function blur(g: Gray, r: number): Gray {
  if (!r) return g
  const tmp = new Float32Array(g.data.length), out = new Float32Array(g.data.length)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0, n = 0; for (let k = -r; k <= r; k++) { const xx = Math.min(W - 1, Math.max(0, x + k)); s += g.data[y * W + xx]; n++ } tmp[y * W + x] = s / n }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0, n = 0; for (let k = -r; k <= r; k++) { const yy = Math.min(H - 1, Math.max(0, y + k)); s += tmp[yy * W + x]; n++ } out[y * W + x] = s / n }
  return { data: out, width: W, height: H }
}
function shifted(g: Gray, dx: number, dy: number): Gray {
  const [p] = translatePlanesSubpixel([g.data, g.data, g.data], W, H, dx, dy)
  return { data: p, width: W, height: H }
}

describe('alignPyramids', () => {
  it('recovers a sub-pixel shift between a sharp and a blurred slice to within 0.15 px', () => {
    const ref = texture(), img = blur(shifted(ref, 12.3, -7.6), 3)
    const d = alignPyramids(lumPyramid(ref), lumPyramid(img))
    expect(Math.abs(d.dx - 12.3)).toBeLessThan(0.15); expect(Math.abs(d.dy + 7.6)).toBeLessThan(0.15)
  })
  it('handles a shift far beyond the refinement window via the coarse level', () => {
    const ref = texture(), img = shifted(ref, -25, 18)
    const d = alignPyramids(lumPyramid(ref), lumPyramid(img))
    expect(Math.abs(d.dx + 25)).toBeLessThan(0.2); expect(Math.abs(d.dy - 18)).toBeLessThan(0.2)
  })
  it('reports zero for an identical image and builds a pyramid down to the coarse width', () => {
    const ref = texture(), pyr = lumPyramid(ref)
    expect(pyr.length).toBe(2); expect(pyr[1].width).toBe(W / 2)
    const d = alignPyramids(pyr, pyr)
    expect(Math.abs(d.dx)).toBeLessThan(0.01); expect(Math.abs(d.dy)).toBeLessThan(0.01)
  })
})

describe('SliceAligner', () => {
  it('chains neighbour alignments through a stack whose defocus changes slice by slice', () => {
    const base = texture()
    // slice k is shifted by cumulative (2.6k, -1.4k) px and blurred by |k - 2| (sharpest in the middle)
    const shifts = [0, 1, 2, 3, 4].map((k) => ({ dx: 2.6 * k, dy: -1.4 * k }))
    const slices = shifts.map((s, k) => blur(shifted(base, s.dx, s.dy), Math.abs(k - 2) * 2))
    const al = new SliceAligner()
    slices.forEach((s, k) => {
      const d = al.next(s)
      expect(Math.abs(d.dx - shifts[k].dx)).toBeLessThan(0.3); expect(Math.abs(d.dy - shifts[k].dy)).toBeLessThan(0.3)
    })
  })
})

describe('sub-pixel translation', () => {
  it('interpolates halfway values and matches an integer shift exactly', () => {
    const g = texture(), rgba = new Uint8ClampedArray(W * H * 4)
    for (let i = 0; i < W * H; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = g.data[i]; rgba[i * 4 + 3] = 255 }
    const half = translateRgbaSubpixel(rgba, W, H, 0.5, 0)
    const i = 200 * W + 300
    expect(Math.abs(half[i * 4] - (rgba[i * 4] + rgba[(i - 1) * 4]) / 2)).toBeLessThanOrEqual(1)
    const lum = luminance(rgba, W, H)
    expect(Math.abs(lum.data[i] - rgba[i * 4])).toBeLessThan(1)
    const [p] = translatePlanesSubpixel([g.data, g.data, g.data], W, H, 3, -2)
    expect(p[i]).toBe(g.data[(200 + 2) * W + 300 - 3])
  })
})
