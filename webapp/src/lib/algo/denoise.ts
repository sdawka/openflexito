/** Classical, dependency-free spatial denoisers (`docs/image-pipeline/design.md` WP3). Everything
 *  operates on a `Plane` (re-exported from `exposureFuse.ts` so callers share one type across algo
 *  files). Border handling is reflect-101 (mirrored without repeating the edge sample) throughout, so
 *  no filter darkens or brightens the image border the way a zero-padded convolution would.
 *
 *  `boxFilter`/`gaussianBlur` are the shared O(n) building blocks (separable, running-sum / truncated
 *  kernel) used by `guidedFilter` (He et al. 2010), `bilateral` (Tomasi & Manduchi 1998, direct small
 *  radius), `waveletShrink` (3-level orthogonal Daubechies-4 DWT, BayesShrink/SURE/soft thresholding)
 *  and `nlmFast` (integral-image Non-Local Means, Buades et al. 2005 / Darbon et al. 2008 speedup).
 *  `denoisePlane`/`denoiseRgb` dispatch by `DenoiseParams.method`; `denoiseRgb` denoises luma and
 *  chroma separately in YCbCr so chroma can be smoothed harder without softening edges (guided by the
 *  denoised luma). The `Denoiser` interface + registry let a future ONNX-backed denoiser register
 *  itself under a new `method` name without callers changing (no learned denoiser ships yet: no
 *  verified GPL-compatible ONNX weights with a stable Hugging Face id as of this writing). */

import type { Plane } from './exposureFuse'
import { estimateSigmaMad } from './noise'

export type { Plane }

// ---------------------------------------------------------------------------------------------
// Border handling + separable box/Gaussian filters (shared building blocks)
// ---------------------------------------------------------------------------------------------

/** Reflect-101 index into [0, n): mirrors repeatedly without duplicating the edge sample, robust to
 *  `i` arbitrarily far outside the range (needed when a filter radius exceeds the plane size, e.g. in
 *  small unit-test images). */
function reflect(i: number, n: number): number {
  if (n <= 1) return 0
  const period = 2 * (n - 1)
  let m = ((i % period) + period) % period
  return m >= n ? period - m : m
}

/** Separable box (mean) filter via a running sum: O(w*h) regardless of radius. */
export function boxFilter(p: Plane, radius: number): Plane {
  const { data, width: w, height: h } = p
  if (radius <= 0) return { data: data.slice(), width: w, height: h }
  const win = 2 * radius + 1
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    let sum = 0
    for (let k = -radius; k <= radius; k++) sum += data[row + reflect(k, w)]
    tmp[row] = sum / win
    for (let x = 1; x < w; x++) {
      sum += data[row + reflect(x + radius, w)] - data[row + reflect(x - radius - 1, w)]
      tmp[row + x] = sum / win
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let k = -radius; k <= radius; k++) sum += tmp[reflect(k, h) * w + x]
    out[x] = sum / win
    for (let y = 1; y < h; y++) {
      sum += tmp[reflect(y + radius, h) * w + x] - tmp[reflect(y - radius - 1, h) * w + x]
      out[y * w + x] = sum / win
    }
  }
  return { data: out, width: w, height: h }
}

/** Separable Gaussian blur, kernel truncated at 3σ, reflect-101 borders. */
export function gaussianBlur(p: Plane, sigma: number): Plane {
  const { data, width: w, height: h } = p
  if (sigma <= 0) return { data: data.slice(), width: w, height: h }
  const radius = Math.max(1, Math.ceil(sigma * 3))
  const kernel = new Float32Array(2 * radius + 1)
  let ksum = 0
  for (let i = -radius; i <= radius; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); kernel[i + radius] = v; ksum += v }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= ksum
  const tmp = new Float32Array(w * h)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) {
      let s = 0
      for (let k = -radius; k <= radius; k++) s += data[row + reflect(x + k, w)] * kernel[k + radius]
      tmp[row + x] = s
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let s = 0
      for (let k = -radius; k <= radius; k++) s += tmp[reflect(y + k, h) * w + x] * kernel[k + radius]
      out[y * w + x] = s
    }
  }
  return { data: out, width: w, height: h }
}

// ---------------------------------------------------------------------------------------------
// Guided filter (He, Sun, Tang 2010) — box filters only, O(n)
// ---------------------------------------------------------------------------------------------

/** Edge-aware filter of `p` guided by `guide` (may be `p` itself for self-guided smoothing): fits a
 *  local linear model `q = a*guide + b` per `radius`-window (via box-filtered moments) so output edges
 *  track the guide's edges. `eps` trades smoothing (large eps -> plain box filter of `p`) against
 *  edge fidelity (eps -> 0 keeps edges present in `guide`; when `guide === p` the filter tends to the
 *  identity as eps -> 0, since the local linear fit becomes exact). */
export function guidedFilter(p: Plane, guide: Plane, radius: number, eps: number): Plane {
  const { width: w, height: h } = p
  const n = w * h
  const I = guide.data, P = p.data
  const II = new Float32Array(n), IP = new Float32Array(n)
  for (let i = 0; i < n; i++) { II[i] = I[i] * I[i]; IP[i] = I[i] * P[i] }
  const meanI = boxFilter({ data: I, width: w, height: h }, radius).data
  const meanP = boxFilter({ data: P, width: w, height: h }, radius).data
  const corrI = boxFilter({ data: II, width: w, height: h }, radius).data
  const corrIP = boxFilter({ data: IP, width: w, height: h }, radius).data
  const a = new Float32Array(n), b = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const varI = corrI[i] - meanI[i] * meanI[i]
    const covIP = corrIP[i] - meanI[i] * meanP[i]
    const ai = covIP / (varI + eps)
    a[i] = ai
    b[i] = meanP[i] - ai * meanI[i]
  }
  const meanA = boxFilter({ data: a, width: w, height: h }, radius).data
  const meanB = boxFilter({ data: b, width: w, height: h }, radius).data
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = meanA[i] * I[i] + meanB[i]
  return { data: out, width: w, height: h }
}

// ---------------------------------------------------------------------------------------------
// Bilateral filter (Tomasi & Manduchi 1998) — direct, small radius
// ---------------------------------------------------------------------------------------------

/** Direct bilateral filter: spatial Gaussian (σs) x range Gaussian (σr, in the plane's own units).
 *  O(w*h*radius^2); radius derived from σs (2σs), so keep σs small (this is the "small radius" tier —
 *  use `guidedFilter` for a linear-time edge-aware smooth at larger scales). */
export function bilateral(p: Plane, sigmaS: number, sigmaR: number): Plane {
  const { data, width: w, height: h } = p
  const radius = Math.max(1, Math.ceil(sigmaS * 2))
  const out = new Float32Array(w * h)
  const twoSigS2 = 2 * sigmaS * sigmaS
  const twoSigR2 = Math.max(1e-9, 2 * sigmaR * sigmaR)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = data[y * w + x]
      let sum = 0, wsum = 0
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = reflect(y + dy, h)
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = reflect(x + dx, w)
          const v = data[yy * w + xx]
          const ds = dx * dx + dy * dy
          const dr = v - c
          const wgt = Math.exp(-ds / twoSigS2 - (dr * dr) / twoSigR2)
          sum += wgt * v; wsum += wgt
        }
      }
      out[y * w + x] = wsum > 0 ? sum / wsum : c
    }
  }
  return { data: out, width: w, height: h }
}

// ---------------------------------------------------------------------------------------------
// Wavelet shrinkage: 3-level orthogonal Daubechies-4 DWT, periodic extension, BayesShrink/SURE/soft
// ---------------------------------------------------------------------------------------------

// Standard normalised Daubechies-4 (db2, 4-tap) analysis low-pass; sum(h^2)=1, sum(h)=sqrt(2).
const H4 = [
  (1 + Math.sqrt(3)) / (4 * Math.SQRT2),
  (3 + Math.sqrt(3)) / (4 * Math.SQRT2),
  (3 - Math.sqrt(3)) / (4 * Math.SQRT2),
  (1 - Math.sqrt(3)) / (4 * Math.SQRT2),
]
// QMF high-pass: g[n] = (-1)^n * h[3-n]; orthonormal to h and to its own even translates, so the
// reconstruction below (same filters, no time-reversal — see derivation in the module's tests) gives
// exact (to floating-point) perfect reconstruction with periodic wrap-around indexing.
const G4 = [H4[3], -H4[2], H4[1], -H4[0]]

function dwtAxis(p: Plane, axis: 'x' | 'y'): { lo: Plane; hi: Plane } {
  const { data, width: w, height: h } = p
  if (axis === 'x') {
    const w2 = w >> 1
    const lo = new Float32Array(w2 * h), hi = new Float32Array(w2 * h)
    for (let y = 0; y < h; y++) {
      const row = y * w
      for (let i = 0; i < w2; i++) {
        let a = 0, d = 0
        for (let k = 0; k < 4; k++) { const v = data[row + ((2 * i + k) % w)]; a += H4[k] * v; d += G4[k] * v }
        lo[y * w2 + i] = a; hi[y * w2 + i] = d
      }
    }
    return { lo: { data: lo, width: w2, height: h }, hi: { data: hi, width: w2, height: h } }
  }
  const h2 = h >> 1
  const lo = new Float32Array(w * h2), hi = new Float32Array(w * h2)
  for (let x = 0; x < w; x++) {
    for (let i = 0; i < h2; i++) {
      let a = 0, d = 0
      for (let k = 0; k < 4; k++) { const v = data[((2 * i + k) % h) * w + x]; a += H4[k] * v; d += G4[k] * v }
      lo[i * w + x] = a; hi[i * w + x] = d
    }
  }
  return { lo: { data: lo, width: w, height: h2 }, hi: { data: hi, width: w, height: h2 } }
}

function idwtAxis(lo: Plane, hi: Plane, axis: 'x' | 'y'): Plane {
  if (axis === 'x') {
    const w2 = lo.width, h = lo.height, w = w2 * 2
    const out = new Float32Array(w * h)
    for (let y = 0; y < h; y++) {
      const row = y * w
      for (let i = 0; i < w2; i++) {
        const a = lo.data[y * w2 + i], d = hi.data[y * w2 + i]
        for (let k = 0; k < 4; k++) out[row + ((2 * i + k) % w)] += H4[k] * a + G4[k] * d
      }
    }
    return { data: out, width: w, height: h }
  }
  const h2 = lo.height, w = lo.width, h = h2 * 2
  const out = new Float32Array(w * h)
  for (let x = 0; x < w; x++) {
    for (let i = 0; i < h2; i++) {
      const a = lo.data[i * w + x], d = hi.data[i * w + x]
      for (let k = 0; k < 4; k++) out[((2 * i + k) % h) * w + x] += H4[k] * a + G4[k] * d
    }
  }
  return { data: out, width: w, height: h }
}

function dwt2d(p: Plane): { ll: Plane; lh: Plane; hl: Plane; hh: Plane } {
  const { lo: L, hi: H } = dwtAxis(p, 'x')
  const l = dwtAxis(L, 'y'), hb = dwtAxis(H, 'y')
  return { ll: l.lo, lh: l.hi, hl: hb.lo, hh: hb.hi }
}
function idwt2d(b: { ll: Plane; lh: Plane; hl: Plane; hh: Plane }): Plane {
  const L = idwtAxis(b.ll, b.lh, 'y')
  const H = idwtAxis(b.hl, b.hh, 'y')
  return idwtAxis(L, H, 'x')
}

function padToMultiple(p: Plane, mult: number): Plane {
  const w2 = Math.ceil(p.width / mult) * mult, h2 = Math.ceil(p.height / mult) * mult
  if (w2 === p.width && h2 === p.height) return p
  const out = new Float32Array(w2 * h2)
  for (let y = 0; y < h2; y++) {
    const sy = Math.min(p.height - 1, y)
    for (let x = 0; x < w2; x++) out[y * w2 + x] = p.data[sy * p.width + Math.min(p.width - 1, x)]
  }
  return { data: out, width: w2, height: h2 }
}
function cropTo(p: Plane, w: number, h: number): Plane {
  if (p.width === w && p.height === h) return p
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[y * w + x] = p.data[y * p.width + x]
  return { data: out, width: w, height: h }
}

type DetailBand = { lh: Plane; hl: Plane; hh: Plane }

function waveletDecompose(p: Plane, levels: number): { details: DetailBand[]; ll: Plane } {
  let cur = p
  const details: DetailBand[] = []
  for (let l = 0; l < levels; l++) {
    const b = dwt2d(cur)
    details.push({ lh: b.lh, hl: b.hl, hh: b.hh })
    cur = b.ll
  }
  return { details, ll: cur }
}
function waveletReconstruct(ll: Plane, details: DetailBand[]): Plane {
  let cur = ll
  for (let l = details.length - 1; l >= 0; l--) cur = idwt2d({ ll: cur, lh: details[l].lh, hl: details[l].hl, hh: details[l].hh })
  return cur
}

function softThreshold(data: Float32Array, t: number): Float32Array {
  const out = new Float32Array(data.length)
  for (let i = 0; i < data.length; i++) { const v = data[i], a = Math.abs(v); out[i] = a > t ? Math.sign(v) * (a - t) : 0 }
  return out
}

/** BayesShrink threshold: τ = σ_n² / σ_x, σ_x = sqrt(max(0, var(subband) − σ_n²)) (Chang, Yu, Vetterli
 *  2000). Falls back to the subband's max magnitude (threshold everything) when the estimated signal
 *  variance is ~0 (pure-noise subband). */
function bayesThreshold(subband: Float32Array, sigmaN: number): number {
  let s = 0
  for (const v of subband) s += v * v
  const varX = s / Math.max(1, subband.length)
  const sigmaX2 = Math.max(0, varX - sigmaN * sigmaN)
  const sigmaX = Math.sqrt(sigmaX2)
  if (sigmaX > 1e-9) return (sigmaN * sigmaN) / sigmaX
  let mx = 0
  for (const v of subband) mx = Math.max(mx, Math.abs(v))
  return mx
}

/** SURE (Stein's Unbiased Risk Estimate) threshold, exact grid search over the sorted |coefficients|
 *  (Donoho & Johnstone 1995 / Luisier et al. 2007): minimises the closed-form SURE risk for soft
 *  thresholding, `n·σ² − 2σ²·#{|x|≤t} + Σ min(x_i², t²)`, without needing ground truth. */
function sureThreshold(subband: Float32Array, sigmaN: number): number {
  const n = subband.length
  if (n === 0) return 0
  const absSorted = Float32Array.from(subband, Math.abs).sort()
  const sq = Float32Array.from(absSorted, (v) => v * v)
  const cumSq = new Float64Array(n)
  let cum = 0
  for (let i = 0; i < n; i++) { cum += sq[i]; cumSq[i] = cum }
  const sigma2 = sigmaN * sigmaN
  let bestT = 0, bestRisk = Infinity
  for (let i = 0; i < n; i++) {
    const t = absSorted[i]
    const numBelow = i + 1
    const risk = n * sigma2 - 2 * sigma2 * numBelow + cumSq[i] + (n - numBelow) * t * t
    if (risk < bestRisk) { bestRisk = risk; bestT = t }
  }
  return bestT
}

/** 3-level (default) 2D orthogonal wavelet shrinkage. Pads to a multiple of 2^levels (edge
 *  replication) so every level halves exactly, decomposes with periodic-extension Daubechies-4,
 *  soft-thresholds each detail subband at every level (rule default `bayes`), reconstructs, crops
 *  back to the input size. `sigma` is the estimated noise standard deviation in the plane's own
 *  units; the same value is used at every level (a standard, cheap approximation — see BayesShrink
 *  usage in practice — rather than re-estimating σ per level). */
export function waveletShrink(p: Plane, sigma: number, o?: { levels?: number; rule?: 'bayes' | 'sure' | 'soft' }): Plane {
  const levels = Math.max(1, o?.levels ?? 3)
  const rule = o?.rule ?? 'bayes'
  const padded = padToMultiple(p, 1 << levels)
  const { details, ll } = waveletDecompose(padded, levels)
  const shrunk = details.map((d) => {
    const shrinkBand = (b: Plane): Plane => {
      const t = rule === 'soft' ? sigma : rule === 'sure' ? sureThreshold(b.data, sigma) : bayesThreshold(b.data, sigma)
      return { data: softThreshold(b.data, t), width: b.width, height: b.height }
    }
    return { lh: shrinkBand(d.lh), hl: shrinkBand(d.hl), hh: shrinkBand(d.hh) }
  })
  const rec = waveletReconstruct(ll, shrunk)
  return cropTo(rec, p.width, p.height)
}

// ---------------------------------------------------------------------------------------------
// Non-Local Means (integral-image speedup)
// ---------------------------------------------------------------------------------------------

function shiftReflect(data: Float32Array, w: number, h: number, dx: number, dy: number): Float32Array {
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const sy = reflect(y + dy, h)
    for (let x = 0; x < w; x++) out[y * w + x] = data[sy * w + reflect(x + dx, w)]
  }
  return out
}

/** Integral-image NLM (Darbon et al. 2008 speedup of Buades et al. 2005): for every offset in the
 *  `search`x`search` window, box-filter the squared difference image (patch radius `patch`) to get
 *  each pixel's patch distance to that shifted neighbourhood in O(1) amortised time, then accumulate
 *  `exp(-max(d-2σ², 0)/h²)`-weighted neighbours. `h` (filter strength) defaults to `sigma`, scaled by
 *  the caller through `params.strength` before calling (see `denoisePlane`). */
export function nlmFast(p: Plane, sigma: number, o?: { patch?: number; search?: number; h?: number }): Plane {
  const { data, width: w, height: h } = p
  const patch = o?.patch ?? 3
  const search = o?.search ?? 10
  const hParam = Math.max(1e-6, o?.h ?? sigma)
  const n = w * h
  const acc = new Float64Array(n), wsum = new Float64Array(n)
  const h2 = hParam * hParam
  const twoSigma2 = 2 * sigma * sigma
  for (let dy = -search; dy <= search; dy++) {
    for (let dx = -search; dx <= search; dx++) {
      const shifted = shiftReflect(data, w, h, dx, dy)
      const diff = new Float32Array(n)
      for (let i = 0; i < n; i++) { const d = data[i] - shifted[i]; diff[i] = d * d }
      const dAvg = boxFilter({ data: diff, width: w, height: h }, patch).data
      for (let i = 0; i < n; i++) {
        const dm = Math.max(0, dAvg[i] - twoSigma2)
        const wgt = Math.exp(-dm / h2)
        acc[i] += wgt * shifted[i]; wsum[i] += wgt
      }
    }
  }
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = wsum[i] > 1e-12 ? acc[i] / wsum[i] : data[i]
  return { data: out, width: w, height: h }
}

// ---------------------------------------------------------------------------------------------
// Dispatch, RGB (YCbCr split), Denoiser registry
// ---------------------------------------------------------------------------------------------

export type DenoiseMethod = 'wavelet' | 'nlm' | 'guided' | 'bilateral' | 'none'
export interface DenoiseParams {
  method: DenoiseMethod
  /** 0..2, scales `sigma` (estimate or override) before it reaches the chosen method. */
  strength: number
  /** Absolute sigma override in the plane's own units (0..1 for float planes); undefined = estimate. */
  sigma?: number
  /** Extra chroma smoothing, 0..1 (denoiseRgb only). */
  chroma: number
  patch?: number
  search?: number
}

/** Dispatches to the method named in `params.method`. `sigma` is the base (estimated or supplied)
 *  noise sigma; the effective sigma passed to the method is `(params.sigma ?? sigma) * params.strength`. */
export function denoisePlane(p: Plane, params: DenoiseParams, sigma: number): Plane {
  const base = params.sigma ?? sigma
  const s = Math.max(0, base * Math.max(0, params.strength))
  switch (params.method) {
    case 'wavelet': return waveletShrink(p, s)
    case 'nlm': return nlmFast(p, s, { patch: params.patch, search: params.search })
    case 'guided': return guidedFilter(p, p, params.patch ?? 4, Math.max(1e-6, s * s))
    case 'bilateral': return bilateral(p, params.patch ?? 2, Math.max(1e-6, s))
    case 'none':
    default: return { data: p.data.slice(), width: p.width, height: p.height }
  }
}

// Minimal local YCbCr helpers (Rec.601-style, 0..1 float) to avoid a circular import with
// enhance.ts, which exports the public rgbToYcbcr/ycbcrToRgb with the same formulas.
function toY(r: number, g: number, b: number): number { return 0.299 * r + 0.587 * g + 0.114 * b }
function toCb(r: number, g: number, b: number): number { return -0.168736 * r - 0.331264 * g + 0.5 * b }
function toCr(r: number, g: number, b: number): number { return 0.5 * r - 0.418688 * g - 0.081312 * b }

/** Denoises luma and chroma (YCbCr) separately: luma via `denoisePlane` with `params`, chroma via a
 *  guided filter driven by the *denoised* luma (radius 4..8, eps from `params.chroma`) so chroma noise
 *  and MJPEG 4:2:0 blockiness are smoothed harder without softening luminance edges. */
export function denoiseRgb(planes: { r: Plane; g: Plane; b: Plane }, params: DenoiseParams, sigmaHint?: number): { r: Plane; g: Plane; b: Plane } {
  const { r, g, b } = planes
  const n = r.width * r.height
  const y = new Float32Array(n), cb = new Float32Array(n), cr = new Float32Array(n)
  for (let i = 0; i < n; i++) { y[i] = toY(r.data[i], g.data[i], b.data[i]); cb[i] = toCb(r.data[i], g.data[i], b.data[i]); cr[i] = toCr(r.data[i], g.data[i], b.data[i]) }
  const yPlane: Plane = { data: y, width: r.width, height: r.height }
  const sigma = sigmaHint ?? estimateSigmaMad(y, r.width, r.height)
  const yD = denoisePlane(yPlane, params, sigma)
  const chromaStrength = Math.max(0, Math.min(1, params.chroma))
  const radius = Math.round(4 + 4 * chromaStrength)
  const eps = Math.max(1e-6, 0.02 + 0.2 * chromaStrength)
  const cbPlane: Plane = { data: cb, width: r.width, height: r.height }
  const crPlane: Plane = { data: cr, width: r.width, height: r.height }
  const cbD = chromaStrength > 0 ? guidedFilter(cbPlane, yD, radius, eps) : cbPlane
  const crD = chromaStrength > 0 ? guidedFilter(crPlane, yD, radius, eps) : crPlane
  const outR = new Float32Array(n), outG = new Float32Array(n), outB = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const Y = yD.data[i], Cb = cbD.data[i], Cr = crD.data[i]
    outR[i] = Y + 1.402 * Cr
    outG[i] = Y - 0.344136 * Cb - 0.714136 * Cr
    outB[i] = Y + 1.772 * Cb
  }
  return {
    r: { data: outR, width: r.width, height: r.height },
    g: { data: outG, width: r.width, height: r.height },
    b: { data: outB, width: r.width, height: r.height },
  }
}

/** Pluggable denoiser registry: `denoiseRgb`/`denoisePlane` above register as `'classical'`; a future
 *  ONNX-backed denoiser can `registerDenoiser({ name: 'onnx-xyz', run })` without callers changing. */
export interface Denoiser {
  name: string
  run(planes: { r: Plane; g: Plane; b: Plane }, params: DenoiseParams, sigma: number): { r: Plane; g: Plane; b: Plane }
}
const registry = new Map<string, Denoiser>()
export function registerDenoiser(d: Denoiser): void { registry.set(d.name, d) }
export function getDenoiser(name: string): Denoiser | undefined { return registry.get(name) }
export function listDenoisers(): string[] { return Array.from(registry.keys()) }
registerDenoiser({ name: 'classical', run: (planes, params, sigma) => denoiseRgb(planes, params, sigma) })
