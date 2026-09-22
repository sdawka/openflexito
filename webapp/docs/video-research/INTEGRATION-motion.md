# Integration note: rotation stabilisation, strength presets, re-timing, hold edges

Implements `docs/video-research/motion.md` proposals 2(d) (rotation), 2 "UI: strength", 8 and the
"constant frame rate" addendum (re-timing), and 9 / the "hold edges" addendum (margin fill). The
pure code is in `src/lib/algo/stabilize.ts` and `src/lib/algo/retime.ts` (vitest-covered in
`algo/__tests__/{stabilize,retime}.test.ts`). Nothing in the recorder, the mode catalogue or the UI
was touched; this note says exactly where each API plugs in. Method names below refer to
`services/recorder.svelte.ts` as of this writing (`drawStreamFrame`, `resizeIfNeeded`,
`encodeOutput`, formerly `pushFrame`); if the pre-roll/trigger work moves them, the hook points are
"the one place the stabilised frame is drawn" and "the one place `sink.addFrame` is called".

## 1. APIs

### `algo/stabilize.ts`

```ts
interface StabilizeOptions {
  // existing: reanchorPx, minCutoff, beta, maxShiftPx, minQuality, registerOptions
  rotation?: boolean          // default false
  rotationMinCutoff?: number  // Hz, default 0.5
  maxThetaDeg?: number        // clamp of the applied correction, default 2
  thetaDeadbandDeg?: number   // below this nothing is applied, default 0.05
  rotationPatchH?: number     // side-patch height cap in tracking px, default 256
}
interface StabilizeResult {
  dx: number; dy: number; rawDx: number; rawDy: number; quality: number; reanchored: boolean
  theta: number              // radians: rotation correction to apply about the frame centre; 0 when off/gated
  rawTheta: number           // radians: accumulated raw scene rotation (diagnostics / HUD)
  rotationConfident: boolean // this frame's θ measurement passed the gate
}
type StabilizeStrength = 'light' | 'normal' | 'strong'           // 3 / 1 / 0.3 Hz
const STABILIZE_STRENGTH_HZ: Record<StabilizeStrength, number>
function stabilizeOptionsFor(strength, base = defaultStabilizeOptions): StabilizeOptions
function rotationMargin(width, height, thetaMaxRad): number       // extra crop margin, px, integer
```

- `dx`/`dy` are still in **tracking-frame px** and must be scaled by `grayScale`; `theta` needs no
  scaling (an angle is the same at any scale).
- Sign: `theta` is what to pass to `ctx.rotate()` (canvas y-down convention: positive = clockwise on
  screen). It is already `smoothed − raw`, i.e. the negative of the jitter, so apply it as-is.
- The rotation measurement is gated: both side patches must have correlation quality ≥ `minQuality`,
  agree in x within 1 px, and give |θ| ≤ 2·`maxThetaDeg`; otherwise the last raw θ is reused for the
  frame (like the translation path does on a bad frame). `|correction| < thetaDeadbandDeg` → `theta = 0`.
- `reset()`/`reanchor()` also clear the rotation origin; the θ filter keeps its state on `reanchor()`.
- Cost with `rotation: true`: two extra `displacement()` calls on ≈ 160×256 patches of the 480-px
  tracking frame (each a 512×512 FFT triple), ≈ 2 ms; nothing when off.
- `rotationMargin()` is exact for a rectangle rotated about its centre. For 1640×1232 it is 15 px at
  1° and 29 px at 2° (`maxThetaDeg` default). The report's `0.5·h·sin θ` (≈ 11 px) covers only the
  left/right edges; the top/bottom edges of a landscape frame need `0.5·w·sin θ`.

### `algo/retime.ts`

```ts
type RetimeMode = 'vfr' | 'cfr' | 'ramp'
interface SpeedKeyframe { tIn: number /* s since first frame */; speed: number /* >0, 1 = real time */ }
interface RetimeOptions { mode: RetimeMode; fps?: number; keyframes?: SpeedKeyframe[] }
interface RetimeResult { emit: boolean; tOut: number; duplicates: number; duplicateTimes: number[] }
class Retimer {
  constructor(opts: RetimeOptions)       // throws for cfr without fps
  push(tSec: number): RetimeResult       // tSec = device time in seconds (same origin the sink already gets)
  reset(): void
  stats(): { pushed; emitted; duplicates; dropped }
  get outputTime(): number
}
// pure helpers for a UI preview of a ramp
function speedAt(keyframes, tRel): number
function outputTimeAt(keyframes, tRel): number
function normaliseKeyframes(kf): SpeedKeyframe[]  // sorted, speeds > 0
```

Semantics (also in the file's doc comment):

- `vfr`: identity. `emit` is always true, `tOut = tSec` (nudged +1 µs if the input repeats or
  goes backwards). This is the default and keeps true timing.
- `cfr`: slot `k` at `t0 + k/fps`, `t0` = first pushed time. A frame is emitted when its time has
  reached the next unfilled slot, and is placed at the latest slot at or before its time. When more
  than one slot passed since the last emitted frame, `duplicates` = number of intermediate slots and
  `duplicateTimes` lists their times (ascending, all `< tOut`). A frame that arrives before the next
  slot is dropped (`emit: false`).
- `ramp`: `tOut = t0 + ∫₀^{tSec−t0} dt/speed(t)` with piecewise-linear `speed(t)` between keyframes
  (constant before the first/after the last), closed form per segment. With `fps`, a frame is kept
  only when the output has advanced ≥ 1/fps since the last kept frame (dropped otherwise); without
  it every frame is kept. No duplicates in this mode (slow-motion stretches are simply sparser;
  players hold the last frame).
- Output times are strictly increasing (≥ 1 µs apart) across emits and duplicates.

## 2. Wiring the stabiliser: `drawStreamFrame` + margin

### Options

Add to `RecorderOptions`:

```ts
/** one-euro cutoff preset for the stabiliser ('normal' = today's 1 Hz) */
stabilizeStrength?: 'light' | 'normal' | 'strong'
/** also correct in-plane rotation (+2 ms/frame, +15..29 px crop) */
stabilizeRotation?: boolean
/** 'crop' = today's behaviour; 'hold' = keep the previous content under the uncovered margin (§4) */
stabilizeEdges?: 'crop' | 'hold'
```

Defaults: `'normal'`, `false`, `'crop'`. Persist alongside the existing `stabilize` flag; record
`stabilizeStrength`/`stabilizeRotation`/`stabilizeEdges` in the video item meta next to `stabilised`.

### Margin

The margin is decided in `start()` before the first frame (`this.margin = o.stabilize ? STAB_MARGIN_PX + 2 : 0`),
and the frame size is only known at the first frame. `rotationMargin` depends on the frame size, so
either take it at the first frame (before `resizeIfNeeded`) or use the known 1640×1232 stream size.
Recommended: compute it lazily once per recording where the `Stabilizer` is constructed and let
`resizeIfNeeded` pick it up (it reads `this.margin` on every call):

```ts
const STAB_THETA_MAX_DEG = 2

private drawStreamFrame(frame: MjpegFrame): void {
  const { bitmap } = frame
  let dx = 0, dy = 0, theta = 0
  if (this.stabilizeWanted) {
    if (!this.stabilizer) {
      this.grayScale = bitmap.width / Math.max(1, Math.round(bitmap.width * Math.min(1, GRAY_WIDTH / bitmap.width)))
      const base = stabilizeOptionsFor(this.optsUsed.stabilizeStrength ?? 'normal', {
        ...defaultStabilizeOptions,
        maxShiftPx: STAB_MARGIN_PX / this.grayScale,
        reanchorPx: 20 / this.grayScale,
        rotation: !!this.optsUsed.stabilizeRotation,
        maxThetaDeg: STAB_THETA_MAX_DEG,
      })
      this.stabilizer = new Stabilizer(base)
      // rotation needs a wider crop; set it before the first resizeIfNeeded of this recording
      if (base.rotation) this.margin = STAB_MARGIN_PX + 2 + rotationMargin(bitmap.width, bitmap.height, STAB_THETA_MAX_DEG * Math.PI / 180)
    }
    this.resizeIfNeeded(bitmap.width, bitmap.height)
    const moving = device.moving && !this.mode?.drivesStage
    if (moving) { if (!this.wasMoving) this.stabilizer.reanchor(); this.wasMoving = true }
    else {
      if (this.wasMoving) this.stabilizer.reanchor()
      this.wasMoving = false
      const g = this.grayOf(bitmap)
      const r = this.stabilizer.track(g, frame.ts != null ? frame.ts / 1e9 : performance.now() / 1000)
      // quantised to 1/8 px so the encoder does not see resampling noise on a still scene
      dx = Math.round(r.dx * this.grayScale * 8) / 8; dy = Math.round(r.dy * this.grayScale * 8) / 8
      theta = r.theta   // radians, 0 unless rotation is on and the gate passed
    }
  } else this.resizeIfNeeded(bitmap.width, bitmap.height)

  const ctx = this.ctx!
  if (theta !== 0) {
    // rotate about the *source frame's* centre, which in canvas coordinates (after the margin crop)
    // sits at (bitmap.w/2 − margin, bitmap.h/2 − margin); translation is applied in the same transform
    const cx = bitmap.width / 2 - this.margin, cy = bitmap.height / 2 - this.margin
    const c = Math.cos(theta), s = Math.sin(theta)
    // setTransform(a, b, c, d, e, f): x' = a·x + c·y + e ; y' = b·x + d·y + f
    ctx.setTransform(c, s, -s, c, cx - c * cx + s * cy - dx, cy - s * cx - c * cy - dy)
    ctx.drawImage(bitmap, -this.margin, -this.margin, bitmap.width, bitmap.height)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  } else {
    ctx.drawImage(bitmap, -this.margin - dx, -this.margin - dy, bitmap.width, bitmap.height)
  }
}
```

Notes for the integrator:

- The `setTransform` above is `translate(cx, cy) · rotate(theta) · translate(−cx, −cy) · translate(−dx, −dy)`
  written out; `ctx.translate(cx, cy); ctx.rotate(theta); ctx.translate(-cx - dx, -cy - dy)` is the
  same thing if you prefer the composable calls. Always reset the transform afterwards: the frame
  chain's `getImageData`/`putImageData` are unaffected, but `drawBurnIn` and the `outCtx.drawImage`
  copy are not.
- The `1/8 px` quantisation stays on dx/dy only. Do not quantise θ: the dead band already keeps a
  still scene untouched, and 0.05° at 820 px from the centre is 0.7 px, coarser than the translation
  quantum.
- The ordering change (`resizeIfNeeded` after the margin is set) matters only on the first frame.
  The existing `injectRing` (pre-roll) path draws with `-this.margin` too and needs no change other
  than the same margin value.
- `reanchor()` on move start/stop also zeroes the rotation origin, so a jog is never fought as a
  rotation either.
- HUD/diagnostics: `r.rawTheta` (degrees = `·180/π`) and `r.rotationConfident` are worth a line in
  the recorder's status while rotation is on; θ drift on a real stage is the report's "4° rotated
  axis" case and the user may want to see it.

## 3. Wiring the re-timer: `encodeOutput` (formerly `pushFrame`) and the duplicate count

### Options

```ts
/** output timing: 'vfr' keeps true times (default); 'cfr' = constant rate at retimeFps; 'ramp' = speed keyframes */
retime?: 'vfr' | 'cfr' | 'ramp'
retimeFps?: number                       // cfr slot rate / ramp max rate (default 18 = the stream rate)
retimeKeyframes?: SpeedKeyframe[]        // ramp
```

The mode's own `retime` hook (time-lapse's `t0 + kept/fps`) runs **first** and remains; the
`Retimer` sits between it and `sink.addFrame`, so e.g. lucky + cfr gives a stutter-free lucky
video and time-lapse + ramp still works. Create it in `start()` (`this.retimer = o.retime && o.retime !== 'vfr' ? new Retimer({ mode: o.retime, fps: o.retimeFps ?? 18, keyframes: o.retimeKeyframes }) : null`)
and drop it in `stop()`.

```ts
private retimer: Retimer | null = null
private retimeDuplicated = 0
private retimeDropped = 0

private encodeOutput(tOut: number | null, seq: number): void {
  if (!this.sink || !this.recording) return
  let tSec = tOut != null ? tOut / 1e9 : performance.now() / 1000
  if (this.mode?.retime) tSec = this.mode.retime(tSec)
  let dupTimes: number[] = []
  if (this.retimer) {
    const r = this.retimer.push(tSec)
    if (!r.emit) { this.retimeDropped++; return }   // before the next slot: nothing to encode
    tSec = r.tOut
    dupTimes = r.duplicateTimes
  }
  if (this.firstOutT == null) this.firstOutT = dupTimes[0] ?? tSec
  if (this.burnIn.length) { /* unchanged; elapsedS uses tSec */ }
  // the intermediate slots get the same canvas (the recorder only has the current frame), then
  // the frame itself at its slot; each addFrame may be refused by the encoder backlog independently
  for (const td of dupTimes) if (this.sink.addFrame(this.outCanvas!, td)) this.retimeDuplicated++
  if (this.sink.addFrame(this.outCanvas!, tSec)) {
    this.frames++
    this.log.push({ t: tOut ?? 0, seq, position: { ...device.position } })
    if (this.frames === 20) this.captureThumbnail()
  }
}
```

Counting: the sink's `duplicated` is 0 for the WebCodecs sink and `frames` for the MediaRecorder
fallback without `requestFrame`. In `stop()` write
`framesDuplicated: result.duplicated + this.retimeDuplicated` and
`framesDropped: result.dropped + this.retimeDropped` into the item meta (the gallery already shows
both fields). Do **not** push duplicates into `this.log` (it is the per-real-frame position log) and
do not count them in `this.frames` (the "frames" the status line reports are captured frames).
Record `retime: { mode, fps, keyframes, ...retimer.stats() }` under `item.video` for the Viewer.

Burn-in with duplicates: the burn-in is drawn once on the canvas before the loop, so the duplicates
carry the same elapsed-time text as the frame. If exact per-slot timestamps matter, draw the burn-in
inside the loop with `elapsedS = td − firstOutT` before each `addFrame` (cost: one text draw each).

Hold-last vs repeat-current: the report's "hold the latest frame" would put the *previous* frame in
the skipped slots. That needs a copy of the previous output canvas (an extra `drawImage` of
1640×1232 per frame). The repeat-current semantics implemented here is what the task fixed; if the
integrator wants hold-last, keep `this.prevOut: OffscreenCanvas`, draw the current output into it
after the `addFrame`, and pass `this.prevOut` in the duplicate loop.

Encoder backlog: a `cfr` at 30 fps from an 18 fps stream adds ~12 duplicate samples per second. The
WebCodecs sink's in-flight cap (`maxInFlight`) will start refusing frames on a slow machine; the
refusals are counted in `result.dropped` as today. Consider defaulting `retimeFps` to the measured
stream rate (the `FrameMeta` timestamps give it) rather than a fixed 18.

## 4. "Hold edges" for the stabiliser (proposal 9 / addendum)

Today the canvas is `(w − 2·margin) × (h − 2·margin)` and the translated frame always covers it, so
nothing is uncovered: the margin is a **crop**. "Hold edges" keeps the full frame size instead and
lets the translated/rotated frame *not* cover the border strip, which then shows what was drawn there
on earlier frames (slightly stale pixels rather than a black band or a crop).

Precise recipe, in `drawStreamFrame`, when `stabilizeEdges === 'hold'`:

1. **Canvas size = source size.** In `resizeIfNeeded` use `margin = 0` for the canvas size when
   holding (`cw = w, ch = h`); keep `STAB_MARGIN_PX` (+ rotation margin) only as the correction clamp
   (`maxShiftPx`) — it no longer crops. `outputSize` reported to the mode/sink is the full frame.
2. **Never clear the canvas** between frames (the 2D context keeps its contents; today's
   `drawImage` overwrites everything, so the hold comes for free once the canvas is not cleared).
   `resizeIfNeeded` resizing the canvas element clears it: that only happens on the first frame.
3. **Draw the warped frame over the previous content** with the same transform as §2 but with
   `margin = 0`:
   `ctx.drawImage(bitmap, -dx, -dy, w, h)` (or the `setTransform` form with `cx = w/2, cy = h/2`).
   The uncovered strip (up to `maxShiftPx` + rotation margin wide, ≤ 26 px at the defaults the
   report quotes) keeps the previous frame's pixels.
4. **Feather the seam by 8 px** so the boundary between fresh and stale pixels does not flicker:
   draw the frame through a soft-edged mask instead of directly. Implementation with no per-pixel
   JS: keep one `OffscreenCanvas` `maskCanvas` of the frame size holding a white rectangle whose
   8-px border fades to transparent (build once: fill white, then
   `ctx.globalCompositeOperation = 'destination-out'` and paint four 8-px linear gradients along the
   edges, or simply `ctx.filter = 'blur(4px)'` on a rectangle inset by 4 px). Per frame:
   - `warp.setTransform(...)`; `warp.drawImage(bitmap, 0, 0)` into a scratch `OffscreenCanvas warp`
     of frame size (cleared first);
   - `warp.setTransform(1,0,0,1,0,0)`; `warp.globalCompositeOperation = 'destination-in'`;
     `warp.drawImage(maskCanvas, 0, 0)` (the warped frame now has an 8-px alpha ramp at its own edge);
   - `warp.globalCompositeOperation = 'source-over'`;
   - `ctx.drawImage(warp, 0, 0)` onto the persistent recording canvas.
   Cost: two extra full-frame `drawImage`s (≈ 2 ms). Note the mask must be applied in the *warped*
   frame's coordinates (its own edge), which is why it goes through the scratch canvas rather than
   masking the destination.
5. **Reset the held content on a re-anchor jump.** When `r.reanchored` is true and the origin
   moved by more than the margin (a jog ended; the scene is new), the stale border is unrelated
   content: draw the frame once *without* the feather/hold (plain `drawImage` at `(−dx, −dy)` after
   `ctx.clearRect`) so the border refreshes in one go. Same when `device.moving` flips.
6. **Frame chain / modes** are unaffected: they read `getImageData` off the canvas after the draw, as
   now. The gallery item should record `stabilizeEdges: 'hold'` so the Viewer can explain the
   ≤ 26-px band of frozen pixels around a specimen leaving the field (the report's stated failure).

Interaction with §2: with `'hold'` the rotation margin is not needed for cropping, only for the
clamp; keep `maxThetaDeg` as the clamp and skip `rotationMargin()` in the canvas size.

## 5. UI to expose (Photo panel → Record video → encoder options, next to "Stabilise")

- **Stabilise strength**: three-way `light / normal / strong` (3 / 1 / 0.3 Hz), shown only when
  Stabilise is on. Tooltip: "light: follows the hand, removes fast vibration; strong: also damps slow
  table breathing, lags a deliberate pan more".
- **Rotation**: checkbox under Stabilise (default off). Tooltip: "corrects slow rotation drift
  (+2 ms/frame, crops 15–29 px more)".
- **Edges**: radio `crop / hold` (default crop). Tooltip for hold: "no crop; the border shows
  slightly stale pixels".
- **Output timing**: select `true times (VFR) / constant rate / speed ramp`; with `constant rate` a
  fps field (default the stream's rate, 18); with `speed ramp` a small keyframe list
  (time, speed) plus a preview line "0–3 s real time, 3–8 s 60×, …" computed with `outputTimeAt`
  for the total output length. VFR stays the default: scientific recordings keep true timing.
- Gallery Viewer *Video* section: show `retime` mode/fps and the duplicate/drop counts (fields exist),
  plus `stabilizeStrength`/`stabilizeRotation`/`stabilizeEdges`.

## 6. Verification the integrator should add to the e2e

- Record with rotation on against the fake (its axes are rotated 4°, so a jog produces a real
  rotation change relative to the reference: after the jog settles `rawTheta` should be ≈ 0 again
  because the re-anchor zeroes it, while `theta` stays 0 on a still scene). Check the saved item's
  size is the source minus `2·(42 + rotationMargin)`.
- Record 3 s with `cfr` at 30 fps: the saved meta must show `framesDuplicated > 0`, `framesDropped`
  small, and the MP4 duration ≈ 3 s.
- Record with a two-keyframe ramp (1× → 10× at 1 s): duration well under the wall time.
