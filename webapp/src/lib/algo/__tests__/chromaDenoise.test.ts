import { describe, it, expect } from 'vitest'
import { ChromaDenoiser } from '../chromaDenoise'

const W = 64, H = 64
function img(f: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const [r, g, b] = f(x, y), i = (y * W + x) * 4
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255
  }
  return d
}
/** deterministic LCG in [-1, 1) */
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 31 - 1 } }

/** sum of the Cb and Cr standard deviations */
function chromaStd(d: Uint8ClampedArray): number {
  let sb = 0, sb2 = 0, sr = 0, sr2 = 0, n = 0
  for (let i = 0; i < d.length; i += 4) {
    const cb = -0.168736 * d[i] - 0.331264 * d[i + 1] + 0.5 * d[i + 2]
    const cr = 0.5 * d[i] - 0.418688 * d[i + 1] - 0.081312 * d[i + 2]
    sb += cb; sb2 += cb * cb; sr += cr; sr2 += cr * cr; n++
  }
  return Math.sqrt(Math.max(0, sb2 / n - (sb / n) ** 2)) + Math.sqrt(Math.max(0, sr2 / n - (sr / n) ** 2))
}
function lumaAt(d: Uint8ClampedArray, x: number, y: number): number { const i = (y * W + x) * 4; return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] }

describe('ChromaDenoiser', () => {
  it('reduces coloured speckle on a flat coloured field and leaves the luma alone', () => {
    const r = rng(7)
    // opposite-sign noise on R and B keeps the luma almost flat: pure chroma speckle
    const noisy = img(() => { const e = r() * 24; return [170 + e, 110, 120 - e] })
    const cd = new ChromaDenoiser({ temporal: 0 })
    const out = cd.push(noisy, W, H)
    expect(chromaStd(out)).toBeLessThan(chromaStd(noisy) / 3)
    let maxLumaDiff = 0
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) maxLumaDiff = Math.max(maxLumaDiff, Math.abs(lumaAt(out, x, y) - lumaAt(noisy, x, y)))
    expect(maxLumaDiff).toBeLessThan(1.5)
  })

  it('does not blur a sharp luma edge (grey, chroma neutral)', () => {
    const edge = img((x) => (x < W / 2 ? [50, 50, 50] : [200, 200, 200]))
    const out = new ChromaDenoiser().push(edge, W, H)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) expect(Math.abs(out[(y * W + x) * 4 + c] - edge[(y * W + x) * 4 + c])).toBeLessThanOrEqual(1)
  })

  it('keeps a colour edge that coincides with a luma edge', () => {
    const edge = img((x) => (x < W / 2 ? [180, 40, 40] : [40, 160, 60]))
    const out = new ChromaDenoiser().push(edge, W, H)
    // the luma step (≈ 31 codes, var ≈ 240 vs ε = 64 in a window straddling it) guides the chroma:
    // a plain 9×9 box blur at half res would smear the ~120-code colour edge over ±9 px; here the
    // colours are mostly intact 2 px away, nearly so at 6 px and exact beyond the filter's reach
    // (two box passes of radius 4 on the half-res grid: 2·4·2 = 16 px)
    const check = (x: number, ref: number[], tol: number) => { const i = (20 * W + x) * 4; for (let c = 0; c < 3; c++) expect(Math.abs(out[i + c] - ref[c])).toBeLessThan(tol) }
    const L = [180, 40, 40], R = [40, 160, 60]
    check(W / 2 - 3, L, 25); check(W / 2 + 2, R, 25)
    check(W / 2 - 7, L, 12); check(W / 2 + 6, R, 12)
    check(W / 2 - 19, L, 2); check(W / 2 + 18, R, 2)
  })

  it('temporal EMA converges to the stable colour and reset() forgets it', () => {
    const cd = new ChromaDenoiser({ temporal: 0.8 })
    const red = img(() => [200, 60, 60]), green = img(() => [60, 200, 60])
    cd.push(red, W, H)
    // a large colour change is gated: the first green frame is already mostly green
    const first = cd.push(green, W, H)
    expect(first[1]).toBeGreaterThan(150)
    for (let k = 0; k < 20; k++) cd.push(green, W, H)
    const settled = cd.push(green, W, H)
    expect(Math.abs(settled[1] - 200)).toBeLessThan(3)
    cd.reset()
    const afterReset = cd.push(red, W, H)
    expect(Math.abs(afterReset[0] - 200)).toBeLessThan(2)
  })

  it('returns the same buffer on consecutive frames of one size', () => {
    const cd = new ChromaDenoiser()
    const a = cd.push(img(() => [100, 100, 100]), W, H)
    const b = cd.push(img(() => [120, 100, 90]), W, H)
    expect(a).toBe(b)
  })
})
