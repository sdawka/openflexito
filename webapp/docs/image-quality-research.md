# Image quality research: focus plane, colour shading, resolution, noise, stitching

Status: research (2026-10-05), read-only survey of the code plus literature. Companion to the
self-calibrating shading work in `algo/shading.ts`, which this document does **not** revisit.
Evidence: a live frame from the real microscope (soft focus, yellow centre / magenta rim, low
contrast) and a stitched 3×3 scan (tiled shading, tiles out of focus, a thick debris specimen that
no single plane covers).

## 0. What the hardware actually resolves (sets every priority below)

| quantity | value | source |
|---|---|---|
| IMX219 pixel pitch | 1.12 µm | sensor datasheet |
| Objective (Settings default) | NA 0.65 (a 40× RMS objective) | `store/settings.svelte.ts` `objectiveNA: 0.65` |
| Abbe resolution at 550 nm | λ / 2NA ≈ 0.42 µm | — |
| Magnification with the OpenFlexure 50 mm tube lens | ≈ 40 × 50/160 = 12.5× (check with `stageStepUm` / the CSM calibration) | OpenFlexure optics design |
| Sample sampling, full 3280×2464 readout | ≈ 0.09 µm/px → **4.7 px per resolvable element** | derived |
| Sample sampling, 2×2 binned 1640×1232 | ≈ 0.18 µm/px → 2.3 px per element (still above Nyquist) | derived |
| Sample sampling, 820×616 live view | ≈ 0.36 µm/px → 1.2 px per element: **the live view is stream-limited, not optics-limited** | derived |
| Depth of field (n = 1, λ 550 nm) | ≈ λ/NA² + pitch/(M·NA) ≈ 1.3 µm | Berek formula, used by `algo/stackPlan.ts` |

Consequences, if the magnification figure holds (measure it, item M1):

1. The full-resolution still is ~2.3× oversampled. The **binned 1640×1232 mode loses nothing optically**, captures 4× faster, carries 2× the SNR per pixel, and is what `/record.h264` and the sweep stack already use. Scans and per-tile stacks can use it (A4, C3).
2. A 410 px grab (`grabGray(410, …)`, used by every Laplacian metric in `autofocusService.ts` and the scan's local refine) is **8× downsampled**: one DOF of defocus changes nothing visible at that scale. Fine focus metrics must run at ≥ 1640 px or on the ISP's own full-resolution focus statistic (A1).
3. The "soft" live frame is partly just the 820×616 stream. Judging focus quality from the live view is unreliable; judge it from stills.

## 1. Survey of what exists

| area | code | what it does today | gap |
|---|---|---|---|
| Focus metric | `algo/sharpness.ts` `laplacianVariance`, `gradientEnergy` | 4-neighbour Laplacian variance, Tenengrad-style gradient energy on grey floats | no normalisation by mean intensity, no band-pass, no ROI/tiling, computed on 410 px grabs |
| Autofocus | `algo/autofocus.ts` (`fastAutofocus` JPEG-size sweep + `quadraticPeak`, `loopingAutofocus`, `stepAutofocus` 9 stops, `twoPassAutofocus` with `fitPeak` gaussian/lorentzian and full-res confirm), `services/autofocusService.ts`, `store/focusCtl.svelte.ts` | v3 port; JPEG size of the MJPEG stream or libcamera `FocusFoM` as proxy | **the Pi's hardware MJPEG encoder is rate-controlled to ~100 kB/frame** (README "Stream mode"): sharpness goes into the quantiser, not the byte count, so the proxy's peak/floor contrast is suspect on hardware; the e2e passes because the fake has no rate control |
| Scan focus | `services/scan.svelte.ts` `FocusMode` `'none' | 'every' | 'interpolate'`, `afRange 600`, `localRefine ±40` 5-point Laplacian; `algo/heightMap.ts` robust plane / bilinear sub-grid with leave-one-out outliers | 'every' = one fast JPEG-size sweep per tile; 'interpolate' = sub-grid + prediction + optional 5-point Laplacian on 410 px | no curve-quality gate (empty field, debris), no drift model between tiles, no per-tile stack |
| Stack planning | `algo/stackPlan.ts` (`focusBand`, `planStack`) | band = sweep above threshold, spacing = DOF/2 | only used by the Photo panel's fine stack, not by scans |
| Fusion | `algo/pyramidFuse.ts` (Burt–Adelson pattern-selective, consistent selection, noise floor, hybrid DMap), `algo/sweepFuse.ts` (per-block argmax, motion gate), `algo/sweepDeconv.ts`, `algo/stack.ts` | mature, streaming, 8/16-bit | not wired to scan tiles |
| Deconvolution | `algo/deconvolve.ts` `makePsf` (box ⊗ box ⊗ Gaussian), `wiener`, `richardsonLucy`; pipeline step in `algo/pipeline.ts` | PSF is assumed (sigma), no chromatic term, same PSF across the field | no measured PSF, no per-channel PSF |
| RAW develop | `algo/rawdev.ts` (ALSC tables or measured flat, WB, Malvar/RCD demosaic, CCM by CT, gamma) | correct per-record parameters | tuning has **one CCM (5000 K), no `ct_curve`**, so `estimateColourTemperature` is always undefined |
| Lens shading | `algo/lst.ts` (v3 `lst_from_camera` port: 16×12 luminance + Cr/Cb from a RAW flat), `routes/Calibrate.svelte` → `camera.set_tuning`; `algo/flatField.ts` per-channel RAW flat | writes fixed ALSC tables (`n_iter 0`) | bundled `imx219.json` ships `luminance_lut` all 1.0 and Cr 1.07–1.50 / Cb 1.26–1.62: **stock-lens chroma shading with no luminance correction**; only the colour *gains* are corrected, never the colour *crosstalk* (Bowman 2020 §3) |
| Device camera | `device/openflexito/camera.py` | stream 820×616 from the full 3280×2464 readout (~18 fps), stills q95 with `still_clean` (ISP denoise off, sharpness 0), `frames=N` averaging for RAW only, brackets, binned record mode, fast modes | stills are single frames; no on-device averaging for JPEG; AWB is libcamera `bayes` on the specimen field |
| Stitching | `algo/stitch.ts` (`pairwiseOffsets` via `fftTrack.displacement`, `solvePositionsRobust`, RGB gain solve, overlap feather, 3-level multiband), `algo/shading.ts` | robust, bounded memory | no stage model, no seam finding, no sharpness-aware blending |

## 2. Ranked improvement plan

Ranking is quality gain per effort **on this hardware** (Pi 3B+ relay, all maths in the browser).
"Verify" names the fake-camera/e2e route first and the hardware test second.

### A. Focus plane in scans

**A1. Make the per-tile focus metric trustworthy (metric + resolution)** — rank 1

- *Problem.* Two of the three metrics in use are blind on hardware: JPEG size from a rate-controlled encoder, and Laplacian variance on an 8×-downsampled grab. Both are why "every tile" scans still come out soft.
- *Algorithm.* (a) Default the fast sweep to libcamera's `FocusFoM` (`metric: 'fom'`, already parsed by `samplesFromSweep`): the ISP computes it on the full-resolution raw before compression, so rate control cannot touch it. (b) For step/fine metrics, use **normalised variance** (Sun, Duthaler & Nelson 2004: best overall of 18 operators in brightfield microscopy, insensitive to illumination changes between tiles) on a **1640 px** grab, or a centre crop of a binned frame, with Brenner gradient as a cheap second opinion (Pertuz, Puig & Garcia 2013 compare 36 operators; Laplacian-family and Tenengrad lead when noise is low, variance-family when it is not). (c) Score the curve, not just the peak: `countTurningPoints` already exists; add peak/floor contrast and the fitted width in DOF units. A curve with contrast < ~1.3 or ≠ 1 turning point is "no information" (empty field) or "multiple planes" (debris), and the tile falls back to the height-map prediction instead of a random z.
- *Where.* `algo/sharpness.ts` (add `normalisedVariance`, `brenner`, `tileMetric` over a 4×4 grid returning the median of per-tile scores so one piece of debris cannot dominate); `algo/autofocus.ts` (`curveQuality()`); `services/scan.svelte.ts` `autofocusHere` (metric `'fom'`, gate on quality); `api/sampler.ts` `grabGray` width 1640 when a 1640 stream or binned frame is available.
- *Gain.* Removes the systematic per-tile softness; the fix is mostly configuration and a quality gate.
- *Cost.* Low (1–2 days). **Prerequisite:** `FocusFoM` is only copied into the RAW trailer today (`rawfmt.py`); the per-frame stream metadata built in `camera.py#_on_request` does not carry it and the fake emits `focus_fom: None`, so `metric: 'fom'` currently yields NaN everywhere. Add it to the frame meta on the device (one key, under `_meta_lock`) and compute a stand-in in `fake_camera.py` (Laplacian energy of the rendered frame) so the e2e can exercise it.
- *Verify.* Fake: a `focusMetric.mjs` e2e that sweeps z and prints peak/floor contrast and fitted-peak error for `jpeg`, `fom`, Laplacian@410, NV@1640; the fake's defocus ∝ |z| gives a known truth. Hardware (M2): log `f.size`, `focus_fom` and NV@1640 over one ±300-step sweep on the algae slide and compare contrasts; if JPEG-size contrast < 1.3 the proxy is dead on this encoder.

**A2. Focus drift tracking and plane prediction between tiles** — rank 3

- *Problem.* Slides are tilted and stages creep; "interpolate" measures a sub-grid once and trusts bilinear interpolation; "every" throws away everything it learned at the previous tile.
- *Algorithm.* Recursive least-squares update of the plane `z = a·col + b·row + c` after every *measured* tile (Micro-Manager's and MIST-style acquisitions do this as "focus drift correction" between positions), with an innovation gate: a measurement farther than k·σ from the prediction is held back as suspect and only accepted when the next tile confirms it. The prediction seeds the next tile's sweep centre and shrinks `afRange` to ±3 DOF around it, making every sweep shorter and more precise. OpenFlexure's own scanning uses the same idea informally (autofocus every N tiles, interpolate between).
- *Where.* `algo/heightMap.ts` (`PlaneTracker` class: `update(sample)`, `predict(col,row)`, `sigma`), used by `scan.svelte.ts` for both focus modes.
- *Gain.* Fewer failed tiles, faster scans, tilt handled continuously.
- *Cost.* Low-medium (pure TS + tests).
- *Verify.* Fake needs a tilt option (`OPENFLEXITO_FAKE_TILT=a,b` steps per tile) — a small addition to `fake_camera.py`; e2e asserts every tile's recorded z within 1 DOF of the fake's true plane.

**A3. Per-tile extended depth of field (EDOF tiles)** — rank 2

- *Problem.* The debris specimen in the 3×3 scan is thicker than one DOF (~1.3 µm); no single plane can be sharp everywhere, so even perfect autofocus leaves parts soft.
- *Algorithm.* Two options, both reusing existing fusion code:
  - **A3a. Per-tile sweep stack (recommended).** For each tile, run the existing sweep stack (`services/photo/sweepStack.ts`: one continuous z sweep recorded from the sensor's H.264 at 1640×1232, frames' z from timestamps, band fused by the pyramid worker). The binned mode is at Nyquist for this optic (§0), so no resolution is lost versus a full-res still. One sweep ≈ 2 s per tile versus 1.3 s for a still; the stage already moves in z for autofocus. The sweep's own sharpness curve *is* the autofocus, so A1's sweep and the capture merge into one move.
  - **A3b. Per-tile discrete stack.** `stackPlan.ts` sizes a 3–5 slice full-res stack from the autofocus band; `pyramidFuse` fuses it (16-bit path exists). 4–7 s per tile; use when the user wants the full 8 MP mosaic.
  - Fusion: pyramid fusion with `selection: 'consistent'` (no PMax halo) for static specimens; `sweepFuse`'s motion-gated argmax only for live/moving work. Forster et al. 2004 (complex-wavelet EDOF) is the classic reference; the Laplacian-pyramid variant already here is the standard practical equivalent.
- *Where.* `scan.svelte.ts`: a new `capture: 'still' | 'sweep' | 'stack'` config; tile blobs become fused PNG/JPEG + a per-tile depth map (`PyramidFuser.depthIndex()`) kept in `scan.tiles[i]` so `HeightMapOverlay` can show relief; `components/ScanMap.svelte` unchanged.
- *Gain.* Largest visible improvement on thick specimens; also makes autofocus error irrelevant within the band.
- *Cost.* Medium (orchestration + storage; fusion exists). Scan time ×1.5–3.
- *Verify.* Fake: the specimen needs per-feature z offsets (a thickness parameter) so a single plane cannot be sharp; e2e compares mean NV of EDOF tiles vs single-plane tiles. Hardware: the debris slide, 3×3, compare the two mosaics' per-tile sharpness (M3).

**A4. Scan capture from the binned mode** — rank 5 (enabler)

- *Problem.* Full-res stills cost 1.3 s + 1.5 MB each and a mode switch; the resolution is not usable (§0).
- *Algorithm.* Offer `fullRes` = `'full' | 'binned'`: a binned 1640×1232 still (`switch_mode` to the record sensor config, `capture_request`) or the first frames of a recording. Keep full-res as an option for low-magnification objectives where the sampling is tighter.
- *Where.* `camera.py#still` (sensor size parameter), `api/snapshot.ts`, `scan.svelte.ts` (`fov` derived from the chosen size).
- *Cost.* Low. *Verify.* Hardware MTF measurement M1 decides whether binned ≥ full in practice.

### B. Colour shading and white balance

**B1. Measure the lens-shading tables on this optic and fix the tuning's shape** — rank 1 (shared with A1)

- *Problem.* The yellow-centre/magenta-rim field is what an IMX219 produces when its stock-lens chief-ray-angle compensation meets a telecentric microscope beam (Bowman et al. 2020: the microlens offsets cause both vignetting and **colour crosstalk** that rises towards the edge; the firmware's built-in correction is tuned for the stock short-focal-length lens). The bundled `imx219.json` ships exactly that stock-lens chroma shape (Cr up to 1.50, Cb up to 1.62 at the edge) with no luminance correction and fixed tables (`n_iter 0`, so libcamera's adaptive ALSC never runs). Applying stock chroma gains to an optic that does not have the stock shading *adds* a magenta rim. `tuning_customised` in `system.status` says whether the Calibrate step has ever been run on the scope that took the sample frame.
- *Algorithm.* (a) Run the existing Calibrate flow (`lst.ts`: flat tables → RAW flat of an **empty, evenly lit** field → `lensShadingFromPlanes` → `set_tuning`), then re-check the field. (b) If the field is clean but the rim stays desaturated, that is crosstalk, not gain: implement Bowman's spatially varying **colour unmixing** — a 3×3 matrix per 16×12 cell, estimated from a RAW flat under R, G, B illumination (the Sangaboard's spare PWM channels can drive three LEDs; or a colour-chart slide at several field positions), inverted per cell and applied to the linear RGB planes in `rawdev.ts` after demosaic and before the CCM. A cheap first approximation is a per-cell **saturation gain** (scalar boost of chroma towards the edge) baked into the same 16×12 grid. (c) Consider `n_iter > 0` with the measured tables as the prior, so ALSC tracks illumination colour changes; measure whether it hunts under the LED.
- *Where.* `algo/lst.ts` (`unmixingFromFlats`), `algo/rawdev.ts` (`developLinear` gets an optional per-cell matrix field), `algo/tuning.ts` (store it in the tuning JSON under a custom key that libcamera ignores), `routes/Calibrate.svelte` (a step 1d).
- *Gain.* Removes the dominant colour defect in every single image, not just mosaics.
- *Cost.* (a) zero code; (b) medium (new calibration + RAW path); (c) a day of hardware trials.
- *Verify.* Fake already renders vignetting + tint (`fake_camera.py` shading model) and the e2e has "both calibrations"; extend `mosaicMetric.mjs`'s fold to a single-still version (radial polynomial fit to log R/G, B/G) and assert the contrast after calibration. Hardware: M4.

**B2. Apply the measured per-channel flat to JPEG stills and the live view** — rank 4

- *Problem.* The ISP tables only fix what the ISP sees; stills taken before a calibration, and any residual (dust, LED off-axis), stay. Scan tiles now get `estimateShading`, but single Photos and the live view do not.
- *Algorithm.* One `GainMap` (16×12 or 32×24, per channel) from either the RAW flat (`calibration.rawFlatField`, `flatField.ts`) or the last scan's `ShadingEstimate`; apply in **linear light** (decode with the tuning's `gamma_curve` or sRGB, divide, re-encode) — a JPEG is gamma-encoded, dividing the encoded values over-corrects shadows. For the live view, register a `FrameProcessor` on the `view` target (order ~30, before deflicker) in `services/frameChain.ts`; it is a 820×616 per-pixel multiply, cheap. For stills, a step at `saveSnapshot` time guarded by a setting, keeping the original blob.
- *Where.* `services/shadingProcessor.ts` (new), `algo/flatField.ts` `applyGainMapRgba(linear)`, `services/photo/common.ts`.
- *Gain.* Flat live view and stills at once; the user sees the calibration working.
- *Cost.* Low. *Verify.* Fake + e2e: snapshot after flat calibration, radial fit contrast < 0.05.

**B3. White balance from a blank field, locked per scan** — rank 6

- *Problem.* libcamera's `bayes` AWB on a specimen field drifts towards grey-world; a yellowish specimen makes the background blue, a blue-stained one makes it yellow. `cameraLock.ts` freezes whatever AWB settled on at scan start.
- *Algorithm.* "Set WB on blank" button and scan option: move to an empty tile (or the brightest 5 % of the first tile), compute `ColourGains` so that patch is neutral (`whiteBalance.svelte.ts` has the neutral picker maths), persist as the scan's gains. Add a `ct_curve` and a second CCM to the tuning only if a colour chart is available (the CTT is the Raspberry Pi tool for this); with a single white LED the 5000 K CCM is adequate.
- *Where.* `services/scan.svelte.ts` (pre-scan step), `services/whiteBalance.svelte.ts`.
- *Cost.* Low. *Verify.* Hardware only: background mean chroma per tile after a scan.

### C. Resolution and sharpness

**C1. Measured PSF and per-channel deconvolution** — rank 7

- *Problem.* `deconvolve.ts` assumes a Gaussian sigma; wrong sigma either does nothing or rings.
- *Algorithm.* Estimate the PSF from the image itself with the **slanted-edge method** (ISO 12233 style: find straight edges in a still, build the oversampled edge-spread function per colour channel, differentiate to the line-spread function, fit a Gaussian or Airy-Gaussian); do it in 3×3 field zones to get a radially varying sigma. A 1 µm bead slide gives the direct PSF if available (standard in fluorescence; Huygens/PSF Distiller workflow). Then `wiener` per channel with the measured sigma, Anscombe-stabilised as in `pipeline.ts`.
- *Where.* `algo/psfEstimate.ts` (new, pure), `algo/deconvolve.ts` `makePsf({ sigma })` per channel and zone, `components/EnhancePanel.svelte` "measure PSF from this image".
- *Gain.* Moderate: real sharpening of edges inside the band without the halos of unsharp masking.
- *Cost.* Medium. *Verify.* Fake: known Gaussian defocus; estimated sigma within 10 %. Hardware: M5.

**C2. Lateral chromatic aberration estimation** — rank 8

- *Problem.* Colour fringes at the field edge add to the "magenta rim" and soften edges after demosaic.
- *Algorithm.* Lateral CA is a per-channel radial scale (plus a small offset): find R and B scale factors that maximise alignment with G along edges (minimise edge-position differences from the slanted-edge data in C1, or a coarse-to-fine search on `register.ts` per field zone); correct by resampling R and B in linear light before the CCM (Rudakova & Monasse 2013 for the precise model; Lensfun TCA for the radial-polynomial form). The Enhance pipeline already has a CA step; give it measured parameters instead of manual sliders.
- *Where.* `algo/psfEstimate.ts` returns per-channel edge offsets; `algo/enhance.ts` CA step takes `{ rScale, bScale, centre }`; `rawdev.ts` applies it at develop time for RAW.
- *Cost.* Low once C1 exists. *Verify.* Fake: add a CA term to `fake_camera.py` shading model; residual edge offset < 0.3 px.

**C3. Capture mode and sharpening order** — rank 9

- Stills already use `still_clean` (no ISP denoise, sharpness 0), which is right for a browser pipeline. Keep sharpening last-but-one (`pipeline.ts` already orders: denoise → deconvolve → tone → sharpen → CLAHE → look). The remaining choice is C3 = A4: capture from the binned mode when the optic is oversampled, otherwise demosaic with RCD (`demosaic.ts`) from RAW tiles for the sharpest result at 4 s per tile over Ethernet. RAW tiles are only worth it with Ethernet (README link table).

### D. Noise and dynamic range

**D1. On-device frame averaging for stills** — rank 10

- *Problem.* Single q95 JPEG stills carry the sensor's read + shot noise (README measured 0.87 levels temporal noise on the stream); the noise floor limits how far C1 can sharpen.
- *Algorithm.* Reuse the RAW `frames=N` path for stills: N `capture_request`s in one mode switch, averaged on the device in the YUV `main` buffer (float32 accumulate, numpy, ~0.3 s per 8 MP frame on the Pi 3) before JPEG encoding; or average in the browser from the RAW mean (exists) and develop. Lock AE/AWB during the burst (`_still_controls(frozen)` already does).
- *Where.* `camera.py#still(frames=N)`, `web.py` `/snapshot.jpg?full=1&frames=4`, `api/snapshot.ts`.
- *Cost.* Low-medium. *Verify.* Hardware: temporal noise of a flat field vs N (M6).

**D2. Exposure strategy for scans** — rank 11

- *Problem.* AE is locked from the first tile; a bright blank first tile under-exposes dense tiles and vice-versa.
- *Algorithm.* Expose-to-the-right on the **background**: before the scan, set exposure so the brightest 2 % of the blank field sits at ~90 % (histogram maths in `algo/histogram.ts`), then lock. Optionally an **HDR tile** mode: `/bracket.bin` (OFBK) per tile fused with Mertens exposure fusion (`exposureStack.ts`) — only for very dense stained sections; it triples capture time.
- *Where.* `scan.svelte.ts` pre-scan, `services/cameraLock.ts` (`lockCamera({ ettr: true })`).
- *Cost.* Low. *Verify.* Fake e2e: background p98 within 85–95 % after lock.

### E. Stitching beyond shading

**E1. Stage-model-constrained translation refinement (MIST)** — rank 12

- *Problem.* `pairwiseOffsets` accepts any phase-correlation peak above `minQuality 1.3`; on blank or periodic overlaps it accepts a wrong peak and the robust solve has to find it.
- *Algorithm.* MIST (Chalfoun et al. 2017): evaluate the top two phase-correlation peaks and their four periodic aliases by NCC over the overlap; estimate stage repeatability *r*, camera angle and backlash from the medians of the horizontal/vertical translation sets; replace translations that deviate from the row/column median by more than 4r with the median; refine by constrained hill-climbing on NCC within ±4r. `displacement()` already returns a quality; add NCC verification and the 4r clamp. ASHLAR (Muhlich et al. 2022) uses the same idea with a permutation test for the noise threshold.
- *Where.* `algo/stitch.ts` `pairwiseOffsets` → `pairwiseOffsetsMist`, `stageModelFromPairs`.
- *Cost.* Medium (pure TS + tests). *Verify.* Fake scans with sparse specimen (blank overlaps); e2e asserts positions within 2 px of the fake's 1 px/step model.

**E2. Sharpness-aware seams** — rank 13

- *Problem.* Feather and multiband blend average a sharp tile with a soft neighbour in the overlap, so every overlap is a soft band even when one tile is in focus.
- *Algorithm.* Weight each tile's feather by a smoothed local sharpness map (NV in 32 px cells) so the sharper tile dominates the overlap; it is a per-cell weight multiply in `BandAccumulator`. Full graph-cut seams (Kwatra et al. 2003, Agarwala et al. 2004) are overkill for 8192² in a worker; a **minimum-error-boundary** dynamic-programming seam per overlap strip (Efros & Freeman 2001) gives most of the benefit at O(strip) cost and hides small misregistrations as well.
- *Where.* `algo/stitch.ts` `BandAccumulator` (weight hook), `algo/seam.ts` (new).
- *Cost.* Low (weights) / medium (DP seams). *Verify.* Fake with a tilt option (A2): the overlap band's NV approaches the sharper tile's.

## 3. Do first (best quality per effort on this hardware)

1. **B1(a) + A1(a)**: run the lens-shading calibration on a clean blank field and switch the scan's fast autofocus to `FocusFoM`. Zero to one day; both are configuration on top of existing code and remove the two most visible defects (colour rim, random tile focus).
2. **A1(b,c)**: normalised variance at 1640 px plus a curve-quality gate that falls back to the predicted z. One to two days of pure TS with the fake's known defocus as truth.
3. **A3a**: per-tile sweep stack from the binned H.264 sweep, fused by the existing pyramid worker. Two to four days; the only fix for specimens thicker than one DOF, and it merges autofocus and capture into one z move.
4. **B2**: per-channel flat on the live view (frame-chain processor) and stills, applied in linear light. One day; makes the calibration visible everywhere.
5. **A2**: recursive plane tracker between tiles, shrinking each sweep around the prediction. One to two days.

Then C1/C2 (measured PSF and CA), E1 (MIST constraints), D1 (averaged stills).

## 4. Measurements to take on the real microscope

| id | capture | score | decides |
|---|---|---|---|
| M1 | Stage calibration (`stageStepUm`) + a stage micrometer or the CSM calibration | µm/px at full res and binned; slanted-edge MTF50 of a sharp edge in both modes | whether binned mode is lossless (A4, A3a, C3) |
| M2 | One ±300-step z sweep on the algae slide, logging `size`, `focus_fom`, Laplacian@410, NV@1640 per frame (an e2e-style script against the Pi) | peak/floor contrast and turning-point count per metric; fitted peak vs the step-metric peak | A1 metric choice; whether the JPEG-size proxy is dead on the hardware encoder |
| M3 | 3×3 scan of the debris slide three ways: single plane, A1 metric, EDOF tiles | per-tile NV map; fraction of tiles within 1 DOF of their neighbour's z | A3 |
| M4 | RAW flat of an empty field before and after `lst.ts` calibration; a saturated colour chart or stained slide at centre and corner | radial fit of log R/G, B/G (contrast p95−p5); saturation of the same patch centre vs corner | B1(a) vs B1(b): gain shading vs crosstalk |
| M5 | Full-res still of a sharp edge (coverslip edge or a bead slide) at centre and four corners | per-channel edge-spread sigma and R/B offset vs G | C1 sigma, C2 CA scale |
| M6 | 8 flat-field stills at fixed exposure, 1 and 4 frames averaged | temporal std per channel; histogram p2/p98 of a dense tile vs a blank one | D1, D2 |
| M7 | 5×5 scan with 20 % overlap, blank corners | `pairwiseOffsets` residuals after solve; MIST-style r estimate; count of dropped pairs | E1 |

## 5. Sources

- Bowman, Vodenicharski, Collins, Stirling, *Flat-field and colour correction for the Raspberry Pi camera module*, J. Open Hardware 4(1), 2020 — https://doi.org/10.5334/joh.20 (arXiv https://arxiv.org/abs/1911.13295); OpenFlexure forum discussion https://openflexure.discourse.group/t/lens-shading-correction-for-raspberry-pi-camera/682
- Knapper et al., *Fast, high-precision autofocus on a motorised microscope: automating blood sample imaging on the OpenFlexure Microscope*, J. Microscopy 285(1), 2022 — https://onlinelibrary.wiley.com/doi/10.1111/jmi.13064 (JPEG-size sharpness proxy; assumes a constant-quality software MJPEG encoder)
- Sun, Duthaler, Nelson, *Autofocusing in computer microscopy: selecting the optimal focus algorithm*, Microsc. Res. Tech. 65, 2004 — https://amnl.mie.utoronto.ca/data/J7.pdf (normalised variance best overall)
- Pertuz, Puig, Garcia, *Analysis of focus measure operators for shape-from-focus*, Pattern Recognition 46(5), 2013 — https://doi.org/10.1016/j.patcog.2012.11.011
- Micro-Manager autofocus manual (OughtaFocus: Brent search, Mean/StdDev/Edges and later metrics) — https://micro-manager.org/Autofocus_manual
- Chalfoun et al., *MIST: Accurate and Scalable Microscopy Image Stitching Tool with Stage Modeling and Error Minimization*, Sci. Rep. 7, 2017 — https://www.nature.com/articles/s41598-017-04567-y ; code https://github.com/usnistgov/MIST
- Muhlich et al., *Stitching and registering highly multiplexed whole-slide images of tissues and tumors using ASHLAR*, Bioinformatics 2022 — https://labsyspharm.github.io/ashlar/
- Forster, Van De Ville, Berent, Sage, Unser, *Complex wavelets for extended depth-of-field*, Microsc. Res. Tech. 65, 2004 — https://bigwww.epfl.ch/publications/forster0404.html
- Kwatra et al., *Graphcut textures*, SIGGRAPH 2003; Agarwala et al., *Interactive digital photomontage*, SIGGRAPH 2004; Efros & Freeman, *Image quilting*, SIGGRAPH 2001 (minimum-error-boundary seam)
- Rudakova & Monasse, *Precise correction of lateral chromatic aberration in images*, PSIVT 2013 — https://imagine.enpc.fr/~monasse/Callisto/pdf/PSIVT2013ChromAber.pdf
- Raspberry Pi camera tuning: picamera2 ALSC discussion (`n_iter`, `luminance_strength`, fixed vs adaptive tables) — https://github.com/raspberrypi/picamera2/discussions/597 ; Raspberry Pi *Camera Algorithm and Tuning Guide* §5.9 (ALSC), Camera Tuning Tool
- Goldman & Chen, *Vignette and exposure calibration and compensation*, ICCV 2005 (basis of `algo/shading.ts`, for context)
