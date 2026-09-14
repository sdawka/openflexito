/** Deconvolution to recover the resolution a drizzled (or single) image lost to the imaging chain's
 *  point-spread function: a square "drop" convolution from drizzling itself (`pixfrac` wide, only
 *  relevant post-drizzle), the sensor's square pixel aperture (box the size of one physical pixel,
 *  in *output*-grid units so a drizzled 2x image has a 0.5-output-pixel aperture), and the optical
 *  blur of the microscope, approximated as a Gaussian of the objective's measured or assumed sigma.
 *  The combined PSF is the convolution of all three (each a small box or Gaussian; the FFT product
 *  of their individual transfer functions gives the same result without an explicit spatial
 *  convolution). Two classic estimators are provided:
 *
 *  - `wiener`: linear, one FFT pass, fast; trades a `noise` parameter against ringing/amplification.
 *  - `richardsonLucy`: iterative, non-linear, non-negativity-preserving; sharper for a well-known
 *    PSF and low noise but can ring or amplify noise if over-iterated on a noisy or wrong PSF.
 *
 *  Both operate on one linear-light greyscale (or single Bayer-plane) channel at a time; callers
 *  deconvolve R, G, B (or raw CFA planes) separately since the PSF here has no chromatic term. */

import { fft2d, nextPow2 } from './fft'

export interface PsfOptions {
  /** Drizzle drop half-width in *output*-pixel units (pixfrac/2 * scale used by that drizzle, 0 if
   *  the image was not drizzled). Modelled as a square box. */
  dropHalfWidth?: number
  /** Sensor pixel aperture half-width in output-pixel units (0.5 / scale for a plain drizzled image,
   *  i.e. one physical pixel maps to `scale` output pixels). Modelled as a square box. */
  apertureHalfWidth?: number
  /** Gaussian sigma (output pixels) of the residual optical blur (diffraction + any uncorrected
   *  aberration) not already accounted for by the box terms above. 0 disables it. */
  sigma?: number
}

/** Point-spread function on an `N`x`N` grid (must be a power of two, ≥ 16), centred, summing to 1:
 *  the product in frequency space of two centred boxes (drop, aperture) and a Gaussian, transformed
 *  back to the spatial domain and re-normalised (multiplying transfer functions is exact for boxes
 *  and Gaussians, since convolution of the underlying kernels is a product of their FTs). */
export function makePsf(N: number, opts: PsfOptions = {}): Float64Array {
  if (N & (N - 1)) throw new Error('makePsf: N must be a power of two')
  const half = N / 2
  const psf = new Float64Array(N * N)
  psf[0] = 1   // delta function: convolving with it (via the FFT product below) is the identity
  const re = new Float64Array(N * N), im = new Float64Array(N * N)
  for (let i = 0; i < re.length; i++) re[i] = psf[i]
  fft2d(re, im, N, N)
  const boxSinc = (k: number, w: number): number => { // FT of a centred box of half-width w, at frequency index k (cycles/N)
    if (w <= 0) return 1
    const f = k <= half ? k / N : (k - N) / N
    const x = 2 * Math.PI * f * w
    return Math.abs(x) < 1e-9 ? 1 : Math.sin(x) / x
  }
  const dh = opts.dropHalfWidth ?? 0, ah = opts.apertureHalfWidth ?? 0, sigma = opts.sigma ?? 0
  for (let y = 0; y < N; y++) {
    const wy = boxSinc(y, dh) * boxSinc(y, ah)
    const fy = y <= half ? y / N : (y - N) / N
    for (let x = 0; x < N; x++) {
      const wx = boxSinc(x, dh) * boxSinc(x, ah)
      const fx = x <= half ? x / N : (x - N) / N
      const gauss = sigma > 0 ? Math.exp(-2 * (Math.PI * sigma) ** 2 * (fx * fx + fy * fy)) : 1
      const w = wx * wy * gauss
      re[y * N + x] *= w; im[y * N + x] *= w
    }
  }
  fft2d(re, im, N, N, true)
  // re-centre (the delta was at (0,0), so the kernel now wraps around the corners) and renormalise
  const out = new Float64Array(N * N)
  let sum = 0
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const v = Math.max(0, re[y * N + x])
    const xc = (x + half) % N, yc = (y + half) % N
    out[yc * N + xc] = v
    sum += v
  }
  if (sum > 0) for (let i = 0; i < out.length; i++) out[i] /= sum
  return out
}

function toFreq(img: Float32Array, w: number, h: number, N: number): { re: Float64Array; im: Float64Array } {
  const re = new Float64Array(N * N), im = new Float64Array(N * N)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) re[y * N + x] = img[y * w + x]
  fft2d(re, im, N, N)
  return { re, im }
}

function psfFreq(psf: Float64Array, N: number): { re: Float64Array; im: Float64Array } {
  // psf is already N x N, centred at (N/2, N/2); shift to (0,0) before transforming so the FT phase
  // matches an unshifted spatial-domain convolution kernel
  const re = new Float64Array(N * N), im = new Float64Array(N * N)
  const half = N / 2
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) re[((y + half) % N) * N + (x + half) % N] = psf[y * N + x]
  fft2d(re, im, N, N)
  return { re, im }
}

/** Wiener deconvolution: `F = conj(H) / (|H|^2 + noise) * G` in frequency space, H the PSF's
 *  transform, G the (zero-padded) image's, `noise` the assumed noise-to-signal power ratio (larger
 *  = gentler, less ringing but less sharpening; a few percent of the signal's own power is a
 *  reasonable start, exposed to the caller rather than guessed since it is scene-dependent). */
export function wiener(img: { data: Float32Array; width: number; height: number }, psf: Float64Array, psfSize: number, noise = 0.01): Float32Array {
  const { width: w, height: h } = img
  const N = nextPow2(Math.max(w, h, psfSize))
  const g = toFreq(img.data, w, h, N)
  const H = psfFreq(psf.length === N * N ? psf : resizePsf(psf, psfSize, N), N)
  const re = new Float64Array(N * N), im = new Float64Array(N * N)
  for (let i = 0; i < re.length; i++) {
    const hr = H.re[i], hi = H.im[i], mag2 = hr * hr + hi * hi
    const denom = mag2 + noise
    // conj(H)/denom * G
    const cr = hr / denom, ci = -hi / denom
    re[i] = cr * g.re[i] - ci * g.im[i]
    im[i] = cr * g.im[i] + ci * g.re[i]
  }
  fft2d(re, im, N, N, true)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = Math.max(0, re[y * N + x])
  return out
}

/** Resize a PSF grid to another power-of-two size by re-deriving it isn't meaningful for an
 *  arbitrary kernel; `makePsf` should be called at the target size directly. This helper only pads
 *  (zero, PSF assumed to already fit) or centre-crops when the caller passes a mismatched size. */
function resizePsf(psf: Float64Array, from: number, to: number): Float64Array {
  if (from === to) return psf
  const out = new Float64Array(to * to)
  const halfFrom = from / 2, halfTo = to / 2
  const r = Math.min(halfFrom, halfTo)
  for (let y = -r; y < r; y++) for (let x = -r; x < r; x++) {
    out[((y + halfTo + to) % to) * to + (x + halfTo + to) % to] = psf[((y + halfFrom + from) % from) * from + (x + halfFrom + from) % from]
  }
  let sum = 0; for (const v of out) sum += v
  if (sum > 0) for (let i = 0; i < out.length; i++) out[i] /= sum
  return out
}

/** Circular (FFT-based) convolution of an image with a PSF the same padded size, used internally by
 *  Richardson-Lucy's forward-model step and exposed for tests. */
function convolveFft(data: Float64Array, N: number, H: { re: Float64Array; im: Float64Array }): Float64Array {
  const re = new Float64Array(N * N), im = new Float64Array(N * N)
  re.set(data)
  fft2d(re, im, N, N)
  const or_ = new Float64Array(N * N), oi = new Float64Array(N * N)
  for (let i = 0; i < re.length; i++) { or_[i] = re[i] * H.re[i] - im[i] * H.im[i]; oi[i] = re[i] * H.im[i] + im[i] * H.re[i] }
  fft2d(or_, oi, N, N, true)
  return or_
}

/** Richardson-Lucy deconvolution (Poisson-noise-appropriate multiplicative update):
 *  `u ← u * (H^T * (g / (H * u))) `, H^T the PSF mirrored (its conjugate in frequency space).
 *  Non-negative by construction; `iterations` trades sharpening against noise amplification and
 *  ringing (5-15 is typical for a well-estimated PSF; more rings on real data). */
export function richardsonLucy(img: { data: Float32Array; width: number; height: number }, psf: Float64Array, psfSize: number, iterations = 10): Float32Array {
  const { width: w, height: h } = img
  const N = nextPow2(Math.max(w, h, psfSize))
  const g = new Float64Array(N * N)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[y * N + x] = Math.max(1e-6, img.data[y * w + x])
  const H = psfFreq(psf.length === N * N ? psf : resizePsf(psf, psfSize, N), N)
  const Ht = { re: H.re, im: new Float64Array(N * N) }
  for (let i = 0; i < Ht.im.length; i++) Ht.im[i] = -H.im[i]   // conjugate = flipped kernel
  let u = new Float64Array(N * N)
  u.set(g)
  for (let it = 0; it < iterations; it++) {
    const hu = convolveFft(u, N, H)
    const ratio = new Float64Array(N * N)
    for (let i = 0; i < ratio.length; i++) ratio[i] = g[i] / Math.max(1e-6, hu[i])
    const back = convolveFft(ratio, N, Ht)
    for (let i = 0; i < u.length; i++) u[i] = Math.max(0, u[i] * back[i])
  }
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = u[y * N + x]
  return out
}
