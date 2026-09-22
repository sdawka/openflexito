# Creative and microscopy-specific video modes

Research note for `services/video/*`. Scope: what stage + illumination + browser computation can do together during a recording that a plain camera cannot. Numbers assume the IMX219 MJPEG stream (1640×1232, ~18 fps, 8-bit) and a 2–3 frame camera pipeline delay between a command (LED, stage) and the first frame that shows its effect.

## 0. Tagging illumination (and stage) state onto frames

Every interleaved mode below needs to know, per frame, which LED pattern / stage stop the frame was *exposed* under. Three options:

| Approach | Verdict |
|---|---|
| **Luma classification** (current `hdrVideo.ts`) | Works only for a bright/dim pair on a static, mostly-bright scene. Fails for dark-field vs bright-field with a sparse specimen (dark-field is always dark), for left/right oblique (same mean luma by design) and for a moving organism. Keep only as a *validator*. |
| **Fixed latency queue** (`levelLog`, `LATENCY = 2`) | Fragile: pipeline depth varies with exposure time and with dropped MJPEG parts (the browser sees `seq` gaps). Off by one frame and the DPC sign flips. |
| **Timestamp attribution** (recommended) | The device already timestamps everything on `CLOCK_BOOTTIME` and each frame carries `t` (= `SensorTimestamp`, exposure start) and `exposure` in `X-Frame`. Add `t: now_ns()` to the `light` event and to the `light.set` reply (measured *after* the UART/sysfs write returns). The browser keeps a log of `(t, light)` and attributes a frame to the state that held over `[t, t + exposure]`; a frame whose exposure window straddles a switch is **discarded**. No pipeline model needed, immune to dropped frames. Do the same for the stage: `position` events carry `t` and `moving`, so a frame is "settled at stop k" iff `[t, t+exposure]` lies entirely inside a `moving: false` interval at that position. |

Implementation: a small `algo/frameAttrib.ts` (`StateLog<T>` with `push(t, state)` and `stateOver(t0, t1): T | 'ambiguous'`, ring of ~64 entries), fed from `device` events in the service layer and consulted by modes via a new optional `info.light` / `info.settled` on `ModeFrameInfo`. Until the device change lands, fall back to the latency queue and *verify* it with luma where the levels differ.

Consequence for cadence: with an 18 fps stream and a 2–3 frame settle, a 2-channel interleave keeps roughly one usable frame per channel every 3–4 frames, so the output runs at 4–6 fps. To recover rate, hold each state for exactly `hold` frames (default 3) and use the last frame of each hold. If a real LED sync is ever wanted, the Pi's `libcamera` frame-done callback (picamera2 `pre_callback`) can toggle the LED during readout, which brings the interleave to full rate; that is a device change, out of scope for the browser.

## 1. Proposed modes, ranked by value for effort

### 1. Interleaved illumination channels → pseudo-DPC, dark-field/bright-field composite, Rheinberg colour
**Benefit:** phase-like contrast on transparent cells and a coloured dark-field/bright-field composite from the same recording, without optics.
**Hardware:** main CC LED (bright-field), PWM channels driving extra LEDs (left/right or top/bottom oblique, ring dark-field) via `light.set {pwm: [...]}`.
**Algorithm:** cycle states `S = [L, R, (T, B), (BF), (DF)]`, each held `hold` frames; attribute frames per §0; keep per state the newest settled frame `I_s`. Outputs (pick one):
- DPC: `dpc = (I_L − I_R) / (I_L + I_R + ε)` on luma, then `0.5 + gain·dpc` for display (Tian & Waller 2015; the quantitative Tikhonov inversion needs the transfer function of the actual LED geometry, so stop at the qualitative ratio). Two-axis DPC averages the L/R and T/B ratios or shows them as a 2-channel colour.
- Rheinberg: `out = tint_BF · I_BF + tint_DF · I_DF` with user colours (classical blue centre / red annulus); a numerical version of the coloured-stop technique.
- Split/quad view: tile the channels for teaching.
Time compensation: the channels are ~50–150 ms apart, so register `I_R` to `I_L` with `algo/register.ts` before differencing when the specimen moves (skip when the measured shift < 0.3 px).
**Cost:** one pass over the frame per output frame (~10 ms at full res); registration on a 410 px downscale ~5 ms. No reduced-res needed.
**UI:** channel map (which PWM index is L/R/T/B/DF), hold frames (3), output (`dpc-x`, `dpc-xy`, `rheinberg`, `split`), DPC gain (4), Rheinberg tints, AE/AWB lock (mandatory, `cameraLock`).
**Failure:** LED brightness mismatch gives a DC offset in DPC — normalise each channel by its running mean first; specimen faster than the cycle → doubled edges; PWM channel that doesn't change the picture → the luma validator flags "channel dead".
**Stage motion:** user pan → drop all `I_s`, wait one full cycle (mode reads `info.position`, it must *not* rely on `drivesStage` suppression).

### 2. Focus servo (autofocus-maintaining long recordings)
**Benefit:** hour-long recordings of a drifting or crawling specimen stay sharp.
**Algorithm:** every frame compute a focus metric on the live frame at 1/4 res (Brenner or Laplacian variance, `algo/focus`). Two coupled loops:
- *Nudge loop* (default): every `period` s (30) and only in a quiet moment (no `device.moving`, no user RPC in the last 2 s, frame-to-frame difference below a threshold), step z by `+δ`, wait `settle` frames, measure, step `−2δ`, measure, fit a parabola through the three metric values, move to the vertex clamped to `±δ`, with backlash `compensate: "z"` on the final approach. `δ` default 2 steps (≈ half the depth of field at 40×).
- *Passive drift estimate*: between nudges track the metric's slow trend; if it drops >15 % from its post-nudge value, schedule a nudge now.
Also gate the *encoder*: frames captured during a nudge are replaced by the last good frame (`process()` returns the held frame with the new `t`), so the movie never shows the probe.
**Cost:** metric ~2 ms/frame at quarter res.
**UI:** period, δ, max total excursion (clamp ±50 steps, then stop and warn), "hide probe frames".
**Failure:** specimen leaves the field → metric collapses, servo must freeze (metric < 30 % of baseline for 3 s → hold z, show "lost"); mixed-depth scenes have multiple maxima, the ±δ clamp keeps the servo on the current one.
**Stage motion:** user z move → adopt the new z as the setpoint; user xy move → pause 2 s, re-baseline.

### 3. Event-triggered recording with pre-roll
**Benefit:** wait for the paramecium to swim in; the file starts 2 s before it did.
**Algorithm:** ring buffer of the last `preroll` s of *encoded* chunks is impossible with the current single MP4 writer, so buffer decoded RGBA at reduced res (820×616, 2 MB/frame, 3 s = 110 MB) or, cheaper, keep the raw JPEG parts from `api/mjpegStream.ts` in a byte ring (60 KB each, 3 s ≈ 3 MB) and decode them into the encoder when triggered. Trigger = motion energy (mean |Δ| of a 1/8 res luma against an exponential background, threshold `thr`, min area) or a Transformers.js detection class or a blob count change from `algo/tracking.ts`. Record until `quiet` s (3) without a trigger, then close the item and re-arm. Each event becomes a gallery item with `trigger` meta.
**Cost:** ~1 ms/frame for the detector. The JPEG ring route is the right one; the mode needs a hook to receive the un-decoded part, add `acceptRaw?(part)` to `VideoModeRun` or let the recorder own the ring.
**UI:** pre-roll s, quiet s, trigger source, sensitivity, max events.
**Failure:** stage moves and LED changes trigger falsely → suppress while `device.moving` and for 1 s after any `light` event.

### 4. Kymograph (line-scan over time)
**Benefit:** cilia beat, flow in a channel or a growing tip becomes one readable x–t image, live.
**Algorithm:** user draws a polyline on the live view (reuse the measurement tool). Each frame: sample the line with bilinear interpolation into a `L`-pixel row (width `w` averaged perpendicular, default 3 px), append as a new row to a canvas that scrolls; output frame = the kymograph (width `L`, height = `rows`, e.g. 1024) so the *video* is the growing kymograph. Optionally side-by-side with the live frame (`outputSize` w + L). Export also the final kymograph as PNG.
**Cost:** negligible.
**UI:** line, perpendicular width, rows/time span, side-by-side.
**Stage motion:** line is defined in image space; on xy motion translate the line by the CSM-derived shift (`StageShiftTracker`) or mark a red gap row.

### 5. z-projection over time (min / max / range)
**Benefit:** a "photo finish" of everything that passed: max projection shows tracks of bright particles on dark-field, min projection shows dark swimmers on bright-field, range shows activity.
**Algorithm:** per-pixel running `max`/`min` (or both → `range = max − min`) with optional decay `v = max(v·d, x)` so old trails fade (motion trails already exist; this is the non-fading, exact version). Reset on stage motion. Three lines of code beyond `motionModes.ts`; add `mode: 'max' | 'min' | 'range'`.

### 6. Particle count / track overlay
**Benefit:** cells per field and mean speed burned into the frame while recording.
**Algorithm:** `algo/tracking.ts` blobs at 1/4 res, gated nearest-neighbour association, count + mean speed (µm/s via `scaleCal`) + trajectories through `burnIn.ts`; per-frame counts saved as a CSV blob on the item. Mostly plumbing over the tracking service.

### 7. Flight path / panorama video
**Benefit:** a smooth "camera dolly" along a user path across the slide, or a slow orbit at constant z.
**Algorithm:** user picks waypoints (from the scan map). The stage cannot move slowly and smoothly (moves are step bursts; frames during motion are blurred, no strobe), so: step along the path in increments of `≤ 1/8` field of view, wait settled (per §0), take one frame per stop, and *synthesise* the in-between frames by translating/cross-fading the two neighbouring stops using the known stage delta → CSM pixels (`StageShiftTracker`) refined with `algo/register.ts`. `retime()` maps stop index to a constant speed. 18 fps output from ~3 stops/s.
**Cost:** one bilinear translate per output frame.
**UI:** waypoints, speed (fields/s), loop, frames per stop.
**Failure:** backlash on direction reversals → use `compensate: "xy"` at each stop; z variation across the slide → combine with mode 2 (servo). **Whole-slide continuous-motion capture is not viable here**: no strobe, no TDI, 18 fps; this stop-and-synthesise path is the honest version.

### 8. HDR+-style burst merge (temporal Wiener merge on aligned tiles)
**Benefit:** the denoise quality of a 8-frame burst at video rate, no ghosting on movers.
**Algorithm (Hasinoff et al. 2016):** keep the last `N` (8) frames; align each to the current one by tile (16×16 at 1/4 res via `algo/register.ts`, upscaled offsets); merge per 16×16 tile in the DFT domain with weight `A = D²/(D² + c·σ²)` where `D` is the per-frequency difference to the reference and `σ²` from the noise model (`algo/noise.ts`); inverse DFT, overlap-add with raised-cosine windows. Existing temporal denoise is a per-pixel EMA plus stage shift; this handles specimen motion per tile without smearing.
**Cost:** heavy at full res (~200 ms); run in a worker at 820×616 then upsample the *difference* (denoised − input) and add to the full-res frame (guided residual). Output lags by one worker round-trip.
**UI:** N, strength `c`, reduced-res toggle.

### 9. Lucky imaging + drizzle
**Benefit:** the existing lucky mode picks sharp frames; drizzling the picked frames onto a 1.5× grid also recovers sampling.
**Algorithm:** gate frames by sharpness percentile (existing), register with sub-pixel `displacement()`, drizzle with `pixfrac` 0.6 onto 1.5× (reuse `videoSrWorker.ts` with `scale: 1.5`), sliding window `window` (12). Unlike `superres`, do **not** dither the stage: the jitter of a living sample and stage micro-vibration already provide sub-pixel phases; a quality gate on the registration residual rejects blurred frames. Cheapest way to get a second super-res path that works on a moving specimen.

### 10. Live Wiener deconvolution at reduced resolution
**Benefit:** crisper video from a fixed, measured PSF.
**Algorithm:** PSF estimated once from a bead or from the tuning (Gaussian σ fitted to the edge spread of a calibration target; `algo/deconvolve.ts` exists). Per frame at 820×616: FFT (worker, `algo/fftTrack.ts`' FFT), multiply by `H*/(|H|² + K)` with `K` from the noise model, inverse, upsample the sharpening residual to full res as in mode 8. Fixed PSF → precompute the filter once.
**Cost:** two 2-D FFTs of 820×616 per frame ≈ 40 ms in a worker; ~15 fps output.
**Failure:** wrong PSF → ringing; clamp `K` ≥ 0.01 and show the PSF σ on screen. Do not attempt blind deconvolution live.

### 11. TAA-style jittered super-sampling
**Benefit:** anti-aliased, low-noise video at native resolution for a *static* scene, cheaper than `superres`.
**Algorithm:** stage jitter of sub-pixel offsets from a Halton (2,3) sequence (via CSM; requires the calibration, else skip the mode), exponential history `H = 0.1·reproject(I) + 0.9·H` where reprojection uses the *known* stage offset plus a registration correction; neighbourhood clamp (clip the history to the 3×3 min/max of the current frame) rejects ghosting from movers — the standard TAA recipe (Karis, "High Quality Temporal Supersampling", SIGGRAPH 2014). Output size unchanged.
**Cost:** one pass/frame. A cheap sibling of `superres` for when 2× zoom isn't wanted.

## 2. Critique of the existing stage/LED modes

- **No frame attribution.** `StageDither` waits for the move promise and then dwells, but frames exposed during the move are still delivered to the mode. `edof` survives because sharpness selection rejects blurred frames; `sweep` records blur at every stop, and `superres` feeds blurred frames into the drizzle window (the `rejected` restarts). Fix: expose the dither's `index` and a `settled` flag per frame via §0, and let `accept()` drop unsettled frames.
- **`hdr` classification.** Fixed `LATENCY = 2` plus luma thresholds; the running means start from the first frame and are swapped when they cross, so a dark specimen swimming in flips the class. Switching is skipped while a `setLight` promise is pending, so the period drifts and the level log no longer matches. Ghosting: every output fuses the newest frame of each class regardless of age; when the other class is stale by many frames a mover is doubled. Cap staleness (drop when the partner frame is older than `period + 3`).
- **`drivesStage` is overloaded.** It means both "the mode moves the stage" and "never reset me", so `edof` and `superres` never reset when the *user* pans, and the `LiveStacker` smears the old scene into the new one. Modes should compare `info.position` against their own expected offsets and reset on any other change; the recorder should keep resetting the stabiliser on non-pattern motion.
- **`superres` half-pixel pattern.** `Math.round(pixelsToStage(0.5 px))` is 0 or 1 step when the calibration is near 1 px/step, so the pattern degenerates to two states and the sub-pixel phases collapse. Choose the smallest *non-zero* integer step vectors whose pixel image has fractional parts spread over the unit square (or use a Halton sequence of integer steps), and let registration measure the real phase. The 150 ms dwell is also hard-coded and shorter than the 2–3 frame pipeline delay at 18 fps (~170 ms).
- **Dither loop dies silently.** A move error breaks the loop, `error` is only visible in `stats()`, and recording continues without the pattern. Surface it in `status()` and stop the run.
- **Backlash.** Raw moves are fine for a symmetric ±dz dither, but the `sweep` reversal is backlash-visible; use `compensate: "z"` on the turnaround only.
- **Lost focus during xy dither.** `superres` dithers xy for minutes with nothing watching focus; pair it with the servo of mode 2.
- **AE lock** is enforced only for `hdr`; every interleaved-illumination mode and the dithers should lock AE/AWB too (a brightness change at the field edge from the dither is otherwise chased by AE).

## 3. Do not bother

- **Whole-slide continuous-motion video**: needs strobed illumination or TDI (GANscan-style deblurring is a training project). Use stop-and-synthesise (mode 7) or the scan.
- **Ultrasound persistence / speckle filters**: persistence *is* the existing temporal denoise EMA; speckle-reducing anisotropic diffusion targets coherent speckle that an LED microscope does not have.
- **Quantitative DPC phase retrieval**: needs the transfer function of the real LED geometry and NA; the qualitative ratio (mode 1) gives the look with none of the calibration burden.
- **Real-time blind deconvolution or learned deblurring** in TS: too slow, unstable on 8-bit JPEG.
- **Eulerian magnification on stage-driven modes**: the dither is the largest "motion" and swamps the signal.
- **Rheinberg with the single CC LED**: colour composites need at least two spatially distinct light sources; without PWM-driven extra LEDs this is only a LUT.

## Sources

- Tian & Waller, *Quantitative differential phase contrast imaging in an LED array microscope*, Opt. Express 23, 11394 (2015). https://opg.optica.org/oe/fulltext.cfm?uri=oe-23-9-11394
- Hasinoff et al., *Burst photography for HDR and low-light imaging on mobile cameras*, ACM ToG 35(6), 2016. https://dl.acm.org/doi/10.1145/2980179.2980254
- Mobile-phone Rheinberg microscope with an LED array, J. Biomed. Opt. 24(3), 2019. https://www.spiedigitallibrary.org/journals/journal-of-biomedical-optics/volume-24/issue-3/031007/
- Contrast enhancement by oblique illumination with an LED array, Optik 2019. https://www.sciencedirect.com/science/article/abs/pii/S0030402619301858
- Portable low-cost Raspberry Pi microscope with oblique/dark-field/Rheinberg LED ring, HardwareX 2024. https://pmc.ncbi.nlm.nih.gov/articles/PMC11541420/
- Software focus systems and drift correction, Nikon MicroscopyU. https://www.microscopyu.com/applications/live-cell-imaging/correcting-focus-drift-in-live-cell-microscopy
- GANscan: continuous scanning microscopy, Light Sci. Appl. 2022 (why continuous motion needs strobe/deblur). https://www.nature.com/articles/s41377-022-00952-z
- picamera2 issue #1278, exposure not syncing with light control (pipeline delay). https://github.com/raspberrypi/picamera2/issues/1278
- Kymographs in ImageJ (KymographBuilder, Live Kymographer). https://imagej.net/tutorials/generate-and-exploit-kymographs
- Speckle-reducing anisotropic diffusion for ultrasound, IEEE TBME 2002. https://ieeexplore.ieee.org/document/1028423/
- Lucky imaging pipeline and drizzle, AutoStakkert; Fruchter & Hook drizzle. http://www.autostakkert.com/
- Karis, *High Quality Temporal Supersampling*, SIGGRAPH 2014 course.
