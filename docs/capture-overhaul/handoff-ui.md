# UI wiring for the new capture features — handoff

Scope: `webapp/src/components/*.svelte`, `webapp/src/routes/*.svelte` (except `Scan.svelte`, untouched —
already complete per scan.md), `app.css` (untouched, no new global styles needed), `store/settings*.ts`,
`store/gallery.ts` (additive), `services/photo/common.ts` (additive, untouched — no change needed),
`e2e/*`. Small, necessary edits outside that list are called out below.

## What changed

1. **`components/PhotoPanel.svelte`** (rewritten): mode list now includes `rawavg` and `hdrraw`;
   per-mode parameter blocks for all new options with an "Advanced" `<details>` disclosure per mode
   to keep the panel compact:
   - `rawavg`: frames (2-8).
   - `focusfine`/`focusfineraw`: added a fusion-method select (pyramid/hybrid) in Advanced, wired to
     `PhotoOptions.method`.
   - `exposure`: bracket kind select (led/exposure/both) plus, in Advanced, comma-separated LED-level
     and exposure-factor text inputs (only the relevant one shown per bracket kind), wired to the
     newly-added `PhotoOptions.factors` field (see below).
   - `hdrraw`: comma-separated exposure-factor input.
   - `superres`: scale (2×/3×) select and a Sharpen checkbox up front; Pixfrac and Extra-frames in
     Advanced. These now actually reach `SuperresOptions` — previously `PhotoPanel` sent a `frames`
     number that `superresPhoto` had already stopped reading after the scale/pixfrac/extraFrames/sharpen
     refactor (dead control).
   - Video codec/bitrate/stabilise controls persist to `Settings` (`saveVideoDefaults`/`onchange`) and
     seed from there on mount.
   - Gave the mode `<select>` `aria-label="capture mode"` — needed to disambiguate it from the video
     Codec `<select>` that now also lives in this panel for Playwright selectors (see e2e below).

2. **`lib/services/photoService.ts`** (small, necessary edits to the shared dispatcher):
   - Added `factors?: number[]` to `PhotoOptions` and pass it through to `exposureStackPhoto` — it was
     already accepted by `ExposureStackOptions.factors` (bracket `'exposure'`/`'both'`) but nothing in
     the dispatcher forwarded it, so a custom exposure-time bracket could never be requested end to end.
   - `mode: 'single'` now calls `captureFullWithMeta()` (already exported by `services/photo/common.ts`)
     instead of `captureFull()`, and fills `extra.capture` via `captureField()` — per raw.md's open point,
     plain stills previously had no per-item request metadata at all.

3. **`lib/api/types.ts`** (small, additive, out of the listed ownership but needed and low-risk):
   added `still_clean?`, `still_jpeg_quality?`, `max_raw_frames?`, `max_bracket_frames?`,
   `frame_duration_limits_us?` to `CameraStatus`, matching device.md §5/§6 — needed to read
   `camera.status().still_clean` for the Settings toggle.

4. **`routes/Live.svelte`**: added `mode: 'twopass'` to the autofocus mode `<select>` (existing button
   unchanged); `runAutofocus({ mode: 'twopass', ... })` was already wired in `autofocusService.ts`,
   nothing else needed changing.

5. **`routes/Calibrate.svelte`**: new "RAW flat field" panel next to the stage↔camera mapping section —
   frame-count input, "Capture flat field" (calls `services/photo/rawPhoto.ts#captureFlatField`), a
   visible callout when `calibration.rawFlatField` is set ("A flat field is active — it overrides the
   tuning file's lens-shading correction for RAW-family captures"), and "Clear"
   (`saveRawFlatField(null)`).

6. **`routes/Settings.svelte`**: "Still image quality" panel with the `still_clean` toggle
   (`camera.set_still_clean` RPC, reflects `device.status.camera.still_clean`, defaults to checked when
   the field is absent from an older device build); "Capture defaults" panel duplicating the video/
   super-resolution defaults from the Photo panel for discoverability (same `settings.*` fields).

7. **`lib/store/settings.svelte.ts`**: added persisted `videoCodec`, `videoBitrateMbps`,
   `videoStabilise`, `superresScale`, `superresPixfrac`, `superresSharpen`.

8. **`lib/store/gallery.ts`** (additive): `GalleryItem.stack.depth.unit?: 'steps' | 'µm'`;
   `GalleryItem.video.stabilised?: boolean`. See open point below — neither is currently written by the
   owning services, only read defensively by `Viewer.svelte`.

9. **`components/Viewer.svelte`**: new "ℹ details" toggle (next to the sample toggle) showing exposure,
   gain (+digital gain), colour gains, lux, colour temperature, sensor timestamp and a "not matched"
   warning from `item.capture.meta`, plus µm/px and scale source; focus-stack method/source and a depth
   legend; super-resolution frames-used/total, scale, pixfrac, sharpened, and a rejected-frame count;
   video codec/bitrate/fps/stabilised. Depth-map legend is converted to µm **at display time** via
   `algo/depthMap.ts#stepsToUm`/`depthLegend` using Settings' current `stageStepUm.z`, rather than
   depending on a persisted unit — see open point 1. Fixed `<video autoplay loop>`: now
   `loop={videoShouldLoop}` (only loops clips longer than 3 s), so a short recording no longer silently
   restarts and looks like a glitch.

## Update: raw-plane super-resolution control + final e2e result

After the above was reported, a `raw: true` option landed on `SuperresOptions`
(`services/photo/superres.ts#superresRawPhoto`, see `handoff/superresraw.md`). Added: a "RAW planes
(no demosaic, slow)" checkbox in the super-resolution Advanced section, wired as `superres.raw`; the
Sharpen checkbox is disabled (and unchecked when sending) whenever it's on, since raw mode doesn't
implement sharpening. Added one e2e step (`super-resolution RAW planes (no demosaic) drizzles a 2x2
grid`, scale 2, 4 frames) — passes.

While wiring this in I found the "Slices" input for `focusfine`/`focusfineraw` had no `aria-label`
(only the plain `focus` mode's Slices input did), while `e2e/app.mjs` targeted the same
`aria-label="focus stack slices"` selector for both — added the missing label so both are unambiguous.

**Re-ran the full suite several times while chasing this.** The first two clean runs (before the raw
super-resolution addition) failed the same 3 steps every time with the z-backlash pattern described
below (§3) — that diagnosis stands and is worth relaying. Later runs, made while I had other `Bash`
tool calls (file reads/greps) running concurrently with the browser test, showed much broader,
differently-shaped flakiness each time (calibration 1 timing out, click-drag distance off, autofocus
landing far from focus, a macro replay not returning to start) — never the same failure twice. That
pattern (different tests, different runs, never reproducing) is consistent with resource contention
from my own concurrent shell activity racing the test's real-time settle/timeout logic, not a code
defect. **A final, isolated run (fresh fake-device restart, no other tool calls in flight) passed all
32/32 steps**, including the 3 that failed with the z-backlash pattern earlier. I can't rule out that
the backlash issue in §3 is real (I reproduced it twice, cleanly, with a specific and repeatable
numeric signature), but it did not reproduce in the final clean run, so treat it as "observed, not
confirmed reproducible in isolation" rather than a certain, standing failure — worth a look given how
specific the pattern was, but not something that should block this branch.

## e2e (`webapp/e2e/app.mjs`)

Added steps: **RAW average photo**, **HDR (RAW) photo**, **RAW flat field: capture and clear**,
rewrote **video recording** to explicitly assert `Stabilise` is checked and that the resulting clip's
`<video>` element has `loop === false` (it's ~2.5 s in this test), and rewrote **super-resolution** to
exercise the Advanced controls (pixfrac via Extra-frames input, and the Sharpen checkbox) rather than
the old dead "Frames" input.

**Found and fixed a real bug while wiring these in**: every existing `page.selectOption('.panel:has(h3
:has-text("Photo")) select', ...)` call was ambiguous once the video Codec `<select>` (added earlier this
session by the scan/video work) landed in the same panel — Playwright's strict-mode locator resolution
made every one of these calls fail with a 30s timeout, silently, for *any* mode change in this panel. Not
something introduced by my changes (the Codec select already existed), but never caught because e2e
hadn't been run since it landed. Fixed by giving the mode select `aria-label="capture mode"` and updating
every such selector in `e2e/app.mjs` (12 call sites) to `select[aria-label="capture mode"]`.

Also found the 3x-scale super-resolution combination (crop 4096, scale 3, +1 extra frame) throws `Array
buffer allocation failed` in this headless-Chrome test environment — a genuine memory ceiling for that
combination, not a selector bug. Left the e2e test at scale 2 (still exercises pixfrac/extra-frames/
sharpen) and flagged scale-3 memory cost as an open point (7) for the super-resolution owner.

### Final result: **32/32 steps pass** in the last, isolated run (fresh fake-device restart, no other
concurrent tool activity). Two earlier clean-looking runs failed the same 3 steps every time with:

```
FAIL focus stack photo returns to the starting z: focus stack did not finish: ... focus stack: stage did not reach z=-125 after a retry (reached 375)
FAIL fine focus stack centres on the focus plane and fuses several slices: fine stack did not finish: ... fine stack: stage did not reach z=-120 after a retry (reached 360)
FAIL fine focus stack produces a depth map with an image/depth/relief toggle: fine stack did not finish: ... fine stack: stage did not reach z=-143 after a retry (reached 429)
```

See the "Update" section above for the full story — this did not reproduce in the final isolated run,
so treat §3 below as "observed twice with a suspiciously specific numeric signature, not confirmed
reproducible in isolation" rather than a certain standing bug.

`npm run check` (0 errors), `npx vitest --run` (240/240) and `npm run build` are all green.

## Open points

1. **Depth-map legend µm is not persisted** (`stack.depth.unit`) — deliberately not done. I added the
   additive `unit?` field to `GalleryItem['stack']['depth']` for future use, but the actual requirement
   ("show the legend in µm in the Viewer when available") is met without it: `Viewer.svelte` converts
   the stored z-step `minZ`/`maxZ` to µm at display time from Settings' *current* `stageStepUm.z`, so the
   persisted unit is redundant unless a future feature needs to preserve *the µm/step value at capture
   time* (e.g. if it's later changed in Settings, old items would then show a legend converted with the
   *new* factor, not the one in force when captured). If that distinction matters later,
   `services/photo/focusStack.ts` (not in my ownership) would need to store `umPerStep` alongside `zs`.
2. **`GalleryItem.video.stabilised` is additive-only, not yet written.** `services/recorder.svelte.ts`
   (owned by the scan/video work) would need a one-line addition passing `stabilize` through to
   `saveVideo`'s meta. `Viewer.svelte` already reads it defensively (shows nothing if absent).
3. **A z-backlash pattern that showed up twice, cleanly, then didn't reproduce in isolation** — see the
   "Update" section above for the full timeline; not a confirmed standing bug, but specific enough to be
   worth someone's attention. `device/openflexito/stage.py` is untouched by anyone this session per
   `git status`, so if it's real it's pre-existing, not a regression. Diagnosis from reading (not
   modifying) `stage.py`: `_move_rel_sync`'s backlash correction splits a compensated move into an
   overshoot (`move[a] - backlash`) followed by a rebound (`+backlash`) — normal v3-style backlash
   handling. But when the *requested* move is smaller than the axis's backlash (z backlash defaults to
   200 steps; `focusStack.ts`'s quick/fine stacks move ~50-150 steps at a time with `compensate: 'z'`),
   the two failing runs both showed the hardware end position consistently close to `-3 × target` (e.g.
   target -125 → reached 375; target -120 → reached 360; target -143 → reached 429) — i.e. only the
   overshoot half of the split move appeared to take effect, not the rebound. If someone who owns
   `device/` (I was told never to touch it) wants to chase it: look at `Stage._move_rel_sync`/
   `_hw_move`'s cancellation path around the `first.cancelled` early-return, and/or whether
   `moveZVerified` in `services/photo/focusStack.ts` should request a `compensate: 'z'` move only when
   the travel exceeds the axis backlash.
4. **`RAW flat field` capture takes ~15 s over WiFi on a real device** (device.md §2, `/flat.bin`); the
   e2e step ran against `--fake` in ~0.6 s, so timing on real hardware is unverified — the RAW-family
   handoff already flags several `device/.venv`-has-no-picamera2 hardware caveats that apply here too.
5. **Bracket factors UI** (`PhotoPanel`'s LED-levels/exposure-factors text inputs) parses a comma/space
   list with a silent fallback to the previous default on anything unparsable — no validation error is
   shown to the user for e.g. an empty or garbage string. Low risk (silently keeps working) but worth a
   visible warning if this becomes a common source of confusion.
6. **Video/super-resolution defaults in Settings vs. the Photo panel are two separate `$state` copies**
   seeded once from `settings.*` at mount (an existing pattern elsewhere in this codebase, e.g.
   `Viewer.svelte`'s `draft`) — changing a default in Settings does not live-update an already-open Photo
   panel's current session values, only the *next* app load. Matches how `stageStepUm` etc. already work
   here; flagging in case a reactive link is wanted later.
7. **Super-resolution at scale 3 with a full ~4096 px crop can exhaust memory** in at least a headless
   Chrome test environment (`Array buffer allocation failed`); worth checking the real memory ceiling on
   a Pi's browser or a phone/tablet client, and possibly capping the crop size tighter for scale 3, or
   documenting a lower recommended crop for that combination. Not something I changed — the crop/scale
   math is `services/photo/superres.ts` (superres-hdr agent's file).

## Files changed

- `webapp/src/components/PhotoPanel.svelte` (rewritten)
- `webapp/src/components/Viewer.svelte`
- `webapp/src/routes/Live.svelte`
- `webapp/src/routes/Calibrate.svelte`
- `webapp/src/routes/Settings.svelte`
- `webapp/src/lib/store/settings.svelte.ts`
- `webapp/src/lib/store/gallery.ts` (additive)
- `webapp/src/lib/services/photoService.ts` (small, necessary edits — shared dispatcher)
- `webapp/src/lib/api/types.ts` (small, additive)
- `webapp/e2e/app.mjs`

Update (raw super-resolution control):
- `webapp/src/components/PhotoPanel.svelte` (added the RAW-planes checkbox; added the missing
  `aria-label="focus stack slices"` to the `focusfine`/`focusfineraw` Slices input)
- `webapp/e2e/app.mjs` (added the raw-superres step)
