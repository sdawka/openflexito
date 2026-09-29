/** Sweep focus stack maths: the stage sweeps z at constant speed while the camera records, so each
 *  frame's z follows from its SensorTimestamp between the move's t0/t1 (same clock, same
 *  interpolation as `autofocus.ts#samplesFromSweep`). The sweep doubles as the focus search: a
 *  per-frame sharpness curve picks the span that holds any in-focus detail (a thick specimen can
 *  have several peaks), and up to `maxSlices` frames spread evenly in z over that span are fused.
 *
 *  Why this works where the old z-dither EDOF video mode did not: frames are exposed for well
 *  under a millisecond, so the z motion during one frame is a fraction of a step (no blur, unlike
 *  a lateral move), nothing waits for the stage to settle, and the frames come from the sensor's
 *  1640×1232 H.264 rather than the 820 px MJPEG preview. */

export interface SweepMove { t0: number; t1: number; z0: number; z1: number }

/** z of a frame stamped `ts` (ns) during `move`, or null when the frame falls outside it. `lagNs`:
 *  the frame was exposed at ts + lagNs (focus calibration, `algo/zCalibration.ts`); default 0. */
export function zAtTime(ts: number, m: SweepMove, lagNs = 0): number | null {
  const t = ts + lagNs
  if (!(m.t1 > m.t0) || t < m.t0 || t > m.t1) return null
  return m.z0 + ((t - m.t0) / (m.t1 - m.t0)) * (m.z1 - m.z0)
}

/** Step delay (µs) that puts ≈`stepsPerFrame` z steps between frames at `fps`, never faster than
 *  the board's current minimum (`minUs`). */
export function sweepStepTimeUs(fps: number, stepsPerFrame: number, minUs: number): number {
  return Math.max(minUs, Math.round(1e6 / (Math.max(1, fps) * Math.max(1, stepsPerFrame))))
}

export interface SweepSample { z: number; s: number }

export interface SweepSelection {
  /** indices into the samples, ascending in z, at most `maxSlices` */
  indices: number[]
  /** index of the sharpest sample */
  peak: number
  /** z span the selection covers (the in-focus band plus one sample of margin each side) */
  span: [number, number]
}

/** Pick the slices to fuse. The in-focus band is every sample whose sharpness rises above
 *  `threshold` of the way from the curve's floor to its peak, widened by one sample each side;
 *  inside it, targets spaced evenly in z take their nearest sample (duplicates collapse, so a band
 *  narrower than `maxSlices` samples just yields fewer slices). `samples` must be in capture order,
 *  i.e. monotonic in z. */
export function chooseSweepSlices(samples: readonly SweepSample[], maxSlices: number, threshold = 0.2): SweepSelection {
  const n = samples.length
  if (!n) return { indices: [], peak: -1, span: [0, 0] }
  let lo = Infinity, hi = -Infinity, peak = 0
  for (let i = 0; i < n; i++) {
    const s = samples[i].s
    if (s < lo) lo = s
    if (s > hi) { hi = s; peak = i }
  }
  const cut = lo + threshold * (hi - lo)
  let first = peak, last = peak
  for (let i = 0; i < n; i++) if (samples[i].s > cut) { first = Math.min(first, i); last = Math.max(last, i) }
  first = Math.max(0, first - 1); last = Math.min(n - 1, last + 1)
  const want = Math.max(1, Math.round(maxSlices))
  const za = samples[first].z, zb = samples[last].z
  const picked = new Set<number>()
  if (want === 1 || first === last) picked.add(peak)
  else {
    for (let k = 0; k < want; k++) {
      const target = za + ((zb - za) * k) / (want - 1)
      let best = first
      for (let i = first + 1; i <= last; i++) if (Math.abs(samples[i].z - target) < Math.abs(samples[best].z - target)) best = i
      picked.add(best)
    }
  }
  return { indices: [...picked].sort((a, b) => a - b), peak, span: [Math.min(za, zb), Math.max(za, zb)] }
}
