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

import type { FrameMeta, MoveResult } from '../api/types'

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
}

export function frameTime(f: FrameMeta): number | null {
  return f.ts ?? f.t ?? null
}

/** Frames captured during a move (t0 < t <= t1) mapped to interpolated z. */
export function samplesFromSweep(frames: readonly FrameMeta[], t0: number, t1: number, z0: number, z1: number, metric: SharpnessMetric): Sample[] {
  const out: Sample[] = []
  if (t1 <= t0) return out
  for (const f of frames) {
    const t = frameTime(f)
    if (t === null || t <= t0 || t > t1) continue
    const s = metric === 'fom' ? (f.focus_fom ?? NaN) : f.size
    if (!Number.isFinite(s)) continue
    out.push({ z: z0 + ((t - t0) / (t1 - t0)) * (z1 - z0), s, t })
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

export interface FastAutofocusResult { peakZ: number; samples: Sample[]; refined: QuadraticPeak | null; startZ: number }

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
  const samples = samplesFromSweep(io.frames(), move.t0, move.t1, z0, z1, metric)
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
  return { peakZ, samples, refined, startZ }
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
