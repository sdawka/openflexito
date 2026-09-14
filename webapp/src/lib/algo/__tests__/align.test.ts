import { describe, expect, it } from 'vitest'
import { SliceAligner, alignPyramids, alignStack, alignSimilarity, chooseReference, laplacianEnergy, lumPyramid, luminance, scaleGray, translateFloat, translatePlanesSubpixel, translateRgbaSubpixel } from '../align'
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

describe('chooseReference / alignStack', () => {
  it('picks the middle slice by default and chains outward both ways to it', () => {
    const base = texture()
    // slice k: cumulative shift (2.6k, -1.4k), blur |k-2|*2 (sharpest at k=2, the middle of 5)
    const shifts = [0, 1, 2, 3, 4].map((k) => ({ dx: 2.6 * k, dy: -1.4 * k }))
    const lums = shifts.map((s, k) => blur(shifted(base, s.dx, s.dy), Math.abs(k - 2) * 2))
    expect(chooseReference(5)).toBe(2)
    const out = alignStack(lums, chooseReference(5))
    expect(out[2]).toEqual({ dx: 0, dy: 0, quality: Infinity })
    for (let k = 0; k < 5; k++) {
      const wantDx = shifts[k].dx - shifts[2].dx, wantDy = shifts[k].dy - shifts[2].dy
      expect(Math.abs(out[k].dx - wantDx)).toBeLessThan(0.3)
      expect(Math.abs(out[k].dy - wantDy)).toBeLessThan(0.3)
    }
  })
  it('"sharpest" mode picks the slice with the most Laplacian energy', () => {
    const base = texture()
    const lums = [0, 1, 2].map((k) => blur(base, k === 1 ? 0 : 4))   // slice 1 is the only sharp one
    expect(chooseReference(3, 'sharpest', lums)).toBe(1)
    expect(laplacianEnergy(lums[1])).toBeGreaterThan(laplacianEnergy(lums[0]))
  })
})

describe('Lanczos-3 resampling', () => {
  it('preserves more high-frequency content than bilinear at a half-pixel shift', () => {
    const ref = texture()
    const half = 0.5
    const bilinear = translateFloat(ref.data, W, H, 1, half, 0, 'bilinear')
    const lanczos = translateFloat(ref.data, W, H, 1, half, 0, 'lanczos3')
    // shift back by -half and compare high-frequency (Laplacian) energy retained vs the original:
    // a box-like kernel (bilinear) attenuates near Nyquist far more than Lanczos-3.
    const energyOf = (d: Float32Array) => { let s = 0; for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = y * W + x, l = 4 * d[i] - d[i - 1] - d[i + 1] - d[i - W] - d[i + W]; s += l * l } return s }
    expect(energyOf(lanczos)).toBeGreaterThan(energyOf(bilinear))
    // an integer shift is exact for both methods
    const intB = translateFloat(ref.data, W, H, 1, 3, 0, 'bilinear'), intL = translateFloat(ref.data, W, H, 1, 3, 0, 'lanczos3')
    let dmax = 0; for (let i = 0; i < intB.length; i++) dmax = Math.max(dmax, Math.abs(intB[i] - intL[i]))
    expect(dmax).toBeLessThan(1e-6)
  })
})

describe('alignSimilarity (optional scale + translation)', () => {
  it('recovers a ~1% magnification change and a translation', () => {
    const ref = texture()
    const img = { data: scaleGray(ref, 1.01).data, width: W, height: H }
    const shiftedImg: Gray = { data: translateFloat(img.data, W, H, 1, 4, -3, 'bilinear'), width: W, height: H }
    const s = alignSimilarity(ref, shiftedImg, { maxScale: 0.03 })
    expect(Math.abs(s.scale - 1.01)).toBeLessThan(0.01)
    expect(Math.abs(s.dx - 4)).toBeLessThan(1); expect(Math.abs(s.dy + 3)).toBeLessThan(1)
  })
  it('reports scale ~1 for two identical slices', () => {
    const ref = texture()
    const s = alignSimilarity(ref, ref)
    expect(Math.abs(s.scale - 1)).toBeLessThan(0.01)
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
