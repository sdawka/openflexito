# Focus stacking, autofocus and live stack — audit

Scope: `webapp/src/lib/algo/{stack,pyramidFuse,align,sharpness,autofocus,depthMap,liveStack,fft,fftTrack}.ts`, `workers/{stackWorker,liveStackWorker}.ts`, `services/{photoService,autofocusService,liveStack.svelte}.ts`, the related tests, `device/openflexito/{fake_camera,stage,camera}.py`. Read-only.

All 32 focus-related unit tests pass (`align`, `pyramidFuse`, `stack`, `liveStack`, `depthMap`, `autofocus_track`). The OpenFlexure v3 server clone is **not** present locally, so v3 comparisons below rest on the code's own docstrings, not on the reference source.

## 1. Current behaviour (facts)

### Capture, quick stack (`focus`) — `services/photoService.ts:144-180`
- z range is fixed by the user: `slices` (default 5) × `stepZ` (default 50) from `src/components/PhotoPanel.svelte:12-13`, symmetric about the current z. Nothing is derived from depth of field.
- Sequence: one compensated `'z'` move to the bottom (`:150`), then raw `+step` moves upward (`:152`), so every slice is approached from the same side after the device's v3-style pre-engagement. Return is `moveTo(startZ, 'z')` in `finally` (`:161`).
- Settle: fixed 150 ms plus two new stream frames, 1.5 s timeout (`:153`). Arrival is only "the move RPC resolved"; the device blocks until the board reports stopped and re-reads the hardware position (`device/openflexito/stage.py:231-274`). No vibration or frame-difference check.
- Exposure/WB are **not** locked across slices by the browser. The device freezes AE/AWB *per still* from the latest stream frame (`device/openflexito/camera.py:436-450`), so each slice locks to whatever AE/AWB had drifted to at that moment. Only the LED exposure stack locks AE (`photoService.ts:189-191`).
- Alignment on the main thread (`:166-170`), block fusion `focusStack`, saved as JPEG q0.95 with per-slice blobs, `method: 'blocks'`.

### Capture, fine stack (`focusfine`, `focusfineraw`) — `photoService.ts:210-303`
- Runs fast autofocus (JPEG size metric) over `range` (default 1000) to find `centreZ` (`:213`). Span = clamp(1.5 × FWHM of the JPEG-size curve above half max, ≥ slices×4, ≤ range) (`:216-221`); step ≥ 2; default 9 slices.
- Same move pattern: compensated to bottom (`:239`), raw steps up (`:241`), 200 ms + 2 frames settle (`:242`), return `moveTo(centreZ, 'z')` (`:264`).
- Slices stream into `stackWorker` (8-bit RGBA from JPEG, or 16-bit developed RAW via `rawWorker` `want: 'rgb16'`), aligned there (`stackWorker.ts:32-35`) and fused in the Laplacian pyramid; depth map extracted afterwards (`:277-284`). 16-bit result is written as PNG16 with an 8-bit preview.

### Alignment — `algo/align.ts`
- Translation only. No scale or rotation model.
- Neighbour-chained (`SliceAligner.next`, `:101-109`): coarse phase correlation at ≤ 410 px width (`displacement`, `fftTrack.ts:36-75`, high-pass σ 10 px, centroid + parabolic peak), accepted if peak ratio > 1.15 and shift < 5 % width (`align.ts:72`); then ±2 px NCC search per finer level on a 512×512 central crop (`:67-86`), parabolic sub-pixel fit at level 0 (`:88-91`). Slice 0 is always the reference; every other slice is resampled with bilinear interpolation (`translatePlanesSubpixel`, `:132-147`; `translateRgbaSubpixel`, `:115-129`).
- Tests: single-pair accuracy < 0.15 px with blur radius 3; five-slice chain < 0.3 px cumulative with synthetic blur (`align.test.ts:34-63`). No test with scale change, rotation, or real defocus PSFs.

### Fusion
- Quick stack `algo/stack.ts:110-126`: 8×8 cells, weight = (Σ lap²)² ≈ |lap|⁴ on luma (`cellMaps`, `:15-34`), normalise → two 3×3 box passes (`smooth`, `:37-52`) → normalise, bilinear weight interpolation between cell centres (`blend`, `:67-93`), one spatial-domain weighted average, 8-bit output. No pyramid.
- Fine stack `algo/pyramidFuse.ts`: Burt–Adelson pattern-selective fusion. Per level, per pixel, hard max of a 5×5 box-smoothed |Laplacian| of the **luma** pyramid (`energy`, `:56-70`; selection `:110-119`); RGB coefficients follow the luma winner; coarsest Gaussian is the plain mean of all slices (`:122`, `:129`). Downsample kernel [1 4 6 4 1]/16 (`:22-40`), bilinear upsample (`:43-53`). Pyramid depth: until min side ≤ 48 (`levelsFor`, `:12-19`), i.e. 6 Laplacian levels at 3280×2464. Float planes in, 8-bit (`result`, `:141-146`) or 16-bit (`result16`, `:153-158`) out; only a clamp on output.
- `depthIndex()` is the level-0 winner per pixel (`:117`, `:150`). Tests cover half-blurred synthetic images only (`pyramidFuse.test.ts`, `stack.test.ts`).

### Autofocus — `algo/autofocus.ts`, `services/autofocusService.ts`
- Fast (`autofocus.ts:113-141`): compensated `'z'` move −dz/2, raw sweep +dz, frames with t0 < ts ≤ t1 get z by linear time interpolation (`samplesFromSweep`, `:35-46`), metric = JPEG byte size of the MJPEG stream frame (`f.size`) or libcamera `focus_fom` (null on the fake, `fake_camera.py:108`). 150 ms wait for late socket frames (`:123`). Argmax, then least-squares parabola over ±4 samples accepted only if curvature is negative at 2σ and the fitted peak is within dz/10 of the argmax (`quadraticPeak`, `:58-85`; `:135-137`); featureless check best/worst < 1.03 throws (`:130-133`); final `'z'` compensated move (`:140`) so the approach direction matches the sweep. Looping variant retries when the peak is in the outer 1/5 of the sweep (`:144-154`).
- Step (`:164-180`): 9 Laplacian-variance samples on a 410 px snapshot (`autofocusService.ts:23`, `grabGray(410, 60)` = 60 ms + 1 frame), approach from below, raw moves, returns via below-then-up so the final approach shares the sampling direction. Parabola over ±2 samples.
- The sweep speed model is constant step rate (device duration = steps × `step_time_us`, `stage.py:236`).

### Depth map — `algo/depthMap.ts`
- 3×3 majority vote, one pass by default (`smoothDepthIndex`, `:13-37`), z lookup by slice index (`depthZMap`, `:40-44`), colour ramp normalised to the map's own min/max (`:68-76`), relief shading from the z gradient (`:81-94`). Units: z steps only, as documented (`:5-6`); no z step → µm factor exists.

### Live stack — `algo/liveStack.ts`, `services/liveStack.svelte.ts`
- Per 16×16 block weight = (E/best)^4 with floor 0.02, accumulators forget at 0.96/frame, best decays 0.995/frame (`liveStack.ts:97-104`); energy is Laplacian on 2×2-averaged luma (`:55-75`); per-pixel weights bilinearly feathered between blocks (`:106-129`). xy jitter aligned to the *first* frame of the composite with sub-pixel bilinear shift (`:80-91`), reset when shift ≥ 5 % width (`:86`).
- Service grabs the live `<img>` at 8 fps (`liveStack.svelte.ts:14`, `:47`), resets on any position event and ignores frames for 400 ms wall-clock and until frame timestamps pass the move time (`:71-80`). `LiveAverager` is a plain EMA α = 0.25 (`liveStack.ts:138-158`).

## 2. Defects and risks (with evidence)

1. **Reference slice is the most defocused one and stays unresampled.** Slice 0 is the bottom of the stack (`photoService.ts:150`, `:239`); every sharper slice is bilinearly shifted (`stackWorker.ts:35`, `photoService.ts:169`). Bilinear at a half-pixel shift is a [½,½] box: MTF 0 at Nyquist, ≈0.7 at half Nyquist. Fact: this softens every slice except the least useful one and biases the per-pixel winner toward slice 0. Hypothesis: visible loss of the finest detail in fused results and an inflated slice-0 contribution figure.
2. **Pure max-selection at coarse pyramid levels** (`pyramidFuse.ts:113-119`). Near a high-contrast in-focus edge, the defocused slice's blurred edge carries more low-frequency Laplacian energy a few pixels away from the edge, so coarse coefficients come from the wrong slice. This is the classic PMax halo/glow. Hypothesis, not tested: the tests use half-blurred images with a straight seam, which cannot show it.
3. **Noise amplification in flat regions.** Hard argmax of noisy |lap| among N slices selects the largest noise excursion at every fine-level pixel (`:114`). With 9 slices this raises fine-level noise variance in featureless background. Fact by construction; magnitude untested. The 16-bit RAW path is most exposed (no JPEG smoothing of the input).
4. **No consistency between levels or channels.** The winner is chosen per level independently; colour follows luma. Chromatic detail with no luma contrast is lost. Low risk in brightfield.
5. **Per-slice AE/AWB freeze, not per-stack** (`camera.py:445-449`). If AE or AWB moves between slices, the fused image blends different exposures/colours; the coarse Laplacian mean averages them, hiding the drift as low-frequency mottle. Fact: not locked. Whether AE actually drifts under defocus is a hypothesis (defocus changes contrast more than mean).
6. **Span from JPEG-size FWHM** (`photoService.ts:216-219`). JPEG size is a whole-frame, low-frequency-heavy proxy whose curve is much broader than the optical depth of field, so 1.5 × FWHM over 9 slices probably spaces slices wider than the DOF, leaving soft bands between planes. Hypothesis; the fake camera's blur ∝ |z| (`fake_camera.py:78-80`) cannot validate this.
7. **Quick stack has no DOF information at all**: 5 × 50 steps is a guess the user must tune per objective.
8. **Translation-only alignment on a 512 px central crop** (`align.ts:46-49`). Any magnification change or rotation with z leaves the frame edges misregistered while the centre reports a good fit. Hypothesis: on the OpenFlexure the z-actuator moves the optics module, so breathing is expected to be small but non-zero; unmeasured.
9. **Chaining error** accumulates linearly; tests bound it at 0.3 px over 5 slices on synthetic data. Fine for 9 slices, marginal for the 15 the UI allows.
10. **Arrival is not verified against the requested target**; the device re-reads position but callers never compare `end_hw` to the target or check `cancelled` (`photoService.ts:152`, `:241`). A cancelled or short move silently records a wrong `zs[i]`, which then feeds the depth map.
11. **Autofocus assumes constant sweep speed** (`autofocus.ts:43`). Holds for the raw sweep with the Sangaboard's fixed step time; a compensated sweep would break it (t0/t1 span two moves, `stage.py:297`). Today the sweep is raw, so this is a latent trap only.
12. **Sample-dependent autofocus failure**: JPEG size is dominated by whatever has most texture — dust on the camera window, condenser structure, sensor noise at high gain. The 1.03 ratio test catches an empty field but not a false peak. Low-contrast samples give a broad, noisy curve; the ±4-sample parabola is then rejected and argmax runs on noise. Hypothesis.
13. **Depth map**: correct as documented, z steps only; `scaleCal` carries `stageStepUm` for xy but nothing for z. One majority-vote pass leaves banding at slice ties. Minor.
14. **Live stack extends DOF only marginally.** Weights are relative to each block's own decayed best, so on a still scene it is a sharpness-weighted temporal average, i.e. mostly denoising; extended DOF appears only when vibration actually moves the focal plane (the docstring says so, `liveStack.ts:3-6`). Correctness: the alignment reference is the first frame until reset (`:90`), so slow drift under 5 % width is absorbed by ever-larger bilinear shifts of new frames, softening them relative to the stale first frame. `replaced` statistic counts blocks over the decayed best, so it never settles to zero on a still scene; cosmetic.

## 3. Improvement ideas (ranked)

| # | Idea | Gain | Cost | Risk |
|---|------|------|------|------|
| 1 | Reference = middle/sharpest slice; align others to it (chain outward both ways) and resample with bicubic or Lanczos-3 | Recovers fine detail lost to bilinear on the sharpest slices; removes slice-0 bias | Small: bidirectional `SliceAligner`, new kernel in `align.ts` | Low; slight ringing at saturated edges with Lanczos |
| 2 | Coarse-level weights derived from the smoothed fine-level winner map (Gaussian-pyramided, Mertens-style) instead of per-level argmax; soft (softmax) selection | Removes PMax halos and cross-level inconsistency in one change | Medium: rewrite of the selection loop in `pyramidFuse.ts`, keep streaming | Medium; needs a halo fixture (sharp disc over a blurred slice) |
| 3 | Noise-aware selection: where all energies at a pixel are below a per-level noise floor, average instead of selecting | Cleaner background; essential for the 16-bit RAW path | Small | Low |
| 4 | Lock AE/AWB for the whole stack (as the LED stack already does) and restore afterwards | Consistent brightness and colour across slices | Small, existing pattern in `photoService.ts:189-201` | Low |
| 5 | Adaptive z step from a real DOF estimate: use a Laplacian metric on stream frames (or FocusFoM) for the fine-stack sweep, space slices at ≈0.7 × measured half-width, add one extra slice beyond each end | Fewer soft bands, fewer wasted slices | Medium | Medium; a stage-step→µm factor for z would let it be sanity-checked |
| 6 | Verify arrival: compare `end_hw` to the target and check `cancelled`; retry or abort; record the read-back z in `zs` | Correct depth maps, no silent short moves | Small | Low |
| 7 | Two-pass autofocus: coarse JPEG sweep, then a short fine sweep with a Laplacian/Brenner metric and a Gaussian or Lorentzian fit | Sharper, more robust peak on low-contrast samples | Medium | Low |
| 8 | Similarity-transform alignment (scale + translation via log-polar or four-corner NCC) | Edge registration if breathing is measurable | Medium–high | Medium; measure breathing on hardware first, may be unnecessary |
| 9 | Hybrid DMap: build weights from the smoothed depth index and blend with the pyramid result where depth is confident | Zerene-style cleanliness on smooth surfaces | High | Medium |
| 10 | Per-slice light denoise (guided or bilateral on luma) before the RAW fine stack | Less noise entering selection | Medium, CPU cost | Low |
| 11 | Live stack: re-anchor the alignment reference to the composite every N frames | Avoids growing bilinear softening under slow drift | Small | Low |
| 12 | Full-res still at the peak to confirm autofocus before the fine stack starts | Guards against stream-proxy false peaks | Small, +1.3 s | Low |

Highest value for least work: items 1, 3, 4 and 6. Item 2 changes visible quality most and needs a dedicated halo test before touching the pyramid.
