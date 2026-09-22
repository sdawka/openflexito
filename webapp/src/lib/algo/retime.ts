/** Output-timestamp re-timing for the recorder (`docs/video-research/motion.md`, proposal 8 and the
 *  "constant frame rate output" addendum). The recorder hands every frame it is about to encode to
 *  `Retimer.push(tSec)` with the frame's device time and gets back whether to encode it, at what
 *  output time, and how many extra copies to add first:
 *
 *  - `vfr`: the honest default. Every frame is emitted at its own time (variable frame rate), so a
 *    scientific recording keeps true timing.
 *  - `cfr`: constant frame rate. Slot `k` is at `t0 + k/fps` with `t0` the first frame's time. A frame
 *    is emitted when its time has reached the next unfilled slot and is placed at the latest slot at
 *    or before its time; when more than one slot passed since the last emitted frame the result
 *    reports the intermediate slots as `duplicates` (with their times), which the caller fills with
 *    the same canvas before adding it at `tOut` (the recorder only has the current frame; holding the
 *    previous one would need a copy of the output canvas, see INTEGRATION-motion.md). A frame that
 *    arrives before the next slot is dropped. Skipping modes (lucky, time compression) thereby play
 *    back without stutter.
 *  - `ramp`: speed ramp. Piecewise-linear speed keyframes `{ tIn, speed }` (`tIn` seconds since the
 *    first frame; `speed` > 0, 1 = real time, 60 = 60× time compression, 0.5 = half speed) define
 *    `speed(t)`; the output time is `∫ dt / speed(t)`, integrated analytically per linear segment so
 *    a ramp from 1× to 60× is exact and monotone. With an `fps`, a frame is kept only when its output
 *    time has advanced by ≥ 1/fps since the last kept frame (the report's `accept()`), so a 60×
 *    stretch does not push 18 input frames per output frame into the encoder; without one every
 *    frame is kept. Slow-motion stretches (speed < 1) simply space frames further apart; players hold
 *    the last frame, so no duplicates are produced.
 *
 *  Output times are strictly increasing (each at least 1 µs after the previous), which the MP4 muxer
 *  requires. Pure: no DOM, no clock, no canvas. */

export type RetimeMode = 'vfr' | 'cfr' | 'ramp'

export interface SpeedKeyframe {
  /** seconds since the first pushed frame */
  tIn: number
  /** playback speed factor from this keyframe on, linearly interpolated to the next one (> 0) */
  speed: number
}

export interface RetimeOptions {
  mode: RetimeMode
  /** `cfr`: the output slot rate; `ramp`: the maximum output rate (0/undefined = keep every frame) */
  fps?: number
  /** `ramp`: speed keyframes; unsorted is fine; empty or missing = real time */
  keyframes?: SpeedKeyframe[]
}

export interface RetimeResult {
  /** encode this frame (false = drop it, nothing else in the result applies) */
  emit: boolean
  /** output timestamp for this frame (seconds, same origin as the input; the sink subtracts its first) */
  tOut: number
  /** copies of this same frame the caller adds *before* it, at `duplicateTimes` (cfr only) */
  duplicates: number
  /** output timestamps of the duplicates, ascending, all < `tOut` */
  duplicateTimes: number[]
}

export interface RetimeStats { pushed: number; emitted: number; duplicates: number; dropped: number }

const MIN_STEP = 1e-6

/** Speed at input time `tRel` (seconds since the first frame) for sorted keyframes. */
export function speedAt(keyframes: SpeedKeyframe[], tRel: number): number {
  if (keyframes.length === 0) return 1
  if (tRel <= keyframes[0].tIn) return keyframes[0].speed
  for (let i = 1; i < keyframes.length; i++) {
    const a = keyframes[i - 1], b = keyframes[i]
    if (tRel <= b.tIn) {
      if (b.tIn === a.tIn) return b.speed
      const u = (tRel - a.tIn) / (b.tIn - a.tIn)
      return a.speed + (b.speed - a.speed) * u
    }
  }
  return keyframes[keyframes.length - 1].speed
}

/** ∫₀^{tRel} du / speed(u) for sorted keyframes: the output time of input time `tRel`. Closed form per
 *  segment: for `speed = a + b·u`, `∫ du/(a + b·u) = ln((a + b·Δ)/a) / b` (Δ/a when b = 0). */
export function outputTimeAt(keyframes: SpeedKeyframe[], tRel: number): number {
  if (keyframes.length === 0) return tRel
  if (tRel <= 0) return 0
  let t = 0, out = 0
  const seg = (dur: number, s0: number, s1: number): number => {
    if (dur <= 0) return 0
    const b = (s1 - s0) / dur
    if (Math.abs(b) < 1e-12 * Math.max(1, s0)) return dur / s0
    return Math.log((s0 + b * dur) / s0) / b
  }
  // before the first keyframe: constant speed
  const first = keyframes[0]
  if (first.tIn > 0) {
    const dur = Math.min(tRel, first.tIn)
    out += dur / first.speed
    t = dur
    if (tRel <= first.tIn) return out
  }
  for (let i = 1; i < keyframes.length; i++) {
    const a = keyframes[i - 1], b = keyframes[i]
    if (b.tIn <= t) continue
    const end = Math.min(tRel, b.tIn)
    const sStart = speedAt(keyframes, t), sEnd = speedAt(keyframes, end)
    out += seg(end - t, sStart, sEnd)
    t = end
    if (tRel <= b.tIn) return out
  }
  // after the last keyframe: constant speed
  const last = keyframes[keyframes.length - 1]
  if (tRel > t) out += (tRel - t) / last.speed
  return out
}

/** Validated, sorted copy of the keyframes (speeds clamped to > 0, non-finite entries dropped). */
export function normaliseKeyframes(kf: SpeedKeyframe[] | undefined): SpeedKeyframe[] {
  return (kf ?? [])
    .filter((k) => Number.isFinite(k.tIn) && Number.isFinite(k.speed))
    .map((k) => ({ tIn: Math.max(0, k.tIn), speed: Math.max(1e-3, k.speed) }))
    .sort((a, b) => a.tIn - b.tIn)
}

export class Retimer {
  private readonly mode: RetimeMode
  private readonly fps: number
  private readonly keyframes: SpeedKeyframe[]
  private t0: number | null = null
  private lastIn = -Infinity
  private lastOut: number | null = null
  private nextSlot = 0
  private st: RetimeStats = { pushed: 0, emitted: 0, duplicates: 0, dropped: 0 }

  constructor(opts: RetimeOptions) {
    this.mode = opts.mode
    this.fps = opts.fps && opts.fps > 0 ? opts.fps : 0
    this.keyframes = normaliseKeyframes(opts.keyframes)
    if (this.mode === 'cfr' && !this.fps) throw new Error('Retimer: cfr needs fps > 0')
  }

  /** Forget the origin and the slot state (a new recording). */
  reset(): void {
    this.t0 = null; this.lastIn = -Infinity; this.lastOut = null; this.nextSlot = 0
    this.st = { pushed: 0, emitted: 0, duplicates: 0, dropped: 0 }
  }

  stats(): RetimeStats { return { ...this.st } }

  /** Output time the pushed input times map to so far (for a HUD or the mode's status line). */
  get outputTime(): number { return this.lastOut ?? 0 }

  push(tSec: number): RetimeResult {
    this.st.pushed++
    if (!Number.isFinite(tSec)) return this.drop()
    if (this.t0 === null) this.t0 = tSec
    // input time never runs backwards (a re-ordered or duplicated device timestamp)
    if (tSec < this.lastIn) tSec = this.lastIn
    this.lastIn = tSec
    const rel = tSec - this.t0
    switch (this.mode) {
      case 'vfr': return this.emit(tSec, [])
      case 'cfr': {
        const slot = Math.floor(rel * this.fps + 1e-6)
        if (slot < this.nextSlot) return this.drop()
        const dupTimes: number[] = []
        for (let k = this.nextSlot; k < slot; k++) dupTimes.push(this.t0 + k / this.fps)
        this.nextSlot = slot + 1
        return this.emit(this.t0 + slot / this.fps, dupTimes)
      }
      case 'ramp': {
        const out = this.t0 + outputTimeAt(this.keyframes, rel)
        if (this.fps && this.lastOut !== null && out - this.lastOut < 1 / this.fps - 1e-9) return this.drop()
        return this.emit(out, [])
      }
    }
  }

  private drop(): RetimeResult {
    this.st.dropped++
    return { emit: false, tOut: this.lastOut ?? 0, duplicates: 0, duplicateTimes: [] }
  }

  private emit(tOut: number, dupTimes: number[]): RetimeResult {
    // strictly increasing output times: nudge every timestamp past the previous one by ≥ 1 µs
    const times: number[] = []
    let prev = this.lastOut
    for (const t of [...dupTimes, tOut]) {
      const v = prev === null ? t : Math.max(t, prev + MIN_STEP)
      times.push(v); prev = v
    }
    const finalT = times.pop() as number
    this.lastOut = finalT
    this.st.emitted += 1 + times.length
    this.st.duplicates += times.length
    return { emit: true, tOut: finalT, duplicates: times.length, duplicateTimes: times }
  }
}
