# Integration notes: creative modes (timestamp attribution, HDR settling check, robust SR drizzle)

What landed in `algo/frameAttrib.ts`, `algo/drizzleRobust.ts`, `services/video/{hdrVideo,illumModes}.ts`
and `workers/videoSrWorker.ts`, and what the catalogue (`videoModes.ts`), the panel
(`PhotoPanel.svelte`) and `stageModes.ts` need to expose. Nothing here touches those files; every
new worker/param field is optional with a default, so the existing wiring keeps working unchanged.

## 1. Frame attribution (`algo/frameAttrib.ts`, `illumModes.ts#LightAttributor`)

`StateLog<T>` (ring of 64 timed switches, `push(t, state)` / `push(tSent, state, tAcked)` /
`stateOver(t0, t1): T | 'ambiguous'`) and `ClockMap` (browser `performance.now()` → device ns,
max-offset estimate over the last 32 frames). `LightAttributor` in `illumModes.ts` glues them to
`device.setLight`: a commanded switch is logged in device time as the interval `[sent, acked]`
(+ a measured `lagNs`), and a frame is attributed to the state that held over
`[t, t + exposure + 33 ms readout]`; a frame straddling a switch is dropped (`null`). Without a
frame timestamp it falls back to the commanded state `latency` frames earlier (+ luma validation
in `hdr`). Exposure is looked up by `seq` in `device.frames`.

**No new params.** Recommended follow-ups outside my ownership:

- `ModeFrameInfo` (types.ts): add `exposure?: number | null` (µs) filled by the recorder from the
  MJPEG part's `meta.exposure`, so `frameExposureNs(seq)` need not scan `device.frames`.
- Device: add `t: now_ns()` to the `light` event / `light.set` reply (creative.md §0); the
  attributor can then push the device time directly and drop the `ClockMap` approximation.

## 2. `hdr` mode (`hdrVideo.ts`)

No new params (`HdrVideoParams` unchanged: `ratio`, `period`). Behaviour changes to document in
the blurb/cost line:

- Settling check on the first ~3–11 frames (baseline at bright, one switch to dim, watch up to 8
  frames); those frames pass through unfused. Measures the pipeline latency (fallback queue) and
  the timestamp correction. `status()` starts with `settling check · …` during it.
- If the picture does not move by > 5 % within 8 frames, `status()` carries
  `warning: the LED does not change the picture at this exposure (…)` and `stats().warning` is
  set; the run continues.
- Fusion is in linear light with the measured bright/dim gain (`stats().gainMeasured`).

New `stats()` fields: `dropped`, `mismatched`, `gainMeasured`, `settleLatencyFrames`,
`attribution: 'timestamp' | 'commanded'`, `lagMs`, `warning?`.

## 3. `illum` mode (`illumModes.ts`)

No new params (`IllumParams` unchanged). With timestamps every attributed frame is used (not just
the last of a hold), so the output rate rises; a partner older than `2·hold + 3` frames yields no
output (`stale`). New `stats()` fields: `dropped`, `stale`, `attribution`.

## 4. `superres` mode: robust drizzle (`videoSrWorker.ts`, `algo/drizzleRobust.ts`)

Worker `init` message gained two optional fields; `stageModes.ts#superresVideoMode` should pass
them from the params and show the new result field in `status()`/`stats()`.

| param | type | default | label / UI |
|---|---|---|---|
| `superres.robust` | `boolean` | `true` | "Reject movers" (checkbox) — Wronski 2019 robustness: frames are down-weighted where they differ from the newest frame beyond the noise, so a moving specimen is not smeared |
| `superres.robustK` | `number` (1–6, step 0.5) | `3` | "Rejection threshold (σ)" — advanced; lower rejects more |

Worker message: `{ type: 'init', scale, pixfrac, window, robust?, robustK? }`.
Result (`VideoSrResult`, exported from the worker) gained
`robustRejectedFrac: number` — mean fraction of plane pixels pushed below weight 0.5 over the
window's older frames (0 static, rising with motion). Suggested status text:
`· ${Math.round(robustRejectedFrac * 100)} % rejected as motion`; suggested stats key
`robustRejectedFrac`. The `R` type in `stageModes.ts` can be replaced by `VideoSrResult`.

## 5. Verification

`npm run check` clean; `npx vitest --run` 65 files / 553 tests green, including the new
`__tests__/frameAttrib.test.ts` (7) and `__tests__/drizzleRobust.test.ts` (5: static scene equals
plain drizzle, a square appearing in one frame is not smeared, all-rejected equals single-frame
upsampling bit for bit, no holes at low pixfrac, coarse weight maps). No fake was running on
port 8099, so `node e2e/video-mode.mjs hdr|illum|superres` still needs a run against the fake
(HDR's settling check will hit the 8-frame warning there, since the fake's picture does not follow
the LED — expected).
