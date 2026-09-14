# Brief: UI wiring for the new capture features

Repo /Users/sdawka/Code/openflexito. Read CLAUDE.md, then the five handoff files in /Users/sdawka/.claude/jobs/e88486dd/tmp/handoff/
(device.md, focus.md, superres.md, scan.md, raw.md): each has a "UI controls needed" section. Then read
webapp/src/components/PhotoPanel.svelte, webapp/src/routes/Settings.svelte, the Camera/Focus/Calibrate panels under
webapp/src/components and routes, components/Viewer.svelte, lib/services/photoService.ts (PhotoOptions), lib/store/settings*.

## File ownership (strict)
You own: webapp/src/components/*.svelte, webapp/src/routes/*.svelte (except Scan.svelte which is finished: only touch it if a
control listed in scan.md is missing), webapp/src/app.css, webapp/src/lib/store/settings*.ts, webapp/src/lib/store/gallery.ts
(additive only), webapp/src/lib/services/photo/common.ts (additive), webapp/e2e/*. A concurrent agent owns
services/photo/superres.ts and workers/superresWorker.ts; another owns README/CLAUDE/TODO. Do not edit algo/ or device/.
Svelte 5 runes; never write a $state you read in the same $effect; clear MJPEG img.src on unmount.

## Work
1. PhotoPanel: expose every new PhotoOptions field with sensible defaults and short titles/tooltips: modes `rawavg` (frames 2-8),
   `hdrraw`, exposure-stack `bracket` (led | exposure | both) and factors, superres `scale` (2|3), `pixfrac`, `sharpen`
   (none|wiener|rl) + sigma, focus stack `method` (pyramid|hybrid), fine-stack metric, and anything else the handoffs list.
   Keep the panel compact: an "Advanced" disclosure per mode is fine.
2. Autofocus: `mode: 'twopass'` selectable where autofocus is triggered (Focus panel / autofocus button), default stays 'fast'.
3. Flat field: a "Capture flat field" action (sample removed, N frames via the service action described in raw.md), with a
   visible indicator wherever the flat field overrides ALSC, and a "Clear" action. Put it in the Calibrate route next to the
   lens-shading calibration.
4. Settings: `still_clean` toggle (RPC camera.set_still_clean, status field, see device.md), video defaults (codec, bitrate,
   stabilise), superres defaults, a z µm/step is already there: use `stepsToUm`/`depthLegend` from algo/depthMap.ts to show
   the depth-map legend in µm in the Viewer when available, and persist the legend unit on `GalleryItem.stack.depth`
   (additive `unit` field) when saving (coordinate through services/photo/focusStack.ts only if a one-line change is needed;
   otherwise describe).
5. Plain `single` stills: use `captureFullWithMeta` (services/photo/common.ts) so the `capture` metadata field (frame meta +
   µm/px) is populated for single photos too (small edit in photoService.ts dispatch for 'single' only).
6. Viewer.svelte: gallery item detail should show the new metadata (`capture`: exposure, gain, colour gains, timestamp; µm/px;
   superres frames used/rejected; stack method; video codec/bitrate/fps/stabilised). Fix the `<video autoplay loop>` so short
   clips do not look like a glitch (controls, no loop, or loop only when > 3 s).
7. e2e (webapp/e2e/app.mjs): update steps your UI changes affect; ADD steps for: rawavg photo, hdrraw photo (fake device supports
   /bracket.bin), superres with the new options, video recording with stabilise on, flat-field capture + clear. Run it:
   `cd device && .venv/bin/python -m openflexito --fake --webapp-dir ../webapp/dist --port 8099 &` after `cd webapp && npm run build`,
   then `cd webapp && npm run test:e2e` (check package.json for how the URL/port is passed). Kill the fake afterwards.
   Fix whatever the e2e reveals in files you own; for failures in files you don't own, write them to the handoff with exact
   error text.

## Finish
`cd webapp && npm run check && npx vitest --run && npm run build` green and the e2e passing (report the step count).
Write open points to /Users/sdawka/.claude/jobs/e88486dd/tmp/handoff/ui.md. Report files changed and e2e result.
