# Video research: motion and time

Scope: stabilisation, temporal resampling, motion visualisation/analysis in the live recorder
(`services/recorder.svelte.ts` → `services/video/*` → `algo/*`). Given: 1640×1232 RGBA at ~18 fps
(Nyquist 9 Hz), synchronous `process()`, exact device timestamps, stage position per frame, CSM
calibration (px ↔ steps). Budget: one full-frame pass in TS ≈ 4–6 ms; > 25 ms/frame drops frames.
Every proposal computes on a ≤ 410-px luma (`boxDown` in `register.ts`) and touches full
resolution once, to render.

## Ranked proposals (value for effort)

### 1. Stage-aware stabilisation
**Benefit.** Stabilisation stays on through jog, drag-to-pan and scans: the commanded pan is kept,
the residual (backlash overshoot, settling ring, table vibration) is removed.
**Algorithm.** Predicted shift `p = CSM⁻¹·(pos_t − pos_ref)` in px (`StageShiftTracker` already
computes this for denoise), with `pos_t` interpolated at the frame's device time from
`event.position` t0/t1. Pass `round(p)` as the coarse offset into `register()` so it measures only
the residual `r = measured − p`; the one-euro filter smooths `r`. Do not reset while
`device.moving`; widen `maxShiftPx` ×2 instead. Re-anchor when `|p| > reanchorPx` (reference no
longer overlaps).
**Cost.** Same as today. **UI.** None; silently falls back to today's behaviour without a
calibration. **Failure.** Wrong calibration → the residual has a constant slope during a pan, which
the filter follows: no worse than now. Organisms are small against a whole-frame correlation.
**Reset.** Reconnect, or `confident === false` for > 5 frames.

### 2. Fix the stabiliser's scale and clock, then add rotation
**Benefit.** The stabiliser currently applies ~0.29× the needed correction (critique below); fixing
that is the largest visible win. Rotation covers slow drift on a rotated stage axis (the fake has 4°).
**Algorithm.** (a) `dx_full = dx_gray·bitmap.width/gray.width`; margin and `maxShiftPx` in full-res
px; feed an 820-px luma so the fine crop sees real detail. (b) Feed `track()` the device time, not
`performance.now()`. (c) Keep `drawImage` at fractional offsets (bilinear = sub-pixel) but quantise
to 1/8 px so the encoder does not see resampling noise. (d) Rotation: register the left and right
thirds of the luma separately (two extra `displacement()` calls on ~136×300 crops, ≈ 2 ms);
`θ = atan2(dy_R − dy_L, baseline)`, own one-euro filter (`minCutoff` 0.5 Hz), applied with
`setTransform` about the frame centre when `|θ| > 0.05°` and both crops are confident and agree in
x within 1 px. Margin grows by `0.5·h·sin θ_max` (≈ 11 px at 1°).
**Cost.** +2 ms. **UI.** Strength (`minCutoff` 0.3–3 Hz), rotation toggle. **Failure.** A large
organism in one half biases θ (the agreement gate catches it); gratings score low quality and are
ignored. **Reset.** As today, plus θ = 0.

### 3. Lock-to-specimen (tracker-driven digital follow)
**Benefit.** A swimming organism stays centred without moving the stage; the follow controller
only fires when the target nears the frame edge.
**Algorithm.** `detectBlobs` + the existing linker on the 410-px luma; selected track centroid →
one-euro (`minCutoff` 0.8, `beta` 0.05) → crop window `W×H` centred on it, rendered with a
source-rect `drawImage`. Within `0.15·W` of the edge, issue the follow move (`compensate: false`)
and shift the crop by the predicted stage shift (proposal 1 maths) while it moves so the target
does not jump. Lost > 10 frames: hold the last centre, show a "lost" HUD state.
**Cost.** ≈ 3 ms. **UI.** Output size preset, click-to-select target (reuse the tracker UI).
**Failure.** Merging organisms → centroid jump, bounded by the linker's `maxDisp`; the user picks
the blob when debris is tracked. **Reset.** On target loss only, never on stage motion.

### 4. Dense optical-flow visualisation (grid LK → HSV wheel / arrows)
**Benefit.** Shows direction and speed (cilia-driven currents, cytoplasmic streaming, swimming
heading), which highlight/trails cannot.
**Algorithm.** Pyramidal Lucas–Kanade on 8×8 cells, 3 levels (410 → 205 → 102), 2 iterations per
level (shifts to ~12 px): solve `[ΣIx² ΣIxIy; ΣIxIy ΣIy²]·[u v]ᵀ = −[ΣIxIt ΣIyIt]ᵀ` on a
σ≈1-blurred luma; reject cells with the smaller eigenvalue < τ (aperture problem) or high residual;
EMA per cell α = 0.3. Render hue = direction, value = min(1, |v|/v_max) over the dimmed grey frame,
or arrows on a 32-px grid; emit mean speed and dominant direction to `stats()`.
**Cost.** 6–8 ms + one blend pass. **UI.** Wheel / arrows, `v_max` (auto: 95th percentile), grid
step, α. **Failure.** A stage pan paints the whole field one colour: subtract the predicted stage
shift from every vector and blank while `device.moving`; flicker gives uniform false flow, so run
after deflicker (order 50, already guaranteed). **Reset.** Clear the EMA on motion or reconnect.
[Farnebäck 2003](https://www.diva-portal.org/smash/get/diva2:273847/FULLTEXT01.pdf) costs 3–4× more
for no gain on a coarse grid; [DIS](https://github.com/tikroeger/OF_DIS) is the model if LK is too slow.

### 5. Kymograph along a user line
**Benefit.** The standard quantitative view for beating cilia, particle flow and growing tips:
a space–time image whose slopes are velocities, exported as PNG + CSV.
**Algorithm.** Per frame, sample a user polyline at 1-px spacing (bilinear luma or RGB), averaging
across a `w`-px perpendicular band (as ImageJ's KymographBuilder), and append the profile as a row
with its device timestamp (capped ring of 10,000 rows). Draw live beside the video with rows at
their true `t`; velocity from `scaleCal` µm/px. Shift the sampled line by the predicted stage shift
so it stays attached to the specimen during small pans; mark rows taken while `device.moving`.
**Cost.** ≈ 0.1 ms. **UI.** Line tool, band width 1–15 px, contrast stretch, export.
**Failure.** Stage moves smear rows (marked); focus drift changes contrast only.
**Reset.** Never automatic. Input format users expect: [KymoButler](https://elifesciences.org/articles/42288);
do not attempt its tracing network.

### 6. Event-triggered recording with pre-roll
**Benefit.** Watch an empty field for hours; the file starts seconds before an organism enters and
stops after it leaves.
**Algorithm.** Ring of raw MJPEG parts + timestamps (5 s ≈ 90 frames ≈ 15 MB). Trigger = fraction
of pixels with `diff > k·σ` from `BackgroundModel` on the 205×154 luma; start after 3 consecutive
frames above `on`, stop after `post` s below `off < on`. On start, decode and push the ring in
order (the recorder already accepts frames with their own `t`), then run live; on stop, finalise
and open the next segment. `device.moving` inhibits triggering for 1 s after the move.
**Cost.** 0.5 ms armed; a ~1.5 s decode burst at start, bounded by the encoder's queue.
**UI.** Sensitivity (0.2–5 % of the field), pre-roll 2–10 s, post-roll 1–30 s, max segments; gallery
meta `event: { trigger, energyPeak }`. **Failure.** Flicker or AE hunting triggers: hold the camera
lock while armed and run after deflicker; slow organisms under `k·σ` are missed. **Reset.**
Background resets on stage motion; arming waits 2 s for it to relearn.

### 7. Running-median background for motion highlight
**Benefit.** A stationary-then-moving organism is no longer absorbed and a passing one leaves no
ghost.
**Algorithm.** McFarlane–Schofield increment/decrement: `bg += sign(luma − bg)·s`, `s = 1/4` per
frame (converges to the temporal median; a pixel occupied < 50 % of the time is never learned).
Keep the MAD σ; add a per-pixel running mean of |diff| (α 0.02) and threshold on
`max(k·σ, 2.5·mad_local)` so dark noisy corners stop flickering.
**Cost.** One pass, as today. **UI.** Adaptation `s` 0.1–1, sensitivity `k`. **Failure.** Whole-field
thermal drift shows as motion after minutes; proposal 1 fixes lateral drift, not focus.
**Reset.** Re-seed `bg` from the first settled frame after a move (converging at `s` takes ~100 frames).

### 8. Speed ramps, constant-rate output, interval averaging
**Benefit.** Time compression gains a presentation ramp (real time → 60× → real time); skipping
modes (lucky, time compression) gain stutter-free playback; long intervals gain free √N denoising.
**Algorithm.** Ramp: speed keyframes `(t_in, speed)`; `accept()` keeps a frame when `∫speed dt`
since the last kept frame ≥ 1/fps_out, `retime()` returns `kept/fps_out`. Constant rate: an opt-in
flag on `VideoModeRun` (default off so scientific recordings keep true times). Averaging: a
`SlidingMean` over each interval instead of picking one frame when the interval ≥ 4 frame periods.
**Cost.** Zero; averaging one pass. **UI.** Small keyframe timeline; two toggles. **Failure.**
Averaging smears fast swimmers; default off above a motion-energy threshold. **Reset.** None.

### 9. Full-frame stabilisation by margin fill from history
**Benefit.** No crop: the uncovered border shows what was there a few frames ago.
**Algorithm.** A persistent mosaic canvas 2·margin larger than the frame in smoothed coordinates:
draw each stabilised frame into it (overwrites the centre), copy out the frame-size window;
feather the frame edge by 8 px so the seam does not flicker; clear on re-anchor jumps > margin.
**Cost.** Two `drawImage`s. **UI.** Crop / fill radio. **Failure.** An organism leaving the edge
freezes in the ≤ 26-px band until the band is re-covered. **Reset.** With the stabiliser.

### 10. Motion-compensated frame interpolation (export only)
**Benefit.** Smoother 36/54 fps playback of fast swimmers.
**Algorithm.** Bilateral block matching on the 410-px luma (16×16 blocks, ±6 px around the
proposal-4 flow, vector anchored in the intermediate frame so there are no holes), then overlapped-
block motion compensation with a raised-cosine window at full resolution, both directions 50/50;
`t = (t_A + t_B)/2`; fall back to blending where the match error is high.
**Cost.** 15–20 ms per interpolated frame, so only in `timelapseExport.ts`/`encodeWorker.ts`.
**UI.** Export-time 2×/3×. **Failure.** Ghosting where organisms overlap.
Reference: [bilateral ME for FRUC](https://www.researchgate.net/publication/3183347_Motion_Compensated_Frame_Rate_Up-Conversion_Using_Extended_Bilateral_Motion_Estimation).

## (a) Critiques of the existing code

**Stabiliser (`algo/stabilize.ts`, `recorder.svelte.ts#drawStreamFrame`)**
- **Scale bug.** `grayOf()` downsamples to `GRAY_WIDTH = 480`; `track()` returns a shift in those
  pixels; `drawImage(bitmap, −margin − dx, …)` applies it unscaled to the 1640-px bitmap. The
  correction is 480/1640 ≈ 0.29 of what is needed, `maxShiftPx = 24` and the margin are in the
  wrong units, and `register()`'s "full-resolution" fine crop runs on a 3.4× downscale, so it is not
  sub-pixel at sensor resolution. Fix as in proposal 2(a).
- **Wrong clock.** `performance.now()` at draw time drives the one-euro `dt`, so decode jitter is
  filtered as motion. Use the frame's device time.
- **Reset while moving loses the filter state**, so the frames after a jog are over-smoothed.
  Proposal 1 removes the reset.
- **Re-anchor** at `reanchorPx = 40` gray px (≈ 137 full-res px) lets the correlation window grow
  large before rebasing; use ~20 full-res px once the scale is fixed, keep `origin` as a float.
- `minCutoff = 1 Hz` passes 0.3–1 Hz table "breathing"; expose strength. L1 optimal paths
  ([Grundmann 2011](https://research.google/pubs/auto-directed-video-stabilization-with-robust-l1-optimal-camera-paths/))
  need the whole path: export-time only, if ever.

**Motion highlight / trails / colour code (`algo/motionViz.ts`)**
- `BackgroundModel` (α = 0.03, ≈ 1.8 s time constant) absorbs anything moving < threshold per
  frame; running median (proposal 7).
- All three allocate and sort a `sample: number[]` every frame; use a preallocated buffer and a
  256-bin histogram median (O(n)).
- All three threshold on luma only; a coloured organism on a luminance-matched background is
  invisible. Use `max(|ΔR|,|ΔG|,|ΔB|)` at ≈ 1.2× the luma threshold.
- `TemporalColorCode`: `decay = 0.985` fades in ~70 frames while `period = 90`, so the oldest third
  of a cycle is gone; default `decay = 1 − 1/(3·period)`.
- Trails use a two-frame difference, so slow movers never enter the MHI; offer the background
  difference as the source, which is what makes MHI trails read as trajectories.

**Eulerian magnification (`algo/eulerian.ts`)**
- Analysable band < 9 Hz at 18 fps: cilia and flagella (10–30 Hz) alias. Say so in the UI and
  clamp `fHi ≤ 0.45·fps` measured from timestamps.
- Box downsample ×8 without pre-blur aliases texture into the coarse grid and the bilinear add-back
  paints 8-px blocks; use two 5-tap binomial reductions (×4) and add back through the pyramid.
- After `reset()` the low-pass takes ~1/fLo = 2 s to settle and any intensity trend is amplified as
  a flash; ramp `alpha` from 0 over `2/fLo` s.
- A Riesz-pyramid phase-based variant ([Wadhwa 2014](https://ieeexplore.ieee.org/document/6831820/))
  is feasible in TS (3-tap spatial filters, quaternion phase per level) and allows far larger
  amplification without blow-out; add as a "phase" toggle only if Magnify sees real use.

**Time compression (`timeModes.ts`)**: correct; add ramps and interval averaging (proposal 8).

**Lucky imaging (`videoStack.ts#QualityGate`)**: `frameSharpness` at stride 2 is noise-dominated on
a dim field; normalise the Laplacian by the local mean or compute it on a 2× box-down. The 60-frame
percentile window adapts to slow focus drift and keeps drifting frames; take the percentile over the
whole run past 60 frames.

**Tracker (`tracking.ts`)**: a global mean ± kσ threshold fails on uneven illumination; threshold
against `BackgroundModel.bg` when one exists.

## (b) Do not bother

- **Live L1 camera paths.** The LP needs the whole trajectory; a 30-frame window adds 1.7 s
  latency for no gain over one-euro on a microscope, where there are no cinematic paths.
- **MeshFlow / homography models.** A plane imaged orthographically has no parallax and negligible
  rolling shutter at 18 fps; translation + rotation is the complete model
  ([MeshFlow](https://link.springer.com/chapter/10.1007/978-3-319-46466-4_48) solves another problem).
- **Farnebäck at full resolution.** 3–4× grid-LK's cost; the overlay is downsampled anyway.
- **Mixture-of-Gaussians backgrounds.** Multimodal backgrounds come from trees and monitors, not
  bright-field slides; the running median gives the benefit at a fifth of the cost.
- **Live frame interpolation.** ~20 ms/frame competes with decoding; export only.
- **In-browser learned tracking / kymograph tracing.** Model size and WebGPU availability make it
  an offline analysis feature, not a recording mode.
- **Pre-roll of decoded bitmaps.** 8 MB/frame, 5 s = 720 MB; keep JPEG parts.
- **Lanczos resampling for stabilisation.** `drawImage` bilinear at fractional offsets suffices for
  8-bit video; Lanczos belongs to the stack paths that already use it.
