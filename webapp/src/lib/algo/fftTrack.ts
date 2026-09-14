/** Image displacement by high-pass-filtered FFT cross-correlation (port of camera-stage-mapping's
 *  fft_image_tracking). Both images are zero-meaned, zero-padded to 2x, high-pass filtered in the
 *  frequency domain (1 - Gaussian, sigma ~10 px) and cross-correlated. The integer peak is then
 *  refined to sub-pixel precision by upsampling the correlation surface around it with a local
 *  DFT (the surface is band-limited to the image's Nyquist frequency, so its Dirichlet interpolant
 *  is exact up to the windowing of the patch; this is the local-upsampling idea of
 *  Guizar-Sicairos et al., Opt. Lett. 33, 156 (2008), applied to a windowed 32×32 patch instead
 *  of the whole spectrum so the cost stays a few million multiply-adds).
 *
 *  Divergence from the CSM original (and from the previous port): the peak is no longer the mean of
 *  a thresholded centroid and a 1-D parabola. That estimate was biased toward the integer sample
 *  and underestimated sub-pixel shifts by ~2.5× (measured on synthetic scenes), which is fatal for
 *  pixel-shift super-resolution and drift correction. */

import { fft2d, nextPow2 } from './fft'
import type { Gray } from './sharpness'

export interface Displacement {
  dx: number; dy: number
  /** Height of the correlation peak (arbitrary units, scene dependent). */
  peak: number
  /** Peak-to-sidelobe ratio: peak height over the highest correlation value more than 8 px away
   *  from it. ≈1 for an unrelated pair (no real peak, the surface is equally high elsewhere), > 2
   *  for a correct registration of a non-periodic textured scene (typically 5-30), Infinity when
   *  the surface is ≤ 0 everywhere outside the peak. Periodic scenes (gratings) legitimately score
   *  low because their correlation has real secondary peaks. */
  quality: number
}

function prepare(g: Gray, W: number, H: number): { re: Float64Array; im: Float64Array } {
  const re = new Float64Array(W * H), im = new Float64Array(W * H)
  let mean = 0
  for (let i = 0; i < g.data.length; i++) mean += g.data[i]
  mean /= g.data.length
  for (let y = 0; y < g.height; y++) for (let x = 0; x < g.width; x++) re[y * W + x] = g.data[y * g.width + x] - mean
  fft2d(re, im, W, H)
  return { re, im }
}

/** Spatial-frequency high-pass weight: 1 - exp(-(k^2 sigma^2)/2) where k is in cycles/pixel * 2pi. */
function highPassWeights(W: number, H: number, sigmaPx: number): Float64Array {
  const w = new Float64Array(W * H)
  for (let y = 0; y < H; y++) {
    const ky = (y <= H / 2 ? y : y - H) / H
    for (let x = 0; x < W; x++) {
      const kx = (x <= W / 2 ? x : x - W) / W
      const k2 = (2 * Math.PI) ** 2 * (kx * kx + ky * ky)
      w[y * W + x] = 1 - Math.exp(-k2 * sigmaPx * sigmaPx / 2)
    }
  }
  return w
}

/** Displacement of `image` relative to `template` in pixels (positive dx: content moved right). */
export function displacement(template: Gray, image: Gray, sigmaPx = 10): Displacement {
  const W = nextPow2(Math.max(template.width, image.width) * 2)
  const H = nextPow2(Math.max(template.height, image.height) * 2)
  const a = prepare(template, W, H), b = prepare(image, W, H)
  const hp = highPassWeights(W, H, sigmaPx)
  // cross power: B * conj(A), weighted by the squared high-pass (both images filtered once)
  const re = new Float64Array(W * H), im = new Float64Array(W * H)
  for (let i = 0; i < re.length; i++) {
    const wgt = hp[i] * hp[i]
    re[i] = (b.re[i] * a.re[i] + b.im[i] * a.im[i]) * wgt
    im[i] = (b.im[i] * a.re[i] - b.re[i] * a.im[i]) * wgt
  }
  fft2d(re, im, W, H, true)
  // integer peak
  let peak = -Infinity, pi = 0
  for (let i = 0; i < re.length; i++) if (re[i] > peak) { peak = re[i]; pi = i }
  const px = pi % W, py = Math.floor(pi / W)
  // quality: ratio of peak to the highest value outside the peak neighbourhood
  let second = -Infinity
  for (let y = 0; y < H; y++) {
    const ddy = Math.min(Math.abs(y - py), H - Math.abs(y - py))
    const row = y * W
    for (let x = 0; x < W; x++) {
      const ddx = Math.min(Math.abs(x - px), W - Math.abs(x - px))
      if ((ddx > 8 || ddy > 8) && re[row + x] > second) second = re[row + x]
    }
  }
  const sub = refinePeak(re, W, H, px, py, Math.min(template.width, image.width), Math.min(template.height, image.height))
  let dx = px + sub.dx, dy = py + sub.dy
  if (dx > W / 2) dx -= W
  if (dy > H / 2) dy -= H
  return { dx, dy, peak, quality: second > 0 ? peak / second : Infinity }
}

/** Sub-pixel offset of the correlation maximum from the integer sample (px, py).
 *
 *  A (2R)×(2R) patch centred on the integer peak is taken from the (periodic) correlation surface,
 *  weighted by a flat-top window centred on the peak (symmetric and flat over the peak, so it
 *  cannot bias the maximum for a peak within ±1 px of the centre), transformed with a small FFT and evaluated back at fractional
 *  positions ±1 px around the centre on a 1/`us` grid by a separable matrix DFT (centred
 *  frequencies, i.e. Dirichlet interpolation). A parabola through the three finest samples around
 *  the upsampled maximum gives the final estimate; accuracy is a few thousandths of a pixel for a
 *  smooth peak, limited by the truncation of the surface to the patch. */
function refinePeak(surf: Float64Array, W: number, H: number, px: number, py: number, w: number, h: number, R = 32, us = 16): { dx: number; dy: number } {
  const N = 2 * R
  const re = new Float64Array(N * N), im = new Float64Array(N * N)
  const win = new Float64Array(N)
  for (let i = 0; i < N; i++) win[i] = tukey(i - R, R)
  // Overlap envelope: the correlation of two finite images at lag (lx, ly) sums over only
  // (w - |lx|)(h - |ly|) pixel pairs, a triangular envelope centred on lag 0 that tilts the peak
  // toward zero lag by ~σ_peak²/w px (0.03-0.06 px for a 410×308 image). Dividing it out before
  // interpolating removes that bias.
  const lx0 = px <= W / 2 ? px : px - W, ly0 = py <= H / 2 ? py : py - H
  for (let j = 0; j < N; j++) {
    const yy = (py + j - R + H) % H
    const ey = Math.max(1, h - Math.abs(ly0 + j - R)) / h
    for (let i = 0; i < N; i++) {
      const xx = (px + i - R + W) % W
      const ex = Math.max(1, w - Math.abs(lx0 + i - R)) / w
      re[j * N + i] = surf[yy * W + xx] / (ex * ey) * win[i] * win[j]
    }
  }
  fft2d(re, im, N, N)
  // evaluation kernel: e^{2πi k (R + u)/N} for centred k, u = -1..1 in steps of 1/us
  const M = 2 * us + 1
  const kr = new Float64Array(N * M), ki = new Float64Array(N * M)
  for (let k = 0; k < N; k++) {
    const kc = k < N / 2 ? k : k - N
    for (let m = 0; m < M; m++) {
      const ang = 2 * Math.PI * kc * (R + (m - us) / us) / N
      kr[k * M + m] = Math.cos(ang); ki[k * M + m] = Math.sin(ang)
    }
  }
  // rows: T[l][m] = Σ_k F[l][k] E[k][m]
  const tr = new Float64Array(N * M), ti = new Float64Array(N * M)
  for (let l = 0; l < N; l++) for (let k = 0; k < N; k++) {
    const fr = re[l * N + k], fi = im[l * N + k]
    if (fr === 0 && fi === 0) continue
    for (let m = 0; m < M; m++) {
      const er = kr[k * M + m], ei = ki[k * M + m]
      tr[l * M + m] += fr * er - fi * ei; ti[l * M + m] += fr * ei + fi * er
    }
  }
  // columns: out[n][m] = Re Σ_l T[l][m] E[l][n]
  const out = new Float64Array(M * M)
  for (let l = 0; l < N; l++) for (let n = 0; n < M; n++) {
    const er = kr[l * M + n], ei = ki[l * M + n]
    for (let m = 0; m < M; m++) out[n * M + m] += tr[l * M + m] * er - ti[l * M + m] * ei
  }
  let best = -Infinity, bi = 0
  for (let i = 0; i < out.length; i++) if (out[i] > best) { best = out[i]; bi = i }
  const bm = bi % M, bn = Math.floor(bi / M)
  let u = (bm - us) / us, v = (bn - us) / us
  if (bm > 0 && bm < M - 1) u += parabola(out[bn * M + bm - 1], best, out[bn * M + bm + 1]) / us
  if (bn > 0 && bn < M - 1) v += parabola(out[(bn - 1) * M + bm], best, out[(bn + 1) * M + bm]) / us
  return { dx: u, dy: v }
}

/** Flat-top (Tukey) window: 1 within ±R/2 of the centre, cosine taper to 0 at ±R. The flat part
 *  holds the whole correlation peak, so unlike a Hann window it does not pull the maximum toward
 *  the integer sample (a Hann window of this size shifted a 0.5 px peak of typical width to ~0.4). */
function tukey(u: number, R: number): number {
  const a = Math.abs(u)
  if (a <= R / 2) return 1
  if (a >= R) return 0
  return 0.5 * (1 + Math.cos(Math.PI * (a - R / 2) / (R / 2)))
}

/** Offset of the maximum of the parabola through (-1, l), (0, c), (1, r), clamped to ±0.5. */
function parabola(l: number, c: number, r: number): number {
  const den = l - 2 * c + r
  if (!(Math.abs(den) > 1e-12)) return 0
  return Math.max(-0.5, Math.min(0.5, 0.5 * (l - r) / den))
}

/** Crop the central fraction of an image (template for tracking; ±(1-frac)/2 of the FoV is trackable). */
export function centralCrop(g: Gray, frac = 0.5): Gray {
  const w = Math.floor(g.width * frac), h = Math.floor(g.height * frac)
  const x0 = Math.floor((g.width - w) / 2), y0 = Math.floor((g.height - h) / 2)
  const data = new Float32Array(w * h)
  for (let y = 0; y < h; y++) data.set(g.data.subarray((y0 + y) * g.width + x0, (y0 + y) * g.width + x0 + w), y * w)
  return { data, width: w, height: h }
}

/** Displacement of a full frame relative to a central-crop template taken from an earlier frame.
 *  Both are compared at the template size by cropping the image the same way, so the result is the
 *  shift of the scene between the two frames. */
export function trackFrame(template: Gray, frame: Gray, frac = 0.5): Displacement {
  return displacement(template, centralCrop(frame, frac))
}
