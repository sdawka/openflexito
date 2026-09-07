# TODO — where to carry on

State as of 2026-09-07 (main `dd05160`): all features in README are merged, tested (120 vitest, 27 pytest,
29 e2e steps on the fake device, e2e without moves on the real Pi) and deployed; image
`image/build/openflexito-20260907.img` matches main. Always: `cd webapp && npm run check && npx vitest --run
&& npm run build`, run the e2e against the fake, deploy, then commit (no promotional text, never commit
`image/secrets.env`).

## Pending on the real Pi (it was offline when this was written)
- Apply the power-button overlay live: append `dtoverlay=gpio-shutdown` to `/boot/firmware/config-openflexito.txt`
  and reboot (the rebuilt image already has it). Wire a momentary button pin 5 (GPIO3) ↔ pin 6 (GND).
- Re-run Calibrate 1 with the sample removed if a sample was in view during the last e2e run (it rewrote the
  lens-shading tuning from whatever field was showing).
- Try the new features on hardware: super-resolution needs a CSM calibration and a stage that repeats to
  ~0.5 px; check the measured shifts it stores against the commanded ones. Time-lapse drift correction,
  scan autofocus/height map and the measurement tool have only been exercised on the fake device.
- The preview "waves"/hum-bar report is unresolved: the frames leaving the Pi show no periodic banding under
  any LED level, exposure or coil state (README, "Preview noise"). Next time it is visible run the Camera
  panel's **Flicker check** and keep its four lines plus browser, display refresh rate and stream size.

## Feature 5 (waiting on hardware): oblique / darkfield / differential phase contrast
- Two side LEDs on the Sangaboard PWM outputs (J8 pins 2 and 4 are the low-side MOSFET drains, pins 1/3 = +5 V;
  20 mA LED needs ~100 Ω white / ~150 Ω red in series). `light.set {pwm:[a,b]}` already drives them and
  the Illumination panel has Darkfield/Oblique/Rheinberg presets.
- DPC: capture the pair (left only, right only) as full-res stills with frozen AE, phase ≈ (L − R)/(L + R),
  optionally deconvolve with the DPC transfer function; add as a photo mode next to `exposure` in
  `services/photoService.ts`, maths in `lib/algo/dpc.ts` with a synthetic-phase test.
- Digital darkfield: frame with condenser off and both side LEDs on, background-subtract, save as a mode.

## Loose ends left by the feature agents
- Depth map (`algo/depthMap.ts`) and scan height map (`algo/heightMap.ts`) report z in steps; wire the
  µm/step setting (`settings.stageStepUm`, `store/scaleCal.svelte.ts`) into both legends.
- Macro recording hooks the single RPC client; if `device.reconnect()` swaps clients mid-recording the
  `onCall` hook is not rebound (`services/macro.svelte.ts`).
- Time-lapse WebM export and "track a saved time-lapse" have no e2e step; long time-lapses store one JPEG per
  frame with no size cap.
- Polygon scan region is aligned to the planned grid box, not to the overview image's exact geometry.
- Super-resolution falls back to a ≤4096 px central crop above canvas limits; a tiled full-frame output
  would remove the crop.
- "Export all of this sample" without the File System Access API downloads flat files (same as Export).

## Ideas not started
- Live view rendered through fetch + canvas instead of `<img src=stream.mjpg>` (would allow per-frame
  processing without re-grabbing and rule out browser paint effects); only worth it if the flicker check
  ever shows tearing.
- Asymmetric fine-stack span, DNG gain maps from the ALSC tables.
- Upstream: firmware idle coil release (`stage.cpp`), v3 still-capture AE/AWB freeze check, vc4 denoise
  and MJPEG encoder notes (see README hardware notes).
- A "take photo"/"autofocus" hardware button via the `gpio-key` overlay + evdev in the device service
  (`gamepad.py` slot in the plan), fan on GPIO18 with `gpio-fan` if the Pi runs hot at 1640×1232.
