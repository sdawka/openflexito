# Brief: wire raw-plane (Bayer) super-resolution

Repo /Users/sdawka/Code/openflexito. Read CLAUDE.md, the superres and raw handoffs in /Users/sdawka/.claude/jobs/e88486dd/tmp/handoff/
(superres.md "open points", raw.md), then webapp/src/lib/services/photo/superres.ts, workers/superresWorker.ts, algo/drizzle.ts
(`drizzleBayer`), algo/register.ts, lib/api/raw.ts, algo/raw.ts (`parseRaw`, OFRW v2), workers/rawWorker.ts and algo/rawdev.ts
(develop params, flat field, `toRgba8`), algo/png16.ts, services/photo/rawPhoto.ts (how a raw item is saved with 16-bit PNG,
preview and DNG), services/photo/common.ts, services/cameraLock.ts.

## File ownership (strict)
You own: services/photo/superres.ts, workers/superresWorker.ts, algo/drizzle.ts and drizzle tests, and may ADD a `want`/mode to
workers/rawWorker.ts and a pure function to algo/rawdev.ts ONLY if strictly needed (additive; re-read before editing; keep all tests
green). A concurrent agent owns every .svelte file and settings; another owns README/CLAUDE/TODO. Do not edit those; describe the
UI control (mode `superresraw`) in your handoff.

## Work
Add a `superresraw` photo mode: same shift planning and stage moves as `superres`, but each frame is `/raw.bin` (v2 record, via
lib/api/raw.ts) instead of a JPEG. Register frames on a developed-luma proxy (a fast half-resolution develop or a green-plane
extraction is enough), then `drizzleBayer` all mosaics with their measured shifts onto the S× grid producing linear RGB planes with
no demosaic, then run the rest of the develop pipeline (black level already handled? check: apply black/white level, WB gains from
the record trailer, flat field or ALSC, CCM, tone curve) via the existing rawdev functions on the drizzled planes, output a 16-bit
PNG + 8-bit preview like rawPhoto.ts, and record `superres` + `raw` fields on the gallery item (name label "Super-resolution RAW
n/N frames ×S"). Memory: a 2× grid of 3280×2464 is 6560×4928 × 3 planes Float32 ≈ 390 MB; do the drizzle in the worker,
transfer planes, and downscale-crop if `navigator.deviceMemory` < 4 or on failure fall back to a central crop (reuse
`centerCropRgba`-style logic for mosaics keeping Bayer parity even). Tests: a vitest on a synthetic Bayer scene that the
4-shot 1 px pattern through the new pipeline yields full RGB without zipper artefacts and matches the truth better than
demosaic+drizzle. Keep `npm run check && npx vitest --run && npm run build` green.

Write open points to /Users/sdawka/.claude/jobs/e88486dd/tmp/handoff/superresraw.md. Report files changed and tests added.
