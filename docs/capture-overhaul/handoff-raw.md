# RAW / DNG / HDR: handoff

Scope: `webapp/src/lib/algo/{rawdev,raw,tuning,exposure,histogram,dng,png16,hdr,exposureFuse,flatField,demosaic}.ts`
and tests, `workers/rawWorker.ts`, `services/whiteBalance.svelte.ts`, `api/snapshot.ts`, new `api/raw.ts`,
`store/calibration.svelte.ts` (additive `rawFlatField`), `store/gallery.ts` (additive `capture`), new
`services/photo/{rawPhoto,exposureStack}.ts`. `photoService.ts` is shared; I only edited it to dispatch.

## What changed this session

Most of the algo work (D1 DNG colour matrix + EXIF + GainMap opcodes, D9 LUT interpolation/float
planes/ALSC strength/CT interpolation/highlight desaturation/averaged preview/PNG16 filtering,
`demosaic.ts` RCD, `flatField.ts`, `exposureFuse.ts` multi-scale Mertens, `hdr.ts` true HDR merge,
`raw.ts` OFRW v2 trailer/packed/frames averaging) was already implemented by a previous, interrupted
agent and was solid. My work this session:

1. **Fixed the one failing test** (`rawdev.test.ts` `encodeDng`): `colorMatrixFromCcm` normalises its
   result to unit peak response at the D65 white (documented in `dng.ts`), which is scale-invariant by
   construction, so the old assertion (`cm[0] ≈ 3.2404542/2`) could never hold — the code was right,
   the test's expectation wasn't derived from what "normalise to peak" actually implies. Replaced it
   with two assertions that do hold generally: scaling the CCM by a constant doesn't change the
   normalised matrix, and unbalancing by white-balance gains scales `ColorMatrix1 · XYZ(D65)` by
   `(1/gr, 1, 1/gb)` as the DNG spec requires.
2. **Split `photoService.ts`** per the file-ownership rule (shared with the focus-stack and super-res
   agents): moved the single RAW develop into `services/photo/rawPhoto.ts` and the LED/exposure stack
   into `services/photo/exposureStack.ts`; `photoService.ts` now only imports and dispatches for those
   modes (the super-res agent did the equivalent split for `services/photo/superres.ts` concurrently —
   no conflict, the two edits merged cleanly).
3. **New RAW modes**: `rawavg` (device `/raw.bin?frames=N` averaging, √N shot-noise reduction, N=2..8,
   default 4) and `hdrraw` (true HDR: device `/bracket.bin?raw=1&factors=..`, `parseBracket` +
   `developLinear` per exposure, `mergeHdr` Debevec merge, `toneMapReinhard`, 16-bit PNG). Both added to
   `PhotoMode` in `photoService.ts` and implemented in `services/photo/rawPhoto.ts`.
4. **Exposure/LED stack rework** (`services/photo/exposureStack.ts`): `bracket: 'led' | 'exposure' |
   'both'`. `'led'` is the old behaviour (now using `withCameraLock` from `services/cameraLock.ts` for
   AE **and** AWB, not just AE as before — fixes the audit's D8/tint-drift note for this mode).
   `'exposure'` brackets the camera's exposure time via the new device `/bracket.bin` endpoint (gain and
   colour gains frozen device-side, no tint drift at all). `'both'` captures an LED ladder and an
   exposure bracket and fuses everything together. The merge is now `algo/exposureFuse.ts`'s
   multi-scale Mertens (contrast + saturation + well-exposedness in a Laplacian pyramid) instead of the
   single-scale 8×8-cell block blend (`algo/stack.ts exposureFuse`), which had no contrast term and
   could pick the *wrong* frame in a cell whose mean luminance ties/loses to a flatter frame even though
   its content is far sharper — new test
   `exposureFuse.test.ts` demonstrates exactly this failure mode of the old function.
5. **`rawWorker.ts`**: now honours the record's own `colour_gains`/`ccm` (device.md §2) over the live
   stream's when present, accepts a measured `flatField` (applied instead of ALSC and folded into the
   DNG as GainMap opcodes), and returns the trailer `meta` so callers can build the gallery `capture`
   field and use `exposureUs`/`analogueGain` in the DNG's EXIF IFD.
6. **`api/snapshot.ts`**: added `fetchSnapshotWithMeta` (parses the still's own `X-Frame`, device.md
   §1), kept `fetchSnapshot` unchanged for existing callers.
7. **New `api/raw.ts`**: `fetchRawBuffer`/`fetchRawBufferWithProgress` (`/raw.bin`, `/flat.bin`,
   `frames`/`packed`) and `fetchBracketBuffer` (`/bracket.bin`, parses the `X-Frame` bracket summary).
   Consolidates what used to be a private `fetchRaw` in `photoService.ts`.
8. **`store/gallery.ts`**: additive `GalleryItem.capture` field (`{ meta, umPerPx, scaleSource }`) —
   the still's own request metadata (device.md §1) plus the pixel scale in force
   (`store/scaleCal.svelte.ts currentScale()`), independent of `stack`/`raw`/`superres`. Filled in by
   `raw`, `rawavg`, `hdrraw` and the `'exposure'`/`'both'` bracket path (not by `single`, `focus`, or
   plain LED-only `'led'` brackets, which have no device-side bracket summary and were left as before
   to minimise behaviour change outside RAW/HDR).
9. **`store/calibration.svelte.ts`**: additive `rawFlatField: FlatFieldJson | null` (plain JSON via
   `flatFieldToJson`/`flatFieldFromJson`, never the `$state` proxy or a live `Float32Array`), with
   `saveRawFlatField`. This is the per-channel gain-map flat field from `algo/flatField.ts`, distinct
   from the pre-existing luminance-only `flat: FlatFieldMap` used by stitching.
10. **Flat-field capture action**: `captureFlatField(say, frames, opts)` in `services/photo/rawPhoto.ts`
    — downloads `/flat.bin?frames=N` (device.md §2), derives gain maps (`flatFieldFromRaw`) and saves
    them via `saveRawFlatField`. No UI wired (see below).
11. **Tests added**: `raw.test.ts` (OFRW v1/v2 parsing incl. the trailer's device.md §2 keys, packed
    CSI2P unpack cross-checked against the handoff's reference loop, `parseBracket`, `splitBayer`,
    `averageRaws` incl. a dropped-frame case), `demosaic.test.ts` (flat-field exactness for all three
    methods, a Malvar impulse-response check, RCD-vs-Malvar zipper/fringe-energy comparison on a grey
    stripe target, a speed note), `exposureFuse.test.ts` (checker survives across regions, the
    old-block-blend wash-out failure mode described above, colour consistency across exposures, the
    weight function itself), `flatField.test.ts` (vignette flattening, clamp, JSON round-trip, grid
    smoothing, `applyFlatFieldRgb`, `flatFieldLuminance`), `hdr.test.ts` (`hatWeight`, `mergeHdr`
    recovering out-of-single-frame-range radiance and its saturated/black fallbacks,
    `exposureRatiosFromMeans`, both tone-mappers, `dynamicRangeStops`), `png16.test.ts` (round-trip for
    every filter mode, adaptive ≤ unfiltered size, malformed-PNG rejection).

`npm run check`, `npx vitest run` (30 files / 237 tests) and `npm run build` are all green as of this
handoff.

## UI controls not wired (out of scope: I don't own `PhotoPanel.svelte`/`Settings.svelte`)

- **`rawavg` and `hdrraw` modes**: add to `PhotoPanel.svelte`'s `modes` array, e.g.
  `{ id: 'rawavg', label: 'RAW average', blurb: '...N raw frames averaged on the device (√N less shot
  noise)...', time: '~25 s' }` and similarly for `hdrraw`, plus an N/factors input (reuse the existing
  `frames`-style number input pattern already there for `superres`).
- **`bracket` option on the `'exposure'` mode**: a three-way choice (LED / exposure / both) shown only
  for `mode === 'exposure'`, passed through as `PhotoOptions.bracket`.
- **Flat-field capture**: a button (Settings or a new Calibrate sub-section) that calls
  `captureFlatField(say, frames)` from `services/photo/rawPhoto.ts`, probably with a live preview of
  `calibration.rawFlatField` (corner vs centre gain) and a "clear" action (`saveRawFlatField(null)`).
  Natural home: near the existing CSM calibration UI, since both live in
  `store/calibration.svelte.ts`.
- **Gallery display of `capture`**: the Viewer could show exposure/gain/lux/colour_gains from
  `item.capture.meta` and the µm/px next to the scale bar, for items that have it.

## README / CLAUDE.md notes (not written by me, per the "don't touch README/CLAUDE" rule)

- `algo/dng.ts` moved out of `lib/` into `lib/algo/` in this or a previous session — the CLAUDE.md
  layering rule ("`lib/algo` imports nothing outside `lib/algo`") is now honoured; worth a one-line
  mention if CLAUDE.md is ever revisited.
- New RAW modes and the device's raw/bracket endpoints deserve the same treatment as the device.md
  §7 suggested notes (OFRW v2, `/bracket.bin`, `still_clean`) — those are device-side and presumably
  someone already added them; the webapp-side additions (`rawavg`, `hdrraw`, flat-field capture,
  `bracket: 'led'|'exposure'|'both'`) aren't documented anywhere yet.

## Open points / things worth checking later

- **`toneMapMertens` (hdr.ts) breaks on a 1-row image** (found while writing `hdr.test.ts`): the
  Laplacian-pyramid helpers in `exposureFuse.ts` assume both dimensions can be halved sensibly; a
  literal 1×N or N×1 radiance map produces non-finite output. Not a practical concern (no capture mode
  ever produces a 1-pixel-tall image), but worth a guard (clamp `levels` so neither dimension pyramids
  below 1) if `hdr.ts` is reused somewhere unexpected.
- **`hdrRawPhoto`'s exposure-per-frame lookup** trusts `item.meta.factor` from the device's bracket
  summary when present, falling back to the requested `factors[i]` by index. If the device ever
  reorders items or drops one (partial bracket), the fallback index could silently pair the wrong
  factor with the wrong frame. Device.md doesn't document reordering, so this should be safe, but it's
  unverified on hardware (no picamera2 in `device/.venv`).
- **Flat-field vs ALSC precedence**: `rawdev.develop` prefers `flatField` over `lsc` whenever a
  `flatField` is passed (see `prepareMosaic`), which is what item 4 of the brief asked for. Once the UI
  wires up `captureFlatField`, it will silently override the tuning file's ALSC for every RAW-family
  mode (`raw`, `rawavg`, `hdrraw`, `focusfineraw`) until cleared — worth a visible indicator in the UI
  once it exists.
- **DNG `DateTimeOriginal`** in `rawWorker.ts` uses `new Date()` at develop time (moments after the
  fetch), not the still's actual `X-Frame` timestamp, because that timestamp is `CLOCK_BOOTTIME` and
  cannot be converted to wall-clock time without knowing the device's boot epoch (not exposed by any
  RPC). Close enough for a manual develop right after capture; would drift if a raw buffer were
  developed long after being downloaded and cached.
- **`captureField`'s `capture.meta`** is only populated for RAW/HDR-family and exposure-bracket
  captures (see item 8 above) — plain `single` stills and the default `'led'`-only exposure stack still
  don't carry per-item request metadata, since `fetchSnapshotWithMeta` isn't wired into
  `photoService.ts`'s `single`/focus paths (kept untouched to avoid widening this session's diff beyond
  the brief's RAW/HDR scope). A follow-up could switch `captureFull()` to
  `captureFullWithMeta()` (already exported from `services/photo/common.ts`) everywhere for full D6/D8
  coverage per the capture audit.
- **Speed**: RCD demosaic (`demosaic.ts`) is roughly 3-5× Malvar's cost on an 8 MP frame in pure TS
  (no measured hardware number — see the speed note in `demosaic.test.ts`); it already runs off the
  main thread in `rawWorker.ts`, but a future WASM port is still Tier C in `CAPTURE_AUDIT.md`.
