# Focus stack / autofocus / live stack — handoff

Scope owned: `algo/{align,pyramidFuse,stack,sharpness,autofocus,depthMap,liveStack}.ts` + tests,
`workers/{stackWorker,liveStackWorker}.ts`, `services/{autofocusService.ts,liveStack.svelte.ts}`,
new `services/photo/focusStack.ts`. `npm run check`, `npx vitest --run` (237 tests) and `npm run build`
are all green.

## What changed

1. **pyramidFuse.ts bug fix (pre-existing, from a prior agent's unfinished work).**
   `depthSoft()`/`depthConfidence()` compared a per-slice weight against the accumulated total `B`
   (`accB[0]`), which sums every slice's *post-inheritance* level-0 weight, using the *raw*
   `pow(e·inv, power)` as the numerator. Inheritance can multiply a slice's weight well past its raw
   value, so both figures collapsed toward the uniform mean/1÷N regardless of the actual sharpness
   gap (confidence ≈ 0.5 always). Fixed by recording each slice's actual post-inheritance weight
   (`bestWeight0`) and its post-inheritance contribution to `softIndex`, both computed after the
   `Ws[0]` inheritance fold instead of before it. Also had to widen `pyramidFuse.test.ts`'s hybrid-
   fusion test margin/cell size — the *old*, broken confidence made the test pass by luck (low
   confidence meant hybridFuse mostly returned the pyramid result, which happened to already be
   correct); with confidence now genuinely reaching ~1, the test's tiny 128×96 canvas needed a
   smaller `cell`/`passes` so the depth-surface smoothing radius doesn't reach into the checked
   region (documented inline).

2. **align.ts / pyramidFuse.ts**: already had middle-reference + Lanczos-3 alignment, Mertens-style
   consistent selection, noise-floor averaging, hybrid DMap fusion and optional similarity alignment
   from the previous agent's session — I added the missing test coverage (`align.test.ts`:
   `chooseReference`/`alignStack` middle-reference chaining, Lanczos-vs-bilinear MTF, `alignSimilarity`
   with a 1% scale change) and refactored `PyramidFuser.result()`/`result16()` to share `packRgba8`/
   `packRgb16` with the worker's hybrid path (`unpackPlanes` is the inverse, also new/tested indirectly
   via the worker sanity check below).

3. **autofocus.ts**: added `fitPeak` (quadratic/gaussian/lorentzian sub-pixel peak fit — a Lorentzian
   fit is just a quadratic fit on `−1/s`, a Gaussian one a quadratic fit on `ln(s)`) and
   `twoPassAutofocus` (coarse JPEG-size sweep locates the plane, a short fine Laplacian sweep around
   it gets a sharper peak, with an optional full-resolution `confirm()` callback that falls back to
   the best fine sample if it disagrees). `autofocusService.runAutofocus` gained `mode: 'twopass'`;
   existing modes/signature are unchanged. Tests added to `autofocus_track.test.ts`.

4. **liveStack.ts**: `reanchorEvery` (default 200 frames) periodically re-anchors the alignment
   reference to a downsample of the *composite itself* rather than the stale first frame, so slow
   continuous drift no longer accumulates ever-larger bilinear softening. Test added.

5. **depthMap.ts**: `stepsToUm`/`depthLegend` convert a z lookup table to µm given Settings'
   `stageStepUm.z` (0.05 µm/step by default — already exists, I didn't need to add it) and report
   the right unit; `depthZMap` itself is unit-agnostic already so no other change was needed. Tests
   added. **Not wired into the saved gallery item** — see Open points below.

6. **stackWorker.ts**: rewritten. Slices now align to the *middle* slice (or the sharpest, if
   `reference: 'sharpest'`) via `chooseReference`/`SliceAligner.relativeTo`, with Lanczos-3 resampling
   by default (`resample` option). Memory: when the caller supplies `count` up front (`middle` mode —
   every caller in this codebase knows the slice count before capturing), only slices at-or-before the
   reference are buffered (their shift isn't known until the reference arrives); slices after it are
   aligned and fed to the pyramid immediately, same as the original single-pass design. Without
   `count`, or in `'sharpest'` mode (which needs every slice's luminance first), it falls back to
   buffering everything and aligning at `finish` — correct, just not streaming. New `method: 'hybrid'`
   option additionally runs `hybridFuse` at `finish`, which needs every aligned slice kept (packed,
   not float planes) regardless of the above — opt-in, documented as more expensive.
   **Not unit-tested** — no test file existed for it before either; `self`/`postMessage` aren't
   available in this repo's vitest environment (plain node, no jsdom), so importing the worker module
   throws `ReferenceError: self is not defined`. I sanity-checked the worker's logic (streaming vs
   full-buffer vs hybrid paths all agree, arrival-order assertion, `SliceAligner.relativeTo` usage)
   with a throwaway script (monkey-patched `globalThis.self`) — not committed. If a jsdom/worker test
   environment gets added later, this file is now the one most worth covering directly.

7. **services/photo/focusStack.ts (new)**: `takeFocusStack` (quick stack) and `takeFineFocusStack`
   (fine stack) moved out of `photoService.ts`, which now only dispatches. Both:
   - lock AE/AWB for the whole run via `cameraLock.withCameraLock` (previously only the LED/exposure
     stack did this — a focus stack could drift exposure/colour slice to slice, D8 in
     CAPTURE_AUDIT.md);
   - verify every z move (`moveZVerified`): compares the hardware read-back `end_hw.z` against the
     intended cumulative target (tolerance 1 step) and `cancelled`, retries once (the residual
     distance), aborts the stack otherwise, and records the *read-back* z into `zs` rather than the
     logical `device.position.z`;
   - align to the middle slice with Lanczos-3 (quick stack: inline `alignStack`+`chooseReference`;
     fine stack: via the rewritten `stackWorker.ts`).

   Fine stack additionally: measures the depth of field with a dedicated Laplacian sweep
   (`laplacianWidth`, 7 points over ⅙ of the locating range) instead of reusing the coarse
   autofocus's JPEG-size curve (CAPTURE_AUDIT.md D6/#6 — JPEG size is a whole-frame proxy whose curve
   is far broader than the real depth of field), then spaces slices at step ≈ 0.7 × half-width, sized
   to cover the half-width on each side plus one extra slice beyond each end, capped at the user's
   requested slice count (a ceiling, not a target).

## Open points (deliberately not done, outside this file ownership or out of scope)

- **µm depth-map legend isn't persisted to the gallery item.** `GalleryItem.stack.depth` (in
  `store/gallery.ts`, owned by another agent this session) is `{ minZ, maxZ, colorMap }` with no unit
  field, and I didn't want to add one without touching that file/type. `depthMap.ts`'s
  `stepsToUm`/`depthLegend` are ready and tested; `focusStack.ts` logs a µm reading to the progress
  stream but keeps the persisted `stack.depth.minZ/maxZ` in z steps (matching what
  `HeightMapOverlay.svelte`/`Viewer.svelte` presumably assume today). To finish this: add
  `unit?: 'steps' | 'µm'` to `GalleryItem['stack']['depth']`, have `focusStack.ts` pass
  `stepsToUm(zs, umPerStep)` into `depthZMap` when `umPerStep` is set, and update whatever component
  renders the depth legend to print the unit.
- **Hybrid fusion (`method: 'hybrid'`) has no UI control.** `PhotoOptions.method` and
  `stackWorker.ts`'s `method` option are wired end to end and covered by a manual sanity check, but
  nothing in `PhotoPanel.svelte`/`Settings.svelte` (both off-limits to me) exposes it yet. Someone
  with UI ownership needs to add a toggle that sets `PhotoOptions.method = 'hybrid'` for `focusfine`/
  `focusfineraw`.
- **`stackWorker.ts` has no direct unit test** (see point 6 above) — covered indirectly via
  `align.test.ts`/`pyramidFuse.test.ts` (the primitives it calls) and a manual, uncommitted sanity
  script. Worth adding a jsdom/worker-capable test target if this project wants direct coverage later.
- **`twoPassAutofocus`/`fitPeak` have no UI control either** — `AutofocusOptions.mode: 'twopass'` is
  wired in `autofocusService.ts` but nothing calls it from a component yet.
- The similarity (scale+translation) alignment in `align.ts` (`alignSimilarity`/`scaleGray`) stays
  off by default everywhere, as before — whether focus breathing on the OpenFlexure is large enough
  to need it is still unmeasured on hardware (noted in CAPTURE_AUDIT.md §5).
