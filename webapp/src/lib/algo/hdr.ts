/** True HDR from linear RAW frames: frames developed to linear RGB (1.0 = sensor saturation) at known
 *  relative exposures are merged into a radiance map (Debevec & Malik 1997 with a hat weighting that
 *  trusts mid-range samples and discards clipped ones), then tone mapped for display: global Reinhard
 *  (2002) or Mertens fusion of the radiance re-exposed at several stops (`exposureFuse.ts`). Radiance
 *  is in the units of the reference exposure (ratio 1), so a pixel that reads 0.4 in the reference
 *  frame has radiance 0.4 and a pixel clipped there but reading 0.6 at a quarter of the exposure has
 *  radiance 2.4. Exposure ratios come from ExposureTime when the camera was bracketed, or from the
 *  measured mean level (`exposureRatiosFromMeans`) when the LED was varied instead. */

import { interleavedToPlanes, mertensFusePlanes, planesToInterleaved, type MertensOptions } from './exposureFuse'

export interface HdrFrame {
  /** interleaved linear RGB, 1.0 = saturation (rawdev.developLinear without highlight desaturation) */
  data: Float32Array
  /** exposure relative to the reference frame (ExposureTime ratio, or measured brightness ratio) */
  exposure: number
}

export interface MergeOptions {
  /** values at or above this (in any channel) count as clipped (default 0.97) */
  satLevel?: number
  /** values below this are too noisy to trust unless nothing better exists (default 0.002) */
  floor?: number
}

/** Hat weight on the brightest channel: 0 at black and at saturation, 1 at mid grey. */
export function hatWeight(z: number, satLevel: number): number {
  if (z >= satLevel || z <= 0) return 0
  const zn = z / satLevel
  return zn <= 0.5 ? 2 * zn : 2 * (1 - zn)
}

/** Merge to radiance (interleaved float RGB). Pixels clipped in every frame take the shortest
 *  exposure's estimate; pixels black in every frame take the longest exposure's. */
export function mergeHdr(frames: HdrFrame[], width: number, height: number, o: MergeOptions = {}): Float32Array {
  if (!frames.length) throw new Error('mergeHdr: no frames')
  const sat = o.satLevel ?? 0.97, floor = o.floor ?? 0.002
  const n = width * height
  for (const f of frames) if (f.data.length !== n * 3) throw new Error('mergeHdr: frame size mismatch')
  const out = new Float32Array(n * 3)
  const byExposure = frames.map((f, i) => i).sort((a, b) => frames[a].exposure - frames[b].exposure)
  const shortest = byExposure[0], longest = byExposure[byExposure.length - 1]
  for (let i = 0; i < n; i++) {
    const p = i * 3
    let wr = 0, wg = 0, wb = 0, ws = 0
    let anySat = false
    for (const f of frames) {
      const r = f.data[p], g = f.data[p + 1], b = f.data[p + 2]
      const mx = Math.max(r, g, b)
      if (mx >= sat) { anySat = true; continue }
      let w = hatWeight(mx, sat)
      if (mx < floor) w *= mx / floor   // fade out the noise floor rather than a hard cut
      if (w <= 0) continue
      const inv = 1 / f.exposure
      wr += w * r * inv; wg += w * g * inv; wb += w * b * inv; ws += w
    }
    if (ws > 0) { out[p] = wr / ws; out[p + 1] = wg / ws; out[p + 2] = wb / ws; continue }
    // fallback: everything clipped -> shortest exposure; everything black -> longest exposure
    const f = frames[anySat ? shortest : longest], inv = 1 / f.exposure
    out[p] = f.data[p] * inv; out[p + 1] = f.data[p + 1] * inv; out[p + 2] = f.data[p + 2] * inv
  }
  return out
}

/** Relative exposure of each frame from its brightness against the reference frame: the median of
 *  the per-pixel ratios over pixels that are neither clipped nor near black in both frames (sampled).
 *  For LED brackets, where the ratio is only nominally the current ratio. */
export function exposureRatiosFromMeans(frames: Float32Array[], reference = 0, o: { satLevel?: number; floor?: number; samples?: number } = {}): number[] {
  const sat = o.satLevel ?? 0.9, floor = o.floor ?? 0.02, samples = o.samples ?? 20000
  const ref = frames[reference]
  const step = Math.max(1, Math.floor(ref.length / samples))
  return frames.map((f, k) => {
    if (k === reference) return 1
    const ratios: number[] = []
    for (let i = 0; i < f.length; i += step) {
      const a = ref[i], b = f[i]
      if (a > floor && a < sat && b > floor && b < sat) ratios.push(b / a)
    }
    if (!ratios.length) return NaN
    ratios.sort((x, y) => x - y)
    return ratios[ratios.length >> 1]
  })
}

/** Luminance of interleaved RGB. */
const lum = (d: Float32Array, p: number) => 0.2126 * d[p] + 0.7152 * d[p + 1] + 0.0722 * d[p + 2]

export interface ReinhardOptions {
  key?: number        // target log-average luminance (default 0.18)
  whitePercentile?: number   // luminance mapped to white (default 99.9th percentile of scaled L)
}

/** Global Reinhard tone map on radiance: L' = a·L/L̄, Ld = L'(1 + L'/Lw²)/(1 + L'); colour scaled by
 *  Ld/L so hue is kept. Output is linear display-referred RGB in 0..1 (apply a transfer curve after). */
export function toneMapReinhard(radiance: Float32Array, width: number, height: number, o: ReinhardOptions = {}): Float32Array {
  const n = width * height, key = o.key ?? 0.18, delta = 1e-4
  let logSum = 0
  const L = new Float32Array(n)
  for (let i = 0; i < n; i++) { L[i] = lum(radiance, i * 3); logSum += Math.log(delta + L[i]) }
  const lAvg = Math.exp(logSum / n)
  const scale = key / Math.max(1e-9, lAvg)
  // white point: percentile of scaled luminance (sampled)
  const step = Math.max(1, Math.floor(n / 200000))
  const sample: number[] = []
  for (let i = 0; i < n; i += step) sample.push(L[i] * scale)
  sample.sort((a, b) => a - b)
  const pct = o.whitePercentile ?? 99.9
  const lWhite = Math.max(1, sample[Math.min(sample.length - 1, Math.floor((pct / 100) * (sample.length - 1)))])
  const lw2 = lWhite * lWhite
  const out = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    const p = i * 3, ls = L[i] * scale
    if (L[i] <= 0) continue
    const ld = (ls * (1 + ls / lw2)) / (1 + ls)
    const s = ld / L[i]
    out[p] = Math.min(1, radiance[p] * s); out[p + 1] = Math.min(1, radiance[p + 1] * s); out[p + 2] = Math.min(1, radiance[p + 2] * s)
  }
  return out
}

/** Mertens-fuse the radiance re-exposed at several stops (each clipped to 0..1 in display gamma space
 *  so the well-exposedness term is meaningful), then return linear display-referred RGB in 0..1. */
export function toneMapMertens(radiance: Float32Array, width: number, height: number, stops: number[] = [-2, 0, 2], o: MertensOptions = {}): Float32Array {
  const n = width * height
  // normalise so the reference exposure (stop 0) puts the log-average luminance at mid grey
  let logSum = 0
  for (let i = 0; i < n; i++) logSum += Math.log(1e-4 + lum(radiance, i * 3))
  const scale0 = 0.18 / Math.max(1e-9, Math.exp(logSum / n))
  const gam = (v: number) => (v <= 0 ? 0 : v >= 1 ? 1 : Math.pow(v, 1 / 2.2))
  const exposures = stops.map((s) => {
    const k = scale0 * Math.pow(2, s)
    const d = new Float32Array(n * 3)
    for (let i = 0; i < d.length; i++) d[i] = gam(radiance[i] * k)
    return interleavedToPlanes(d, width, height)
  })
  const fused = planesToInterleaved(mertensFusePlanes(exposures, o))
  for (let i = 0; i < fused.length; i++) fused[i] = Math.pow(fused[i], 2.2)   // back to linear for the encoder's curve
  return fused
}

/** Dynamic range (stops) covered by the radiance map between the 0.1th and 99.9th percentiles. */
export function dynamicRangeStops(radiance: Float32Array): number {
  const n = radiance.length / 3, step = Math.max(1, Math.floor(n / 200000))
  const s: number[] = []
  for (let i = 0; i < n; i += step) { const l = lum(radiance, i * 3); if (l > 0) s.push(l) }
  if (s.length < 2) return 0
  s.sort((a, b) => a - b)
  const lo = s[Math.floor(0.001 * (s.length - 1))], hi = s[Math.floor(0.999 * (s.length - 1))]
  return Math.log2(hi / Math.max(1e-12, lo))
}
