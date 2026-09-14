# Brief: registration + super-resolution (resume)

Repo: /Users/sdawka/Code/openflexito. A previous agent was interrupted; its uncommitted edits are in the working tree.
Read CLAUDE.md, CAPTURE_AUDIT.md (D3, D4, theme 1, super-res rows of Tiers A-C) and
/Users/sdawka/.claude/jobs/e88486dd/tmp/superres-hdr-report.md (sections 1, 3, 4).
Then: `git diff webapp/src/lib/algo/fftTrack.ts`, `cat webapp/src/lib/algo/register.ts`, `ls webapp/src/lib/algo/__tests__/helpers/`.

## File ownership (strict)
You own: webapp/src/lib/algo/{fftTrack,fft,drizzle,csm,register}.ts and their tests, new algo/deconvolve.ts,
webapp/src/lib/workers/superresWorker.ts, new webapp/src/lib/services/photo/superres.ts, algo/__tests__/helpers/.
Other agents own align.ts, pyramidFuse.ts, stack.ts (import `grayDown` from stack.ts and `luminance` from align.ts, do not edit),
stitch/timelapse/recorder, rawdev/raw/dng/hdr, device/. `displacement()` in fftTrack.ts is also used by stitch, timelapse,
liveStack and autofocus tracking: keep its signature, make it more accurate, run the whole vitest suite.

photoService.ts is shared with two other agents: move `superresPhoto` and `centerCropRgba` out of
webapp/src/lib/services/photoService.ts into services/photo/superres.ts (helpers from services/photo/common.ts, camera lock
from services/cameraLock.ts `lockCamera`), then edit photoService.ts only to import/dispatch. Re-read the exact lines right
before editing photoService.ts and retry if it changed. Gallery item `name` is a short label ("Super-resolution 4/4 frames ×2"),
no dates; export filenames come from algo/naming.ts.

## Items (check the diff first; some may be done)
1. Sub-pixel accuracy of `displacement()`: replace the thresholded-centroid/parabola average with a proper estimator
   (upsampled local cross-correlation, Guizar-Sicairos style, or a paraboloid/Gaussian fit on the un-thresholded peak
   neighbourhood). Tests: 0.1-0.5 px shifts at 0.05 px tolerance at full and 4x/8x downscaled sizes; the 44 px outlier case
   from the report must not occur; `quality` must separate good from failed registrations (test it).
2. algo/register.ts: coarse-to-fine primitive (integer estimate on a downscale, refinement on a full-resolution central crop)
   returning {dx, dy, quality, confident}; use it in superresWorker at full resolution.
3. Shift pattern in superres.ts: S×S grid at 1/S px hops for output scale S, planned with the CSM 2×2 matrix (rotation),
   one direction per axis with a backlash pre-load move, snake order, optional extra randomised frames. After capture reject
   frames > 0.15 px from a valid phase or duplicating another; report frames used. Options: scale (2|3), pixfrac (default 0.5), sharpen.
4. Drizzle: pixfrac default 0.5, optional per-frame weight, Float32 accumulation reusable for raw planes.
5. algo/deconvolve.ts: Wiener and Richardson-Lucy with PSF = drop ⊗ pixel aperture ⊗ Gaussian(sigma); optional after drizzle;
   tests (correlation with truth rises, noise stays bounded).
6. drizzle.ts `drizzleBayer`: per-CFA-plane drizzle of N mosaics + shifts + bayer order onto the S× grid producing linear RGB
   planes (4-shot 1 px pattern gives full RGB per site without demosaic); test. For the raw fetch path, the device serves
   `/raw.bin` with an OFRW v2 JSON trailer (see /Users/sdawka/.claude/jobs/e88486dd/tmp/handoff/device.md); another agent owns
   algo/raw.ts `parseRaw`. Import existing raw fetch/parse helpers if present; otherwise leave the 'superresraw' wiring as a
   clearly named TODO in your handoff instead of inventing a format.

## Finish
`cd webapp && npm run check && npx vitest --run` green. Do not edit README/CLAUDE/TODO/Settings.svelte/PhotoPanel.svelte;
write UI controls, README text, measured accuracy before/after and open points to
/Users/sdawka/.claude/jobs/e88486dd/tmp/handoff/superres.md. Report files changed, tests added, open points.
