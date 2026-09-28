# Wide depth of field from few frames: optical and computational (non-neural) options

Research note for live extended focus (`algo/sweepFuse.ts`, `/edof.bin`, `stage.py#oscillate`).
The question is whether ~4 full-resolution frames per sweep can give a wide depth of field
without a neural network, or with one only as a final touch. Neural fusion is covered in a
separate note.

Tags: **[verified]** means checked against a cited source or this repo. **[estimate]** means
derived here from stated numbers. **[unverified]** means from memory or a vendor claim not
checked. Prices are all **[unverified]**; get a quote first.

---

## 0. The numbers that decide everything

| quantity | value | source |
|---|---|---|
| z step | 0.050 µm/step | `settings.stageStepUm.z` default; Knapper et al. give 50 ± 2 nm per half-step [verified] |
| max z speed | ~1000 steps/s = **50 µm/s** | task brief; the 28BYJ-48 tops out near here [unverified] |
| z backlash (dead band) | 200 steps = **10 µm** (config); OpenFlexure measured 137 ± 19 steps = 6.9 µm | `config.py StageConfig.backlash`; [Knapper et al. 2021](https://arxiv.org/abs/2109.06842) [verified] |
| default leg | 100 useful + 200 dead = 300 steps = 300 ms, so **1/3 duty** and ~3.3 composites/s | `liveEdof.svelte.ts DEFAULTS` [verified] |
| z per frame period | full (40 fps): **1.25 µm**; crop (~95 fps): **0.53 µm** | [estimate] 50 µm/s ÷ fps |
| DOF, 40×/0.65 (λ = 0.55 µm) | λn/NA² ≈ 1.3 µm, plus a pixel term ≈ 0.3–0.55 µm, so **~1.6–1.9 µm** | [estimate], standard formula |
| DOF, other objectives | 100×/1.25 oil ≈ 0.55 µm · 20×/0.4 ≈ 3.5 µm · 10×/0.25 ≈ 9 µm | [estimate] |
| rolling-shutter readout | line time ≈ 3448 px / 182.4 MHz ≈ 19 µs (Linux `imx219` driver constants), so ≈ **9 ms** top-to-bottom at 480 lines and ≈ **23 ms** at 1232 lines | [unverified] from memory of the driver; the observed ~95 fps crop ceiling is consistent with it |

Consequences:

1. **The stage's speed limits the sweep, not the camera.** At 50 µm/s a 40 fps frame spans
   1.25 µm of z, which is less than one 40× depth of field. So four full-mode frames over a 5 µm
   useful sweep already sample z at about the DOF spacing. For a 5 µm deep specimen at 40×,
   **four frames are enough**. They are low-resolution only because the full mode is streamed at
   820×616. They are not too few.
2. Crop mode samples z about 3× finer than needed at 40×. Eleven frames per 100 ms is
   oversampling, because they are spaced 0.45 µm apart against a ~1.7 µm DOF.
3. **Backlash is the largest waste.** Two-thirds of every leg is dead band. Halving the dead
   band roughly doubles the composite rate in either mode.
4. Rolling shutter tilts each frame in z by velocity × readout: ≈ 0.45 µm (crop) and ≈ 1.2 µm
   (full) from top to bottom [estimate]. In full mode that is almost one DOF. Argmax fusion does
   not care, but anything that assigns one z to a frame (depth maps, deconvolution kernels chosen
   by z) should use `z(t_frame + row · t_line)`.

---

## 1. Focal-sweep imaging (Häusler 1972; Nagahara, Kuthirummal, Zhou and Nayar 2008)

**Principle.** Move focus through the specimen *during* the exposure. Every depth that the sweep
crosses integrates to nearly the same integrated PSF (IPSF). One known kernel then deconvolves the
whole image, whatever the depth. Häusler did this in a microscope in 1972 by translating the
specimen along the axis during exposure, then filtering
([Häusler, Opt. Commun. 6(1):38–42, 1972](https://doi.org/10.1016/0030-4018(72)90243-X), summarised in
[arXiv 1010.4500](https://arxiv.org/pdf/1010.4500)) [verified]. Nagahara et al. swept the sensor instead
and deconvolved with Wiener, or with Dabov's Wiener+BM3D. They report that the IPSF is nearly
invariant to both depth and image position. As an example, an f/1.4 EDOF camera "has the SNR of a
normal camera with f/2.8, but produces the DOF of a normal camera with f/8"
([ECCV 2008 PDF](https://cave.cs.columbia.edu/Statics/publications/pdfs/Nagahara_ECCV08.pdf),
[PAMI version](http://www.cs.columbia.edu/~sujit/PAMI.pdf)) [verified]. Two details from the paper
matter directly here:
- *"we have … captured extended DOF video by moving the detector forward one frame, backward the
  next … (the IPSF is invariant to the direction of motion)"*. That is exactly our triangle
  oscillation [verified].
- Limitations: they did not model occlusions or object motion. *"motion blur due to high-speed
  objects can be expected to cause problems … neither of the objects are imaged in perfect focus"*
  [verified].

The same method is used in microscopy with an ETL instead of a moving stage. A current ramp inside
one exposure gives an "order of magnitude improvement in speed and light dose" over a z-stack
([EDF-RIM, Light Sci. Appl. 2024](https://www.nature.com/articles/s41377-024-01612-0)) [verified from abstract].

### Feasibility here

**Case A: one exposure per leg (true focal sweep).** Sweeping the 5 µm useful range at 50 µm/s
takes 100 ms, so the exposure must be about 100 ms. The camera must run at the leg rate (~3 fps),
and **the exposure must be phase-locked to the moving part of the leg**. The IMX219 on the Pi has
no external trigger. The device would have to time each `mr` from the frame-start timestamps
(next SOF ≈ last `SensorTimestamp` + frame duration − serial latency − dead-band time). That is
control-plane code, so it fits the "Pi only relays" rule, but it is new timing-sensitive code.
Serial-latency jitter is an open question [unverified].

Without phase lock, an exposure that covers a whole leg also integrates the 200-step dwell at the
leg's start z. That adds a sharp in-focus image of one plane to the sweep, so the IPSF becomes
depth-dependent again and one kernel no longer fits every depth. **So Case A needs either the
phase lock or near-zero backlash (section 5).**

Its one real advantage is bandwidth. You get one frame per composite instead of 4–11, so the
stream could carry **1640×1232** (or larger) frames at ~3 fps inside the MJPEG and Wi-Fi budget,
where 40 fps full-resolution streaming does not fit. [estimate]

**Case B: exposure = frame period during the sweep ("sweep-integrated slices").** Today the
exposure is ~718 µs, so each frame freezes one z plane and the gaps between frames are unsampled.
With the exposure set to the frame period (25 ms in full mode), each frame integrates a contiguous
1.25 µm of z. The four frames then **tile the useful range with no gaps**, and each frame has about
twice the DOF of a frozen frame. Argmax fusion keeps working unchanged, and no depth falls between
frames. Costs:
- specimen motion blur over 25 ms, e.g. 2.5 µm for something swimming at 100 µm/s;
- LED brightness down by ~35× (the LED is dimmable, and a lower gain gives lower noise).
This is a configuration change (exposure, LED level) plus exposure-aware z bookkeeping in the
worker. **This is the cheapest real gain available.** [estimate]

**Case C: digital focal sweep.** Summing the N frames of a leg gives the same image as one long
exposure. In the shot-noise-limited brightfield regime it has about the same SNR; read noise is
added N times, which is negligible at brightfield light levels [estimate]. Then Wiener-deconvolve
with the IPSF. This needs no hardware or timing work and can run on today's frames. Compared with
argmax:
- **+** no block seams, no per-block flicker, no flat-block heuristics. Every depth in the swept
  range comes back at once, as a linear, photometrically honest result.
- **−** a fixed contrast/noise penalty (Nagahara: about a 2-stop SNR loss for about a 5-stop DOF
  gain), mild ringing, and no depth map.
- **−** moving specimens *smear* over the whole leg instead of appearing once where they were at
  the reference time. The motion gate in `sweepFuse.ts` exists to prevent this. **Argmax + gate
  remains the right default for moving specimens. Focal sweep suits static, stained specimens.**
- **− brightfield phase objects.** This is reasoning, not a cited result. Unstained cells get their
  brightfield contrast from defocus, and the contrast reverses sign on either side of focus
  (transport-of-intensity). A sweep that is symmetric about the object cancels that contrast to
  first order, so transparent specimens can look *flatter* after a focal sweep. Argmax, by
  contrast, happily picks the slightly defocused frame with strong phase contrast. The IPSF model
  also assumes incoherent linear imaging, which partially coherent brightfield only approximates.
  Stained or absorbing specimens are fine. **Test this on real unstained specimens before
  investing.**

### Deconvolution in this repo

`algo/deconvolve.ts` has `wiener(img, psf, psfSize, noise)` and `richardsonLucy(…)`, and both take
**any PSF array** [verified]. Only `makePsf` is limited, to box + Gaussian terms. What is missing is
an IPSF generator. In the geometric approximation, a sweep of ±D gives blur-disc radii from 0 to
r_max = D·tan(asin(NA/n)). Integrating disc PSFs of radius r(z) over the sweep gives a kernel that
falls off roughly as 1/r out to r_max, with a smooth, zero-free OTF. The zero-free OTF is why Wiener
works here, whereas a single defocus disc has OTF zeros. The kernel should be convolved with the
existing Gaussian/pixel terms. It can also be **measured**: take a digital focal sweep of a
sub-resolution bead or a sharp edge. Cost: `wiener` pads to `nextPow2`, so 1640×1232 becomes 2048²
complex FFTs per channel, which is roughly 0.5–2 s in JS [unverified]. That is fine for a
"develop the composite" button, not per composite live. 820×616 (1024²) should be ~4× cheaper.

**Ranked place:** Case B first (nearly free). Case C as an optional *static* output mode (medium
effort). Case A only after backlash is fixed or the phase lock exists.

---

## 2. Few frames at known z: depth-from-focus, and hybrids with sweep frames

- **Sub-frame depth from 3 samples.** Per block, fit a parabola or Gaussian to log(focus energy)
  over the three frames around the argmax. This gives z to a fraction of the frame spacing
  (classic depth-from-focus interpolation; e.g. Nayar and Nakagawa's shape-from-focus). z per frame
  is already known from timestamps (plus the rolling-shutter row term in section 0). This gives a
  continuous height map from 4 frames at little cost. [estimate]
- **"Nearest frame + depth-aware deblur."** For each block, take the nearest frame and remove the
  residual defocus Δz = z_block − z_frame with a spatially varying Wiener kernel. **This only pays
  when frames are sparser than the DOF.** At 1.25 µm spacing with a ~1.7 µm DOF, the residual is
  ≤ 0.6 µm and within the DOF, so there is nothing to recover. With frozen short exposures and wider
  spacing, the residual kernel is a defocus disc whose OTF has zeros, so detail near those zeros is
  gone for good. [estimate]
- **The hybrid that does help: sweep-integrated slices (Case B) + per-slice IPSF deconvolution.**
  If each frame integrates its own 1/N of the range, then each slice's PSF is a small IPSF with no
  OTF zeros. Picking the best slice per block and deconvolving with that slice's IPSF extends
  each frame's DOF without ghosting, because each block still comes from one frame. The catch is
  speed. Making 4 frames cover 20 µm in 100 ms needs 200 µm/s (4000 steps/s), which is 4× the
  stepper limit. **With the stepper this hybrid is limited to 1.25 µm per frame, which already
  matches the DOF at 40×. It becomes useful only with a faster focus actuator (section 3), or at
  100× where 1.25 µm is about 2 DOFs.** [estimate]
- **Answer to the "4 frames + DLSS" question:** physically, four 40 fps frames already cover about
  5 µm at 40× with no gaps if the exposure is long. The limit is per-frame resolution (streamed at
  820×616) and the stage speed. It is not a shortage of frames. A network adds most as a
  denoiser, super-resolver or deringer on top of an optically complete composite. It cannot
  replace depth information that was never recorded, as with frozen frames spaced wider than the
  DOF.

---

## 3. Cheap optical add-ons

### 3a. Lower the NA: stop down the illumination and/or the objective. Cost ~$0 (printed stop), effort S

DOF ∝ 1/NA². Lateral resolution ∝ 1/NA. **The stream is probably not resolution-limited by the
objective.** If the usual OpenFlexure high-res optics are RMS 40×/0.65 + a 50 mm tube lens + a Pi
camera v2 [unverified], sampling is ≈ 0.09 µm/px at full sensor resolution, 0.18 at 1640, and
**≈ 0.36 µm/px at 820** [estimate: 1.12 µm pixel ÷ ~12.5× magnification]. The Abbe limit at 0.65 NA is
≈ 0.42 µm, and Nyquist for it is ≈ 0.21 µm/px. So the 820-wide stream cannot show the full 0.65 NA
anyway. Stopping the objective down to NA ≈ 0.45 would cost nothing visible at 820 px and gives
(0.65/0.45)² ≈ **2.1× the DOF** [estimate].
- Objective NA: an iris or printed annular stop right behind the RMS objective, near its back
  focal plane. The BFP is inside the barrel, so a stop behind it also vignettes the field edges
  somewhat. Resolution at 1640/full-res captures drops too, so the stop should be removable.
- Condenser / illumination NA: a smaller LED emitter or a condenser iris. In brightfield this
  increases apparent depth and *increases* phase-object contrast, which suits unstained specimens.
  It costs resolution and adds coherent-edge ringing. Easy to try first.
- Or simply use a lower-magnification objective: 20×/0.4 has about twice the DOF of 40×/0.65.
**Ranked high: no code, reversible, a guaranteed gain.** Measure the gain with the existing fine
stack on a tilted target.

### 3b. Electrically tunable lens (ETL). Cost $$$, effort L, largest gain

- **Optotune EL-10-30** (10 mm aperture, 0–300 mA, response in milliseconds) and **EL-16-40-TC**
  (16 mm, −10…+10 dpt, 5 ms response / 25 ms settle)
  ([EL-10-30 datasheet](https://archive.optotune.com/images/products/Optotune%20EL-10-30.pdf),
  [EL-16-40-TC](https://www.optotune.com/product/el-16-40-tc/),
  [Optotune microscopy note](https://www.optotune.com/focus-tunable-lenses-for-microscopy/)) [verified specs].
  Price is roughly US$500–1,500 for the lens, plus a driver (Optotune's USB driver, or a DIY
  current source driven from a Sangaboard PWM output) [unverified].
- Cheaper electrowetting options: **Corning Varioptic** (e.g. A-16/A-39/A-58N; 15 dpt range on the
  A-58N) ([Corning microscopy white paper](https://www.corning.com/emea/en/products/advanced-optics/product-materials/corning-varioptic-lenses/resources/white-paper-microscopy.html),
  [Edmund listing](https://www.edmundoptics.com/f/corning-varioptic-variable-focus-liquid-lenses/15042/)).
  These are about US$100–400 with a driver board, and slower, with tens-of-ms steps [unverified].
- **Placement.** The standard design is a 4f relay with the ETL conjugate to the objective's back
  focal plane, which keeps magnification constant
  ([ETL 3D microscope, PMC11154282](https://pmc.ncbi.nlm.nih.gov/articles/PMC11154282/);
  [J Cell Sci review](https://journals.biologists.com/jcs/article/134/16/jcs258650/271866/Electrically-tunable-lenses-eliminating-mechanical)) [verified].
  A relay does not fit the current optics module; it needs a new, longer optics tube (printed). A
  weak ETL directly behind the objective is simpler. Object-side focus shift ≈ P·f_obj²: with
  f_obj ≈ 4 mm, **±1 dpt ≈ ±16 µm** [estimate]. That is ample range with tiny drive currents, but
  magnification changes with focus (a small per-frame scale change that `align.ts` does not model).
- **What it buys.** No backlash, no 50 µm/s limit, sinusoidal or triangular sweeps at 20–50 Hz. A
  **true focal sweep inside every 25 ms full-resolution frame** becomes possible: 40 fps of IPSF
  frames for deconvolution, or four ¼-range slices per 100 ms for the hybrid in section 2. Settling
  time does not matter for continuous sweeps, only the lens's bandwidth does.
- **Community:** no OpenFlexure ETL build found (forum and web searches) [unverified absence].
  Budget design and printing time accordingly.

### 3c. Sensor-side sweep (Nagahara's original method). Cost ~$10–30, effort M–L, experimental

Object-space focus shift = image-side shift ÷ M² (longitudinal magnification). At M ≈ 12.5
[unverified], **5 µm in the sample is ≈ 0.8 mm of sensor travel** [estimate]. A small voice coil
(speaker, VCM) moving the camera board, or the tube lens, ±0.5 mm at 10–40 Hz is mechanically easy
and has no gear backlash. Magnification changes by ≈ Δ/v (≈ 1–2 %, so several px at the frame
edge [estimate]), which the fusion would have to correct. The Pi Camera Module 3 has a built-in lens
VCM, but OpenFlexure removes the camera lens in its high-res optics, and CM3 support in OpenFlexure
was pending
([OpenFlexure forum, CM3 thread](https://openflexure.discourse.group/t/new-autofocus-camera-modules-raspberry-pi-camera-module-3/1125)) [verified].
It would also mean changing sensors from the IMX219.

### 3d. Wavefront coding (cubic phase mask). Not recommended

A cubic phase plate in the pupil makes the PSF nearly defocus-invariant; you then deconvolve
([Dowski & Cathey, Appl. Opt. 1995](https://graphics.stanford.edu/courses/cs448a-06-winter/dowski-wavefront-coding-optics95.pdf);
[high-NA fluorescence version, Arnison et al.](https://graphics.stanford.edu/courses/cs448a-06-winter/arnison-wavefront-microscopy-edf02.pdf);
[cubic plate on a lens surface, 2021](https://www.sciencedirect.com/science/article/pii/S2666950121000559)) [verified].
It is a poor fit here:
- the mask must sit at the pupil, and the RMS objective's BFP is inside the barrel;
- custom freeform plates are expensive, and no cheap printed version was found;
- it assumes incoherent imaging, which partially coherent brightfield breaks;
- it costs SNR and contrast just like the focal sweep, but is fixed in hardware.
The focal sweep (section 1) gets the same depth-invariant PSF in software, from motion we
already have.

### 3e. Axicon / Bessel detection. Not recommended

An axicon gives a long focal line, but the Bessel side lobes carry most of the energy. In
widefield brightfield detection that means a low-contrast haze. Axicons are used in illumination
(light-sheet, 2-photon), not in widefield detection. [unverified, general optics]

### 3f. Chromatic / angular multiplexing with LEDs. Cheap (~$5), effort M, research-grade

- *Spectral focal sweep*: axial chromatic aberration puts each colour at a different focus
  ([Cossairt & Nayar, ICCP 2010](https://www.researchgate.net/publication/224177318_Spectral_Focal_Sweep_Extended_depth_of_field_from_chromatic_aberrations)) [verified title].
  With narrowband R/G/B LEDs on the Sangaboard PWM channels (`light.set {pwm}`), one Bayer frame
  would hold three planes, offset by the objective's residual chromatic focal shift. For
  achromats that shift is likely ~1–2 µm [unverified; measure it with the existing stack]. This
  works only for specimens without colour of their own.
- *Angled illumination*: an off-axis LED shifts the image laterally in proportion to defocus, so
  two colour-coded angles give a depth cue per block from one frame. That could steer the fusion,
  or a sparse sweep. The full version is LED-array Fourier ptychography with digital refocusing
  ([Claveau et al. 2020](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC6968739/);
  [Pi-camera FPM, Aidukas et al. 2019](https://www.nature.com/articles/s41598-019-43845-9);
  [fast refocusing FPM](https://arxiv.org/pdf/2104.06580)) [verified]. It is computationally
  heavy and needs tens of frames, so it is not live; mention only.

---

## 4. Structured capture: brief feasibility

- **Light-field (microlens array at the image plane).** Lateral resolution is divided by the
  number of angular samples: with 10×10 px per lenslet the 3280×2464 sensor becomes about 328×246
  spatial samples. MLAs cost about $100–500 [unverified]. Fourier light-field designs do better but
  still divide resolution. **Not worth it**: it gives up exactly the resolution the user wants
  more of.
- **Multi-camera.** The Pi 3B+ has one CSI port, so a second sensor means a second Pi and sync.
  **No.**
- **Image splitter, two focal planes on one sensor.** A beamsplitter plus a mirror with a small
  path difference puts two planes side by side on the IMX219, as in multi-focal-plane microscopy.
  This gives simultaneous capture with no motion at half the field of view. Optics about $50–150
  [unverified], plus substantial printed-mount work. Of the structured options it is the only one
  worth a prototype, for fast-moving specimens where any sequential sweep ghosts.

---

## 5. Cutting the backlash cost

The 200-step dead band is 2/3 of every leg (section 0). Options:

- **Measure it instead of padding it (software, effort S).** `suggestBacklash` in `sweepFuse.ts`
  and `liveEdof.backlashEstimate` already estimate the dead band from a static scene [verified].
  OpenFlexure's own measurement was 137 ± 19 steps (Knapper et al.), not 200. Using the measured
  value, e.g. 140, raises duty from 33 % to 42 % at range 100, which is about 25 % more composites
  per second. [estimate]
- **Longer useful range per reversal (software, S).** For static or slow specimens, a range of 300
  with the same dead band gives 60 % duty. Each composite then covers 15 µm. This trades
  composite rate for depth, not waste for depth.
- **Sawtooth / unidirectional sweeps: no gain.** The stepper's return leg is no faster than the
  sweep leg, and both reversals still pay the dead band. A sawtooth only makes every composite
  share one direction, which is useful if up and down legs show different z offsets or hysteresis.
  Triangle legs are already direction-invariant for a focal sweep (Nagahara) [verified].
- **Resonant sweeps: not with this actuator.** The 0.5 mm-pitch lead screw is self-locking, so
  there is no mechanical resonance to drive. A resonant sweep needs a separate actuator in
  series: a piezo disc bender or voice coil under the slide or objective, or the sensor-side coil
  in 3c. With the stepper holding the mean focus, a small fast actuator could supply ±5 µm at tens
  of Hz with **zero dead band**. This is the cheapest route to "ETL-like" behaviour. Piezo-disc
  stroke and load capacity at this scale are [unverified]; a quick bench test is needed.
- **Mechanical preload of the gear train (hardware, S–M, cheap).** OpenFlexure actuators already
  preload the nut against the screw with an elastic band / O-ring. The backlash that remains is in
  the 28BYJ-48 gearbox and the printed gears. Because the screw is self-locking, that nut preload
  never reaches them. A **constant torque on the lead-screw gear**, from a torsion spring or an
  elastic band wrapped on the gear hub, would keep every mesh on one flank in both directions. The
  sweep spans only a fraction of a turn, so the spring torque stays nearly constant, and the
  motor's torque margin should cover it. Printed split anti-backlash gears are the alternative.
  Expected dead band: the gearbox's own few-to-tens of steps instead of ~140–200 [unverified: one
  28BYJ-48 report is ~11–12 steps,
  [MobiFlight forum](https://www.mobiflight.com/forum/topic/1873.html)]. If that holds, duty rises
  from 33 % to about 85 % and composites per second rise ~2.5× in both modes. **This also unlocks
  Case A (one long exposure per leg) without the phase lock.**
- **Use the dead band anyway.** During the dead band the stage sits still at the leg's end z. Those
  frames are a free, frozen, extra-sharp sample of the end planes. The fusion already tolerates
  them, so there is nothing to gain, but nothing is lost either.

---

## 6. Ranking for this hardware

Gain is judged against today's crop-mode argmax at 40×.

| # | option | effort | cost | expected gain | notes |
|---|---|---|---|---|---|
| 1 | **Exposure ≈ frame period during the sweep** (Case B), LED dimmed, rolling-shutter-aware z per row | S (config + worker bookkeeping) | $0 | gapless z coverage; each frame ~2× DOF; full-mode 4-frame composites stop missing planes | motion blur over one frame period; keep a short-exposure option for fast swimmers |
| 2 | **Lower NA**: condenser/LED aperture first, removable objective stop, or a 20× objective | S | ~$0–5 | ~2× DOF with no visible loss at the 820-wide stream (if the sampling estimate holds) | loses resolution in full-res stills unless removed |
| 3 | **Measured backlash + gear-train torsion preload** | S (software) + S–M (print) | ~$1 | 25 % (software) to ~2.5× (preload) more composites/s | preload value [unverified]; bench-test on one actuator |
| 4 | **Digital focal sweep + IPSF Wiener** (Case C) as a "static specimen" output | M (IPSF generator; `wiener` exists) | $0 | seamless composites without flicker or seams; no depth map | smears moving specimens; test on unstained phase objects first |
| 5 | **Fast secondary focus actuator** (piezo disc or voice coil on sensor/objective) with the stepper for coarse z | M–L | $10–30 | zero dead band; per-frame focal sweep at 40 fps | experimental; magnification change if the sensor moves |
| 6 | **ETL** (Optotune EL-10-30/16-40, or Varioptic) | L (new optics tube, driver) | $150–1,500+ | largest: backlash-free 20–50 Hz sweeps, true focal sweep per full-res frame, 1640×1232 EDOF video | no OpenFlexure build found; price [unverified] |
| 7 | One long exposure per leg, phase-locked (Case A) | M–L (device timing) | $0 | full-res composites at ~3/s within bandwidth | only after #3 or with a reliable phase lock |
| 8 | Two-plane image splitter | L | $50–150 | simultaneous 2 planes, no motion ghosts | halves the FOV |
| 9 | RGB/angled-LED multiplexing | M | ~$5 | depth cue or extra planes per frame | research; confounded by specimen colour |
| 10 | Wavefront coding · axicon · light-field MLA · multi-camera | L | $$ | poor for this microscope | see sections 3d, 3e and 4 |

**Suggested path:** #1 and #2 now (both nearly free and measurable with the existing fine stack
and a tilted target). Then #3's software half, and bench-test the preload. Prototype #4 on
recorded legs, which needs no device change. Decide between #5 and #6 only if backlash-free,
video-rate EDOF at full resolution becomes a goal.

---

## Open questions to measure on the real Pi

1. The real dead band from `suggestBacklash` in both sweep directions: is it closer to 137 or 200?
2. The IMX219 line time in both fast modes (libcamera `SensorTimestamp` vs. row, or the
   `LineLength` controls), to confirm the rolling-shutter z tilt.
3. µm/px of the actual optics, which confirms or rejects the NA-headroom argument in 3a.
4. Axial chromatic focal shift between R, G and B LEDs (for 3f).
5. Whether a digital focal sweep of unstained cells loses contrast, as predicted in section 1.
