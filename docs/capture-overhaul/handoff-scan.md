# Scan / time-lapse / video handoff

## State on pickup

A previous agent had already done nearly all of Priority 2 (scan/stitch/time-lapse) and made a
first pass at Priority 1 (video). `Scan.svelte`, `algo/scanPlan.ts`, `algo/stitch.ts`, `algo/drift.ts`
and `services/timelapse.svelte.ts` matched the spec (AE/AWB lock, full-res default with CSM, height
map + local Laplacian refine, adaptive settle + stage-still check, per-tile focus status, return to
origin including z; stitch robust MAD position solve, gain equalisation, feathered/multi-band blend,
flat-field option; time-lapse absolute-clock scheduling, storage estimate/cap, sharpness-triggered
refocus, AE/AWB lock + periodic re-meter, optional PNG). I re-verified these by diff and left them
untouched. All owned tests (`stitch.test.ts`, `scan_stitch.test.ts`, `drift.test.ts`) pass.

`recorder.svelte.ts`, however, still drew from the live `<img>` element (keyed to `event.frame` seq
instead of a 15 fps timer, which helped with duplicate frames but not the root cause). This is what I
spent the session on.

## What I changed (Priority 1: video shake/glitches)

Root cause confirmed: the recorder sampled `drawImage()` off the DOM `<img src="stream.mjpg">`. The
browser's own multipart decoding gives no signal for exactly when a new JPEG part has finished
decoding into visible pixels — the `<img>` lags its own `event.frame` metadata by a few frames (this
lag is called out in `services/liveStack.svelte.ts`'s own comment) — so `drawImage` could sample a
partially-updated `<img>`, i.e. tearing, and the recorded position log never quite matched what was
drawn. That's the audit's D8 finding.

1. **`webapp/src/lib/api/mjpegStream.ts` (new)** — reads `/stream.mjpg` with `fetch` + a
   `ReadableStream`, parses the multipart JPEG parts using the device's own `Content-Length` header
   (falls back to boundary search if absent), decodes each with `createImageBitmap` (which never
   yields a partial image), and delivers `{bitmap, ts, seq, meta, size}` exactly once per real device
   frame. `stop()` aborts the fetch — no leaked MJPEG connection.

2. **`webapp/src/lib/algo/stabilize.ts` (new) + `__tests__/stabilize.test.ts`** — pure per-frame
   stabiliser: `fftTrack.displacement` of a downscaled luma frame against a reference that
   re-anchors itself once the tracked offset exceeds 40 px (keeps the FFT window accurate instead of
   degrading over a long recording); the raw trajectory is smoothed with a one-euro filter (tuned
   `beta: 0.02` — a higher beta made the filter's own adaptive-speed cutoff defeat the jitter removal
   in testing, since hand jitter has high instantaneous velocity even though it's small in amplitude);
   the raw-minus-smoothed residual is the correction, clamped to `maxShiftPx` (24 px default). 4 tests
   cover raw-trajectory accuracy, jitter removal vs. trend tracking, re-anchoring, and the clamp.

3. **`recorder.svelte.ts` (rewritten)** — new `startStream()` method used for the plain live view:
   reads via `MjpegStream`, draws each decoded bitmap into a canvas exactly once, pushes it with
   `captureStream(0)` + `track.requestFrame()` (falls back to a `captureStream(fps)` timer only if
   the browser lacks manual frame pushes). Stabilisation is applied per frame (skipped, and the
   stabiliser reset, while `device.moving` is true, so a real stage move is never fought as jitter);
   the correction is applied as `ctx.drawImage(bitmap, -margin - dx, -margin - dy, ...)` onto a canvas
   that is `2*margin` px smaller than the source, so the recorded frame is always fully covered (no
   exposed edge). Codec is now selectable (VP9/AV1/VP8/auto), with `Recorder.codecSupport()` for the
   UI to grey out AV1 where unsupported; bitrate is a user option (Mbit/s); the per-frame
   `{t, seq, position}` sidecar (`VideoFrameLog[]`, gallery blob `frames`) and `fps` are computed from
   the real frame count/duration. The live-stack composite path (`start(source, label, opts)`) is
   unchanged in behaviour — it's already temporally smoothed, so I didn't add stabilisation there.
   Fixed a pre-existing bug in passing: the saved `bitrateBps` used `this.options.bitrateMbps` (the
   class default) instead of the actual per-recording bitrate — now a `bitrateMbpsUsed` field tracks
   it.

4. **`components/PhotoPanel.svelte`** (video controls only, as scoped) — `toggleRecord()` now calls
   `recorder.startStream()` for the live view and `recorder.start()` (stabilisation forced off) for
   the live stack. Added Codec / Bitrate / Stabilise controls above the Record button.

5. **`store/gallery.ts`, `components/Viewer.svelte`** — untouched; the previous agent had already
   added the additive `codec`/`bitrateBps`/`frames` fields and `<video>` renders fine. One thing I
   did *not* fix (Viewer.svelte is outside my ownership): the gallery viewer's `<video>` has both
   `autoplay` and `loop` — a short clip will silently restart, which could itself read as "glitching"
   to a user reviewing footage. Worth a follow-up outside this scope.

## Verification

- `cd webapp && npm run check`: 3 pre-existing errors, all in `api/snapshot.ts` /
  `services/photo/*` (another agent's files, unrelated to this change) — 0 in anything I touched.
- `npx vitest --run`: 191/192 pass; the one failure is `algo/__tests__/drizzle.test.ts`, also another
  agent's file.
- `npm run build`: succeeds.
- Did not run Playwright e2e (no device/fake running in this session) — I checked
  `e2e/app.mjs`'s "video recording lands in the gallery and opens in the viewer" step by hand: it
  waits on the same status-text patterns (`Stop · N s`, `saved "Video live view"`,
  `video · N s · live view`) that `recorder.ts` still produces, and clicks the same "Record video"
  button, so it should still pass unmodified — but this needs a real run against the fake device to
  confirm before merging.

## Open points

- **Playwright e2e**: please run `npm run test:e2e` against the fake device before merging — I
  could not run it in this session (no device process available) and the whole point of my change is
  runtime frame timing, which unit tests can't fully substitute for.
- **Stabiliser tuning**: `beta: 0.02` (down from a first pass at 0.3) was tuned against a synthetic
  scene, not real footage. It follows a synthetic slow pan while damping synthetic fast jitter; real
  hand shake / stage vibration frequency content will differ, so it may need a real-camera pass to
  retune `minCutoff`/`beta`/`reanchorPx`.
- **Viewer.svelte** `<video autoplay loop>`: flagged above, not fixed (outside my file ownership).
- I did not touch `align.ts`/`fftTrack.ts` (per instructions — another agent owns
  `fftTrack.displacement` accuracy work) or `photoService.ts`.

## Files changed

- `webapp/src/lib/api/mjpegStream.ts` (new)
- `webapp/src/lib/algo/stabilize.ts` (new)
- `webapp/src/lib/algo/__tests__/stabilize.test.ts` (new)
- `webapp/src/lib/services/recorder.svelte.ts` (rewritten)
- `webapp/src/components/PhotoPanel.svelte` (video controls only)

No changes to `stitch.ts`, `scanPlan.ts`, `heightMap.ts`, `drift.ts`, `stitchWorker.ts`,
`timelapse.svelte.ts`, `Scan.svelte`, `TimelapsePanel.svelte`, `TimelapseViewer.svelte` — verified
already complete against the audit and left as-is.
