/** Noise estimation and variance-stabilising transforms shared by `denoise.ts` and `pipeline.ts`.
 *
 *  `estimateSigmaMad` is the classic blind estimator (Donoho & Johnstone): the finest-scale diagonal
 *  wavelet subband of a natural image is dominated by noise (edges contribute comparatively little
 *  energy at that scale), so its median absolute deviation, scaled by 0.6745 (the MAD-to-sigma factor
 *  for a zero-mean Gaussian), is a robust estimate of the noise standard deviation. A single-level
 *  Haar transform is used for the HH (diagonal) subband: cheap, and the /2 normalisation below keeps
 *  its noise variance equal to the input's (see the unit test for the derivation).
 *
 *  `NoiseModel` describes the sensor's Poisson-Gaussian noise (shot noise ~ signal, plus a fixed read
 *  noise), estimated from `gain`/`black`/`white` in the RAW trailer (`rawdev.ts`, `rawfmt.py`) rather
 *  than blindly. `anscombe`/`anscombeInverse` implement the generalised Anscombe transform, which
 *  turns (approximately) signal-dependent Poisson-Gaussian noise into approximately unit-variance
 *  additive Gaussian noise so a Gaussian denoiser (wavelet, NLM, bilateral, guided) performs correctly
 *  across the whole dynamic range instead of over-smoothing highlights and under-smoothing shadows.
 *  The inverse uses the closed-form asymptotically-unbiased approximation from Mäkitalo & Foi (2011)
 *  rather than the naive algebraic inverse, which is biased at low counts. */

/** One level of a Haar transform's HH (diagonal detail) subband, on a `w`x`h` plane (odd trailing
 *  row/column, if any, is dropped — negligible for a large-enough plane). */
function haarHH(plane: Float32Array, w: number, h: number): Float32Array {
  const w2 = w >> 1, h2 = h >> 1
  const out = new Float32Array(Math.max(1, w2 * h2))
  if (w2 < 1 || h2 < 1) return out
  for (let y = 0; y < h2; y++) {
    const y0 = 2 * y, y1 = y0 + 1
    for (let x = 0; x < w2; x++) {
      const x0 = 2 * x, x1 = x0 + 1
      const a = plane[y0 * w + x0], b = plane[y0 * w + x1], c = plane[y1 * w + x0], d = plane[y1 * w + x1]
      out[y * w2 + x] = (a - b - c + d) / 2
    }
  }
  return out
}

/** Selects the `k`-th smallest element of `a` in place (Hoare-partition quickselect, O(n) average —
 *  no allocation, no full sort). `a` is reordered as a side effect; callers that still need the
 *  original order/values pass a disposable copy. */
function nthElement(a: Float32Array, k: number): number {
  let lo = 0, hi = a.length - 1
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1]
    let i = lo, j = hi
    while (i <= j) {
      while (a[i] < pivot) i++
      while (a[j] > pivot) j--
      if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j-- }
    }
    if (k <= j) hi = j
    else if (k >= i) lo = i
    else break
  }
  return a[k]
}

/** Median via `nthElement` (O(n) average, no sort/allocation beyond the caller's disposable copy). */
function medianInPlace(a: Float32Array): number {
  const n = a.length
  if (n === 0) return 0
  const mid = n >> 1
  const upper = nthElement(a, mid)
  if (n % 2 === 1) return upper
  // even length: nthElement(a, mid) leaves everything at indices < mid <= its value (Hoare
  // partition invariant), so the lower median is the max of that left partition.
  let lower = -Infinity
  for (let i = 0; i < mid; i++) if (a[i] > lower) lower = a[i]
  return (lower + upper) / 2
}

const MAX_MAD_SAMPLES = 65536

/** Deterministic strided subsample of `a` down to at most `maxN` elements (a fresh, disposable
 *  array): keeps the MAD estimate's cost bounded on large planes (e.g. 1640x1232 video frames) while
 *  staying within a few percent of the full-population estimate, since MAD is a population statistic
 *  that a uniform stride samples without bias. */
function strideSample(a: Float32Array, maxN: number): Float32Array {
  if (a.length <= maxN) return a.slice()
  const stride = Math.ceil(a.length / maxN)
  const n = Math.ceil(a.length / stride)
  const out = new Float32Array(n)
  for (let i = 0, j = 0; j < n; i += stride, j++) out[j] = a[i]
  return out
}

/** Blind noise-sigma estimate from the finest-level HH wavelet subband: MAD(HH)/0.6745. Operates in
 *  whatever units `plane` is in (0..1 float or 0..65535 etc.) — the caller scales as needed. The HH
 *  subband is strided down to at most `MAX_MAD_SAMPLES` coefficients before the (O(n), sort-free)
 *  median/MAD computation, so cost stays bounded on large planes (a full sort of a ~500k-element
 *  subband, as at 1640x1232, was the dominant cost of a video frame's temporal-denoise sigma refresh
 *  before this — see `TemporalDenoiser`, which now also only refreshes every few frames). */
export function estimateSigmaMad(plane: Float32Array, w: number, h: number): number {
  const hh = haarHH(plane, w, h)
  if (hh.length === 0) return 0
  const sample = strideSample(hh, MAX_MAD_SAMPLES)
  const m = medianInPlace(sample)
  const dev = new Float32Array(sample.length)
  for (let i = 0; i < sample.length; i++) dev[i] = Math.abs(sample[i] - m)
  return medianInPlace(dev) / 0.6745
}

/** Poisson-Gaussian noise model of the sensor, in DN (digital-number, 0..(white-black)) units.
 *  `gain` is DN variance per DN of signal above black (shot-noise slope, i.e. 1/analogue-gain in
 *  e-/DN terms folded together with photon-transfer slope); `readSigma` is the fixed read-noise
 *  standard deviation in DN at this gain. variance(DN) ≈ gain * (DN - black) + readSigma^2. */
export interface NoiseModel { gain: number; readSigma: number; black: number; white: number }

/** Sigma of the model at a given DN level (0..(white-black), i.e. already black-subtracted), useful
 *  for parameterising a denoiser without transforming through Anscombe (e.g. a quick per-tile sigma
 *  for the live-view temporal filter). */
export function sigmaFromModel(model: NoiseModel, meanLevel: number): number {
  const v = Math.max(0, model.gain * Math.max(0, meanLevel)) + model.readSigma * model.readSigma
  return Math.sqrt(v)
}

/** Generalised Anscombe transform. Writing `t = y/gain + readSigma^2/gain^2` (the read noise folded
 *  into an effective offset on the gain-normalised signal), `z = 2*sqrt(t + 3/8)` is exactly the
 *  classic unit-gain Anscombe transform of `t`, so it approximately stabilises variance to 1
 *  regardless of signal level. `plane` is assumed already black-subtracted (0..(white-black)). */
export function anscombe(plane: Float32Array, m: NoiseModel): Float32Array {
  const out = new Float32Array(plane.length)
  const g = Math.max(1e-9, m.gain), rs2 = m.readSigma * m.readSigma
  for (let i = 0; i < plane.length; i++) {
    const y = Math.max(0, plane[i])
    const t = y / g + rs2 / (g * g)
    out[i] = 2 * Math.sqrt(Math.max(0, t + 0.375))
  }
  return out
}

/** Exact unbiased inverse (closed-form asymptotic approximation, Mäkitalo & Foi 2011): for
 *  `z = 2*sqrt(t + 3/8)` this recovers an estimate of `t` that removes the small positive bias the
 *  naive algebraic inverse (`z^2/4 - 3/8`) leaves, especially at low photon counts; `t_hat` is then
 *  mapped back through the same gain/read-noise substitution used by `anscombe` to recover `y`. */
export function anscombeInverse(z: Float32Array, m: NoiseModel): Float32Array {
  const out = new Float32Array(z.length)
  const g = Math.max(1e-9, m.gain), rs2 = m.readSigma * m.readSigma
  const c1 = 0.25 * Math.sqrt(1.5), c3 = 1.25 * Math.sqrt(1.5)
  for (let i = 0; i < z.length; i++) {
    const D = Math.max(1e-6, z[i])
    const inv = 1 / D, inv2 = inv * inv, inv3 = inv2 * inv
    const tHat = (D * D) / 4 - 0.125 + c1 * inv - (11 / 8) * inv2 + c3 * inv3
    out[i] = Math.max(0, g * tHat - rs2 / g)
  }
  return out
}
