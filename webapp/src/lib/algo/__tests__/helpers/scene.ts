/** Synthetic non-periodic scenes for registration tests: seeded white noise (mulberry32, no
 *  short-range correlations — the auditor's LCG scene nearly repeated itself at a lag of
 *  (−8, 44) px, which is what produced its "44 px outliers") smoothed by a few box passes, sampled
 *  bilinearly so any sub-pixel shift can be rendered. */

import type { Gray } from '../../sharpness'

export function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export interface Scene {
  /** Continuous scene value (20..235) at (x, y); defined for −pad ≤ x < width + pad. */
  at(x: number, y: number): number
  /** Greyscale frame of the scene translated by (sx, sy) (content moved right/down). */
  gray(w: number, h: number, sx: number, sy: number, x0?: number, y0?: number): Gray
  /** Same as an opaque grey RGBA frame. */
  rgba(w: number, h: number, sx: number, sy: number): Uint8ClampedArray
}

/** `blurR` and `passes` set the structure scale: three passes of radius 2 ≈ Gaussian σ 2.9 px. */
export function makeScene(width: number, height: number, opts: { seed?: number; blurR?: number; passes?: number; pad?: number } = {}): Scene {
  const pad = opts.pad ?? 48, seed = opts.seed ?? 1, blurR = opts.blurR ?? 2, passes = opts.passes ?? 3
  const rnd = mulberry32(seed)
  const SW = width + 2 * pad, SH = height + 2 * pad
  let a: Float32Array<ArrayBuffer> = new Float32Array(SW * SH)
  for (let i = 0; i < a.length; i++) a[i] = rnd()
  const box = (src: Float32Array<ArrayBuffer>, r: number): Float32Array<ArrayBuffer> => {
    const t = new Float32Array(SW * SH), o = new Float32Array(SW * SH)
    for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) { let s = 0, n = 0; for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < SW) { s += src[y * SW + xx]; n++ } } t[y * SW + x] = s / n }
    for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) { let s = 0, n = 0; for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < SH) { s += t[yy * SW + x]; n++ } } o[y * SW + x] = s / n }
    return o
  }
  for (let p = 0; p < passes; p++) a = box(a, blurR)
  let mn = Infinity, mx = -Infinity
  for (const v of a) { if (v < mn) mn = v; if (v > mx) mx = v }
  const at = (x: number, y: number): number => {
    const X = Math.min(SW - 2, Math.max(0, x + pad)), Y = Math.min(SH - 2, Math.max(0, y + pad))
    const x0 = Math.floor(X), y0 = Math.floor(Y), tx = X - x0, ty = Y - y0
    const v = (a[y0 * SW + x0] * (1 - tx) + a[y0 * SW + x0 + 1] * tx) * (1 - ty) + (a[(y0 + 1) * SW + x0] * (1 - tx) + a[(y0 + 1) * SW + x0 + 1] * tx) * ty
    return 20 + 215 * (v - mn) / (mx - mn)
  }
  return {
    at,
    gray(w, h, sx, sy, x0 = 0, y0 = 0) {
      const data = new Float32Array(w * h)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = at(x0 + x - sx, y0 + y - sy)
      return { data, width: w, height: h }
    },
    rgba(w, h, sx, sy) {
      const d = new Uint8ClampedArray(w * h * 4)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = at(x - sx, y - sy); const p = (y * w + x) * 4; d[p] = d[p + 1] = d[p + 2] = v; d[p + 3] = 255 }
      return d
    },
  }
}

/** The auditor's scene generator (LCG noise, 1640×1232), kept to show that its "44 px outlier"
 *  came from the near-periodicity of the LCG output rather than from the estimator. */
export function makeLcgScene(width: number, height: number, pad = 32): Scene {
  let seed = 12345
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff }
  const SW = width + 2 * pad, SH = height + 2 * pad
  let a: Float32Array<ArrayBuffer> = new Float32Array(SW * SH)
  for (let i = 0; i < a.length; i++) a[i] = rnd()
  const box = (src: Float32Array<ArrayBuffer>, r: number): Float32Array<ArrayBuffer> => {
    const t = new Float32Array(SW * SH), o = new Float32Array(SW * SH)
    for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) { let s = 0, n = 0; for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < SW) { s += src[y * SW + xx]; n++ } } t[y * SW + x] = s / n }
    for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) { let s = 0, n = 0; for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < SH) { s += t[yy * SW + x]; n++ } } o[y * SW + x] = s / n }
    return o
  }
  a = box(box(box(a, 2), 2), 2)
  let mn = Infinity, mx = -Infinity
  for (const v of a) { if (v < mn) mn = v; if (v > mx) mx = v }
  const at = (x: number, y: number): number => {
    const X = Math.min(SW - 2, Math.max(0, x + pad)), Y = Math.min(SH - 2, Math.max(0, y + pad))
    const x0 = Math.floor(X), y0 = Math.floor(Y), tx = X - x0, ty = Y - y0
    const v = (a[y0 * SW + x0] * (1 - tx) + a[y0 * SW + x0 + 1] * tx) * (1 - ty) + (a[(y0 + 1) * SW + x0] * (1 - tx) + a[(y0 + 1) * SW + x0 + 1] * tx) * ty
    return 20 + 215 * (v - mn) / (mx - mn)
  }
  return {
    at,
    gray(w, h, sx, sy, x0 = 0, y0 = 0) {
      const data = new Float32Array(w * h)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = at(x0 + x - sx, y0 + y - sy)
      return { data, width: w, height: h }
    },
    rgba(w, h, sx, sy) {
      const d = new Uint8ClampedArray(w * h * 4)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const v = at(x - sx, y - sy); const p = (y * w + x) * 4; d[p] = d[p + 1] = d[p + 2] = v; d[p + 3] = 255 }
      return d
    },
  }
}
