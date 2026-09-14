# TODO — where to carry on

State as of 2026-09-14 (main, capture-quality overhaul plus UI wiring and networking both committed):
the audit in `CAPTURE_AUDIT.md` (2026-09-10) drove several parallel agents (device wire formats; focus
stack/autofocus/live stack; registration/super-resolution, including the later raw-plane pass; scan/
stitch/video/time-lapse; RAW/DNG/HDR; the UI controls for all of it; wired-networking support) through
nearly every Tier A/B item. `cd device && .venv/bin/pytest -q` (58 tests), `cd webapp && npm run check`
(0 errors), `npx vitest --run` (30 files, 240 tests) and `npm run build` are all green; the full
Playwright e2e (34 steps, `npm run test:e2e` against `--fake`) passes run alone — see the note under
"Loose ends" below on why running two suites against one fake at once is erratic, not a real failure.

## Pending on the real Pi (it was offline when this was written)
- Apply the power-button overlay live: append `dtoverlay=gpio-shutdown` to `/boot/firmware/config-openflexito.txt`
  and reboot (the rebuilt image already has it). Wire a momentary button pin 5 (GPIO3) ↔ pin 6 (GND).
- Re-run Calibrate 1 with the sample removed if a sample was in view during the last e2e run (it rewrote the
  lens-shading tuning from whatever field was showing).
- The preview "waves"/hum-bar report is unresolved: the frames leaving the Pi show no periodic banding under
  any LED level, exposure or coil state (README, "Preview noise"). Next time it is visible run the Camera
  panel's **Flicker check** and keep its four lines plus browser, display refresh rate and stream size.

## Hardware verification needed (most of this session's changes are still only unit-tested against
synthetic scenes/the fake device — `picamera2` is not installed in `device/.venv`, so nothing camera-side
can run for real in this dev environment; a probe below narrowed some of it from a real Pi over SSH)

**Confirmed on the real Pi over SSH on 2026-09-14** (read-only probe, nothing deployed yet):
python3-picamera2 0.3.31 sets `NoiseReductionMode Fast` + `FrameDurationLimits (33333, 33333)` for video
configs and `HighQuality` + `(100, 1e9)` for still configs, so the 33 ms exposure clamp hypothesis and the
still-denoise hypothesis were both right and the explicit limits/`still_clean` in `camera.py` are needed;
`switch_mode_and_capture_request` exists; NetworkManager 1.42.4; avahi publishes on all interfaces
(`use-ipv4=yes`, no interface filter); eth0 had no cable (`carrier 0`, state unavailable) so the
link-local fallback is still untested; the deployed `camera.py` matched the last commit, i.e. the Pi was
one deploy behind this work at probe time.

**Deployed and exercised on the real Pi on 2026-09-14** (`image/deploy.sh`, service restarted clean, no journal
warnings): `/snapshot.jpg?full=1` returns the still's own `X-Frame` (still true, matched true, 396 µs, gain 1.0,
colour gains 0.866/1.352, SensorTimestamp, 3280×2464, 2.3 MB at quality 95 in 3.4 s over WiFi); `/raw.bin?frames=2`
returns the 16-bit mean (bit_depth 16, black 4096, white 65472, trailer with ccm at 5000 K, frame timestamps) in
9.6 s = 13 Mbit/s on the Pi's WiFi; `/bracket.bin?factors=0.5,1,2` gives exposures 189/378/775 µs with gain and
colour gains locked; `/raw.bin?packed=1` is 10.1 MB; `still_clean` reports true in `camera.status`; network status
reports link wifi/wlan0. RSS 252 MB after the raw work. The e2e with `E2E_MOVES=0` against the Pi passed 21 of 22 no-move steps (RAW average, HDR RAW, flat field,
stabilised video included); the 22nd asserted a wired link and now accepts any link label. Calibration 1 ran as part of
it with whatever was in view: re-run it with the sample removed. **Wired link verified 2026-09-14** (cable from the Pi to the router, Pi power-cycled): `openflexito-wired` came up
by itself with a DHCP lease (192.168.0.13) and became the default route (metric 100 vs 600 for WiFi), the hotspot
stayed down, `microscope.local` resolved to the wired address, the app's status bar/`network` reported
link ethernet 100 Mbit/s (the router port or cable negotiated 100BASE-T full duplex, not gigabit), and the service
recovered its poll a few seconds after boot (one "unknown" reading in the first 10 s window). Throughput: 16 MB RAW
in 2.7 s including the ~1.4 s capture (≈100 Mbit/s on the wire) against 9.6 s over the Pi's WiFi (13 Mbit/s measured);
small sequential HTTP requests 41 vs 13 Mbit/s. Note the Pi answers requests to its WiFi address over the cable too
(same subnet, default route), so only the cable's presence matters. Still unverified: the direct-cable link-local
case (no DHCP server), the visual effect of `still_clean`, long exposures past 33 ms, and every stage-moving mode
on hardware.
- **picamera2 defaults for stills**: device.md hypothesis 3 — the *default* `NoiseReductionMode`/
  `FrameDurationLimits` picamera2 picks are now confirmed (2026-09-14 probe above); still pending: deploy
  this codebase's explicit `still_clean`/limits overrides and confirm they actually land in
  `camera.metadata`/the still config dict once running, not just that the defaults they replace exist.
- **`FrameDurationLimits` clamp**: device.md hypothesis 4 — still pending once deployed: verify the
  stream's `(33333, 500000)` minimum is clamped by the 3280×2464 mode's ~66.7 ms floor, and that AE
  actually reaches past 66 ms on dim samples with the explicit limits in place.
- **`switch_mode` + `capture_request` behaviour**: confirm `Picamera2.switch_mode(config_dict)` followed
  by `capture_request()` and a second `switch_mode(video_config)` behaves like
  `switch_mode_and_capture_request`, that `create_still_configuration(raw=None)` really drops the raw
  stream, and that `NoiseReductionModeEnum.Off` is accepted in a configuration's `controls` dict on this
  libcamera build — device.md hypotheses 1-3.
- **Exposure change latency**: still-mode `ExposureTime` should settle within 5 % of the request within
  8 frames (used by `/bracket.bin`'s per-step confirmation) — device.md hypothesis 5.
- **Raw buffer shape/memory**: `request.make_array("raw")` for SBGGR10 should return uint16 (or a
  uint8 view of it, handled by the existing `.view(np.uint16)[:h, :w]`); at most one 16 MB request copy
  plus one 32 MB uint32 accumulator should be live during `/raw.bin?frames=8` — device.md hypotheses 6-7.
- **Super-resolution on real hardware**: needs a CSM calibration and a stage that repeats to ~0.5 px.
  Check the *measured* shifts `services/photo/superres.ts` records against the commanded ones, and
  whether the snake-order + per-reversal backlash pre-load is enough, or whether "one direction per
  axis" (a non-snake cell order) is actually needed — superres.md open points 3-4.
- **Stabiliser tuning**: the video stabiliser's `beta: 0.02` (`algo/stabilize.ts`) was tuned against a
  synthetic pan+jitter scene, not real footage; retune `minCutoff`/`beta`/`reanchorPx` against real
  hand-shake/stage-vibration frequency content — scan.md open point.
- **Focus breathing**: measure how much the image scales with z on the real optics to decide whether
  `algo/align.ts`'s off-by-default similarity (scale+translation) alignment is worth turning on — CAPTURE_AUDIT.md §5, focus.md open point.
- **Flat-field workflow**: `captureFlatField` (`services/photo/rawPhoto.ts`) downloads `/flat.bin`,
  derives gain maps and saves them, but has no UI yet and has never been run against a real sample-removed
  field; once wired, check it against a known-vignetted scene and that it correctly out-competes the
  tuning file's placeholder ALSC tables.
- **Wired networking** (README "Networking", `device/openflexito/netwatch.py`): the `link`/`interface`/
  `link_local`/`speed_mbit`/`interfaces` fields and the `openflexito-wired` NM profile are unit-tested
  and exercised on the fake device only (which reports a fixed `link: "ethernet"`, `speed_mbit: 1000`).
  On the real Pi, verify:
  - **Link-local fallback**: cable straight into a laptop with no router/DHCP server actually brings up
    169.254.x.x on the Pi (NM `ipv4.link-local=fallback`) within the ~15 s `dhcp-timeout`.
  - **avahi on a link-local address**: `microscope.local` resolves over that cable (Debian's default
    avahi config publishes on all interfaces, but this has not been checked against a real 169.254 address).
  - **`nmcli device status` wording** for the wired profile actually reads "connected" (not
    "connected (externally)", which `classify()` would not currently treat as connected).
  - **Real sustained Ethernet throughput** on the Pi 3B+'s single USB-fed bus (README estimates
    200-300 Mbit/s and ~0.5 s per 16 MB `/raw.bin`; unmeasured).
- Time-lapse drift correction, scan autofocus/height map and the measurement tool have still only been
  exercised on the fake device, as before.

## Loose ends left by the feature agents
- **Raw-plane super-resolution** (`superres` + `raw: true`, `services/photo/superres.ts#superresRawPhoto`) is
  wired and tested on synthetic scenes only: no sharpen/deconvolution in raw mode (PSF unverified on linear
  planes), gains/CCM taken from the reference frame's trailer rather than per frame, no DNG output, and the
  `navigator.deviceMemory` crop threshold in `superresWorker.ts` is a guess.
- **`stackWorker.ts` has no direct unit test.** `self`/`postMessage` aren't available in this repo's
  vitest environment (plain node, no jsdom), so importing the worker module throws. It was sanity-checked
  by hand (streaming vs. full-buffer vs. hybrid paths agree) but not committed as a test; worth a
  jsdom/worker-capable test target if this project adds one.
- **`toneMapMertens` (`algo/hdr.ts`) breaks on a 1×N or N×1 image.** The Laplacian-pyramid helpers it
  shares with `exposureFuse.ts` assume both dimensions can be halved sensibly. No capture mode currently
  produces a 1-pixel-tall image, so this is latent, not a live bug — add a guard (clamp `levels` so
  neither dimension pyramids below 1) if `hdr.ts` is reused somewhere new.
- **Super-resolution's `sharpen` PSF has no measured optical-blur term** — only the drizzle drop and
  pixel aperture, since nothing in this codebase measures the real PSF (a bead or knife-edge target)
  yet. Wire in a measured sigma once that exists.
- **Depth-map/height-map units**: `algo/depthMap.ts`'s `stepsToUm`/`depthLegend` convert z steps to µm
  given `settings.stageStepUm`, and `Viewer.svelte` shows the depth-map legend in µm at display time from the current setting;
  `GalleryItem.stack.depth` still has no persisted `unit`/µm-per-step field, so an item viewed after the
  setting changes re-labels itself; same for `algo/heightMap.ts`'s scan height-map legend.
- **`hdrRawPhoto`'s exposure-per-frame lookup** trusts the device bracket summary's `item.meta.factor`
  when present, else falls back to `factors[i]` by array index — unverified against a device that
  reorders or partially completes a bracket (device.md doesn't document reordering, so believed safe).
- **DNG `DateTimeOriginal`** uses wall-clock time at develop time, not the still's own `CLOCK_BOOTTIME`
  timestamp (no RPC exposes the device's boot epoch to convert it) — fine for a develop right after
  capture, would drift for a raw buffer cached and developed later.
- **`capture.meta` (still request metadata) is populated for `single`, RAW/HDR-family and exposure-bracket
  captures**; LED-only `'led'` brackets, focus-stack slices and scan tiles still use `captureFull()` — switch
  them to `captureFullWithMeta()` (`services/photo/common.ts`) for full D6 coverage.
- **RCD demosaic (`algo/demosaic.ts`) is ~3-5× Malvar's cost** on an 8 MP frame in pure TS (no measured
  hardware number yet); already off the main thread in `rawWorker.ts`, a WASM port stays Tier C.
- Depth map (`algo/depthMap.ts`) and scan height map (`algo/heightMap.ts`) still report z in steps on
  screen until the unit-field wiring above is done.
- Macro recording hooks the single RPC client; if `device.reconnect()` swaps clients mid-recording the
  `onCall` hook is not rebound (`services/macro.svelte.ts`).
- Time-lapse WebM export and "track a saved time-lapse" have no e2e step.
- Polygon scan region is aligned to the planned grid box, not to the overview image's exact geometry.
- "Export all of this sample" without the File System Access API downloads flat files (same as Export).
- **Focus-stack arrival check** (`services/photo/focusStack.ts#moveZVerified`) compares the device's
  program-frame `position.z` with the target; `end_hw` is the raw hardware frame (sign/offset applied by
  `stage.py#_to_program`) and must not be compared with program coordinates — this is the likely cause of
  the intermittent "stage did not reach z=..." failures seen in some e2e runs. The e2e (34 steps) passes
  on the fake when run alone; two suites against one fake drive the same stage and fail erratically.

## Feature 5 (waiting on hardware): oblique / darkfield / differential phase contrast
- Two side LEDs on the Sangaboard PWM outputs (J8 pins 2 and 4 are the low-side MOSFET drains, pins 1/3 = +5 V;
  20 mA LED needs ~100 Ω white / ~150 Ω red in series). `light.set {pwm:[a,b]}` already drives them and
  the Illumination panel has Darkfield/Oblique/Rheinberg presets.
- DPC: capture the pair (left only, right only) as full-res stills with frozen AE, phase ≈ (L − R)/(L + R),
  optionally deconvolve with the DPC transfer function; add as a photo mode next to `exposure` in
  `services/photoService.ts`, maths in `lib/algo/dpc.ts` with a synthetic-phase test.
- Digital darkfield: frame with condenser off and both side LEDs on, background-subtract, save as a mode.

## Ideas not started
- A tiled full-frame super-resolution output that removes the ≤4096 px centre crop (never triggers on
  the IMX219's own resolution, but would matter on a higher-resolution sensor).
- Asymmetric fine-stack span, DNG gain maps from the ALSC tables directly (now moot for flat-field-backed
  captures, still relevant for the placeholder ALSC path).
- Upstream: firmware idle coil release (`stage.cpp`), v3 still-capture AE/AWB freeze check, vc4 denoise
  and MJPEG encoder notes (see README hardware notes).
- A "take photo"/"autofocus" hardware button via the `gpio-key` overlay + evdev in the device service
  (`gamepad.py` slot in the plan), fan on GPIO18 with `gpio-fan` if the Pi runs hot at 1640×1232.
- Colour-checker CCM calibration and CA/distortion correction from a grid target (CAPTURE_AUDIT.md
  Tier C).
