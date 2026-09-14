# Brief: RAW develop, DNG, exposure stack, HDR (resume)

Repo: /Users/sdawka/Code/openflexito. A previous agent was interrupted; its uncommitted edits are in the working tree.
Read CLAUDE.md, CAPTURE_AUDIT.md (D1, D8, D9, theme 4, RAW/DNG/HDR/LED rows of Tiers A-C, section 4 still/RAW facts),
sections 2-4 of /Users/sdawka/.claude/jobs/e88486dd/tmp/superres-hdr-report.md, and the device contract at
/Users/sdawka/.claude/jobs/e88486dd/tmp/handoff/device.md (X-Frame still metadata, OFRW v2 trailer, `/raw.bin?frames=N`
16-bit mean, `?packed=1`, `/flat.bin`, `/bracket.bin` OFBK). Then `git diff` every file you own and `ls webapp/src/lib/algo`
(dng.ts and png16.ts were moved into algo/; demosaic.ts, exposureFuse.ts, flatField.ts, hdr.ts exist; raw.ts, rawdev.ts,
tuning.ts, rawWorker.ts and the calibration store were modified).

## File ownership (strict)
You own: webapp/src/lib/algo/{rawdev,raw,tuning,exposure,histogram,dng,png16,hdr,exposureFuse,flatField,demosaic}.ts and tests,
webapp/src/lib/workers/rawWorker.ts, services/whiteBalance.svelte.ts, lib/api/snapshot.ts (and a new api/raw.ts if useful),
store/calibration.svelte.ts (additive flat-field field), store/gallery.ts additive `capture` field only (re-read before editing;
another agent adds video/scan fields), new services/photo/{exposureStack,rawPhoto}.ts.
Others own align/pyramidFuse/stack (import only; write your own pyramid helpers in exposureFuse.ts), fftTrack/drizzle/register,
stitch/timelapse/recorder, device/.

Current state: `npm run check` is clean; one failing test in your area: rawdev.test.ts "encodeDng writes a little-endian TIFF
with the CFA tags and the pixel data" (a ColorMatrix1 value is 2× the expectation because the derivation now includes the
white-balance gains per D1). Decide whether code or test is right using the DNG semantics: ColorMatrix1 maps XYZ to
unbalanced camera RGB, so ColorMatrix1 · XYZ(D65 white) must be proportional to (1/gr, 1, 1/gb).

photoService.ts is shared with two other agents: move the 'raw' mode and the LED 'exposure' stack out of
webapp/src/lib/services/photoService.ts into services/photo/rawPhoto.ts and services/photo/exposureStack.ts (helpers from
services/photo/common.ts, lock from services/cameraLock.ts), then edit photoService.ts only to import/dispatch; re-read exact
lines before editing and retry if changed. Item `name` = short label ("RAW 10-bit", "RAW average ×4", "LED exposure stack ×3",
"HDR RAW ×3"), no dates; filenames come from algo/naming.ts.

## Items (check the diff; some are done)
1. D1 DNG ColorMatrix1 with WB gains + test; EXIF IFD (ExposureTime, ISO = analogue gain × 100, DateTimeOriginal from the
   item's `when` or capture timestamp), ActiveArea, BaselineExposure; GainMap opcode writer (OpcodeList2) with test.
2. D9 LUT linear interpolation; float planes; ALSC luminance_strength; CT interpolation of CCM/ALSC; highlights clipped to
   white; averaged (not decimated) 8-bit preview; PNG16 Up/Paeth filtering with a round-trip test.
3. demosaic.ts: higher-quality demosaic (RCD, AHD or DLMMSE) selectable via develop params; test showing fewer zipper
   artefacts than Malvar; speed note for 8 MP.
4. flatField.ts: gain maps from an averaged blank field (`/flat.bin?frames=N`), applied in develop instead of ALSC when
   present, downscaled Float32 export for stitching and DNG GainMap; stored additively in the calibration store (no $state
   proxies into IndexedDB). A "capture flat field" service action (UI button described in the handoff).
5. exposureStack.ts: lock AE and AWB; multi-scale Mertens (exposureFuse.ts) replacing the block blend;
   `bracket: 'led' | 'exposure' | 'both'`; for 'exposure' use the device `/bracket.bin` OFBK endpoint via a decoder in
   algo/raw.ts or api/raw.ts; tests (no block halos vs the old function, colour consistency).
6. hdr.ts: true HDR from linear RAW brackets (`/bracket.bin?raw=1&factors=..`): Debevec weights, radiance, tone map,
   16-bit PNG + preview; 'hdrraw' mode; tests.
7. raw.ts `parseRaw`: OFRW v2 trailer, packed unpack, bit_depth/black/white from the record, `frames` averaging; rawdev uses
   the record's colour_gains/ccm when present; 'rawavg' option; tests using the byte layouts in the device handoff.
8. api/snapshot.ts: parse `X-Frame` (`fetchSnapshotWithMeta` returning {blob, meta}; keep `fetchSnapshot` returning a Blob);
   store frame meta + µm/px (store/scaleCal.svelte.ts) as an additive `capture` field on GalleryItem in your modes.

## Finish
`cd webapp && npm run check && npx vitest --run` green (whole suite). Do not edit README/CLAUDE/TODO/Settings.svelte/PhotoPanel.svelte;
write UI controls, README text and open points to /Users/sdawka/.claude/jobs/e88486dd/tmp/handoff/raw.md.
Report files changed, tests added, open points.
