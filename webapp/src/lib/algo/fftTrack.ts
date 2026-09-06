/** Image displacement by high-pass-filtered FFT cross-correlation (port of camera-stage-mapping's
 *  fft_image_tracking). Both images are zero-meaned, zero-padded to 2x, high-pass filtered in the
 *  frequency domain (1 - Gaussian, sigma ~10 px), cross-correlated, and the peak located as the
 *  background-subtracted centre of mass of the region above 90 % of the correlation range. */

import { fft2d, nextPow2 } from './fft'
import type { Gray } from './sharpness'

export interface Displacement { dx: number; dy: number; peak: number; quality: number }

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
  // cross power: B * conj(A), weighted
  const re = new Float64Array(W * H), im = new Float64Array(W * H)
  for (let i = 0; i < re.length; i++) {
    const wgt = hp[i] * hp[i]
    re[i] = (b.re[i] * a.re[i] + b.im[i] * a.im[i]) * wgt
    im[i] = (b.im[i] * a.re[i] - b.re[i] * a.im[i]) * wgt
  }
  fft2d(re, im, W, H, true)
  // find peak
  let peak = -Infinity, min = Infinity, pi = 0
  for (let i = 0; i < re.length; i++) { if (re[i] > peak) { peak = re[i]; pi = i } if (re[i] < min) min = re[i] }
  const px = pi % W, py = Math.floor(pi / W)
  // centre of mass of the neighbourhood above 90 % of the range (background subtracted)
  const thr = min + 0.9 * (peak - min)
  let sx = 0, sy = 0, sw = 0, second = -Infinity
  for (let y = py - 5; y <= py + 5; y++) for (let x = px - 5; x <= px + 5; x++) {
    const xx = (x + W) % W, yy = (y + H) % H, v = re[yy * W + xx]
    if (v > thr) { const wgt = v - thr; sx += (x - px) * wgt; sy += (y - py) * wgt; sw += wgt }
  }
  // quality: ratio of peak to the highest value outside the peak neighbourhood
  for (let i = 0; i < re.length; i++) {
    const x = i % W, y = Math.floor(i / W)
    const ddx = Math.min(Math.abs(x - px), W - Math.abs(x - px)), ddy = Math.min(Math.abs(y - py), H - Math.abs(y - py))
    if ((ddx > 8 || ddy > 8) && re[i] > second) second = re[i]
  }
  let dx = px + (sw ? sx / sw : 0), dy = py + (sw ? sy / sw : 0)
  if (dx > W / 2) dx -= W
  if (dy > H / 2) dy -= H
  return { dx, dy, peak, quality: second > 0 ? peak / second : Infinity }
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
