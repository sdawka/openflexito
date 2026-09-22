# Techniques

Every image- and video-processing technique in openflexito, what it does, how a user meets it, and
where it lives. The Pi only relays frames; all of this runs in the browser (`webapp/src/lib/algo` is
pure TypeScript with vitest coverage, services orchestrate, components render).

**How a technique reaches the user** (the *UX* column):

| tag | meaning |
|---|---|
| **automatic** | always on, no control; the user only notices the result |
| **setting** | a persistent toggle or value (Settings page or a panel), off or on by default as noted |
| **mode** | chosen per capture from the Photo panel's *capture mode* or *video mode* picker, with a blurb, a cost line and its own parameters |
| **tool** | an explicit action with its own button or gesture (calibrate, measure, autofocus, …) |
| **option** | a per-capture checkbox next to the mode picker |
| **gallery** | applied after the fact to a saved item, saving a new item |

Links go to `main`; function names are given so a symbol search lands on the code.

---

## 1. Still capture modes

Chosen in **Photo → capture mode**. All of them return the stage to where it started and lock the
camera's auto exposure and white balance for the run ([`cameraLock.ts`](webapp/src/lib/services/cameraLock.ts) `lockCamera`).

| mode | technique | UX | code |
|---|---|---|---|
| Single | Full-resolution still with its own `X-Frame` metadata attached | mode (default) | [`photoService.ts`](webapp/src/lib/services/photoService.ts) `takePhoto`, [`api/snapshot.ts`](webapp/src/lib/api/snapshot.ts) `fetchSnapshotWithMeta` |
| RAW | 10-bit Bayer record (OFRW v2) developed in the browser: black/white level, the tuning file's lens-shading tables or a measured flat, the record's own colour gains and CCM, camera gamma → 16-bit PNG + DNG | mode | [`photo/rawPhoto.ts`](webapp/src/lib/services/photo/rawPhoto.ts) `rawPhoto`, [`algo/rawdev.ts`](webapp/src/lib/algo/rawdev.ts) `develop` `developLinear`, [`algo/demosaic.ts`](webapp/src/lib/algo/demosaic.ts), [`algo/dng.ts`](webapp/src/lib/algo/dng.ts) `encodeDng`, [`algo/png16.ts`](webapp/src/lib/algo/png16.ts) |
| RAW average | N raw frames averaged on the device in one mode switch (√N less shot noise), then developed like RAW | mode | [`photo/rawPhoto.ts`](webapp/src/lib/services/photo/rawPhoto.ts) `rawAveragePhoto`, device `rawfmt.py` `frames=N` |
| Quick stack | Slices around the current z, aligned, merged by per-block sharpness (smoothed weights, single blend) | mode | [`photo/focusStack.ts`](webapp/src/lib/services/photo/focusStack.ts) `takeFocusStack`, [`algo/stack.ts`](webapp/src/lib/algo/stack.ts) `focusStack` |
| Fine stack | Autofocus locates the focus plane and the sharpness-peak depth; slices spread over it are sub-pixel aligned (phase correlation ≤ 410 px, NCC refinement, Lanczos-3) and fused in a Laplacian pyramid with noise-floor averaging; optional Zerene-style DMap hybrid; depth map, height legend and relief rendering | mode + Fusion method (Advanced) | [`photo/focusStack.ts`](webapp/src/lib/services/photo/focusStack.ts) `takeFineFocusStack`, [`algo/align.ts`](webapp/src/lib/algo/align.ts) `SliceAligner`, [`algo/pyramidFuse.ts`](webapp/src/lib/algo/pyramidFuse.ts) `PyramidFuser`, [`algo/depthMap.ts`](webapp/src/lib/algo/depthMap.ts) `colorizeDepth` `reliefShade`, [`workers/stackWorker.ts`](webapp/src/lib/workers/stackWorker.ts) |
| Fine stack from RAW | The fine stack with every slice developed from RAW and fused at 16 bits | mode | [`photo/focusStack.ts`](webapp/src/lib/services/photo/focusStack.ts) `takeFineFocusStack('raw')`, [`workers/rawWorker.ts`](webapp/src/lib/workers/rawWorker.ts) |
| LED exposure stack | The scene at several LED and/or exposure-time levels, exposure-fused (Mertens weights: contrast, saturation, well-exposedness) | mode + Bracket (LED / exposure / both), levels (Advanced) | [`photo/exposureStack.ts`](webapp/src/lib/services/photo/exposureStack.ts) `exposureStackPhoto`, [`algo/exposureFuse.ts`](webapp/src/lib/algo/exposureFuse.ts) `mertensFuse`, device `/bracket.bin` |
| HDR (RAW) | A linear-RAW exposure bracket merged to radiance (Debevec hat weights, exposure ratios from means), tone-mapped (Reinhard or Mertens) to 16-bit | mode + exposure factors | [`photo/rawPhoto.ts`](webapp/src/lib/services/photo/rawPhoto.ts) `hdrRawPhoto`, [`algo/hdr.ts`](webapp/src/lib/algo/hdr.ts) `mergeHdr` `toneMapReinhard` `toneMapMertens` |
| Super-resolution | A 2×2 or 3×3 pattern of stills shifted by sub-pixel stage offsets (through the stage↔camera calibration), registered, drizzled onto a finer grid; optional Wiener sharpening against the drizzle-drop + pixel PSF; RAW-plane variant with no demosaic | mode + Scale, Sharpen, Pixfrac, Extra frames, RAW planes | [`photo/superres.ts`](webapp/src/lib/services/photo/superres.ts) `superresPhoto`, [`algo/drizzle.ts`](webapp/src/lib/algo/drizzle.ts) `drizzle` `drizzleBayer` `drizzleRawSuperres`, [`algo/register.ts`](webapp/src/lib/algo/register.ts) `register`, [`algo/deconvolve.ts`](webapp/src/lib/algo/deconvolve.ts) `wiener`, [`workers/superresWorker.ts`](webapp/src/lib/workers/superresWorker.ts) |
| Quick frame | Saves the current stream frame as it is | tool (button) | [`PhotoPanel.svelte`](webapp/src/components/PhotoPanel.svelte) `quickFrame` |

Related: **RAW flat field** (a measured flat replaces the tuning file's shading tables in every RAW develop) is a tool in the Calibration page — [`algo/flatField.ts`](webapp/src/lib/algo/flatField.ts) `flatFieldFromRaw`, device `/flat.bin`.

---

## 2. Video capture modes

Chosen in **Photo → video mode** under *Record video*. Every mode is a `VideoModeRun`
([`video/types.ts`](webapp/src/lib/services/video/types.ts)) driven by the recorder
([`recorder.svelte.ts`](webapp/src/lib/services/recorder.svelte.ts) `pushFrame` `processFrame`); the catalogue, blurbs and defaults are in
[`video/videoModes.ts`](webapp/src/lib/services/video/videoModes.ts). Design and verification notes: [`webapp/docs/video-modes.md`](webapp/docs/video-modes.md); the research behind the list: [`webapp/docs/video-research/`](webapp/docs/video-research/).

Where a mode sits in a frame's path:

```
MJPEG part → stabilise → frame chain < 900 (deflicker, live denoise) → MODE → frame chain ≥ 900 (look/LUT) → burn-in → encoder
```

### 2.1 Signal quality

| mode | technique | UX | code |
|---|---|---|---|
| Temporal denoise | HDR+-style soft Wiener merge, recursive per pixel: shrinkage `s = cσ²/(m + cσ²)` on the noise-corrected patch difference, a per-pixel effective frame count, a per-luma-bin noise curve measured from the residuals; history warped by the known stage shift so it survives pans (`compensatesStage`). Then a chroma-only stage: Cb/Cr at half resolution through a luma-guided filter with a soft temporal EMA, so colour speckle goes while luma detail stays | mode + Strength (frames), Robustness, Chroma, Lock exposure | [`video/stackModes.ts`](webapp/src/lib/services/video/stackModes.ts) `denoiseMode`, [`algo/burstMerge.ts`](webapp/src/lib/algo/burstMerge.ts) `BurstMerge`, [`algo/chromaDenoise.ts`](webapp/src/lib/algo/chromaDenoise.ts) `ChromaDenoiser` |
| Long exposure | Sliding mean of N frames (ring + running sum) or exponential persistence; TPDF-dithered re-quantisation | mode + Frames, Window, Lock exposure | [`video/stackModes.ts`](webapp/src/lib/services/video/stackModes.ts) `integrateMode`, [`algo/videoStack.ts`](webapp/src/lib/algo/videoStack.ts) `SlidingMean` `ExpIntegrator` `dither` |
| Temporal median | Per-pixel median of 3 or 5 frames, median index found on luma and that frame's RGB copied (no colour fringes) | mode + Frames | [`algo/videoStack.ts`](webapp/src/lib/algo/videoStack.ts) `TemporalMedian` |
| Binned | 2×2 / 3×3 / 4×4 software binning, plain mean or an edge-aware kernel weighting pixels by closeness to the block's majority side; optional bilinear upscale back so calibrations made on the stream stay valid | mode + Factor, Kernel, Keep size | [`algo/binning.ts`](webapp/src/lib/algo/binning.ts) `binRgba` `upscaleRgba` |
| Lucky imaging | Keep only the sharpest fraction of frames: exposure-invariant gradient metric on a 2×2 reduction, running percentile over 200 frames; optional gap filling for constant-rate playback | mode + Keep, Fill gaps | [`algo/videoStack.ts`](webapp/src/lib/algo/videoStack.ts) `frameSharpness` `QualityGate`, [`video/stackModes.ts`](webapp/src/lib/services/video/stackModes.ts) `luckyMode` |

### 2.2 Tone and structure

| mode | technique | UX | code |
|---|---|---|---|
| Enhance (stable) | Auto-levels whose black/white points ease asymmetrically (fast when content would clip, slow otherwise) with a dead band, snap on scene change and freeze while the stage moves; a bounded stretch (at most 25 % of the range remapped by default, so an empty field is not stretched into noise) and a strength mix; soft highlight knee; software white balance anchored to the first frame's bright background (EMA, clamped, auto-idle without a bright background); background flattening either as a rolling estimate (coarse per-channel mean, smoothed in space and time, divided out) or by a **captured reference**: 32 frames of a blank field (and optionally 32 dark frames with the LED off) build a gain map, a dark map and a hot-pixel list applied in a gamma-2.2 linear domain; clarity (luma minus its large-scale mean) | mode + Auto-levels, Clip %, Max stretch, Levels strength, Soft knee, Anchor WB, Flatten (rolling / reference), Flat strength, *Capture blank field* / *Capture dark* / *Clear* buttons, Clarity, Scale | [`video/toneModes.ts`](webapp/src/lib/services/video/toneModes.ts) `enhanceVideoMode`, [`algo/videoTone.ts`](webapp/src/lib/algo/videoTone.ts) `StableLevels` `AnchoredWhiteBalance` `BackgroundFlattener` `localContrast`, [`algo/videoFlat.ts`](webapp/src/lib/algo/videoFlat.ts) `VideoFlat`, [`video/videoFlatCapture.svelte.ts`](webapp/src/lib/services/video/videoFlatCapture.svelte.ts) |
| Relief / dark-field / phase | Pseudo-DIC: directional derivative of a 3×3-blurred luma rendered as light and shadow on grey; digital dark-field: |high-pass| on black; pseudo-phase: high-pass on grey. Visualisations, not phase data | mode + Style, Light angle, Strength, Mix, Scale | [`algo/videoTone.ts`](webapp/src/lib/algo/videoTone.ts) `relief` `highPassView` |

### 2.3 Stage and illumination

All of these lock AE/AWB, refuse to start while the stage is moving, drop frames exposed during a
move ([`video/stageDither.ts`](webapp/src/lib/services/video/stageDither.ts) `StageDither.settled`) and return the stage to its origin on stop.

| mode | technique | UX | code |
|---|---|---|---|
| Extended depth of field | z dither ±Δz while a block-wise sharpest-over-time stack (aligned by phase correlation, feathered, slowly forgetting) builds an all-in-focus view in a worker | mode + Δz, Dwell | [`video/stageModes.ts`](webapp/src/lib/services/video/stageModes.ts) `edofMode`, [`algo/liveStack.ts`](webapp/src/lib/algo/liveStack.ts) `LiveStacker`, [`workers/liveStackWorker.ts`](webapp/src/lib/workers/liveStackWorker.ts) |
| Focus sweep | Triangular z sweep over ±range in N stops, recorded as it goes (turn on the position burn-in to read z) | mode + Range, Stops, Dwell | [`video/stageModes.ts`](webapp/src/lib/services/video/stageModes.ts) `sweepMode` |
| Super-resolution zoom | Stage dithered by the smallest integer steps whose image offsets are near ½ px (through the calibration, `halfPixelSteps`); the last N frames of the central crop are registered and drizzled onto a 1.5×/2× grid in a worker, with a robustness weight (Wronski et al. 2019) that down-weights a frame wherever it differs from the newest one beyond the noise, so a mover is not smeared. Without the dither: *lucky drizzle*, the specimen's own jitter supplies the phases and a sharpness gate rejects blur | mode + Scale, Window, Pixfrac, Stage dither, Reject movers (σ), Keep | [`video/stageModes.ts`](webapp/src/lib/services/video/stageModes.ts) `superresVideoMode` `halfPixelSteps`, [`workers/videoSrWorker.ts`](webapp/src/lib/workers/videoSrWorker.ts), [`algo/drizzle.ts`](webapp/src/lib/algo/drizzle.ts), [`algo/drizzleRobust.ts`](webapp/src/lib/algo/drizzleRobust.ts) |
| HDR (LED alternation) | LED alternated between a bright and a dim level with exposure locked; each frame is attributed to a level by its exposure window against a timed log of the light switches (`StateLog`, browser→device clock mapped from frame arrivals), frames straddling a switch dropped, with the commanded-level latency queue plus luma validation as the fallback; a settling check on the first frames measures the LED latency and warns when the LED does not change the picture; fusion in linear light by well-exposedness on a coarse grid, clipped bright pixels weight 0, stale partners passed through | mode + Ratio, Period | [`video/hdrVideo.ts`](webapp/src/lib/services/video/hdrVideo.ts) `hdrVideoMode`, [`algo/frameAttrib.ts`](webapp/src/lib/algo/frameAttrib.ts) `StateLog` `ClockMap` |
| Interleaved illumination | Two illumination presets (extra LED channels: oblique pairs, dark-field) alternated with a hold, frames attributed by exposure window as above (`LightAttributor`); pseudo differential phase contrast `(A−B)/(A+B)` after per-channel mean normalisation, a Rheinberg colour composite, or a split view | mode + Preset A/B, Output, Hold, Gain, Tints | [`video/illumModes.ts`](webapp/src/lib/services/video/illumModes.ts) `illumMode` `LightAttributor` |
| Focus servo | Every N s, in a quiet moment, z is probed ±δ, the sharpness at the three positions is fitted by a parabola and z moves to the vertex (clamped, backlash-compensated final approach); probe frames are replaced by the last good frame | mode + Every, δ, Max offset, Hide probe | [`video/stageModes.ts`](webapp/src/lib/services/video/stageModes.ts) `servoMode` |

### 2.4 Motion

| mode | technique | UX | code |
|---|---|---|---|
| Motion highlight | Running-median background (McFarlane–Schofield sign increment; never learns what is present less than half the time) or exponential mean; colour-aware `max(|ΔR|,|ΔG|,|ΔB|)` difference over a k·σ threshold from an O(n) histogram median, painted orange over dimmed grey | mode + Threshold σ, Background, Learn | [`algo/motionViz.ts`](webapp/src/lib/algo/motionViz.ts) `BackgroundModel` `robustSigma` |
| Motion trails | Motion-history image (Bobick & Davis): moving pixels light up and decay; source is the frame difference or the background difference | mode + Decay, Threshold σ, Source | [`algo/motionViz.ts`](webapp/src/lib/algo/motionViz.ts) `MotionHistory` |
| Temporal colour code | ImageJ's Temporal-Color Code, live: motion accumulates in the hue of its time in a cycling window; fade defaults to keeping one cycle visible | mode + Hue cycle, Fade, Map | [`algo/motionViz.ts`](webapp/src/lib/algo/motionViz.ts) `TemporalColorCode` |
| Projection over time | Fiji Z-Project on the time axis: running max / min / range, optional fade | mode + Kind, Fade | [`algo/motionViz.ts`](webapp/src/lib/algo/motionViz.ts) `TimeProjection` |
| Motion magnification | Linear Eulerian video magnification (Wu et al. 2012): two first-order IIR low-passes per cell of a box-reduced, 3×3-smoothed luma form a band-pass, amplified ×α, clamped, bilinearly added back; band clamped below 0.45 × the measured frame rate; gain ramped in after a reset | mode + Band, Gain, Scale, Colour | [`algo/eulerian.ts`](webapp/src/lib/algo/eulerian.ts) `EulerianMagnifier` |
| Optical flow | Grid Lucas–Kanade on a 205 px luma, two coarse-to-fine levels, eigenvalue (aperture) gate, EMA of the vectors, commanded stage pan subtracted; rendered as an HSV wheel (hue = direction, brightness = speed) | mode + Cell, Smoothing, Full speed | [`algo/opticalFlow.ts`](webapp/src/lib/algo/opticalFlow.ts) `GridFlow` `renderFlowHsv` |

### 2.5 Analysis and time

| mode | technique | UX | code |
|---|---|---|---|
| Kymograph | One row per frame sampled bilinearly along the Distance measurement's line (or the centre line) with a perpendicular averaging band, scrolling; the line follows small stage pans; optional side-by-side with the live view | mode + Band, Rows, Side by side | [`algo/kymograph.ts`](webapp/src/lib/algo/kymograph.ts) `sampleLine` `Kymograph`, [`video/analysisModes.ts`](webapp/src/lib/services/video/analysisModes.ts) `kymographMode` |
| Motion-triggered | Motion energy (fraction of pixels over k·σ from a running-median background) arms the encoder; a pre-roll ring of raw JPEG parts is written when an event starts; post-roll; idle stretches compressed out of the timeline; inhibited around stage and light changes; the stabiliser is off for this mode because replayed pre-roll frames cannot be tracked | mode + Trigger %, Pre-roll, Post-roll, Compress gaps | [`video/analysisModes.ts`](webapp/src/lib/services/video/analysisModes.ts) `triggerMode`, [`recorder.svelte.ts`](webapp/src/lib/services/recorder.svelte.ts) `injectRing`, [`api/mjpegStream.ts`](webapp/src/lib/api/mjpegStream.ts) `MjpegFrame.bytes` |
| Time compression | One frame per interval, re-timed to the chosen fps; optional averaging of the whole interval into the kept frame | mode + Every, Playback fps, Average interval | [`video/timeModes.ts`](webapp/src/lib/services/video/timeModes.ts) `timelapseMode` |

### 2.6 Options that apply to every video mode

| option | technique | UX | code |
|---|---|---|---|
| Stabilise | Translation stabilisation: phase correlation + NCC refinement against a periodically re-anchored reference on a 480 px copy, one-euro filtered trajectory, the jitter (raw − smoothed) removed with a crop margin; shift scaled back to full-frame px, quantised to ⅛ px, timed by the device clock; re-anchored (filter kept) at both ends of a stage move. **Strength** presets set the filter cut-off (3 / 1 / 0.3 Hz). **Rotation** registers the left and right thirds separately, `θ = atan2(Δdy, baseline)` with its own filter and gates, applied about the frame centre with an exact rectangle margin. **Edges**: crop, or *hold* (full frame size, the uncovered border keeps the previous frames' pixels) | option (default on) + Strength, Rotation, Edges | [`algo/stabilize.ts`](webapp/src/lib/algo/stabilize.ts) `Stabilizer` `stabilizeOptionsFor` `rotationMargin`, [`recorder.svelte.ts`](webapp/src/lib/services/recorder.svelte.ts) `drawStreamFrame` |
| Timing | Variable frame rate keeps every frame at its true device time (default, scientifically honest). Constant rate re-times to a fixed fps: the current frame is repeated into skipped slots and early frames dropped, counts recorded on the item; a speed-ramp mode exists in the algorithm for export tooling | option (Timing, fps) | [`algo/retime.ts`](webapp/src/lib/algo/retime.ts) `Retimer`, [`recorder.svelte.ts`](webapp/src/lib/services/recorder.svelte.ts) `encodeOutput` |
| Deflicker | Per-frame gain toward a slow EMA of the *background* luma (brightest 30 % of unclipped pixels), applied in linear light through a table with a soft knee; re-anchored on stage moves and LED changes | option (default off) + Settings *deflicker live view* | [`algo/deflicker.ts`](webapp/src/lib/algo/deflicker.ts) `Deflicker` `backgroundLuma` `gainLut`, [`deflickerProcessor.ts`](webapp/src/lib/services/deflickerProcessor.ts) |
| Bake look | The Look panel's LUT, curves, levels and mixer applied to the recorded frames after the mode | option | [`lookProcessor.ts`](webapp/src/lib/services/lookProcessor.ts) |
| Live denoise into recording | The live-view temporal denoiser (below) also applied to recorded frames | setting | [`denoiseProcessor.ts`](webapp/src/lib/services/denoiseProcessor.ts) |
| Burn-in | Elapsed time, stage position, scale bar, sample name, mode status drawn on the output frames | option (checkboxes) | [`video/burnIn.ts`](webapp/src/lib/services/video/burnIn.ts) `drawBurnIn` |
| Container / codec / quality / keyframe | WebCodecs `VideoEncoder` through mediabunny into fast-start MP4/WebM with the device frame time as sample timestamp; bounded in-flight queue that drops instead of blocking; MediaRecorder fallback | option | [`videoEncoder.ts`](webapp/src/lib/services/videoEncoder.ts) `createVideoSink` `WebCodecsSink` |

---

## 3. Live view processing (frame chain)

Processors register once in [`frameChain.ts`](webapp/src/lib/services/frameChain.ts) and run in order over the live view (`view`), recordings (`record`) and time-lapse playback (`playback`). The live view switches from the plain `<img>` to a processed canvas only while something is enabled.

| technique | what | UX | code |
|---|---|---|---|
| Deflicker (order 50) | as above | setting (live, default off) | [`deflickerProcessor.ts`](webapp/src/lib/services/deflickerProcessor.ts) |
| Live temporal denoise (order 100) | Recursive motion-compensated blend `α·warp(prev) + (1−α)·cur` with a 3σ ghost gate (MAD σ, refreshed every 8 frames); the stage shift comes from the CSM calibration | setting (Camera panel *live denoise*, strength) | [`denoiseProcessor.ts`](webapp/src/lib/services/denoiseProcessor.ts), [`algo/temporalDenoise.ts`](webapp/src/lib/algo/temporalDenoise.ts) `TemporalDenoiser` |
| Look / LUT (order 900) | 1D/3D LUT (.cube, .3dl, ImageJ, Hald PNG, CSV; Matplotlib, ImageJ and Okabe-Ito colour-blind-safe maps generated from control points) composed with an **ASC-CDL grade** (slope / offset / power per channel, saturation; .cdl export and import), a **filmic preset** (Neutral, Soft = Narkowicz ACES fit in linear at ×1.15, Flat = log curve, with a posterisation warning), monotone-cubic curves, levels, a 3×3 channel mixer with two-channel presets (green/magenta, cyan/red, yellow/blue, isolate R/G/B), saturation and strength; WebGL2 `sampler3D` tetrahedral path with CPU fallback; whole look bakeable into a user LUT (1D when separable, else 33³) | setting (Look panel; *bake into recording*, *apply in gallery*) | [`store/look.svelte.ts`](webapp/src/lib/store/look.svelte.ts) `LookStore`, [`algo/lut.ts`](webapp/src/lib/algo/lut.ts), [`algo/curves.ts`](webapp/src/lib/algo/curves.ts) `bakeAdjustments` `filmicCurve`, [`algo/cdl.ts`](webapp/src/lib/algo/cdl.ts) `applyCdl` `cdlToLut3D` `toCdlXml`, [`algo/colormaps.ts`](webapp/src/lib/algo/colormaps.ts) `OKABE_ITO`, [`gfx/lutGl.ts`](webapp/src/lib/gfx/lutGl.ts) `LutRenderer`, [`LookPanel.svelte`](webapp/src/components/LookPanel.svelte) |
| Focus peaking and zebra (order 950, view only) | Half-resolution luma, 3×3 blur, Sobel magnitude, threshold at the in-frame 97th percentile (EMA'd, frozen while the stage moves, off when the 90th percentile shows no edges), painted in a chosen colour; zebra stripes on clipped (≥ 250) and crushed (≤ 4) pixels in opposite directions. Never recorded | setting (Camera panel *focus aids*) | [`algo/peaking.ts`](webapp/src/lib/algo/peaking.ts) `FocusPeaker` `paintPeaking` `paintZebra`, [`peakingProcessor.ts`](webapp/src/lib/services/peakingProcessor.ts) |
| Live focus stack / smooth | Off the frame chain: block-wise sharpest-over-time composite (extended depth of field from z vibration) or a 4-frame average, in a worker, shown in place of the stream and recordable | setting (Focus panel: Off / Smooth / Stack) | [`liveStack.svelte.ts`](webapp/src/lib/services/liveStack.svelte.ts), [`algo/liveStack.ts`](webapp/src/lib/algo/liveStack.ts) `LiveStacker` `LiveAverager` |

---

## 4. Registration and motion primitives

| technique | what | UX | code |
|---|---|---|---|
| Sub-pixel displacement | Phase correlation with a Gaussian-windowed peak fit; `trackFrame` on a central crop | automatic (used by everything below) | [`algo/fftTrack.ts`](webapp/src/lib/algo/fftTrack.ts) `displacement`, [`algo/fft.ts`](webapp/src/lib/algo/fft.ts) |
| Coarse-to-fine registration | Whole-frame correlation at ≤ 410 px, integer pre-shift, full-resolution crop refinement, quality and confidence | automatic (super-resolution, stabiliser, drizzle worker, live stack) | [`algo/register.ts`](webapp/src/lib/algo/register.ts) `register` |
| Slice alignment | Neighbour-chained from the middle slice, phase correlation then NCC, Lanczos-3 resampling | automatic (focus stacks) | [`algo/align.ts`](webapp/src/lib/algo/align.ts) `SliceAligner` |
| Drift tracking | Frame-to-frame drift for time-lapse playback correction and drift-triggered refocus | automatic (time-lapse) | [`algo/drift.ts`](webapp/src/lib/algo/drift.ts) `DriftTracker` |
| Blob tracking | Threshold + connected components, gated nearest-neighbour linking, per-track speed statistics, CSV export; trajectories drawn on the live view | tool (Tracking panel) | [`algo/tracking.ts`](webapp/src/lib/algo/tracking.ts) `detectBlobs` `BlobTracker`, [`tracking.svelte.ts`](webapp/src/lib/services/tracking.svelte.ts) |
| Follow | Closed-loop stage moves keep a clicked detection centred | tool (click a detected box) | [`followService.svelte.ts`](webapp/src/lib/services/followService.svelte.ts), [`algo/csm.ts`](webapp/src/lib/algo/csm.ts) `closedLoopMove` |

---

## 5. Focus and stage

| technique | what | UX | code |
|---|---|---|---|
| Fast autofocus | One continuous z sweep while the stream's JPEG size (a sharpness proxy) is logged against interpolated z; quadratic peak fit | tool (Focus panel / HUD *AF*, gamepad) | [`algo/autofocus.ts`](webapp/src/lib/algo/autofocus.ts) `fastAutofocus` `quadraticPeak`, [`autofocusService.ts`](webapp/src/lib/services/autofocusService.ts) `runAutofocus` |
| Looping autofocus | Repeated sweeps that shrink around the peak | tool (mode picker) | [`algo/autofocus.ts`](webapp/src/lib/algo/autofocus.ts) `loopingAutofocus` |
| Step autofocus | Nine stops, Laplacian variance of a still at each, argmax + fit | tool | [`algo/autofocus.ts`](webapp/src/lib/algo/autofocus.ts) `stepAutofocus`, [`algo/sharpness.ts`](webapp/src/lib/algo/sharpness.ts) `laplacianVariance` |
| Two-pass autofocus | Coarse JPEG-size sweep, then a short fine Laplacian sweep with a sub-pixel peak model and a full-resolution confirmation | tool | [`algo/autofocus.ts`](webapp/src/lib/algo/autofocus.ts) `twoPassAutofocus` `fitPeak` |
| Backlash compensation | v3 `BaseStage` semantics: compensate only the moving axes, or force `xy`/`z`; raw moves for jogs, drag-to-pan, sweeps | automatic (scans `xy`, autofocus final approach `z`) | device `stage.py`, [`store/device.svelte.ts`](webapp/src/lib/store/device.svelte.ts) `moveRel` |
| Drag-to-pan / click-to-centre | Pointer gestures converted to stage moves through the calibration, one raw move in flight, the image translated by the unmet remainder | tool (gesture) | [`input/pan.ts`](webapp/src/lib/input/pan.ts) `PanController`, [`input/zoomPan.ts`](webapp/src/lib/input/zoomPan.ts) |
| Jog | Keyboard, gamepad, HUD and StagePad share one controller: newest-wins continuous jog, tap = one step | tool | [`input/jog.ts`](webapp/src/lib/input/jog.ts) `JogController`, [`LiveHud.svelte`](webapp/src/components/LiveHud.svelte) |

---

## 6. Calibration and metrology

| technique | what | UX | code |
|---|---|---|---|
| Stage ↔ camera (CSM) | Move until motion is detected, calibrate each axis with tracked displacements, fit backlash, build the 2×2 image→stage matrix | tool (Calibration page) | [`algo/csm.ts`](webapp/src/lib/algo/csm.ts) `calibrate1D` `fitBacklash` `imageToStageMatrix`, [`store/calibration.svelte.ts`](webapp/src/lib/store/calibration.svelte.ts) |
| Flat field / lens shading | Measured flat (coarse per-channel gain grid) from an empty field, guarded against a non-empty field, ALSC gain clamped | tool (Calibration page) | [`algo/flatField.ts`](webapp/src/lib/algo/flatField.ts), [`algo/tuning.ts`](webapp/src/lib/algo/tuning.ts) |
| Exposure calibration | Exposure/gain suggestion from the histogram toward a target | tool (Calibration page); histogram in the Camera panel | [`algo/histogram.ts`](webapp/src/lib/algo/histogram.ts) `suggestExposureStep`, [`algo/exposure.ts`](webapp/src/lib/algo/exposure.ts), [`Histogram.svelte`](webapp/src/components/Histogram.svelte) |
| White balance picker | Neutral-point pick and temperature/tint mapping to colour gains | tool (Camera panel) | [`whiteBalance.svelte.ts`](webapp/src/lib/services/whiteBalance.svelte.ts) |
| Scale bar and measurement | µm/px from the stage calibration or a manual scale; nice scale-bar lengths; distance, polygon area/perimeter, angle; CSV | tool (Measure panel, `M`), setting (*show scale bar*) | [`algo/measure.ts`](webapp/src/lib/algo/measure.ts) `niceScaleBarLength` `polygonArea`, [`store/scaleCal.svelte.ts`](webapp/src/lib/store/scaleCal.svelte.ts), [`measureService.svelte.ts`](webapp/src/lib/services/measureService.svelte.ts) |
| Flicker analysis | Spectral analysis of the stream's brightness for mains/LED-driver beat | tool (Calibration / logs) | [`algo/flicker.ts`](webapp/src/lib/algo/flicker.ts) |

---

## 7. Scanning and stitching

| technique | what | UX | code |
|---|---|---|---|
| Scan plan | N×M around here or the grid covering two marked corners; polygon regions (clipping), serpentine or spiral order; stage↔mosaic mapping | tool (Scan page) | [`algo/scanPlan.ts`](webapp/src/lib/algo/scanPlan.ts) `planScan` `filterByPolygon` `spiralOrder`, [`scan.svelte.ts`](webapp/src/lib/services/scan.svelte.ts) |
| Autofocus per tile / height map | Autofocus every tile or a sub-grid, robust plane fit with outlier rejection, bilinear interpolation of the rest | tool (Scan options) | [`algo/heightMap.ts`](webapp/src/lib/algo/heightMap.ts), [`HeightMapOverlay.svelte`](webapp/src/components/HeightMapOverlay.svelte) |
| Stitching | Pairwise phase-correlation offsets, robust global position solve, overlap gain solve with a flat-field gain map, feathered multi-band (Laplacian) blending in bounded row bands | automatic at scan end (or after cancel: stitch-or-discard) | [`algo/stitch.ts`](webapp/src/lib/algo/stitch.ts) `pairwiseOffsets` `solvePositionsRobust` `solveGains` `blendMultiband`, [`workers/stitchWorker.ts`](webapp/src/lib/workers/stitchWorker.ts) |

---

## 8. After capture (gallery)

| technique | what | UX | code |
|---|---|---|---|
| Enhance pipeline | Canonical order: pseudo-flat-field, vignette, chromatic aberration, denoise (Anscombe when a noise model is known, else MAD σ; wavelet BayesShrink/SURE, or opt-in NLM, guided, bilateral), Wiener/Richardson–Lucy deconvolution, filmic, sRGB encode, auto-levels, shadows/highlights, colour, sharpen, CLAHE, look; presets; preview at reduced width, full-res on Apply | gallery (Enhance panel → saves *(enhanced)* item) | [`algo/pipeline.ts`](webapp/src/lib/algo/pipeline.ts) `developPipeline`, [`algo/enhance.ts`](webapp/src/lib/algo/enhance.ts), [`algo/denoise.ts`](webapp/src/lib/algo/denoise.ts), [`algo/deconvolve.ts`](webapp/src/lib/algo/deconvolve.ts), [`algo/noise.ts`](webapp/src/lib/algo/noise.ts), [`workers/enhanceWorker.ts`](webapp/src/lib/workers/enhanceWorker.ts), [`EnhancePanel.svelte`](webapp/src/components/EnhancePanel.svelte) |
| Stain separation | Colour deconvolution (H&E, H-DAB or custom vectors) and recolouring | gallery (Enhance) | [`algo/enhance.ts`](webapp/src/lib/algo/enhance.ts) `colourDeconvolve` `stainRecolour` |
| Look in the gallery | The current Look re-applied to viewed items | setting (*apply look in gallery*) | [`Viewer.svelte`](webapp/src/components/Viewer.svelte) |
| Time-lapse export | Stored frames encoded to MP4 at an exact fps in a worker; per-frame gain deflicker; drift-corrected playback | tool (Time-lapse viewer) | [`timelapseExport.ts`](webapp/src/lib/services/timelapseExport.ts), [`workers/encodeWorker.ts`](webapp/src/lib/workers/encodeWorker.ts), [`algo/deflicker.ts`](webapp/src/lib/algo/deflicker.ts) |
| Export naming | `YYYYMMDD-HHMMSS_sample_label_x_y_z_blob.ext` for every export | automatic | [`algo/naming.ts`](webapp/src/lib/algo/naming.ts) `fileStem` |
| Image search / detection | CLIP embeddings for shift-drag region search across the gallery; YOLOS detection boxes on the live view | tool (Intelligence panel) | [`workers/aiWorker.ts`](webapp/src/lib/workers/aiWorker.ts), [`searchService.ts`](webapp/src/lib/services/searchService.ts), [`aiService.svelte.ts`](webapp/src/lib/services/aiService.svelte.ts) |

---

## 9. Time-lapse (Live panel)

| technique | what | UX | code |
|---|---|---|---|
| Interval capture with absolute slots | Frames at fixed clock slots (skipped slots recorded), AE/AWB re-locked periodically, drift measured per frame | tool (Time-lapse panel) | [`timelapse.svelte.ts`](webapp/src/lib/services/timelapse.svelte.ts), [`algo/drift.ts`](webapp/src/lib/algo/drift.ts) `nextSlot` |
| Drift-triggered refocus | Autofocus when the mean |Laplacian| drops by more than a percentage from its best | setting (panel) | [`algo/drift.ts`](webapp/src/lib/algo/drift.ts) `sharpnessDropped` |

---

## 10. Recording infrastructure worth knowing

| technique | what | code |
|---|---|---|
| Exact frame timing | Every frame carries the device's `CLOCK_BOOTTIME` nanosecond timestamp; the recorder uses it as the sample time, so playback speed is real time regardless of drops | [`api/mjpegStream.ts`](webapp/src/lib/api/mjpegStream.ts), [`videoEncoder.ts`](webapp/src/lib/services/videoEncoder.ts) |
| Camera lock | AE/AWB frozen from the latest frame's metadata for any multi-shot run and released afterwards | [`cameraLock.ts`](webapp/src/lib/services/cameraLock.ts) |
| Activity holds | A hidden tab stays awake for recordings, live stacks, tracking and time-lapse gaps; the device otherwise sleeps after 10 idle minutes | [`activity.svelte.ts`](webapp/src/lib/services/activity.svelte.ts), device `power.py` |
| Fake device | Stage-coupled synthetic specimen (1 px/step, 4° axis rotation, defocus ∝ |z|) so every technique above is exercised end to end in CI without hardware | [`device/openflexito/fake_camera.py`](device/openflexito/fake_camera.py), [`webapp/e2e/app.mjs`](webapp/e2e/app.mjs) |
