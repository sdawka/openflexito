# openflexito

A thin, hackable replacement for the OpenFlexure microscope software, built for a
Raspberry Pi 3B+ with a Sangaboard v0.5.

**The Pi is a dumb relay.** It streams the camera, relays motor and LED commands to the
Sangaboard over UART, blinks its status LED, and serves the web app. Nothing heavy runs on it.

**The browser is the brains.** Autofocus, camera calibration, click-to-move, scanning and
stitching, gallery, and later object detection run in a Svelte + TypeScript app on your laptop.

```
device/   Python service for the Pi (aiohttp, picamera2, pyserial)   → python -m openflexito
webapp/   Svelte 5 + TypeScript + Vite app served by the Pi           → npm run dev / build
image/    OS image: install.sh (live Pi), build.sh (sdm), overlay files
```

## Quick start (development on a laptop, no hardware)

The fake device renders a stage-coupled specimen (moves scroll it, z defocuses it), so calibration,
autofocus and scans can be exercised end to end. Browser tests: `cd webapp && npm run test:e2e` with the fake
running on port 8099 serving `webapp/dist` (needs Google Chrome installed).

```bash
cd device && python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/python -m openflexito --fake --port 8080     # fake camera + fake Sangaboard
cd ../webapp && npm install && OPENFLEXITO_DEVICE=http://localhost:8080 npm run dev
```

Open the Vite URL. Keys WASD/arrows jog XY, PgUp/PgDn jog Z, a gamepad works too.

## Build a ready-to-boot image (macOS or Linux, no loop mounts)

```bash
cp image/secrets.env.example image/secrets.env   # WiFi SSID/password/country, admin user/password
./image/build-mac.sh                             # -> image/build/openflexito-<date>.img
```

The script takes the official Bookworm Lite 64-bit image and injects a first-boot script plus the
project into the boot partition. First boot: sets hostname `microscope`, the admin user with your
`~/.ssh/id_ed25519.pub`, WiFi, SSH, then reboots. Second boot: installs the service (needs internet
once, 5-10 min, ACT LED blinks fast), then it runs headless at `http://microscope.local/` on every
power-up. Flash with Raspberry Pi Imager ("Use custom", skip OS customisation) or `dd`.

## Install on a running Raspberry Pi (Pi OS Lite 64-bit Bookworm)

```bash
git clone <this repo> && cd openflexito
(cd webapp && npm ci && npm run build)          # optional: bundle the web app
sudo ./image/install.sh --trim                  # add --readonly for an overlay root fs
sudo reboot
```

Then open `http://microscope.local/`. The service listens on port 80; the WebSocket RPC is
at `/ws`, HTTP RPC at `POST /rpc`, method list at `/rpc/schema`, streams at `/stream.mjpg`
and `/stream-lores.mjpg`, stills at `/snapshot.jpg[?full=1]`, raw Bayer at `/raw.bin`.

WiFi: put `openflexito-wifi.txt` (see `openflexito-wifi.example.txt`) on the boot partition
before first boot. If no known network is found 40 s after boot, the Pi opens a hotspot
`microscope` / `microscope` at `http://10.42.0.1/`.

Status LED (green ACT): fast blink booting, slow blink no WLAN, double blink hotspot,
solid connected, heartbeat streaming, SOS hardware error.

## Sangaboard wiring

The Sangaboard v0.5 HAT talks over the Pi's PL011 UART (GPIO 14/15, `/dev/ttyAMA0`,
115200). The image disables Bluetooth and the serial console to free it. Power the Pi from
the Sangaboard's USB-C only.

## Licence

GPL-3.0-or-later. Algorithms in `webapp/src/lib/algo` are re-implementations of those in
the GPL-3.0 [OpenFlexure microscope server](https://gitlab.com/openflexure/openflexure-microscope-server);
the bundled `imx219.json` tuning file comes from that project.

## Hardware notes (verified on a Pi 3B+ with Sangaboard v0.5.5, firmware v1.0.4, IMX219)

- Sangaboard replies: `version` → `Sangaboard Firmware v1.0.4`, `board` → `Sangaboard v0.5.5`,
  `dt?` → `minimum step delay 1000`, `moving?` → `true|false`, `mr` → `done.`,
  `led_channels?` → `CC:1 PWM:2`. Every command answers in 2–4 ms over `/dev/ttyAMA0`.
  A 200-step move round-trips through the RPC in 0.3 s (0.25 s of actual motion).
- `/dev/dma_heap/*` must be group `video` or libcamera fails with "Could not open any dma-buf
  provider". Pi OS gets this from `raspberrypi-sys-mods`; the trim step keeps that package and
  the overlay ships its own rule (`etc/udev/rules.d/60-openflexito.rules`) as a belt and braces.
- The service binds IPv4 and IPv6. Clients resolve `microscope.local` to an IPv6 address first;
  an IPv4-only listener made every request wait ~2.5 s for the IPv6 attempt to fail.
- The ACT LED's `pattern`/`repeat` sysfs files are recreated as root whenever the trigger is
  re-selected, so the unit selects the trigger once in `ExecStartPre` and hands the files to the
  service user; `leds.py` never re-selects an active trigger.
- The overlay is copied with `rsync --chown=root:root` and the tarball is built with uid 0. An earlier build
  re-owned `/`, `/etc` and `/usr` to the build machine's uid, which made NetworkManager ignore the hotspot
  profile (it requires root-owned 0600 files) and broke sudo's path checks.
- First-boot install waits for NTP sync (`timedatectl`) before `apt`, otherwise the Pi's clock is
  still at the image date and apt rejects every release file as "not valid yet".
- CPU on the Pi 3B+: picamera2 alone (1640×1232 + 410×308 YUV420, no raw stream, 30 fps) costs
  ~35 % of one core; each MJPEG encoder adds ~30 %. Encoders therefore run only while a stream or
  WebSocket client is connected (start latency ~0.2 s); `/snapshot.jpg` falls back to a software
  JPEG when the encoder is idle. Idle service: ~34 % of one core, 185 MB RSS.
- Frame metadata: picamera2 encoders emit timestamps relative to their first frame; the offset is
  added back so `X-Timestamp`/`event.frame.ts` equal `SensorTimestamp` (CLOCK_BOOTTIME ns). Stream
  lag from sensor to JPEG output is ~60 ms.
- `/raw.bin` (3280×2464 SBGGR10 unpacked to 16 MB) takes ~14 s over WiFi; the tuning reload via a
  fresh `CameraManager` takes 1.5 s.

## Logs and crashes

The service log lives in the systemd journal, which the image makes persistent and size-capped
(64 MB, two months) so crashes survive a reboot. Uncaught exceptions in threads, the asyncio loop and
the main thread are routed through `logging`, so a dying camera or stage thread leaves a traceback.
Settings → Device logs fetches the tail (journal or in-memory records, filtered by level), downloads it
for a bug report, or clears it. RPC: `system.logs`, `system.clear_logs`.

The service runs unprivileged with `NoNewPrivileges`, so privileged actions (clear journal, reboot,
power off) are request files in `/var/lib/openflexito/requests/` handled by the root-side
`openflexito-maint.path` unit. No sudo.

## Status (2026-09-06)

Verified on hardware (Pi 3B+, Sangaboard v0.5.5, Pi Camera v2) from the built image:
- image: `build-mac.sh` → flash → first boot configures WiFi/user/SSH and reboots → second boot
  installs (~5 min) → third boot streams headless at `http://microscope.local/`.
- device: stream 1640×1232 at 30 fps with monotonic sensor timestamps, `/snapshot.jpg[?full=1]`,
  `/raw.bin` header and payload, `camera.set_tuning` round trip, relative moves with consistent
  position readback, `light.set`, WebSocket events and RPC, ACT LED solid/heartbeat states.

Verified in a real browser (Playwright driving Chrome, `webapp/e2e/app.mjs`): against the fake device all 11
steps pass (tab navigation, jog, snapshot → gallery, camera controls, colour calibration, stage↔camera mapping,
autofocus, 2×2 scan → stitched mosaic in the gallery, settings persistence, no page errors). Against the Pi with an
empty field of view: navigation, jog, snapshot, controls and the colour calibration pass (the field is now
flat and neutral); mapping, autofocus and scan correctly refuse to run without a sample in view.
Bugs this found and fixed: a Svelte effect loop that froze the whole app after the first page, MJPEG `<img>`
elements that kept streaming after leaving a page (leaking a connection per visit until the browser stalled),
Svelte state proxies stored into IndexedDB, and explicit colour gains silently disabling auto white balance.

Verified without hardware (fake camera + fake Sangaboard, `--fake`):
- device: 21 pytest tests (protocol, backlash, persistence, cancel, RPC, WebSocket events, MJPEG headers, raw format, LED patterns); HTTP smoke test of every endpoint; webapp served with SPA fallback.
- webapp: 24 vitest tests (raw Bayer parsing, exposure search, lens-shading table, tuning edits, autofocus interpolation and parabola fit, FFT, image tracking, backlash fit, camera-stage matrix, scan planning, stitching); headless run of the full calibration pipeline against the fake device.

Not yet verified:
- Hotspot fallback timing on hardware (unplug the router: slow blink → double blink within ~40 s, `http://10.42.0.1/`).
- Stage↔camera mapping, click-to-move, autofocus and scanning on the real microscope with a sample in view
  (they pass on the fake device and refuse cleanly on an empty field).
- The intelligence features (detection, follow, image search) against real models in a browser.
- `image/build.sh` (sdm in Docker) end to end; `install.sh --readonly`.

Intelligence features (Transformers.js in a Web Worker, WebGPU when available; models download from
huggingface.co on first use and are cached by the browser): object detection with boxes on the live
view, click a box to follow it with the stage, shift-drag a region to find similar images in the
gallery, and text search over indexed gallery images and scan tiles. These are type-checked and built
but not yet exercised in a browser against models.
