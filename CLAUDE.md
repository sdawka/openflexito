# openflexito

Thin-device microscope stack. **Rule: the Pi only relays; all image maths lives in `webapp/src/lib/algo` (pure TS, vitest-tested).** The device (`device/openflexito`) exposes data and control only. Never fork the OpenFlexure v3 server; use its sources as an algorithm reference. Licence GPL-3.0-or-later.

## Commands
- device: `cd device && .venv/bin/pytest -q` · run fake: `.venv/bin/python -m openflexito --fake --port 8080`
- webapp: `cd webapp && npm run check && npx vitest --run && npm run build` · dev: `OPENFLEXITO_DEVICE=http://localhost:8080 npm run dev`
- browser e2e (Playwright + installed Chrome): start the fake with `--webapp-dir webapp/dist --port 8099`, then `cd webapp && npm run test:e2e` (11 steps: tabs, jog, snapshot, both calibrations, autofocus, scan, settings). `npm run test:e2e -- http://microscope.local` runs it on the real Pi (moves the stage, rewrites tuning); `E2E_MOVES=0` skips moves. Run it after any UI change: unit tests do not catch Svelte effect loops or leaked MJPEG connections.
- image: `image/build-mac.sh` (mtools injection into the official Bookworm Lite image; needs `image/secrets.env`) is the working builder; `image/build.sh` (sdm) is untested. `sudo image/install.sh [--trim] [--readonly]` on a live Pi.

## Conventions
- RPC methods are registered in `device/openflexito/app.py` (`register_rpc`); names are `group.verb`; params are keyword JSON. `GET /rpc/schema` is generated from type hints, keep hints accurate.
- Timestamps everywhere are nanoseconds on CLOCK_BOOTTIME (same clock as libcamera `SensorTimestamp`); the browser interpolates z per frame from `event.position` t0/t1.
- Moves that must not be backlash-compensated (jog, click-to-move, autofocus sweeps, CSM) pass `compensate: false`.
- Svelte 5 runes; reactive stores are `*.svelte.ts`. No UI framework; styles in `src/app.css` + component `<style>`. Never write a `$state` you also read inside the same `$effect` (infinite loop that kills the whole app); clear `img.src` of MJPEG images on unmount (a detached `<img>` keeps streaming); never put `$state` proxies into IndexedDB (structured clone fails).
- The fake camera (`--fake`) renders a stage-coupled specimen (1 px/step, 4° axis rotation, defocus ∝ |z|), so calibration, autofocus and scans work end to end without hardware.
- Hardware-specific values (UART, IMX219 modes, LED sysfs) are documented in `README.md`; don't change `config-openflexito.txt` without re-checking the Pi 3B+ notes there.
- AI features live in `webapp/src/lib/workers/aiWorker.ts` (Transformers.js) + `services/{aiService,searchService,followService}`. Models are Hugging Face ids in Settings; default `Xenova/yolos-tiny` and `Xenova/clip-vit-base-patch32`.
