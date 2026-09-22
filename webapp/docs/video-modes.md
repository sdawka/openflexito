# Video modes

Recording used to mean "encode the live view". It now has modes, the way still capture has
modes: a mode picker in the Photo panel under **Record video**, a blurb, a cost line, per-mode
parameters, burn-in overlays, and the shared encoder options (container, codec, quality,
keyframe, stabilise, deflicker, bake look).

## Architecture

```
MJPEG part → stabilise (working canvas) → frame chain < 900 (deflicker 50, live denoise 100)
           → mode.process() → frame chain ≥ 900 (look/LUT) → burn-in → encoder (output canvas)
```

- `services/video/types.ts` — `VideoModeRun`: `outputSize`, `accept` (pre-decode gate), `process`
  (transform; may return `null`, a different size, or a worker result for an earlier frame with its
  own `t`), `retime`, `start`/`stop` (drive the stage/LEDs), `reset`, `status`, `stats`.
- `services/video/videoModes.ts` — catalogue (`VIDEO_MODES`: label, blurb, cost, group) + defaults
  + `createVideoMode(id, params)`. Mode families: `stackModes` (denoise, integrate, median, bin,
  lucky), `motionModes` (motion, trails, timecode, magnify), `stageModes` (edof, sweep, superres),
  `hdrVideo`, `timeModes` (timelapse). `stageDither.ts` is the shared stage driver; `burnIn.ts`
  draws overlays on the output canvas; `common.ts` has the stage→pixel shift tracker and output buffers.
- `services/recorder.svelte.ts` — owns the working and output canvases (they differ when the
  mode changes the size), calls the hooks, resets the mode when `device.moving` flips unless the
  mode `drivesStage`, and refuses to save a recording that produced no frames.
- `frameChain.run(target, frame, t, { min, max })` — order ranges, so the recorder can run the
  mode between denoise and the LUT without editing the processors.
- Pure maths in `algo/`: `videoStack.ts` (SlidingMean, ExpIntegrator, TemporalMedian,
  QualityGate, frameSharpness), `binning.ts` (mean / edge-aware), `motionViz.ts`
  (BackgroundModel, MotionHistory, TemporalColorCode), `eulerian.ts` (EulerianMagnifier); all
  vitest-covered. Workers: `liveStackWorker.ts` (reused for EDOF), `videoSrWorker.ts`
  (register + drizzle sliding window).
- Gallery: `item.video.mode = { id, label, params, stats }` and `item.video.burnIn`; the Viewer
  shows them under *Video*.

## Modes

| id | what | drives | output |
|---|---|---|---|
| plain | the stream | – | full |
| denoise | soft Wiener merge with a per-pixel count map and measured noise curve (`algo/burstMerge.ts`), history warped by the known stage shift (`compensatesStage`) | – | full |
| integrate | sliding mean of N / exponential persistence, TPDF-dithered | – | full |
| median | temporal median of 3 or 5 (median index on luma, RGB copied) | – | full |
| bin | 2/3/4 binning, mean or edge-aware (majority-side reference), optional upscale back to source size | – | w/f × h/f or full |
| lucky | keep the sharpest fraction (exposure-invariant gradient metric, running percentile over 200 frames), optional gap filling | – | sparse or full |
| enhance | stable auto-levels (asymmetric easing, dead band, snap on scene change, soft knee), anchored software WB, rolling background flattening, clarity (`algo/videoTone.ts`) | – | full |
| relief | pseudo-DIC relief, digital dark-field, pseudo-phase | – | full |
| edof | z dither ±Δz + LiveStacker (worker), unsettled frames dropped, AE locked | z | full, worker rate |
| sweep | triangular z sweep, ±range in N stops, unsettled frames dropped | z | full |
| superres | integer-step dither chosen for ~½ px image offsets (`halfPixelSteps`) + drizzle of the central crop → 1.5×/2×; or lucky drizzle without dither | xy | full size, ~4 fps |
| hdr | LED bright/dim alternation, AE/AWB locked, well-exposedness fusion, clipped bright pixels weight 0, stale partner → pass-through | LED | full |
| illum | two illumination presets alternated with a hold; pseudo-DPC (A−B)/(A+B), Rheinberg tints, or split | LED | ≤ half rate |
| servo | focus servo: periodic ±δ probe, parabola fit, clamped backlash-compensated correction, probe frames hidden | z | full |
| motion | running-median (or exponential) background, colour-aware k·σ difference painted orange | – | full |
| trails | motion-history image with decay; frame or background difference source | – | full |
| timecode | ImageJ temporal colour code, hue by time, fade defaults to 1 − 1/(3·period) | – | full |
| project | running max / min / range over time, optional fade | – | full |
| magnify | Eulerian magnification, IIR band-pass on a smoothed coarse grid, band clamped to 0.45·fps, gain ramped after reset | – | full |
| flow | grid Lucas–Kanade (2 levels, eigenvalue gate, EMA) rendered as an HSV wheel; commanded pan subtracted | – | full |
| kymograph | one row per frame along the Distance measurement's line (or the centre line), scrolling; side-by-side with the live view | – | line × rows (+ live) |
| trigger | record only while motion energy > threshold (+ post-roll), gaps compressed; inhibited around stage/light changes | – | sparse |
| timelapse | one frame per interval, re-timed to fps; optional interval averaging | – | sparse |

Stage-driving modes are refused while the stage is moving; HDR is refused when the main LED is
off; super-resolution warns without a calibration (falls back to a one-step dither). All
stage-driving modes return the stage to its origin on stop, also on error, lock AE/AWB for the run
and drop frames exposed during a move (`StageDither.settled()`).

## What the research changed

`docs/video-research/{quality,motion,colour,creative}.md` are the four reports. Fixes they drove:
the stabiliser applied its tracking-frame shift unscaled to the full frame (~0.3× the needed
correction), used the wall clock and reset its filter on every move (now scaled, device-timed,
re-anchored with the filter kept, correction quantised to ⅛ px); the recorder's motion reset
defeated the denoiser's stage compensation (`compensatesStage`); the hard 3σ ghost gate became a
soft Wiener merge; averaged outputs are dithered; the temporal median compares luma only; the
sharpness metric is exposure-invariant; binning's edge kernel no longer references an off-centre
pixel; the SR dither no longer collapses to two states near 1 px/step; deflicker measures the
bright background, applies its gain in linear light with a knee, and re-anchors on LED changes;
motion detection is colour-aware with a running-median background; Eulerian magnification is
clamped below Nyquist and ramped after a reset.

Deliberately not done (see the reports' "do not bother" and critique sections): pre-roll for the
trigger mode (needs the raw JPEG parts from `api/mjpegStream.ts` and a recorder hook to inject a
buffered burst — the design is in `motion.md` #6 / `creative.md` #3), stage-aware residual
stabilisation through a pan and rotation (`motion.md` #1–2), timestamped light events from the
device for exact illumination attribution (`creative.md` §0 — a device change), live frame
interpolation, phase-based magnification, learned denoisers, per-pixel sensor maps on JPEG input.

## Verifying

`e2e/app.mjs` records bin, motion (+ elapsed-time burn-in), timelapse, edof (z returns), superres
(xy returns), project, flow, kymograph, trigger (fires on a jog's settle frames) and servo (nudges,
z returns) against the fake and checks the saved item's size/mode/stats in the Viewer.
`node e2e/video-mode.mjs <id>` records one mode and prints its status/metadata for debugging. HDR
can only be exercised for start/stop on the fake (its picture does not follow the LED).

Research notes that fed the mode list: `docs/video-research/*.md`.
