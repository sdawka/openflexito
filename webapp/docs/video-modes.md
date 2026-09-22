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
| denoise | motion-compensated recursive denoise (`TemporalDenoiser`, α) | – | full |
| integrate | sliding mean of N / exponential persistence | – | full |
| median | temporal median of 3 or 5 | – | full |
| bin | 2/3/4 binning, mean or edge-aware | – | w/f × h/f |
| lucky | keep the sharpest fraction (running percentile of mean |Laplacian|) | – | sparse |
| edof | z dither ±Δz + LiveStacker (worker) | z | full, worker rate |
| sweep | triangular z sweep, ±range in N stops | z | full |
| superres | half-pixel xy dither (via CSM) + drizzle of the central half → 2× | xy | full size, ~4 fps |
| hdr | LED bright/dim alternation, AE/AWB locked, well-exposedness fusion | LED | full |
| motion | EMA background, k·σ difference painted orange over dimmed grey | – | full |
| trails | motion-history image with decay | – | full |
| timecode | ImageJ temporal colour code, hue by time, optional fade | – | full |
| magnify | Eulerian magnification, IIR band-pass on box-downsampled luma | – | full |
| timelapse | one frame per interval, re-timed to fps | – | sparse |

Stage-driving modes are refused while the stage is moving; HDR is refused when the main LED is
off; super-resolution warns without a calibration (falls back to a one-step dither). All
stage-driving modes return the stage to its origin on stop, also on error.

## Verifying

`e2e/app.mjs` records bin, motion (+ elapsed-time burn-in), timelapse, edof (z returns) and
superres (xy returns) against the fake and checks the saved item's size/mode/stats in the Viewer.
`node e2e/video-mode.mjs <id>` records one mode and prints its status/metadata for debugging. HDR
can only be exercised for start/stop on the fake (its picture does not follow the LED).

Research notes that fed the mode list: `docs/video-research/*.md`.
