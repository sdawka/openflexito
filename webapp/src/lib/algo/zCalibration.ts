/** Focus (z) calibration from four sweeps through focus: the z backlash and the camera's frame lag.
 *
 *  Coordinates are the commanded (device) z. After an upward move the lead-screw nut is engaged on
 *  the upward side, and that is the reference: moving up, physical z = commanded z. Reversing
 *  downwards, the first b steps (the dead band) do not move the stage, after which physical z =
 *  commanded z + b. The in-focus plane is at F in the up-engaged frame.
 *
 *  Frame lag δ: a frame stamped `ts` was really exposed at ts + δ (exposure/2 plus the rolling
 *  shutter's readout to the middle row), so during a sweep at signed speed u (steps/ns) the z
 *  interpolated at `ts` is short of the z at exposure by u·δ. The sharpest frame's interpolated z is
 *  therefore
 *    up sweep at speed v:    p_up(v) = F − v·δ
 *    down sweep at speed v:  z(ts) − v·δ + b = F   ⇒   p_dn = F − b + v·δ
 *  Two up sweeps at different speeds give δ = (p(v2) − p(v1)) / (v1 − v2). The backlash is
 *    b = p_up − p_dn + (v_up + v_dn)·δ
 *  i.e. the naive p_up − p_dn *under*-estimates b by 2·v·δ when δ > 0: the lag pulls the up peak
 *  down and the down peak up. The sequence is up (v1), down (v1), up (v1), up (v2): p_up is the mean
 *  of the two slow up sweeps, which bracket the down sweep in time and so cancel a linear drift of
 *  focus; |p_up1 − p_up2| is the repeatability. The lag uses the second slow up sweep, the one next
 *  to the fast one in time. */

import type { Sample } from './autofocus'
import { quadraticPeak } from './autofocus'

export interface SweepPeak {
  /** refined peak z (commanded coordinates) */
  z: number
  /** sharpest sample's z */
  zMax: number
  /** peak / floor of the focus metric over the sweep */
  contrast: number
  samples: number
  /** whether the fit refinement was used (a confident maximum near the sharpest sample) */
  fitted: boolean
}

export interface SweepPeakOptions {
  /** reject a sweep whose metric varies less than this ratio (featureless field); default 1.05 */
  minContrast?: number
  /** reject a peak within this fraction of the sweep's z range of either end; default 0.08 */
  edge?: number
  /** fewest samples a sweep must hold; default 8 */
  minSamples?: number
  /** reject a sweep whose parabola refinement is not a confident maximum; default true */
  requireFit?: boolean
}

/** The focus peak of one sweep: argmax of the metric, refined by a Gaussian (else a parabola)
 *  fitted to the contiguous samples above half height around it. Throws with a user-facing message when the sweep
 *  has too few frames, too little focus contrast, its peak at an end (focus outside the sweep), or
 *  (with `requireFit`) no confident parabola. */
export function sweepPeak(samples: readonly Sample[], opts: SweepPeakOptions = {}, label = 'sweep'): SweepPeak {
  const minContrast = opts.minContrast ?? 1.05, edge = opts.edge ?? 0.08, minSamples = opts.minSamples ?? 8
  const s = [...samples].filter((x) => Number.isFinite(x.z) && Number.isFinite(x.s)).sort((a, b) => a.z - b.z)
  if (s.length < minSamples) throw new Error(`${label}: only ${s.length} frames during the sweep (need ${minSamples}); is the stream running?`)
  let k = 0, lo = Infinity
  for (let i = 0; i < s.length; i++) { if (s[i].s > s[k].s) k = i; lo = Math.min(lo, s[i].s) }
  const hi = s[k].s
  const contrast = lo > 0 ? hi / lo : Infinity
  if (!(contrast >= minContrast)) throw new Error(`${label}: focus contrast ${contrast.toFixed(3)} is too low (need ${minContrast}); put a sample with visible detail in focus, LED on`)
  const zLo = s[0].z, zHi = s[s.length - 1].z, margin = edge * (zHi - zLo)
  if (s[k].z < zLo + margin || s[k].z > zHi - margin) throw new Error(`${label}: the sharpest frame is at the end of the sweep (z ${Math.round(s[k].z)}); focus first, or widen the span`)
  const half = lo + 0.5 * (hi - lo)
  let a = k, b = k
  while (a > 0 && s[a - 1].s > half) a--
  while (b < s.length - 1 && s[b + 1].s > half) b++
  // at least two samples either side, so the parabola sees the curvature
  a = Math.max(0, Math.min(a, k - 2)); b = Math.min(s.length - 1, Math.max(b, k + 2))
  // a Gaussian above the curve's floor (a parabola through ln(s − floor)): a fast sweep has only a
  // few frames across the peak, and a plain parabola through them is biased towards whichever
  // frame lands nearest the top; the parabola is the fallback
  const win = s.slice(a, b + 1)
  const inWin = (q: { z: number; confident: boolean } | null) => !!q && q.confident && q.z >= s[a].z && q.z <= s[b].z
  const floor = lo - 1e-6 * Math.max(1, Math.abs(hi - lo))
  const g = win.every((x) => x.s > floor) ? quadraticPeak(win.map((x) => ({ z: x.z, s: Math.log(x.s - floor) }))) : null
  const q = inWin(g) ? g : quadraticPeak(win)
  const fitted = inWin(q)
  if (!fitted && (opts.requireFit ?? true)) throw new Error(`${label}: the focus curve has no clear single peak (${b - a + 1} frames near it); is the sample moving, or the stage slipping?`)
  return { z: fitted ? q!.z : s[k].z, zMax: s[k].z, contrast, samples: s.length, fitted }
}

export interface ZCalSweep {
  peak: number
  /** speed magnitude, steps/ns (commanded span / move duration) */
  speed: number
}

export interface ZCalibrationSolution {
  /** steps (unrounded) */
  backlash: number
  /** ns, frame exposure after its timestamp */
  lagNs: number
  /** |p_up1 − p_up2|, steps */
  repeatability: number
  /** p_up − p_dn before the lag correction, steps */
  naiveBacklash: number
}

/** Solve the four peaks for backlash and lag; see the file comment for the model and signs. */
export function solveZCalibration(up1: ZCalSweep, down: ZCalSweep, up2: ZCalSweep, fast: ZCalSweep): ZCalibrationSolution {
  if (!(fast.speed > up2.speed)) throw new Error('focus calibration: the fast sweep must be faster than the slow ones')
  const lagNs = (fast.peak - up2.peak) / (up2.speed - fast.speed)
  const pUp = (up1.peak + up2.peak) / 2, vUp = (up1.speed + up2.speed) / 2
  const naiveBacklash = pUp - down.peak
  return { backlash: naiveBacklash + (vUp + down.speed) * lagNs, lagNs, repeatability: Math.abs(up1.peak - up2.peak), naiveBacklash }
}
