# Handoff: raw-plane (Bayer) super-resolution

Scope actually touched: `webapp/src/lib/algo/drizzle.ts` (+tests), `webapp/src/lib/algo/rawdev.ts`
(one small additive refactor), `webapp/src/lib/workers/superresWorker.ts`,
`webapp/src/lib/services/photo/superres.ts`. Nothing else was edited.

## What I built

`superresraw`: same S×S grid, snake move order and backlash handling as the existing JPEG
`superresPhoto`, but each grid frame is a whole `/raw.bin` record (OFRW v2) instead of a JPEG still,
and the reconstruction skips demosaicing entirely.

- **`algo/drizzle.ts`**: added `drizzleRawSuperres(frames, scale, pixfrac, opts)` — drizzles N Bayer
  mosaics onto a `scale`× grid with no demosaic step (`drizzleBayer`, already existed), then runs the
  rest of the RAW develop pipeline on the combined planes: per-source-frame black level, white balance
  and lens-shading/flat-field correction (`rawdev.ts#prepareMosaic`, applied *before* drizzling, since
  shading is a function of the frame's own sensor position — not something that survives being
  averaged with other frames' shading first), hole-filling per plane (`fillPlaneHoles`, one plane at a
  time so an isolated red hole doesn't leave a colour fringe), then highlight desaturation and the
  colour matrix on the combined RGB (`rawdev.ts#desaturateHighlights`/new `applyCcm`). Also extended
  `DrizzleBayerResult` with per-plane weight arrays (`rWeight`/`gWeight`/`bWeight`, additive) so a
  caller can actually call `fillPlaneHoles` on the result — the existing type didn't expose them.
- **`algo/rawdev.ts`**: pulled the inline colour-matrix loop out of `developLinear` into an exported
  `applyCcm(rgb, ccm)` (pure, additive refactor; `developLinear`'s own behaviour is unchanged) so
  `drizzleRawSuperres` can reuse the exact same matrix step instead of a second copy.
- **`workers/superresWorker.ts`**: added `initRaw`/`addRaw` messages alongside the existing
  `init`/`add` (RGBA/JPEG) ones — same worker, same `finish` message, discriminated by which `init*`
  arrived. `addRaw` registers each frame on a caller-supplied registration proxy (see below), doubling
  the measured shift back to full mosaic-pixel units (the proxy is at half the mosaic's resolution).
  `finish` (raw branch) calls `drizzleRawSuperres`, then `rawdev.ts#encodeRgb16`/`toRgba8` and
  `png16.ts#encodePng16` — the whole ~390 MB-worst-case intermediate stays in the worker and only a
  16-bit PNG `Blob` + small 8-bit preview cross back to the main thread. If drizzling throws (most
  likely a memory allocation failure), the worker centre-crops its own already-received mosaics
  further (keeping width/height/offsets even so the CFA phase isn't disturbed) and retries up to twice
  before giving up, reporting the retry as progress.
- **`services/photo/superres.ts`**: added `SuperresOptions.raw?: boolean` and a new
  `superresRawPhoto()` that `superresPhoto` dispatches to when set. It fetches `/raw.bin` per grid
  cell (`api/raw.ts#fetchRawBufferWithProgress`, already used elsewhere for RAW modes), parses it
  (`algo/raw.ts#parseRaw`), builds a registration proxy (`splitBayer`'s two green planes averaged into
  one half-resolution `Gray`) since `register()`/`displacement()` assume a normal image, not
  CFA-patterned data, and centre-crops the mosaic up front on a memory-constrained device
  (`navigator.deviceMemory < 4` → 2400 px long-side bound, vs. 4096 otherwise, matching the JPEG
  path's own cap) before sending it to the worker. Reused the JPEG path's grid planning
  (`planGrid`/`stepsForPixels`/`moveWithBacklashGuard`) and factored the phase accept/reject logic
  (`nearestPhase` + duplicate/tolerance checks) into a shared `evaluateShifts()` used by both paths.
  Gains/CCM are resolved once from the reference frame's own trailer (falls back to the live stream's)
  and shared across the burst, since the capture locks AE/AWB for its duration. The gallery item gets
  `name: "Super-resolution RAW n/N frames ×S"`, plus both `extra.superres` and `extra.raw` (with
  `applied.demosaic: 'none (drizzled Bayer planes)'`) and `extra.capture` — no new gallery-schema
  fields were needed, both extra types already existed.

## A real bug found and fixed along the way

While writing the pipeline test I found `drizzleBayer`'s CFA-phase offset math
(`algo/drizzle.ts#phasePlanes`) was missing a half-cell centring term: `dx: (dx - ox) / 2` should have
been `dx: (dx - ox + 1) / 2` (same for `dy`/`oy`). Without it, even the *reference* frame (zero
measured shift) landed its own real samples a full mosaic pixel away from their true position — caught
by a regression test reconstructing a plain intensity ramp through `drizzleRawSuperres`, where the
error should be ~0 for a single unshifted frame but was a full-pixel systematic offset. Fixed with a
one-line change plus a derivation comment; the pre-existing `drizzleBayer` describe block still passes
unchanged (its tolerance was loose enough not to have caught this).

## UI control (not wired — I don't own `.svelte` files)

Describing `mode 'superresraw'` for whoever owns `PhotoPanel.svelte`/`Settings.svelte`: it does **not**
need a new top-level `PhotoMode` value in `photoService.ts` — the existing `mode: 'superres'` already
dispatches to `superresPhoto`, which now branches on `SuperresOptions.raw`. So the UI only needs a
checkbox/toggle (e.g. "RAW" or "no JPEG") next to the existing super-resolution scale/extra-frames/
sharpen controls, wired as `superres: { ...opts, raw: true }` under `mode: 'superres'`. `sharpen` has
no effect in raw mode (see below) — grey it out or hide it when `raw` is checked.

## Open points

1. **`sharpen` (post-drizzle Wiener deconvolution) is not implemented for the raw path.** The existing
   PSF model (`algo/deconvolve.ts#makePsf`, used by the JPEG path's `sharpenRgba`) was derived against
   the JPEG pipeline's 8-bit post-encode output; I did not want to guess whether/how it applies
   unchanged to linear 16-bit planes without verifying it, so `superresRawPhoto` ignores `o.sharpen`
   silently. Whoever wires the UI should grey out or hide the sharpen checkbox when RAW mode is
   selected, or a follow-up can adapt `sharpenRgba` for `RgbF` input.
2. **The upfront `navigator.deviceMemory < 4` crop bound (2400 px) is a guess**, not measured against
   an actual out-of-memory failure on hardware — I don't have a device to test against, and
   `deviceMemory` itself is only exposed on Chromium browsers (undefined elsewhere, in which case no
   upfront crop is applied and only the worker's own retry-on-failure applies). The worker's retry
   loop (halve the long side, keep even, up to two retries) is exercised only by unit-level reasoning,
   not an actual induced allocation failure — I don't have a way to reliably trigger a real OOM in
   vitest/node to test that path end-to-end.
3. **Per-frame trailer gains/CCM are not used per-frame.** `superresRawPhoto` resolves `gains`/`ccm`
   once from the *reference* frame's own OFRW trailer (or the live stream as a fallback) and applies
   them to the whole burst, on the assumption that the capture's `lockCamera()` call keeps AE/AWB
   frozen for the whole run so these shouldn't drift frame to frame. If a real device's trailer values
   do drift slightly during a burst despite the lock, `drizzleRawSuperres` would need to accept
   per-frame options instead of one shared `DevelopOptions` — not needed unless that's observed.
4. **No DNG output for `superresraw`** — the mode returns a 16-bit PNG + preview only (matching the
   brief), since a DNG's own colour-matrix/white-balance metadata model doesn't map cleanly onto an
   already-developed, already-combined image the way it does for a single raw capture.
5. **No hardware verification** — same caveat as the rest of this super-resolution work: everything is
   unit-tested against synthetic Bayer scenes (`algo/__tests__/drizzle.test.ts`), no `--fake` device or
   real Pi was used, since no device-side code changed.

## Files changed

- `webapp/src/lib/algo/rawdev.ts` — extracted `applyCcm` (additive; `developLinear` now calls it).
- `webapp/src/lib/algo/drizzle.ts` — fixed `drizzleBayer`'s phase-offset math (real bug, see above);
  added per-plane weight arrays to `DrizzleBayerResult`; added `drizzleRawSuperres` +
  `RawSuperresFrame`/`DrizzledRawResult` types.
- `webapp/src/lib/algo/__tests__/drizzle.test.ts` — new `drizzleRawSuperres` describe block (3 tests:
  colour-fringe/"zipper" comparison against a naive demosaic-then-drizzle baseline on a hard-edge
  synthetic scene, white-balance/CCM plumbing, error handling).
- `webapp/src/lib/workers/superresWorker.ts` — added `initRaw`/`addRaw` messages, raw `finish` branch
  (drizzle → develop → encode, with a memory-failure retry), `SuperresRawResult` type.
- `webapp/src/lib/services/photo/superres.ts` — added `SuperresOptions.raw`, `superresRawPhoto()`,
  `centerCropMosaic`, `greenProxy`; factored `evaluateShifts()` out of the existing JPEG path (no
  behaviour change there, confirmed by the pre-existing tests/build still passing).

## Tests added

`algo/__tests__/drizzle.test.ts`: 3 new tests under `drizzleRawSuperres`. `npm run check` (0 errors),
`npx vitest --run` (240/240 passing, 30 files, no failures — including the 3 pre-existing failures a
prior handoff mentioned, which are gone now too) and `npm run build` are all green as of this handoff.
