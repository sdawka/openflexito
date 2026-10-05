/** Autofocus, browser side (port of OpenFlexure v3 things/autofocus.py).
 *
 *  Fast mode: sweep z at constant speed while the MJPEG stream runs; each frame's sharpness proxy
 *  is its JPEG byte size (or libcamera's FocusFoM). The z of each frame is interpolated in time
 *  between the stage position before and after the sweep (the device emits both with timestamps
 *  on the same clock as the camera's SensorTimestamp). Peak = argmax, optionally refined with a
 *  quadratic fit that must be a confident maximum.
 *
 *  Step mode: move in discrete steps, settle, measure any sharpness metric (e.g. Laplacian on a
 *  snapshot). Slower but metric-agnostic and independent of stage speed. */

import type { FrameMeta, MoveResult } from './types'

export type SharpnessMetric = 'jpeg' | 'fom'

export interface Sample { z: number; s: number; t?: number }

export type ZCompensation = false | 'z'

export interface FastAutofocusIO {
  /** Relative z move. `compensate: 'z'` asks the device for v3-style Z_ONLY backlash correction
   *  (approach the target from the + side); false (default) is a raw move used for the sweep. */
  moveZ(dz: number, compensate?: ZCompensation): Promise<MoveResult>
  currentZ(): number
  frames(): readonly FrameMeta[]                // ring buffer of recent frames (device clock ns)
  onProgress?(msg: string): void
  cancelled?(): boolean
  /** frame lag, ns: a frame stamped ts was exposed at ts + lag (`algo/zCalibration.ts`); default 0 */
  lagNs?: number
}

export function frameTime(f: FrameMeta): number | null {
  return f.ts ?? f.t ?? null
}

/** Frames exposed during a move (t0 < t <= t1) mapped to interpolated z. `lagNs`: a frame stamped
 *  ts was exposed at ts + lagNs (measured by the focus calibration, `algo/zCalibration.ts`); the
 *  exposure time is what is interpolated, and `t` of each sample stays the stamp. */
export function samplesFromSweep(frames: readonly FrameMeta[], t0: number, t1: number, z0: number, z1: number, metric: SharpnessMetric, lagNs = 0): Sample[] {
  const out: Sample[] = []
  if (t1 <= t0) return out
  for (const f of frames) {
    const ts = frameTime(f)
    if (ts === null) continue
    const t = ts + lagNs
    if (t <= t0 || t > t1) continue
    const s = metric === 'fom' ? (f.focus_fom ?? NaN) : f.size
    if (!Number.isFinite(s)) continue
    out.push({ z: z0 + ((t - t0) / (t1 - t0)) * (z1 - z0), s, t: ts })
  }
  return out
}

export function argmax(samples: Sample[]): Sample | null {
  let best: Sample | null = null
  for (const s of samples) if (!best || s.s > best.s) best = s
  return best
}

export interface QuadraticPeak { z: number; s: number; confident: boolean; a: number; b: number; c: number }

/** Least-squares parabola through (z, s); confident if the curvature is negative with 95 % confidence
 *  (a + 2*sigma_a < 0), as in v3's _get_peak_turning_point. */
export function quadraticPeak(samples: Sample[]): QuadraticPeak | null {
  const n = samples.length
  if (n < 3) return null
  // normalise z for conditioning
  const zm = samples.reduce((a, s) => a + s.z, 0) / n
  const zs = samples.map((s) => s.z - zm), ys = samples.map((s) => s.s)
  let S0 = n, S1 = 0, S2 = 0, S3 = 0, S4 = 0, T0 = 0, T1 = 0, T2 = 0
  for (let i = 0; i < n; i++) {
    const z = zs[i], y = ys[i], z2 = z * z
    S1 += z; S2 += z2; S3 += z2 * z; S4 += z2 * z2
    T0 += y; T1 += y * z; T2 += y * z2
  }
  // solve [[S4,S3,S2],[S3,S2,S1],[S2,S1,S0]] [a,b,c] = [T2,T1,T0]
  const M = [[S4, S3, S2], [S3, S2, S1], [S2, S1, S0]], v = [T2, T1, T0]
  const inv = invert3(M)
  if (!inv) return null
  const a = inv[0][0] * v[0] + inv[0][1] * v[1] + inv[0][2] * v[2]
  const b = inv[1][0] * v[0] + inv[1][1] * v[1] + inv[1][2] * v[2]
  const c = inv[2][0] * v[0] + inv[2][1] * v[1] + inv[2][2] * v[2]
  // residual variance -> covariance of a is sigma^2 * inv[0][0]
  let rss = 0
  for (let i = 0; i < n; i++) { const r = ys[i] - (a * zs[i] * zs[i] + b * zs[i] + c); rss += r * r }
  const sigma2 = n > 3 ? rss / (n - 3) : 0
  const sigmaA = Math.sqrt(Math.max(0, sigma2 * inv[0][0]))
  const confident = a + 2 * sigmaA < -1e-12
  const zPeak = a !== 0 ? -b / (2 * a) : 0
  return { z: zPeak + zm, s: a * zPeak * zPeak + b * zPeak + c, confident, a, b, c }
}

function invert3(m: number[][]): number[][] | null {
  const [a, b, c] = m[0], [d, e, f] = m[1], [g, h, i] = m[2]
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-18) return null
  const D = -(b * i - c * h), E = a * i - c * g, F = -(a * h - b * g)
  const G = b * f - c * e, H = -(a * f - c * d), I = a * e - b * d
  return [[A / det, D / det, G / det], [B / det, E / det, H / det], [C / det, F / det, I / det]]
}

/** Count sign changes of significant differences; a clean focus curve has exactly one (v3 _count_turning_points). */
export function countTurningPoints(values: number[], threshold = 0.5): number {
  const d: number[] = []
  for (let i = 1; i < values.length; i++) d.push(values[i] - values[i - 1])
  const mean = d.reduce((a, v) => a + Math.abs(v), 0) / Math.max(1, d.length)
  const sig = d.filter((v) => Math.abs(v) / (mean || 1) > threshold)
  let turns = 0
  for (let i = 1; i < sig.length; i++) if (Math.sign(sig[i]) !== Math.sign(sig[i - 1])) turns++
  return turns
}

export interface FastAutofocusResult { peakZ: number; samples: Sample[]; refined: QuadraticPeak | null; startZ: number; quality: CurveQuality }

export interface CurveQuality {
  /** peak / robust floor (median of the lowest third), on the smoothed curve */
  contrast: number
  /** (peak - floor) / robust noise of the floor (MAD of the residuals at the lowest third of the smoothed curve); copes
   *  with a metric that sits on a large baseline, where peak/floor stays near 1 */
  snr: number
  /** sign changes of significant differences (`countTurningPoints`); a clean peak has 1 */
  turningPoints: number
  /** FWHM of the peak in samples (half-way between floor and peak); NaN if a side never drops that far */
  widthSamples: number
  /** index of the peak among the valid (finite) samples, in the order given */
  peakIndex: number
  ok: boolean
  reason?: 'flat' | 'multimodal' | 'edge' | 'few'
}

export interface CurveQualityOptions { minContrast?: number; minSnr?: number; maxTurningPoints?: number; smooth?: number }

/** Score a focus curve, not just its peak. A curve passes the signal test when contrast >=
 *  `minContrast` (default 1.3) OR snr >= `minSnr` (default 6). Measured on the Pi: JPEG size shows
 *  no contrast at all (dead on the hardware encoder), libcamera FocusFoM 1.29 on a ~4000 baseline
 *  (so only the SNR test passes it), Laplacian on the 820 px stream 12, Laplacian on a full-res
 *  still downscaled to 1640 only 1.14 (JPEG noise dominates). Non-finite samples are dropped. Reasons are checked in
 *  order few (< 5 valid samples), flat (contrast below `minContrast`: empty field), edge (peak at an
 *  end: true focus lies outside the sweep), multimodal (more than `maxTurningPoints`: debris or
 *  several planes). */
export function curveQuality(samples: readonly { z: number; s: number }[], opts: CurveQualityOptions = {}): CurveQuality {
  const minContrast = opts.minContrast ?? 1.3, minSnr = opts.minSnr ?? 6, maxTurns = opts.maxTurningPoints ?? 1
  const win = Math.max(1, Math.round(opts.smooth ?? 3))
  const v = samples.map((x) => x.s).filter((x) => Number.isFinite(x))
  const n = v.length
  if (n < 5) return { contrast: NaN, snr: NaN, turningPoints: 0, widthSamples: NaN, peakIndex: n ? v.indexOf(Math.max(...v)) : -1, ok: false, reason: 'few' }
  const half = win >> 1
  const sm = v.map((_, i) => {
    const a = Math.max(0, i - half), b = Math.min(n - 1, i + half)
    let t = 0
    for (let k = a; k <= b; k++) t += v[k]
    return t / (b - a + 1)
  })
  let pk = 0
  for (let i = 1; i < n; i++) if (sm[i] > sm[pk]) pk = i
  const peak = sm[pk]
  const low = [...sm].sort((a, b) => a - b).slice(0, Math.max(1, Math.floor(n / 3)))
  const floor = (low[(low.length - 1) >> 1] + low[low.length >> 1]) / 2
  const contrast = floor > 0 ? peak / floor : peak > floor ? Infinity : 1
  // noise: MAD of raw-minus-smoothed residuals at the lowest third (selected by smoothed value, so
  // the selection does not truncate the residuals); 1.4826 -> sigma, sqrt(n/(n-1)) undoes the
  // smoothing's shrinkage, and the smoothed peak's own noise is sigma/sqrt(window)
  const cut = low[low.length - 1]
  const res: number[] = []
  for (let i = 0; i < n; i++) if (sm[i] <= cut) res.push(v[i] - sm[i])
  res.sort((a, b) => a - b)
  const rm = (res[(res.length - 1) >> 1] + res[res.length >> 1]) / 2
  const dev = res.map((x) => Math.abs(x - rm)).sort((a, b) => a - b)
  const mad = (dev[(dev.length - 1) >> 1] + dev[dev.length >> 1]) / 2
  const sigma = (1.4826 * mad) / Math.sqrt(Math.max(0.5, 1 - 1 / win))
  const noise = Math.max(sigma / Math.sqrt(win), 1e-9 * Math.max(1, Math.abs(peak)))
  const snr = (peak - floor) / noise
  const turningPoints = countTurningPoints(sm)
  const level = floor + (peak - floor) / 2
  let left = NaN, right = NaN
  for (let i = pk; i > 0; i--) if (sm[i - 1] <= level) { left = i - (sm[i] - level) / (sm[i] - sm[i - 1]); break }
  for (let i = pk; i < n - 1; i++) if (sm[i + 1] <= level) { right = i + (sm[i] - level) / (sm[i] - sm[i + 1]); break }
  const widthSamples = right - left
  const reason: CurveQuality['reason'] = contrast < minContrast && !(snr >= minSnr) ? 'flat' : pk === 0 || pk === n - 1 ? 'edge' : turningPoints > maxTurns ? 'multimodal' : undefined
  return { contrast, snr, turningPoints, widthSamples, peakIndex: pk, ok: !reason, ...(reason ? { reason } : {}) }
}

/** v3 fast_autofocus: move dz/2 down (backlash-corrected on z), sweep +dz recording sharpness,
 *  then move to the peak with z backlash correction. The correction makes the final approach come
 *  from the same (+) side as the sweep, so backlash affects both equally without a full return. */
export async function fastAutofocus(io: FastAutofocusIO, dz = 2000, metric: SharpnessMetric = 'jpeg'): Promise<FastAutofocusResult> {
  const startZ = io.currentZ()
  io.onProgress?.(`moving to sweep start (${-dz / 2})`)
  await io.moveZ(-Math.floor(dz / 2), 'z')
  const z0 = io.currentZ()
  io.onProgress?.(`sweeping ${dz} steps`)
  const move = await io.moveZ(dz)
  const z1 = io.currentZ()
  // give the last frames of the sweep a moment to arrive over the socket
  await new Promise((r) => setTimeout(r, 150))
  const samples = samplesFromSweep(io.frames(), move.t0, move.t1, z0, z1, metric, io.lagNs ?? 0)
  const best = argmax(samples)
  if (!best || samples.length < 3) {
    await io.moveZ(startZ - io.currentZ())
    throw new Error(`autofocus: only ${samples.length} frames recorded during the sweep`)
  }
  const worst = samples.reduce((m, s) => Math.min(m, s.s), Infinity)
  if (worst > 0 && best.s / worst < 1.03) {  // sharpness barely changed over the whole sweep
    await io.moveZ(startZ - io.currentZ())
    throw new Error('autofocus: no focus signal, the image is featureless (put a sample in view, LED on)')
  }
  // refine with a parabola over the neighbourhood of the maximum
  const i = samples.indexOf(best), win = samples.slice(Math.max(0, i - 4), i + 5)
  const refined = quadraticPeak(win)
  const peakZ = Math.round(refined?.confident && Math.abs(refined.z - best.z) < dz / 10 ? refined.z : best.z)
  io.onProgress?.(`peak at z=${peakZ} (metric ${best.s})`)
  await io.moveZ(peakZ - io.currentZ(), 'z')   // v3: move_absolute(z=peak, Z_ONLY)
  return { peakZ, samples, refined, startZ, quality: curveQuality(samples) }
}

/** Repeat fast autofocus until the peak lies in the middle 3/5 of the sweep (v3 looping_autofocus). */
export async function loopingAutofocus(io: FastAutofocusIO, dz = 2000, metric: SharpnessMetric = 'jpeg', maxAttempts = 10): Promise<FastAutofocusResult> {
  let last: FastAutofocusResult | null = null
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (io.cancelled?.()) throw new Error('autofocus cancelled')
    last = await fastAutofocus(io, dz, metric)
    const zs = last.samples.map((s) => s.z), lo = Math.min(...zs), hi = Math.max(...zs)
    if (last.peakZ > lo + dz / 5 && last.peakZ < hi - dz / 5) return last
    io.onProgress?.(`peak near edge of sweep, retrying (${attempt + 1}/${maxAttempts})`)
  }
  throw new Error('autofocus: no focus found within range')
}

export type PeakModel = 'quadratic' | 'gaussian' | 'lorentzian'

/** Sub-pixel peak fit with a choice of curve shape. 'quadratic' is `quadraticPeak` unchanged.
 *  'gaussian' fits a parabola to ln(s) (exact for a true Gaussian peak, and the standard trick for
 *  fitting one — the log of a Gaussian is a parabola). 'lorentzian' fits a parabola to −1/s (a
 *  Lorentzian's reciprocal is a parabola too), which has heavier tails than a Gaussian and tracks a
 *  focus curve that falls off more slowly away from the peak (common on low-contrast samples: a
 *  Gaussian fit there under-weights the tails and can be pulled off-centre by a single noisy sample).
 *  Falls back to 'quadratic' if any sample is non-positive (ln/reciprocal undefined). */
export function fitPeak(samples: Sample[], model: PeakModel = 'quadratic'): QuadraticPeak | null {
  if (model === 'quadratic' || samples.some((s) => !(s.s > 0))) return quadraticPeak(samples)
  if (model === 'gaussian') {
    const q = quadraticPeak(samples.map((s) => ({ z: s.z, s: Math.log(s.s) })))
    return q && { ...q, s: Math.exp(q.s) }
  }
  const q = quadraticPeak(samples.map((s) => ({ z: s.z, s: -1 / s.s })))
  return q && { ...q, s: -1 / q.s }
}

export interface TwoPassIO extends FastAutofocusIO {
  /** Fine-pass sharpness metric (e.g. Laplacian variance on a snapshot), read after settling. */
  measure(): Promise<number>
}

export interface TwoPassOptions {
  coarseDz?: number
  coarseMetric?: SharpnessMetric
  fineRange?: number      // z span of the fine sweep around the coarse peak; default coarseDz/10
  fineSteps?: number      // default 9
  fineModel?: PeakModel   // default 'gaussian'
  /** Optional full-resolution confirmation: given a candidate z, returns its sharpness (any metric
   *  comparable across calls, e.g. Laplacian on a full-res still) so a stream-proxy false peak can be
   *  rejected. Not called unless provided (an extra full-res capture costs ~1.3 s on the Pi). */
  confirm?(z: number): Promise<number>
  /** Points of the stepped coarse pass that replaces the continuous sweep when the sweep's proxy
   *  shows no signal or fails the curve gate (default 11). Measured on an IMX219 Pi: libcamera's
   *  FocusFoM varied 5 % across z over a thick specimen while the stream Laplacian rose 20×, so a
   *  sweep-only coarse pass refused every tile of a scan; the stepped pass uses `measure()`. */
  coarseSteps?: number
  /** 'auto' (default): continuous proxy sweep, stepped fallback when it shows no signal or fails the
   *  gate; 'stepped': skip the proxy sweep and step the fine metric across the range from the start
   *  (a scan over a thick specimen, where the proxy passed its gate with wrong peaks). */
  coarse?: 'auto' | 'stepped'
}

/** `quality` scores the fine curve (NaN samples dropped); the coarse sweep's is `coarse.quality`.
 *  `coarseMode` says whether the coarse peak came from the continuous proxy sweep or from the stepped
 *  fallback on the fine metric. */
export interface TwoPassResult { peakZ: number; coarse: FastAutofocusResult; coarseMode: 'sweep' | 'stepped'; fineSamples: Sample[]; finePeak: QuadraticPeak | null; confirmed: boolean; quality: CurveQuality }

/** Two-pass autofocus: a fast, coarse JPEG-size (or FocusFoM) sweep over the full range locates the
 *  focus plane roughly, then a short step sweep around it measures a sharper, metric-agnostic
 *  Laplacian/Brenner-style figure at rest (no stream-proxy noise) and fits a Gaussian or Lorentzian
 *  peak for the final z. More robust than either pass alone: the coarse pass would need many more
 *  samples to reach the same sub-pixel precision over its full range, and the fine pass alone would
 *  need to search blindly if not seeded by the coarse peak. */
export async function twoPassAutofocus(io: TwoPassIO, opts: TwoPassOptions = {}): Promise<TwoPassResult> {
  const coarseDz = opts.coarseDz ?? 2000
  let coarse: FastAutofocusResult | null = null, coarseMode: 'sweep' | 'stepped' = 'sweep'
  try {
    if (opts.coarse === 'stepped') throw new Error('autofocus: no focus signal (stepped coarse pass requested)')
    const c = await fastAutofocus(io, coarseDz, opts.coarseMetric ?? 'jpeg')
    if (c.quality.ok) coarse = c
    else io.onProgress?.(`coarse sweep refused (${c.quality.reason}, contrast ${c.quality.contrast.toFixed(2)}): stepping the fine metric across the range instead`)
  } catch (e) {
    if (!/featureless|no focus signal/.test((e as Error).message)) throw e
    io.onProgress?.(opts.coarse === 'stepped' ? 'stepping the fine metric across the range' : 'coarse sweep saw no signal in its proxy: stepping the fine metric across the range instead')
  }
  if (!coarse) {
    // fastAutofocus has returned to the start z (it does so before throwing, and a refused curve
    // ends at its own best guess); step the fine metric over the whole range from here
    const startZ = io.currentZ()
    const stepped = await stepAutofocus(io, coarseDz, Math.max(5, opts.coarseSteps ?? 11))
    const q = curveQuality(stepped.samples)
    if (!q.ok) {
      await io.moveZ(startZ - io.currentZ(), 'z')
      throw new Error('autofocus: no focus signal, the image is featureless (put a sample in view, LED on)')
    }
    coarse = { peakZ: stepped.peakZ, samples: stepped.samples, refined: null, startZ, quality: q }
    coarseMode = 'stepped'
  }
  const range = Math.max(20, opts.fineRange ?? Math.round(coarseDz / 10)), steps = Math.max(5, opts.fineSteps ?? 9)
  const step = Math.max(1, range / (steps - 1))
  io.onProgress?.(`fine pass: ${steps} points across ${range} steps around z=${coarse.peakZ}`)
  await io.moveZ(-Math.round(range / 2) - step, 'z')   // approach the fine window from below
  await io.moveZ(step)
  const fineSamples: Sample[] = []
  for (let i = 0; i < steps; i++) {
    fineSamples.push({ z: io.currentZ(), s: await io.measure() })
    io.onProgress?.(`fine pass: z=${io.currentZ()} sharpness=${fineSamples[i].s.toFixed(1)}`)
    if (i < steps - 1) await io.moveZ(step)
  }
  const best = argmax(fineSamples)!
  const bi = fineSamples.indexOf(best)
  const win = fineSamples.slice(Math.max(0, bi - 3), bi + 4)
  const finePeak = fitPeak(win, opts.fineModel ?? 'gaussian')
  let peakZ = Math.round(finePeak?.confident && Math.abs(finePeak.z - best.z) <= step * 2 ? finePeak.z : best.z)
  await io.moveZ(peakZ - io.currentZ(), 'z')
  let confirmed = true
  if (opts.confirm) {
    const atPeak = await opts.confirm(peakZ)
    // if a neighbouring fine sample was actually sharper at full resolution, the stream proxy was
    // fooled (e.g. by a compression artefact); fall back to the best fine sample instead of the fit.
    if (atPeak < best.s * 0.9 && best.z !== peakZ) {
      confirmed = false
      peakZ = Math.round(best.z)
      await io.moveZ(peakZ - io.currentZ(), 'z')
    }
  }
  return { peakZ, coarse, coarseMode, fineSamples, finePeak, confirmed, quality: curveQuality(fineSamples) }
}

export interface StepAutofocusIO {
  moveZ(dz: number): Promise<unknown>
  currentZ(): number
  measure(): Promise<number>       // any sharpness metric, after settling
  onProgress?(msg: string): void
}

/** Coarse-to-fine step autofocus: sample `steps` points across ±range/2, fit a parabola around the best. */
export async function stepAutofocus(io: StepAutofocusIO, range = 1000, steps = 9): Promise<{ peakZ: number; samples: Sample[] }> {
  const startZ = io.currentZ(), step = range / (steps - 1)
  const samples: Sample[] = []
  await io.moveZ(-range / 2 - step)          // approach from below so all samples share one direction
  await io.moveZ(step)
  for (let i = 0; i < steps; i++) {
    samples.push({ z: io.currentZ(), s: await io.measure() })
    io.onProgress?.(`z=${io.currentZ()} sharpness=${samples[i].s.toFixed(1)}`)
    if (i < steps - 1) await io.moveZ(step)
  }
  const best = argmax(samples)!
  const i = samples.indexOf(best), refined = quadraticPeak(samples.slice(Math.max(0, i - 2), i + 3))
  const peakZ = Math.round(refined?.confident && Math.abs(refined.z - best.z) <= step ? refined.z : best.z)
  await io.moveZ(startZ - range / 2 - step - io.currentZ())  // back below, then up to the peak
  await io.moveZ(peakZ - io.currentZ())
  return { peakZ, samples }
}
