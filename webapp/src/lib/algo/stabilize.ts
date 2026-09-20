/** Video stabilisation: per frame, register the frame against a reference frame with `algo/register.ts`
 *  (coarse whole-frame correlation, refined by a full-resolution crop) instead of hand-rolling a
 *  downscale-then-correlate step here — CLAUDE.md is explicit that `register.ts` is the one primitive
 *  anything measuring sub-pixel motion should use. The reference is periodically re-anchored to the
 *  latest frame (so the correlation window stays small and accurate instead of degrading as the scene
 *  drifts far from the first reference). The raw trajectory (the re-anchor's running origin plus the
 *  current frame's offset from it) is low-pass filtered with a one-euro filter, which follows a
 *  deliberate pan (low frequency, larger amplitude) while damping jitter (high frequency, small
 *  amplitude); the difference between the raw and the filtered trajectory is the jitter to remove,
 *  clamped to a small margin so a mistrack can never push the frame far off-canvas.
 *
 *  Pure: no DOM or canvas access, so `track()` is unit-testable on plain `Gray` arrays. The caller
 *  (the recorder) does the actual `ctx.translate(-dx, -dy)` and crops a matching margin off the
 *  canvas so the translated frame never shows an edge. */
import { register, type RegisterOptions } from './register'
import type { Gray } from './sharpness'

class OneEuroFilter {
  private xPrev: number | null = null
  private dxPrev = 0
  private tPrev: number | null = null

  constructor(private minCutoff: number, private beta: number, private dCutoff = 1) {}

  private alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff)
    return 1 / (1 + tau / dt)
  }

  filter(x: number, tSec: number): number {
    if (this.tPrev === null) { this.tPrev = tSec; this.xPrev = x; this.dxPrev = 0; return x }
    const dt = Math.max(1e-3, tSec - this.tPrev)
    this.tPrev = tSec
    const rawSlope = (x - (this.xPrev as number)) / dt
    const aD = this.alpha(this.dCutoff, dt)
    this.dxPrev = aD * rawSlope + (1 - aD) * this.dxPrev
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dxPrev)
    const a = this.alpha(cutoff, dt)
    const xHat = a * x + (1 - a) * (this.xPrev as number)
    this.xPrev = xHat
    return xHat
  }

  reset(): void { this.xPrev = null; this.dxPrev = 0; this.tPrev = null }
}

export interface StabilizeOptions {
  /** re-anchor the reference to the current frame once the raw offset from it exceeds this many px
   *  (keeps the correlation window small and accurate; also bounds how far a pan can run before the
   *  origin is rebased) */
  reanchorPx: number
  /** one-euro filter: higher = follows real motion faster, lower = smoother but more lagged (Hz) */
  minCutoff: number
  /** one-euro filter: extra responsiveness added at speed (higher = deliberate pans leak through less
   *  smoothing, but jitter riding on top of a fast pan is damped less too) */
  beta: number
  /** clamp the correction actually applied, in px, so a mistrack cannot push the frame far off-canvas */
  maxShiftPx: number
  /** a measurement below this correlation quality is discarded; the previous trajectory point is
   *  reused instead (guards a blank or otherwise untrackable frame) */
  minQuality: number
  /** tuning passed straight through to `register()`'s coarse/fine stages; the defaults are chosen to
   *  keep the per-frame FFT cost bounded for real-time recording rather than for offline accuracy. */
  registerOptions: RegisterOptions
}

export const defaultStabilizeOptions: StabilizeOptions = {
  reanchorPx: 40, minCutoff: 1, beta: 0.02, maxShiftPx: 24, minQuality: 1.5,
  registerOptions: { coarseW: 240, crop: 256, minQuality: 1.5 },
}

export interface StabilizeResult {
  /** apply as `ctx.translate(-dx, -dy)` before cropping the margin */
  dx: number
  dy: number
  /** raw (unfiltered) trajectory position, for diagnostics */
  rawDx: number
  rawDy: number
  quality: number
  reanchored: boolean
}

export class Stabilizer {
  private reference: Gray | null = null
  private origin = { x: 0, y: 0 }
  private lastRaw = { x: 0, y: 0 }
  private fx: OneEuroFilter
  private fy: OneEuroFilter

  constructor(private opts: StabilizeOptions = defaultStabilizeOptions) {
    this.fx = new OneEuroFilter(opts.minCutoff, opts.beta)
    this.fy = new OneEuroFilter(opts.minCutoff, opts.beta)
  }

  /** Drop the reference and filter state: call after a stage move or a scene cut, so the next frame
   *  becomes the new anchor instead of being tracked against a now-unrelated reference. */
  reset(): void {
    this.reference = null
    this.origin = { x: 0, y: 0 }
    this.lastRaw = { x: 0, y: 0 }
    this.fx.reset(); this.fy.reset()
  }

  /** Feed the next frame (in order; `tSec` monotonic, e.g. `performance.now() / 1000`). */
  track(gray: Gray, tSec: number): StabilizeResult {
    if (!this.reference) {
      this.reference = gray
      this.fx.filter(0, tSec); this.fy.filter(0, tSec)
      return { dx: 0, dy: 0, rawDx: 0, rawDy: 0, quality: Infinity, reanchored: true }
    }
    const d = register(this.reference, gray, { ...this.opts.registerOptions, minQuality: this.opts.minQuality })
    let raw = { x: this.origin.x + d.dx, y: this.origin.y + d.dy }
    if (d.confident) this.lastRaw = raw
    else raw = this.lastRaw
    let reanchored = false
    if (Math.hypot(d.dx, d.dy) > this.opts.reanchorPx) {
      this.reference = gray
      this.origin = raw
      reanchored = true
    }
    const sx = this.fx.filter(raw.x, tSec)
    const sy = this.fy.filter(raw.y, tSec)
    let dx = raw.x - sx, dy = raw.y - sy
    const mag = Math.hypot(dx, dy)
    if (mag > this.opts.maxShiftPx) { const k = this.opts.maxShiftPx / mag; dx *= k; dy *= k }
    return { dx, dy, rawDx: raw.x, rawDy: raw.y, quality: d.quality, reanchored }
  }
}
