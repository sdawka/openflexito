# Handoff: registration + super-resolution

Scope: `webapp/src/lib/algo/{fftTrack,fft,drizzle,csm,register}.ts` + tests, new `algo/deconvolve.ts`,
`workers/superresWorker.ts`, new `services/photo/superres.ts`, `algo/__tests__/helpers/`.

## What was already done when I picked this up

A previous, interrupted agent had already:
- Rewritten `fftTrack.ts`'s `displacement()` to refine the integer peak with a local-DFT upsampled
  (Guizar-Sicairos-style) estimator instead of the old thresholded-centroid/parabola average (item 1
  of the brief). Uncommitted, in the working tree.
- Added `algo/register.ts` (coarse-to-fine: downscaled integer estimate, then full-resolution refine
  on a central crop), `{dx, dy, quality, coarseQuality, fineQuality, confident}` (item 2). Untracked.
- Added `algo/__tests__/helpers/scene.ts` (band-limited synthetic scenes + the auditor's near-periodic
  LCG scene, specifically to reproduce the reported 44 px outlier).

Neither had tests yet, and items 3-6 (shift pattern, drizzle defaults, deconvolution, raw-plane
drizzle) were not started. This session did the rest.

## What I changed

- **`algo/__tests__/fftTrack.test.ts`** (new): sub-pixel accuracy at 0.1-0.5 px (0.05 px tolerance) at
  full resolution and at the frame sizes `register()`'s coarse stage and a 4x-downscaled stream use;
  a dense-grid sweep on the LCG scene confirming no 44 px-style outlier; `quality` separating a
  correct match from an unrelated pair.
- **`algo/__tests__/register.test.ts`** (new): coarse-to-fine accuracy on large (900-1024 px) frames,
  `confident` on a good match, `confident: false` on an unrelated pair and on an out-of-range shift,
  `boxDown` unit tests.
- **`algo/drizzle.ts`**: `pixfrac` default changed from 0.8 to 0.5 (brief item 4; the existing unit
  test already demonstrated the sharper reconstruction at 0.3-0.5). Added `weight?: number` per
  `DrizzleFrame` (0 excludes a frame, e.g. one `register()` marked not confident, without removing it
  from the reported list). Extracted the footprint-splatting math into a shared `splat()` used by both
  the RGBA path and a new single-channel `drizzlePlane()` (Float32 accumulation, reusable for raw
  planes) and `fillPlaneHoles()`. Added `drizzleBayer()`: drizzles N raw Bayer mosaics per CFA phase
  (R, two greens pooled, B) onto a common `scale`x grid with no demosaic step (item 6) — the classic
  4-shot 1-mosaic-pixel dither fills every colour at every output site. Tests added for all of the
  above in `algo/__tests__/drizzle.test.ts` (pixfrac default, weight exclusion/down-weighting,
  `drizzlePlane` matching the RGBA path on a grey scene, hole-filling, and `drizzleBayer` on a
  synthetic 4-colour mosaic scene, checked against the known colour function).
- **`algo/deconvolve.ts`** (new) + **`algo/__tests__/deconvolve.test.ts`**: `makePsf()` builds a PSF
  as the product of two boxes (drizzle drop, pixel aperture) and a Gaussian in frequency space (item
  5); `wiener()` and `richardsonLucy()` deconvolve one channel. Tested: PSF sums to 1 and is
  symmetric; both estimators raise correlation with ground truth on a synthetically blurred+noised
  scene versus the blurred input, stay finite/non-negative, and don't diverge under 40
  Richardson-Lucy iterations; Wiener's `noise` parameter trades sharpening against fidelity to the
  blurred input as expected.
- **`workers/superresWorker.ts`**: replaced the old `grayDown` (8x/4x whole-frame downscale) +
  `displacement()` path with `register()` on the full-resolution `luminance()` of each frame (item 2's
  "use it in superresWorker at full resolution"). A frame whose registration isn't `confident` is
  drizzled with `weight: 0` (reported, not silently included). `pixfrac` is now a message parameter
  (default 0.5) instead of hard-coded.
- **`services/photo/superres.ts`** (new): `superresPhoto()` moved out of `photoService.ts`, along with
  `centerCropRgba`. Implements item 3: an S×S grid (`scale` 2 or 3) at 1/S-full-resolution-pixel hops,
  planned in image pixels and converted to stage steps through the CSM 2x2 matrix
  (`calibration.csm.matrix`, image px → stage steps) rather than scaling a per-axis step count — the
  old code ignored the CSM rotation entirely (superres-hdr-report.md D3/§1). Visits cells in snake
  (boustrophedon) order; whenever an axis's direction reverses, a backlash pre-load move (from
  `csm.calX/calY.backlash`) precedes the real move so the mechanical slack is taken up predictably.
  Target stage positions are computed directly from the absolute grid cell (not accumulated per-hop),
  so rounding never compounds. Optional `extraFrames` adds randomised sub-pixel positions for
  redundancy. After capture, a frame is rejected (weight 0, reported) if its measured phase is more
  than 0.15 px from the nearest planned phase or duplicates an already-accepted frame's phase.
  Options: `scale` (2|3), `pixfrac` (default 0.5), `sharpen` (post-drizzle Wiener deconvolution against
  a PSF built from the drizzle drop + one physical pixel's aperture — no extra optical-blur term,
  since it isn't measured anywhere in this codebase). Uses `services/cameraLock.ts#lockCamera` for
  the whole run (freezes AE/AWB) instead of the old `superresPhoto` doing nothing about white
  balance. `photoService.ts` now only imports and dispatches (`o.superres ?? {}`); `PhotoOptions`
  gained a `superres?: SuperresOptions` field. Gallery item name is `Super-resolution {used}/{total}
  frames ×{scale}` (short label, no dates, per the brief); `extra.superres` gained `used`, `pixfrac`,
  `sharpened` fields (`store/gallery.ts`, additive).
- **`store/gallery.ts`**: extended the `superres` extra-data type with the new fields above (additive,
  not a file in my exclusive-ownership list, but the change was required and is narrow).

## Measured registration accuracy, before/after

From `superres-hdr-report.md` (previous audit, old `grayDown` + `displacement` path, whole frame
downscaled 4x/8x before registering):

| true shift (full px) | measured | error |
|---|---|---|
| (0.25, 0.15) | (0.10, 0.06) | 0.18 |
| (0.5, 0.3) | (0.20, 0.12) | 0.36 |
| (1, 1) | (0.41, 0.41) | 0.84 |
| (1.5, 0.9) | (−8.19, 43.96) | **44.1** |

After (this session's `fftTrack.test.ts` / `register.test.ts`, run against the repo's own code):
- `displacement()` alone, at full resolution and at 4x/8x-downscale-equivalent frame sizes: **< 0.05
  px** error for shifts 0.1-0.5 px (8/8 test cases), and no outlier beyond ~1 px error anywhere on a
  dense grid swept over the report's own near-periodic LCG scene (was the source of the 44 px cases).
- `register()` (coarse-to-fine, as now wired into `superresWorker.ts`) on 900-1024 px frames: **< 0.05
  px** for shifts up to 1.3 px, **< 0.15 px** for a 22-27 px shift (coarse stage + fine residual),
  `confident: true` for a real match, `confident: false` for an unrelated pair or an out-of-range
  shift.

I did not have hardware access to re-run the exact `regtest.ts`/`regtest2.ts` scripts from the
original audit; the numbers above are from the new unit tests, generated the same way (synthetic
scene, known shift, measure error) and cover the same shift range plus the specific pathological
scene.

## Suggested UI controls (not wired — `PhotoPanel.svelte`/`Settings.svelte` are out of my ownership)

- Super-resolution: a scale toggle (2x / 3x), an "extra frames" number input (redundancy against
  rejected frames), a "sharpen" checkbox (post-drizzle deconvolution), and surfacing `used`/`total`
  and any rejection reasons from `extra.superres` in the gallery detail view (currently only `shifts`
  is shown anywhere, if at all — I didn't check the viewer component).
- A `pixfrac` advanced setting (default 0.5) would let a user trade holes-at-few-frames against
  sharpness, per the report's Tier A recommendation.

## Suggested README text (not written — README.md is out of my ownership)

> **Super-resolution**: captures an S×S grid (S = 2 or 3) of full-resolution stills at 1/S-pixel
> stage offsets, planned through the camera-stage calibration so the pattern lands correctly even
> though the stage axes are rotated ~4° from the sensor. Each frame is registered to the first at full
> resolution and combined by drizzle (Fielding/Hook & Fruchter resampling) onto a finer grid;
> mis-registered or duplicate-phase frames are automatically excluded and reported. Requires the
> stage↔camera calibration (Calibrate tab) to have been run first.

## Open points

1. **Raw-plane super-resolution (item 6's raw fetch path) is not wired up.** `drizzleBayer()` itself is
   implemented and tested against a synthetic mosaic, but nothing in `services/photo/superres.ts`
   calls it: the brief said to leave the device raw-fetch/parse wiring as a clearly named TODO rather
   than invent a format, since `algo/raw.ts#parseRaw` and the OFRW v2 trailer are owned by another
   agent. **TODO for whoever picks this up**: add a `raw: boolean` (or a `'superresraw'` mode) option
   that, per grid cell, fetches `/raw.bin` (see `api/raw.ts#fetchRawBufferWithProgress`, already used
   by `photoService.ts`'s fine-stack RAW path) instead of a JPEG still, parses it with `algo/raw.ts`'s
   `parseRaw`, and feeds the resulting Bayer mosaics + measured shifts + `bayer` order into
   `drizzleBayer()`, then runs the existing `rawdev` pipeline (black level, LSC, WB, CCM, gamma) on
   the resulting linear R/G/B planes, skipping the demosaic step. Registration for the raw path should
   probably run on a quick demosaiced/binned preview of each raw frame (or on a still-mode JPEG shot
   alongside each raw, if the device supports it) rather than directly on the mosaic, since
   `register()`/`displacement()` assume a normal image, not CFA-patterned data.
2. **`sharpen`'s PSF has no optical-blur (Gaussian sigma) term** — only the drizzle drop and pixel
   aperture. Nobody in this codebase currently measures the actual optical PSF (a bead or knife-edge
   target), so I left `sigma` at 0 (`makePsf` supports it) rather than guess a number. Once
   `superres-hdr-report.md`'s Tier B "PSF-measurement UI" idea is built, wire that sigma in here.
3. **The `moveWithBacklashGuard` backlash pre-load is per-axis-reversal, not "always one direction."**
   The brief's shift-pattern bullet lists "one direction per axis" and "snake order" together, which
   are in tension for a 2D raster (a snake necessarily reverses one axis's direction every row). I
   implemented snake order for minimum travel and pre-load the backlash on every direction reversal
   (matching the `BaseStage` convention CLAUDE.md describes for compensated moves, replicated by hand
   here since these remain raw/uncompensated moves like the rest of the file). If "one direction per
   axis" was meant literally (e.g. only ever visit cells in a single quadrant, accepting a
   non-square/non-snake path to avoid any reversal at all), that would need a different cell ordering;
   I judged the pre-load approach more robust and did not want to guess further without a stage to
   verify actual backlash behaviour on hardware.
4. **No hardware verification.** Everything above is unit-tested against synthetic scenes only,
   consistent with the rest of this task (`--fake` device wasn't used either, since none of this
   changed device-side code). The CSM-matrix-based move planning, backlash pre-load, and phase
   rejection logic in `services/photo/superres.ts` have not been exercised end-to-end against a real
   or fake stage.
5. **Pre-existing, unrelated test failures observed in this session** (not caused by my changes, not
   in my ownership): `algo/__tests__/exposureFuse.test.ts` (1 failing assertion, `mertensFuse`) and
   `algo/__tests__/flatField.test.ts` (1 failing assertion, `flatFieldFromRaw`), both apparently
   mid-edit by other concurrent agents; and a stray `workers/__tests__/_tmp_smoke.test.ts` that fails
   with `self is not defined` (a worker-context smoke test run outside a worker environment) — looked
   like scratch/debug output left by another agent's `stackWorker.ts` work, not something I created or
   own. `npm run check` is clean (0 errors); `npx vitest --run` currently has 3 failing test files, all
   outside this task's ownership list.

## Files changed

- `webapp/src/lib/algo/fftTrack.ts` — not touched further this session (already done by the prior
  agent); tests added.
- `webapp/src/lib/algo/register.ts` — not touched further this session (already done); tests added.
- `webapp/src/lib/algo/__tests__/fftTrack.test.ts` — new.
- `webapp/src/lib/algo/__tests__/register.test.ts` — new.
- `webapp/src/lib/algo/drizzle.ts` — pixfrac default, per-frame weight, `drizzlePlane`,
  `fillPlaneHoles`, `drizzleBayer`.
- `webapp/src/lib/algo/__tests__/drizzle.test.ts` — extended.
- `webapp/src/lib/algo/deconvolve.ts` — new.
- `webapp/src/lib/algo/__tests__/deconvolve.test.ts` — new.
- `webapp/src/lib/workers/superresWorker.ts` — rewritten to use `register()` at full resolution,
  per-frame confidence-based weighting, configurable `pixfrac`.
- `webapp/src/lib/services/photo/superres.ts` — new (`superresPhoto`, `centerCropRgba`).
- `webapp/src/lib/services/photoService.ts` — `superresPhoto`/`centerCropRgba` removed, now
  imports/dispatches to `services/photo/superres.ts`; `PhotoOptions.superres` field added.
- `webapp/src/lib/store/gallery.ts` — `superres` extra-data type extended (`used`, `pixfrac`,
  `sharpened`, `confident` on shifts).

## Tests added

`fftTrack.test.ts` (8), `register.test.ts` (7), `drizzle.test.ts` (+8 new, 10 total),
`deconvolve.test.ts` (7). All pass; `npm run check` and the full `vitest --run` are clean except the
three pre-existing, out-of-scope failures noted in Open point 5.
