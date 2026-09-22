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
 *  Rotation (`docs/video-research/motion.md`, proposal 2(d) and the "similarity stabilisation"
 *  addendum): with `rotation: true` the left and right thirds of the tracking frame are registered
 *  separately (two `displacement()` calls on patches offset by the whole-frame integer shift, so both
 *  see the same content) and the in-plane rotation is `θ = atan2(dy_R − dy_L, baseline)`, where
 *  `baseline` is the distance between the two patch centres. θ has its own one-euro filter
 *  (`rotationMinCutoff`, 0.5 Hz: rotation on a microscope is slow drift of a rotated stage axis, never
 *  a fast wobble) and the same raw-minus-smoothed logic as the translation; it is gated (both patches
 *  confident, agreeing in x within 1 px so a large organism in one half cannot fake a rotation) and
 *  has a 0.05° dead band so a still scene is never resampled for nothing. Two tall side patches were
 *  chosen over four 128² corner patches and a Procrustes fit: two FFTs instead of four, each patch
 *  spans most of the frame height so it averages far more texture (the corner patches of a
 *  bright-field slide are often the emptiest part of the field), the baseline is the longest the
 *  frame offers (≈ 2/3 of its width, so a 0.05 px dy error is 0.01° at 480 px), and a plane imaged
 *  orthographically has no scale or shear to fit (the report's "do not bother": translation + rotation
 *  is the complete model). The translation path is untouched by the option: θ is measured from the
 *  same reference and re-anchored with it, but never fed back into dx/dy.
 *
 *  Pure: no DOM or canvas access, so `track()` is unit-testable on plain `Gray` arrays. The caller
 *  (the recorder) does the actual `ctx.translate(-dx, -dy)` (and `ctx.rotate(theta)` about the frame
 *  centre) and crops a matching margin off the canvas so the transformed frame never shows an edge;
 *  `rotationMargin()` gives the extra margin the rotation needs. */
import { displacement } from './fftTrack'
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
  /** also estimate and correct in-plane rotation (default false; +2 `displacement()` calls per frame) */
  rotation?: boolean
  /** one-euro `minCutoff` for the rotation filter (Hz, default 0.5: rotation is slow drift) */
  rotationMinCutoff?: number
  /** clamp for the applied rotation correction, in degrees (default 2); `rotationMargin()` must be
   *  computed with the same value so the rotated frame never shows an edge */
  maxThetaDeg?: number
  /** |correction| below this many degrees is not applied at all (default 0.05), so a still scene is
   *  not resampled for nothing */
  thetaDeadbandDeg?: number
  /** the two side patches are at most this tall (px of the tracking frame, default 256), which bounds
   *  their FFT at 512 rows; centred vertically, so they still span the frame's middle */
  rotationPatchH?: number
}

export const defaultStabilizeOptions: StabilizeOptions = {
  reanchorPx: 40, minCutoff: 1, beta: 0.02, maxShiftPx: 24, minQuality: 1.5,
  registerOptions: { coarseW: 240, crop: 256, minQuality: 1.5 },
  rotation: false, rotationMinCutoff: 0.5, maxThetaDeg: 2, thetaDeadbandDeg: 0.05, rotationPatchH: 256,
}

/** Smoothing strength presets: the one-euro `minCutoff` in Hz. `light` (3 Hz) removes only fast
 *  vibration and follows the hand closely; `normal` (1 Hz) is today's default; `strong` (0.3 Hz)
 *  also damps the 0.3–1 Hz table "breathing" the report notes leaks through at 1 Hz, at the price
 *  of a larger lag behind a deliberate pan (so it needs the full crop margin). */
export type StabilizeStrength = 'light' | 'normal' | 'strong'

export const STABILIZE_STRENGTH_HZ: Record<StabilizeStrength, number> = { light: 3, normal: 1, strong: 0.3 }

/** `base` with `minCutoff` set for `strength`; everything else (clamps, rotation, register tuning)
 *  is kept, so callers compose it with their own size-dependent options. */
export function stabilizeOptionsFor(strength: StabilizeStrength, base: StabilizeOptions = defaultStabilizeOptions): StabilizeOptions {
  return { ...base, minCutoff: STABILIZE_STRENGTH_HZ[strength] }
}

/** Extra crop margin (px, same units as `width`/`height`) a rotation of up to `thetaMaxRad` about the
 *  frame centre needs, on top of the translation margin, so the crop never shows an uncovered edge.
 *  Exact for a rectangle: the crop corner `(w/2 − m, h/2 − m)` must stay inside the rotated source,
 *  which gives `m ≥ (b·sin θ − a·(1 − cos θ)) / (cos θ + sin θ)` for `(a, b) = (w/2, h/2)` (left/right
 *  edges) and `(h/2, w/2)` (top/bottom edges). For small θ this is `0.5·max(w, h)·sin θ`; the
 *  report's `0.5·h·sin θ` (≈ 11 px at 1° for 1232 rows) is the left/right-edge term only, the
 *  top/bottom edges of a landscape frame need `0.5·w·sin θ` (≈ 14 px at 1° for 1640 columns). */
export function rotationMargin(width: number, height: number, thetaMaxRad: number): number {
  const t = Math.abs(thetaMaxRad)
  if (t === 0) return 0
  const c = Math.cos(t), s = Math.sin(t)
  const need = (a: number, b: number): number => (b * s - a * (1 - c)) / (c + s)
  return Math.max(0, Math.ceil(Math.max(need(width / 2, height / 2), need(height / 2, width / 2))))
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
  /** rotation correction to apply, radians, about the frame centre (`ctx.rotate(theta)` after moving
   *  the origin to the centre); 0 unless `rotation` is on, the gate passed and |θ| exceeds the dead
   *  band. Positive `theta` rotates the drawn frame clockwise on screen (canvas y-down convention). */
  theta: number
  /** raw (unfiltered) accumulated rotation of the scene relative to the first anchor, radians */
  rawTheta: number
  /** true when this frame's rotation measurement passed the gate (both patches confident, x agree) */
  rotationConfident: boolean
}

/** One side patch: same rectangle in `ref`; in `img` offset by the integer whole-frame shift. */
function patchAt(g: Gray, x0: number, y0: number, w: number, h: number): Gray {
  const data = new Float32Array(w * h)
  for (let y = 0; y < h; y++) data.set(g.data.subarray((y0 + y) * g.width + x0, (y0 + y) * g.width + x0 + w), y * w)
  return { data, width: w, height: h }
}

export class Stabilizer {
  private reference: Gray | null = null
  private origin = { x: 0, y: 0 }
  private lastRaw = { x: 0, y: 0 }
  private thetaOrigin = 0
  private lastRawTheta = 0
  private fx: OneEuroFilter
  private fy: OneEuroFilter
  private ft: OneEuroFilter

  constructor(private opts: StabilizeOptions = defaultStabilizeOptions) {
    this.fx = new OneEuroFilter(opts.minCutoff, opts.beta)
    this.fy = new OneEuroFilter(opts.minCutoff, opts.beta)
    this.ft = new OneEuroFilter(opts.rotationMinCutoff ?? 0.5, 0)
  }

  /** Drop the reference and filter state: call after a stage move or a scene cut, so the next frame
   *  becomes the new anchor instead of being tracked against a now-unrelated reference. */
  reset(): void {
    this.reanchor()
    this.fx.reset(); this.fy.reset(); this.ft.reset()
  }

  /** Drop only the reference and origin (a deliberate stage move ended: the scene is new) but keep
   *  the one-euro filter state, so the frames after a jog are not over-smoothed from a cold filter.
   *  The next frame becomes the anchor and its correction is 0. */
  reanchor(): void {
    this.reference = null
    this.origin = { x: 0, y: 0 }
    this.lastRaw = { x: 0, y: 0 }
    this.thetaOrigin = 0
    this.lastRawTheta = 0
  }

  /** Feed the next frame (in order; `tSec` monotonic — the frame's *device* time, so decode jitter
   *  is not filtered as motion). Shifts are in the pixels of `gray`; the caller scales them to the
   *  frame it draws (see `recorder.svelte.ts#drawStreamFrame`). `theta` needs no scaling. */
  track(gray: Gray, tSec: number): StabilizeResult {
    if (!this.reference) {
      this.reference = gray
      this.fx.filter(0, tSec); this.fy.filter(0, tSec)
      if (this.opts.rotation) this.ft.filter(0, tSec)
      return { dx: 0, dy: 0, rawDx: 0, rawDy: 0, quality: Infinity, reanchored: true, theta: 0, rawTheta: 0, rotationConfident: false }
    }
    const ref = this.reference
    const d = register(ref, gray, { ...this.opts.registerOptions, minQuality: this.opts.minQuality })
    let raw = { x: this.origin.x + d.dx, y: this.origin.y + d.dy }
    if (d.confident) this.lastRaw = raw
    else raw = this.lastRaw

    // rotation: measured against the same reference, before it is possibly replaced below
    let rawTheta = this.lastRawTheta, rotationConfident = false
    if (this.opts.rotation && d.confident) {
      const m = this.measureRotation(ref, gray, Math.round(d.dx), Math.round(d.dy))
      if (m !== null) { rawTheta = this.thetaOrigin + m; this.lastRawTheta = rawTheta; rotationConfident = true }
    }

    let reanchored = false
    if (Math.hypot(d.dx, d.dy) > this.opts.reanchorPx) {
      this.reference = gray
      this.origin = raw
      this.thetaOrigin = rawTheta
      reanchored = true
    }
    const sx = this.fx.filter(raw.x, tSec)
    const sy = this.fy.filter(raw.y, tSec)
    let dx = raw.x - sx, dy = raw.y - sy
    const mag = Math.hypot(dx, dy)
    if (mag > this.opts.maxShiftPx) { const k = this.opts.maxShiftPx / mag; dx *= k; dy *= k }

    let theta = 0
    if (this.opts.rotation) {
      const st = this.ft.filter(rawTheta, tSec)
      // the scene rotated by (raw − smoothed) relative to the smoothed path: rotate it back
      let corr = st - rawTheta
      const maxT = (this.opts.maxThetaDeg ?? 2) * Math.PI / 180
      if (corr > maxT) corr = maxT; else if (corr < -maxT) corr = -maxT
      theta = Math.abs(corr) > (this.opts.thetaDeadbandDeg ?? 0.05) * Math.PI / 180 ? corr : 0
    }
    return { dx, dy, rawDx: raw.x, rawDy: raw.y, quality: d.quality, reanchored, theta, rawTheta, rotationConfident }
  }

  /** Rotation of `img` relative to `ref` (radians, positive = clockwise on screen in y-down
   *  coordinates) from the left and right thirds, or null when the gate fails. `ix`/`iy` is the
   *  integer whole-frame shift so the two patches of `img` show the content of the `ref` patches. */
  private measureRotation(ref: Gray, img: Gray, ix: number, iy: number): number | null {
    const w = ref.width, h = ref.height
    const pw = Math.floor(w / 3) - Math.abs(ix)
    const phMax = this.opts.rotationPatchH ?? 256
    const ph = Math.min(h - Math.abs(iy), phMax)
    if (pw < 24 || ph < 24) return null
    // vertical placement: centred rows, then shifted so both crops stay inside their frames
    let ry0 = Math.floor((h - ph) / 2), gy0 = ry0 + iy
    if (gy0 < 0) { ry0 -= gy0; gy0 = 0 } else if (gy0 + ph > h) { const o = gy0 + ph - h; ry0 -= o; gy0 -= o }
    const lx = Math.max(0, -ix), rx = w - pw - Math.max(0, ix)
    const L = displacement(patchAt(ref, lx, ry0, pw, ph), patchAt(img, lx + ix, gy0, pw, ph))
    const R = displacement(patchAt(ref, rx, ry0, pw, ph), patchAt(img, rx + ix, gy0, pw, ph))
    const minQ = this.opts.minQuality
    const ok = (q: number): boolean => !Number.isFinite(q) || q >= minQ
    if (!ok(L.quality) || !ok(R.quality)) return null
    // a rotation moves the two patches by ±(baseline/2)·sin θ in y and ~0 in x; a patch that
    // disagrees in x is tracking something else (an organism, a mistrack)
    if (Math.abs(L.dx - R.dx) > 1) return null
    const baseline = rx - lx
    const theta = Math.atan2(R.dy - L.dy, baseline)
    // beyond twice the correction clamp the two patches are not seeing a rigid rotation
    if (Math.abs(theta) > 2 * (this.opts.maxThetaDeg ?? 2) * Math.PI / 180) return null
    return theta
  }
}
