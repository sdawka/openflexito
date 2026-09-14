# Capture quality audit (2026-09-10)

Read-only audit of every capture mode by five parallel reviewers (device path; single still + RAW;
focus stacking + autofocus + live stack; super-resolution + LED exposure stack; scan/stitch + video +
time-lapse). Nothing was changed. File:line references are as of main `bfa3713`. Items marked
**verified** were re-checked by the lead; **measured** means a numeric experiment was run with the
repo's own code; everything else is read from the source. Hypotheses are labelled.

## 1. Confirmed defects (fix first)

| # | Where | Defect | Effect |
|---|-------|--------|--------|
| D1 | `webapp/src/lib/dng.ts:23-26` (**verified**) | `ColorMatrix1 = inv(ccm)·XYZ→sRGB`, without the white-balance gains. libcamera's CCM maps *balanced* camera RGB to sRGB; DNG's ColorMatrix must map XYZ to *unbalanced* camera RGB, with AsShotNeutral carrying the white. | RawTherapee/darktable/Lightroom estimate a wrong illuminant and hue-shift the render. In-app PNG unaffected. Fix: `diag(1/gr, 1, 1/gb)·inv(ccm)·XYZ→sRGB`, verify against RawTherapee. Note `dng.ts` sits in `lib/`, not `lib/algo/`, against the layering rule. |
| D2 | `services/timelapse.svelte.ts:121-127, 197`, `TimelapseViewer.svelte` (**verified**) | Drift `shift` is measured on a 410 px wide downsample (`MEASURE_WIDTH`) but subtracted in full-frame pixels at playback and WebM export. The stage correction itself is scaled correctly (`k = csm.imageWidth / gray.width`). | Stabilised playback undercorrects 2× at 820 px stream frames, 8× at full-res frames. Store the shift scaled by `frameWidth / gray.width` (or normalised units) and add a `drift.test.ts` case. |
| D3 | `services/photoService.ts:315-347` (**verified**) | Super-res 3×3 raster at 0.5 px hops gives per-axis phases {0, 0.5, 1.0}: the third row/column repeats the first. Only 4 of 9 frames carry distinct phases for the 2× grid. Row-start reversal is 1-2 motor steps, inside backlash. | Half the capture time is wasted; on hardware several frames likely land at identical positions (hypothesis). Use 2×2 at 0.5 px for scale 2 or 3×3 at 1/3 px for scale 3, planned in the CSM-rotated frame, snake order with pre-loaded backlash. |
| D4 | `workers/superresWorker.ts:26-32`, `algo/fftTrack.ts:53-71` (**measured**) | Registration runs on the whole frame downscaled 8× (3280 mode). On a synthetic scene at 4× downscale, sub-pixel shifts were underestimated ~2.5× (0.5 px → 0.2 px; 1 px → 0.41 px) and two cases failed by 44 px; `quality` stayed 1.0-1.2 for both and is never used to reject. The same function on a 410×308 full-resolution crop gave 0.03-0.07 px errors. | Drizzle receives wrong phases; the output is a blurred average, not super-resolved. Fix: coarse-to-fine registration (as `SliceAligner` already does), reject frames > ~0.15 px from a valid phase or duplicating another, add a sub-pixel `displacement` test with 0.05 px tolerance. Likely mechanism: the thresholded centroid is biased to the integer sample and is averaged with the parabolic estimate. |
| D5 | `workers/stitchWorker.ts:42-54` | Blend is canvas "over" compositing in capture order with an 8 % alpha feather on tiles 1..n only, not a normalised weighted average. | Last-drawn tile dominates overlaps; seams wherever exposure or vignetting differ. Accumulate Σw·rgb / Σw in float planes, feather every tile. |
| D6 | `device/openflexito/web.py:168-172`, `camera.py:484-503`, `api/snapshot.ts:7-9` | `?full=1` returns the *last stream frame's* metadata; `/raw.bin` carries none; the webapp discards `X-Frame` anyway. RAW is developed with live-stream colour gains, not the frozen gains it was shot with. Gallery items store the persistent controls dict, which is stale under AE. | No honest exposure/gain/timestamp record per still; DNG AsShotNeutral only approximately right; no way to assert still timestamp > stage t1. |
| D7 | `algo/align.ts`, `photoService.ts:150, 239`, `stackWorker.ts:35` | Slice 0 (bottom, most defocused) is the fixed alignment reference; every sharper slice is bilinearly resampled. Bilinear at half-pixel shift is a [½,½] box (MTF 0 at Nyquist). | The stack softens exactly the slices it should keep and biases the winner toward slice 0. Reference = middle slice, align outward both ways, resample bicubic/Lanczos-3. |
| D8 | `camera.py:436-450` vs `photoService.ts:189-201`, `routes/Scan.svelte`, `timelapse.svelte.ts` | AE/AWB are frozen *per still* from the latest stream frame. Only the LED stack locks AE in the browser; nothing locks AWB anywhere; focus stacks, scans and time-lapses lock nothing. | Slice-to-slice / tile-to-tile brightness and tint drift, hidden in stacks as low-frequency mottle and in mosaics as seams. One `lockAeAwb()`/`restore()` helper reused by every multi-shot mode. |
| D9 | `algo/rawdev.ts:160` | Tone curve is a nearest-index 4097-entry LUT: linear signal quantised to 12 bits before the curve; first sRGB output step ≈ 206/65535. | Contradicts the "16-bit lossless" docstring. Linear interpolation in the LUT is free. |
| D10 | `camera.py:292-296`, `:505-508` | `_meta_for` silently falls back to the newest ring entry on timestamp mismatch; `capture_metadata` runs outside `_lock`. | Frame `ts` can point at the wrong frame with no flag; rare crash on reinit. |

## 2. Cross-cutting themes

1. **Registration accuracy is the shared weak point.** Super-res (8× downscale, D4), stitching (256 px analysis width), time-lapse drift (410 px) and live stack all use `fftTrack.displacement` on a heavy downsample and trust the result. Focus stacks already have the right pattern (`SliceAligner`: coarse phase correlation, then NCC refinement at full resolution). Make that the one registration primitive and test it at 0.1-0.5 px.
2. **Lock the camera for the whole run, not per frame** (D8). Also pin FrameDurationLimits explicitly (hypothesis: picamera2's video default clamps exposure near 33 ms while the AGC table goes to 66 ms).
3. **Metadata has to travel with the frame** (D6): capture via `switch_mode_and_capture_request`, put SensorTimestamp/exposure/gain/ColourGains/Lux in `X-Frame` and a versioned OFRW header trailer; parse it in `api/snapshot.ts`; store it plus µm/px and tuning id on every gallery item; add an EXIF IFD to the DNG.
4. **RAW is the quality path; the JPEG path is ISP-limited.** Stills are software JPEG at an unpinned quality (hypothesis: 90, 4:2:0), after ISP denoise (`rpi.sdn`) and sharpening (`rpi.sharpen`, Sharpness 1.0), which inflates Laplacian metrics and adds halos to every stack input. For stills only: `NoiseReductionMode Off`, `Sharpness 0`, pinned quality 95, drop the unused raw/main streams from still configs (each allocates ~16 MB it never reads).
5. **Fusion selects too hard.** `pyramidFuse.ts:110-119` takes a per-level argmax of smoothed |Laplacian| with no cross-level consistency and no noise floor: PMax-style halos at in-focus edges, noise amplification in flat regions (worst in the 16-bit RAW path). Tests only use half-blurred images with a straight seam, which cannot show either.

## 3. Ranked improvement plan

### Tier A: small, pure-TS or config, high return
| Idea | Gain | Cost | Risk |
|---|---|---|---|
| Fix D1, D2, D3, D5, D9 | Correct DNGs, working stabilisation, useful super-res frames, seamless mosaics | ≤ 1 day total, all unit-testable | Low |
| Coarse-to-fine registration everywhere + sub-pixel tests (D4) | 0.05 px shifts; prerequisite for super-res | Small (reuse `SliceAligner`) | Low |
| AE/AWB lock helper for all multi-shot modes (D8) | Consistent stacks, tiles, time-lapse frames | Small | Long time-lapses need a re-meter option |
| Alignment reference = middle slice, Lanczos-3 resampling (D7) | Recovers fine detail in fused stacks | Small | Slight ringing at saturated edges |
| Noise-floor averaging in `pyramidFuse` (average where all energies < per-level noise floor) | Clean backgrounds, essential for RAW stacks | Small | Low |
| Verify stage arrival (`end_hw` vs target, `cancelled`) and record read-back z | Correct depth maps, no silent short moves | Small | Low |
| Drizzle pixfrac 0.4-0.5 once registration is accurate; expose scale/pixfrac | Sharper super-res (the unit test shows it at 0.3) | Trivial | More holes with few frames |
| Time-lapse: absolute-clock scheduling, storage estimate and cap | Correct cadence, no silent quota failure | Small | None |

### Tier B: medium, still browser-side or single device RPC
| Idea | Gain | Cost | Risk |
|---|---|---|---|
| Still metadata end to end (D6): device request metadata → headers/OFRW trailer → gallery item + EXIF IFD | Archival stills, true AsShotNeutral, timing assertions | Medium (header versioned, `algo/raw.ts` update) | Low |
| Stills with ISP denoise/sharpen off, pinned JPEG quality, unused streams dropped | More fine detail into every stack; less memory on the Pi | Low | Noisier single JPEGs; test on the algae sample |
| Explicit FrameDurationLimits (stream 33 ms-0.5 s, stills up to 1 s) | Long low-gain exposures for dim samples | Low | Confirm the clamp hypothesis first |
| Mertens-style pyramid fusion: coarse weights from the smoothed fine-level winner map, softmax selection | Removes PMax halos | Medium (`pyramidFuse.ts` selection loop) | Needs a halo fixture test first |
| Adaptive fine-stack z step from a Laplacian/FocusFoM sweep (not JPEG size, whose FWHM is far broader than the DOF), ≈0.7× half-width spacing, one extra slice each end | Fewer soft bands, fewer wasted slices | Medium | A z µm/step factor would let it be sanity-checked |
| Two-pass autofocus (JPEG-size coarse, Laplacian/Brenner fine, Gaussian/Lorentzian fit), optional full-res confirmation still | Robust on low-contrast samples | Medium | Low |
| Stitch: per-tile log-gain equalisation from overlaps, MAD outlier rejection in the position solve, full-res tiles by default | Seamless, robust mosaics at 4× resolution | Small-medium, pure TS | 8192 px cap forces downscale beyond ~3×3 |
| Scan: height map + short local autofocus (±1-2 steps), adaptive settle ∝ move length | Sharp tiles on tilted samples | Small | Adds time per tile |
| LED stack: lock AWB and ColourGains; add camera-exposure bracketing (×0.5/1/2) alongside LED levels; multi-scale Mertens with contrast/saturation terms | No tint drift, exact ratios, no block halos | Low-medium | Exposure changes alter frame duration |
| Video: redraw on `event.frame` seq not a 15 fps timer; expose fps/bitrate/codec; per-frame `{t, seq, position}` sidecar | No duplicate frames, honest timing | Small-medium | AV1 is CPU heavy |
| Live stack: re-anchor the alignment reference to the composite every N frames | Avoids growing bilinear softening under slow drift | Small | Low |

### Tier C: larger, RAW-based, the real resolution and dynamic-range wins
| Idea | Gain | Cost | Risk |
|---|---|---|---|
| Multi-frame RAW averaging (device sums N raw frames in one mode switch as uint32, ships a 16-bit mean; browser aligns if needed) | √N shot-noise reduction, the only real SNR win available | numpy add of 8 MP × N ≈ 0.3 s each on Pi 3; N raw buffers of memory | Stage vibration between frames |
| Packed 10-bit raw transfer (`SBGGR10_CSI2P`, 10 MB) and RAW as the default Photo on a fast link | 37 % less transfer; linear 16-bit masters | Browser unpack code | 10-15 s per photo over WiFi |
| Flat-field: average several raw frames with the sample removed, store per-pixel gain maps (replaces placeholder `ct: 1234` ALSC tables), apply in `rawdev` and before stitching, export as DNG GainMap opcodes | Real vignetting and dust correction | One-off capture UI, small file | Stale field after re-alignment; must be optional |
| Super-res on the raw Bayer mosaic per CFA plane (4-shot 1 px pattern fills every CFA site: full RGB per pixel with no demosaic), then `rawdev` minus demosaic | True colour super-resolution, linear-light averaging, 16-bit output. The optics facts (88 nm/step; ~0.35 µm/px unverified in repo) imply luminance is only ~1.35× undersampled but each Bayer plane ~2.7×: this is where the headroom is | Medium-high: N × 16 MB transfers, new worker path | 9 frames ≈ 3 min |
| Post-drizzle Wiener / Richardson-Lucy with PSF = drop ⊗ pixel aperture ⊗ measured optical blur (bead or edge) | Recovers aperture and drop MTF loss | Medium + PSF-measurement UI | Ringing if the PSF is wrong |
| True HDR from linear RAW brackets (Debevec weights, known ratios) → radiance → tone map, 16-bit PNG | Real dynamic range, consistent with `focusfineraw` | Medium (`algo/hdr.ts`) | Slow capture; LED path needs a cc→flux curve |
| Better demosaic (DLMMSE/AHD/RCD) in WASM | Fewer zipper artefacts on fine structure; Malvar coefficients verified correct already | High | Speed at 8 MP |
| Similarity-transform (scale + translation) alignment for stacks | Edge registration if focus breathing is measurable | Medium-high | Measure breathing on hardware first |
| Hybrid DMap fusion using the smoothed depth index where confident | Zerene-style clean surfaces | High | Medium |
| Colour-checker CCM calibration (writes `rpi.ccm` via `tuning.ts:53`), CA/distortion correction from a grid target | Accurate stain colour, cleaner edges | Medium | Small targets hard at high magnification |

## 4. Per-mode facts worth knowing (verified in code)

- **Stream**: full 3280×2464 10-bit readout ISP-scaled to 820×616 (default) or 1640×1232, hardware MJPEG pinned near 100 kB/frame with quality unsettable; no crop or binning. Frame ts matched to encoder output by SensorTimestamp.
- **Still**: separate `create_still_configuration` mode switch, encoders stopped and restarted (~1.3 s), software PIL JPEG, quality unpinned. RAW: separate switch, unpacked SBGGR10 as uint16, 16 MB, ~14 s over WiFi, header = OFRW + w/h/bits/black/bayer only.
- **RAW develop**: black 64, 16×12 ALSC bilinear (evaluated per 8×8 block, fine), live WB gains, Malvar-He-Cutler 5×5 (coefficients checked against the paper), nearest-5000 K CCM, tuning gamma via LUT, 16-bit PNG filter 0 (~2× larger than with Paeth). `luminance_strength` and CT interpolation ignored (only matters on stock tunings). No highlight reconstruction: saturated regions come out coloured.
- **Quick focus stack**: user-fixed 5 × 50 steps, compensated `'z'` move to bottom then raw steps up, 150 ms + 2 frames settle, 8×8-cell |lap|⁴ weights, two 3×3 box passes, bilinear cell interpolation, JPEG q0.95.
- **Fine stack**: JPEG-size autofocus sweep sets centre and span (1.5 × FWHM), 9 slices, Burt-Adelson pyramid to min side 48 (6 levels at full res), coarse Gaussian = mean of all slices; depth index = level-0 winner, 3×3 majority vote once, z in steps only.
- **Autofocus**: raw sweep, z interpolated per frame from t0/t1 (constant speed assumption, correct for raw moves), ±4-sample parabola accepted only if curvature is significant and within dz/10 of the argmax, featureless if best/worst < 1.03, final compensated `'z'` approach.
- **Live stack**: 16×16 blocks, weight (E/best)⁴, forget 0.96, best decay 0.995, aligned to the first frame until reset. On a still scene it is a sharpness-weighted temporal average (denoising); extended DOF only when vibration moves the focal plane.
- **Super-res**: 3×3 raw moves at ~0.5 px (2 steps at 88 nm/step, 0.35 µm/px), drizzle scale 2, pixfrac 0.8, on demosaiced/sharpened/JPEG-compressed 8-bit input, 6560×4928 RGBA output (~130 MB), 4096 crop never triggers on IMX219.
- **LED stack**: factors 0.4/0.7/1/1.5 × current cc (dedup, ≤3 levels at full brightness), AE locked, AWB not, single-scale well-exposedness weights on gamma JPEGs, 8-bit output. Display-referred fusion, not HDR.
- **Scan**: default source = latest MJPEG frame, optional full-res stills; `'xy'` compensated moves, fixed 150 ms settle, `waitForFrames(2)`; focus none / every tile / coarse grid + bilinear height map with MAD rejection, no local refinement, autofocus failures swallowed. Stitch: 256 px greyscale, pairwise phase correlation (quality < 1.3 dropped), weighted Gauss-Seidel translation solve, 8192 px cap, JPEG q0.92.
- **Video**: canvas redraw on a 15 fps timer from the live `<img>` or live-stack bitmap, MediaRecorder VP9/VP8 12 Mbit/s, stream resolution, duplicates/drops, only end position stored.
- **Time-lapse**: interval starts after capture (period = interval + capture), optional LED gating and periodic autofocus, one JPEG per frame with no cap, drift on 410 px central 60 % crop with raw correction moves.

## 5. Open questions needing hardware
- picamera2 defaults for still `NoiseReductionMode`, `Sharpness`, JPEG quality and `FrameDurationLimits` (picamera2 not in `device/.venv`; check `camera.metadata` and the still config dict on the Pi).
- Actual super-res `shifts` recorded on hardware (phase diversity, stage repeatability at 1-2 steps).
- Whether AE/AWB actually drifts during a focus stack, and whether white-LED tint changes with drive current.
- Focus breathing magnitude with z (decides whether similarity alignment is worth it).
- Objective magnification / µm/px (README has 88 nm/step xy, 50 nm/step z, no optical pixel size).

## 6. Status (2026-09-11)

A capture-quality session (five parallel agents: device wire formats; focus stack/autofocus/live
stack; registration/super-resolution; scan/stitch/video/time-lapse; RAW/DNG/HDR — handoffs in this
session) closed nearly every Tier A/B item and several of Tier C. `cd device && .venv/bin/pytest -q`
(48 tests), `cd webapp && npm run check` (0 errors) and `npx vitest --run` (30 files, 237 tests) are all
green as of this status. Everything below is unit/synthetic-scene tested only; hardware verification is
still pending (§5 above and TODO.md's "Hardware verification needed").

### Confirmed defects (§1)

| # | Status | Implemented in |
|---|---|---|
| D1 | done | `webapp/src/lib/algo/dng.ts` (`ColorMatrix1` correctly unbalanced by white-balance gains, EXIF IFD, GainMap opcodes) |
| D2 | done | `webapp/src/lib/algo/drift.ts` (`shiftToFrame`/`playbackShift` rescale the measured shift to the actual frame width) |
| D3 | done | `webapp/src/lib/services/photo/superres.ts` (S×S grid at 1/S px through the CSM 2×2 matrix, snake order, per-reversal backlash pre-load) |
| D4 | done | `webapp/src/lib/algo/register.ts` + rewritten `algo/fftTrack.ts` `displacement()` (coarse-to-fine, <0.05 px on the audit's own pathological scene), wired into `workers/superresWorker.ts` |
| D5 | done | `webapp/src/lib/algo/stitch.ts` (`solvePositionsRobust`, `overlapGains`/`solveGains`, `BlendAccumulator` feather blend) + `workers/stitchWorker.ts` (optional multi-band blend) |
| D6 | partly | `device/openflexito/rawfmt.py` + `web.py` (still's own `X-Frame`/OFRW trailer metadata), `webapp/src/lib/api/snapshot.ts` (`fetchSnapshotWithMeta`), `store/gallery.ts` (`GalleryItem.capture`) — wired for `raw`/`rawavg`/`hdrraw` and the `'exposure'`/`'both'` bracket, **not** for plain `single` stills or LED-only brackets (TODO.md) |
| D7 | done | `webapp/src/lib/algo/align.ts` (`chooseReference` middle-slice default, Lanczos-3 resampling in `SliceAligner`) |
| D8 | done | `webapp/src/lib/services/cameraLock.ts` (`lockCamera`), used by `services/photo/focusStack.ts`, `exposureStack.ts`, `superres.ts`, `routes/Scan.svelte`, `services/timelapse.svelte.ts` |
| D9 | done | `webapp/src/lib/algo/rawdev.ts` (linearly-interpolated tone LUT, float planes, ALSC/CT interpolation, highlight desaturation) |
| D10 | done | `device/openflexito/camera.py` (`_meta_for` now tags `matched: false` instead of silently substituting; `capture_metadata` runs under `self._lock`) |

### Cross-cutting themes (§2)

1. Registration accuracy: done — `algo/register.ts` is now the one registration primitive (superres wired; not yet reused by stitch/time-lapse/live-stack's own downsampled `fftTrack.displacement` calls, which still use their original lighter-weight analysis widths).
2. Lock the camera for the whole run: done (D8, above); `FrameDurationLimits` explicit but unverified on hardware.
3. Metadata travels with the frame: partly (D6, above).
4. RAW is the quality path: done — `still_clean` (`NoiseReductionMode Off`, `Sharpness 0`), pinned JPEG quality 95, raw-only/JPEG-only stream configs (`camera.py`).
5. Fusion selects too hard: done — `algo/pyramidFuse.ts` noise-floor averaging, cross-level consistency, optional hybrid DMap-confidence blend (no UI toggle yet, TODO.md).

### Tier A

| Idea | Status | Where |
|---|---|---|
| Fix D1, D2, D3, D5, D9 | done | see D-table above |
| Coarse-to-fine registration everywhere + sub-pixel tests (D4) | done | `algo/register.ts`, `algo/__tests__/{fftTrack,register}.test.ts` |
| AE/AWB lock helper for all multi-shot modes (D8) | done | `services/cameraLock.ts` |
| Alignment reference = middle slice, Lanczos-3 resampling (D7) | done | `algo/align.ts` |
| Noise-floor averaging in `pyramidFuse` | done | `algo/pyramidFuse.ts` |
| Verify stage arrival (`end_hw` vs target, `cancelled`) and record read-back z | partly | `services/photo/focusStack.ts` (`moveZVerified`, focus/fine stacks only) — not applied to `Scan.svelte`'s tile moves |
| Drizzle pixfrac 0.4-0.5 once registration is accurate; expose scale/pixfrac | partly | `algo/drizzle.ts` (`pixfrac` default 0.5) and `services/photo/superres.ts` (`scale`/`pixfrac` options) implemented; no UI control (TODO.md) |
| Time-lapse: absolute-clock scheduling, storage estimate and cap | done | `services/timelapse.svelte.ts` |

### Tier B

| Idea | Status | Where |
|---|---|---|
| Still metadata end to end (D6) | partly | see D6 above |
| Stills with ISP denoise/sharpen off, pinned JPEG quality, unused streams dropped | done | `camera.py` (`still_clean`, `still_jpeg_quality`, `raw_main_size`) |
| Explicit `FrameDurationLimits` | done (unverified on hardware) | `camera.py`, `camera.status()` |
| Mertens-style pyramid fusion (focus stack) | done | `algo/pyramidFuse.ts` |
| Adaptive fine-stack z step | done | `services/photo/focusStack.ts` (dedicated Laplacian sweep, ≈0.7× half-width spacing) |
| Two-pass autofocus | done, no UI | `algo/autofocus.ts` (`twoPassAutofocus`, `fitPeak`), `services/autofocusService.ts` |
| Stitch: log-gain equalisation, MAD outlier rejection, full-res tiles by default | done | `algo/stitch.ts` |
| Scan: height map + short local autofocus, adaptive settle | done | `routes/Scan.svelte`, `algo/heightMap.ts`, `algo/scanPlan.ts` |
| LED stack: lock AWB, exposure bracketing, multi-scale Mertens | done | `services/photo/exposureStack.ts`, `algo/exposureFuse.ts` |
| Video: redraw on frame seq, expose fps/bitrate/codec, per-frame sidecar | done | `api/mjpegStream.ts`, `services/recorder.svelte.ts` |
| Live stack: re-anchor alignment reference | done | `algo/liveStack.ts` |

### Tier C

| Idea | Status | Where |
|---|---|---|
| Multi-frame RAW averaging | done | `device/openflexito/rawfmt.py`/`camera.py` (`/raw.bin?frames=N`), `services/photo/rawPhoto.ts` (`rawavg`) |
| Packed 10-bit raw transfer | done | `rawfmt.py` (`/raw.bin?packed=1`), `algo/raw.ts` |
| Flat-field | partly | `algo/flatField.ts`, `/flat.bin`, `services/photo/rawPhoto.ts#captureFlatField`, `store/calibration.svelte.ts` implemented; no UI (TODO.md) |
| Super-res on the raw Bayer mosaic per CFA plane | done | `algo/drizzle.ts#drizzleRawSuperres`, `workers/superresWorker.ts` (initRaw/addRaw), `services/photo/superres.ts#superresRawPhoto`; synthetic tests only |
| Post-drizzle Wiener/Richardson-Lucy deconvolution | partly | `algo/deconvolve.ts`, `superres.ts`'s `sharpen` option implemented; PSF has no measured optical-blur term |
| True HDR from linear RAW brackets | done | `algo/hdr.ts`, `/bracket.bin?raw=1`, `services/photo/rawPhoto.ts` (`hdrraw`) |
| Better demosaic (RCD) | done | `algo/demosaic.ts` (3-5× Malvar's cost, unmeasured on hardware) |
| Similarity-transform alignment for stacks | done, off by default | `algo/align.ts` (`alignSimilarity`); focus-breathing magnitude unmeasured on hardware |
| Hybrid DMap fusion | done, no UI | `algo/pyramidFuse.ts` (`hybridFuse`), `workers/stackWorker.ts` |
| Colour-checker CCM calibration, CA/distortion correction | pending | not started |
