# Video signal quality: review and proposals

Scope: noise, resolution/binning and exposure integration for recordings of the Pi's MJPEG stream
(1640×1232, ~18 fps, 8-bit, ISP-processed, gamma-encoded, 4:2:0 chroma). Reviewed:
`algo/{videoStack,binning,temporalDenoise,deflicker,stabilize}.ts`, `services/video/{stackModes,hdrVideo,types}.ts`,
`services/denoiseProcessor.ts`, the recorder's per-frame path.

## What the input allows (be honest)

- **The frames are display-referred 8-bit JPEG, not sensor data.** The ISP has already done black level,
  lens shading, demosaic, spatial denoise, gamma and 4:2:0 chroma subsampling; JPEG then quantises 8×8 DCT
  blocks. What is left to remove is: residual shot/read noise (signal-dependent in the *encoded* domain, roughly
  σ ∝ L^0.3 not √L), JPEG ringing/blocking, hot pixels at high gain, LED/mains flicker, and illumination
  non-uniformity. Per-pixel sensor statistics (sCMOS-style gain/offset/variance maps, Huang 2013, Mandracchia 2020) are
  meaningless after demosaic + JPEG: noise is spatially correlated across 2–8 px. Use a *per-luma-bin* noise curve
  instead (proposal 1).
- **Averaging recovers sub-LSB tone only where noise dithers the quantiser.** In bright, clean regions the ISP output
  is nearly noise-free per frame and the JPEG quantiser zeroes the same small DCT coefficients in every frame, so N
  frames average to the same posterised value. Low-contrast texture the quantiser removed is gone; averaging cannot
  bring it back. Clipped highlights (255) and crushed blacks are unrecoverable, and averaging in the gamma domain is
  slightly biased at edges (irrelevant for viewing; it matters for measurements, not for us).
- **Any averaged output must be re-quantised with dither**, otherwise the smooth 16-bit mean becomes 8-bit bands
  that the video encoder then amplifies. Add TPDF (triangular) dither of ±0.5 LSB before rounding in every mode that
  averages (`SlidingMean`, `ExpIntegrator`, `TemporalDenoiser`, binning). Cost: one extra add per channel.

Assumption used below: per-frame analogue gain / exposure is available in the stream's frame metadata
(the same `X-Frame` values `fetchSnapshotWithMeta` parses); if not, the noise curve is measured, not predicted.

## Proposals, ranked by value for effort

### 1. Soft Wiener-style temporal merge with a per-pixel count map (replaces the hard 3σ gate)

**Benefit:** the same denoise strength with far less ghosting on swimming organisms and no "frozen noise" in flat
areas; the strength adapts itself to the measured noise instead of a fixed α.

**Algorithm** (HDR+ pairwise merge, Hasinoff et al. 2016, applied recursively per pixel instead of per DCT tile):

```
d      = Y_cur - Y_warpedHistory                     // luma difference
σ²(Y)  = noiseCurve[Y_cur >> 4]                      // 16-bin curve, see below
s      = c·σ² / (d² + c·σ²)                          // shrinkage in [0,1]; c = 4 default ("robustness")
n_i    = min(N_max, s · n_i + 1)                     // per-pixel effective frame count (Float32 or Uint8/16 map)
a      = s · (1 - 1/n_i)                             // history weight; →0 on motion, →(1-1/N_max) when static
out    = a·history + (1-a)·cur  (all three channels, same a)
```

Noise curve: every 8th frame, in pixels where s > 0.9 last frame, accumulate d² into 16 luma bins;
σ²[bin] = 0.5·mean(d²) (the difference of two frames has twice the variance, and the history is cleaner, so use
0.5–0.7). Seed from `estimateSigmaMad` once. `N_max` is the user's "strength" (8 default, 4–32); `c` exposed as
"motion sensitivity" (2 = cautious, 8 = smooth). Per-pixel counts give 1/n warm-up after any local reset, so a pixel
that was just occluded rebuilds its average in a few frames instead of restarting at α.

**Cost:** one pass, ~6 flops/px plus the warp: ~12 ms at full res without warp, ~25 ms with the bilinear warp.
Skip the warp entirely when |dx|,|dy| < 0.05 px (the common case); use nearest-neighbour warp for integer shifts.
Downsampling: none needed; the `s` map may be computed at 1/2 res and bilinearly upsampled (like `hdrVideo`'s coarse
weights) to save 30%.

**UI:** strength (N_max), motion sensitivity (c). **Failure modes:** a slow-drifting organism with |d| ≈ σ smears
(mitigate with a 3×3 box on d² before the shrinkage: motion detection on a patch, not a pixel, which is also what
hqdn3d and broadcast DNR do). Stage move: warp by the known shift; do **not** reset (see critique 1).
**Reset:** stream reconnect and `maxShiftPx` overrun → history = cur, n = 1 everywhere.

### 2. Luma/chroma split: strong chroma denoise at half resolution

**Benefit:** most visible video noise on the Pi is colour speckle; chroma is already 4:2:0 in the JPEG, so denoising
it at half resolution loses nothing and costs a quarter.

**Algorithm:** convert to Y, Cb, Cr (BT.601 integer coefficients). Run proposal 1 on Y at full res with N_max, and on
Cb/Cr at half res with a 2–4× higher N_max and c (chroma rarely carries motion information). Then a fast guided filter
on Cb/Cr (proposal 3) with the *luma* as guide, radius 4, ε = (2σ)². Recombine. Applies to `TemporalDenoiser`,
`ExpIntegrator` and `SlidingMean` alike.

**Cost:** YCbCr conversion ~4 ms; chroma path is ¼ of luma. Net ~+5 ms over proposal 1.
**UI:** none new (chroma strength = 3× luma internally). **Failure:** coloured organisms moving over a differently
coloured background bleed colour for a frame or two at high chroma N_max; capped by keeping chroma c ≤ 2·luma c.
**Reset:** as proposal 1.

### 3. Fast guided filter as the spatial stage (replace `spatial: DenoiseParams`)

**Benefit:** a real-time edge-preserving spatial denoiser for the live path; the current `spatial` option calls
`denoiseRgb` (allocates 3 float planes per frame, wavelet/NLM) and is unusable at 18 fps.

**Algorithm:** He & Sun, *Fast Guided Filter* (arXiv 1505.00996): compute the guided-filter coefficients a, b on the
image subsampled by s = 4 (box filters via integral images or running sums, radius r/s), upsample a, b bilinearly and
apply `q = a·I + b` at full res. Self-guided on luma; ε = k·σ²(Y) from proposal 1's curve, k = 1–4. Apply *before* the
temporal blend on the current frame with a light ε, or after it on the output with ε scaled by 1/n (only where the
temporal filter could not average).

**Cost:** O(N/s²) for the statistics (~2 ms at s = 4) + one pass to apply (~5 ms). **UI:** spatial strength 0–3.
**Failure:** fine texture below σ is flattened (it is noise-indistinguishable anyway). **Reset:** stateless.

### 4. Bin + upscale, separate luma/chroma factors, dithered

**Benefit:** the binned recording keeps the source frame size, so the scale bar, CSM calibration, measurement and
gallery overlays stay valid; chroma can be binned harder than luma for free.

**Algorithm:** bin luma by f_Y (2), chroma by f_C = 2·f_Y (4) using box sums; add TPDF dither and round; either
emit the small frame (today's behaviour, optional) or upsample back with bilinear (luma) / bicubic (chroma) so output
= source size. Fix the `edge` kernel reference: compare block pixels to the block *median* or mean, not the pixel at
`factor >> 1` (for factor 2 that is the bottom-right pixel, which biases every block). Accumulate sums as integers
(exact), divide once.

**Cost:** box binning ~8 ms; upsampling ~10 ms; edge kernel ×2 (avoid `Math.exp` with a 256-entry LUT on |d|).
**UI:** factor, keep-size toggle, kernel. **Failure:** none for motion; resolution loss is the point.
**Reset:** stateless.

### 5. Exposure-locked integration with gain normalisation

**Benefit:** long exposure and denoise modes stop pulsing when AE/AWB re-converges (an organism entering, LED drift),
and the mean of N frames really is a longer exposure rather than a mix of gains.

**Algorithm:** at `start()` of `integrate`, `denoise`, `median`, `lucky`, call `lockCamera({ ae: true, awb: true })`
(the same lock the photo modes use) and release on stop. If lock is unavailable, weight each incoming frame by
g_ref / g_frame from metadata before accumulating (only valid in the linear part; apply as a gamma-domain gain
(g_ref/g_frame)^(1/2.2), same trick `Deflicker` already relies on). Keep `SlidingMean`'s sum but add a second
"exposure-weighted count" so partial windows stay unbiased.

**Cost:** nil. **UI:** "lock exposure while recording" (default on). **Failure:** a lock that fails silently leaves
today's behaviour. **Reset:** re-lock after reconnect.

### 6. Lucky imaging that actually stacks, with a noise-robust metric

**Benefit:** the current mode only *drops* frames (a jerky lower-rate video). Real lucky imaging stacks the keepers:
sharp *and* clean output at a steady rate.

**Algorithm:** metric = mean of |∇| (Sobel or Roberts) of a 3×3 box-filtered luma at stride 2, divided by the mean
luma (exposure-invariant), i.e. AutoStakkert's "Gradient" (its Laplacian variant is documented as noise-prone; ours
is worse since it uses stride-2 taps on unfiltered luma, so noisier frames rank *sharper*). Optionally per-tile
(4×3 tiles) with a local percentile, like multi-point alignment in PlanetarySystemStacker. Output = proposal 1's
recursive merge fed only by kept frames, with the last output repeated for dropped frames (constant fps) or dropped
(current behaviour, `E2E`-compatible), user choice.

**Cost:** metric ~3 ms; merge as proposal 1. **UI:** keep fraction (0.4 default → 0.5), "fill dropped frames".
**Failure:** a fast organism makes every frame "sharp" where it is and blurry elsewhere; per-tile scoring handles
this. **Reset:** score history and merge history cleared on reconnect; on a stage move keep the history (the
percentile is scale-free) but reset the merge.

### 7. Live flat-field / dust division (and optional dark frame)

**Benefit:** even illumination and no dust shadows in the video, at zero per-frame maths beyond a multiply.

**Algorithm:** the user records a reference on a blank field: mean of 32 frames (proposal 5 lock on) → F; optional
dark D = mean of 32 frames LED off (only worth it above ~4× analogue gain). Gain map
G = clamp((mean(F−D)) / (F−D), 0.5, 4) as Uint16 Q8.8 per channel, blurred 8 px so JPEG blocks in F do not print
through. Per frame: out = D + (cur − D)·G. Reuse the measured `algo/flatField.ts` product when one exists.
**Cost:** ~5 ms. **UI:** capture reference, enable, strength (blend G toward 1). **Failure:** any LED/AE change after
capture makes G wrong (the lock and a "reference stale" warning when frame gain differs from the reference's).
Stage moves are irrelevant (G is fixed to the camera). **Reset:** none; G persists in IndexedDB per LED level.

### 8. Motion-adaptive temporal median (cheaper and colour-safe)

**Benefit:** the same hot-pixel/glitch rejection at a third of the cost and without colour fringes.

**Algorithm:** compute the median *index* on luma only (3- or 5-frame network), then copy that frame's RGB; skip the
alpha channel entirely (today's loops process all four channels). For n = 5 use the 7-comparator median network
instead of an insertion sort. Blend: out = median where |cur − median| > 2σ else cur (so static detail is not
delayed by two frames).

**Cost:** ~15 ms for n = 3 (was ~35), ~30 ms for n = 5 (was ~80+). **Reset:** unchanged.

## (a) Critiques of the existing implementations

1. **Motion compensation is defeated by the reset policy.** The recorder resets every mode when `device.moving`
   flips, and `denoiseProcessor` does the same, so `StageShiftTracker`'s shift is only ever non-zero on the last frame
   of a move. Either add a `compensatesStage` flag to `VideoModeRun` that suppresses the reset for `denoise` (it then
   warps by the known shift, which is the whole point), or drop the shift plumbing. Verify the shift sign against the
   fake camera (1 px/step, 4° rotation): a unit test in `services/video` can check the warped history matches the
   next frame, the docstring currently says "unverified".
2. **`TemporalDenoiser` σ is spatial, should be temporal.** `estimateSigmaMad` on the current frame measures JPEG-
   smoothed texture plus noise; in the encoded domain noise is signal-dependent. Replace with the luma-bin curve from
   |cur − warped| in static pixels (proposal 1). Gate `k = 3` is hard-coded and hard; use the shrinkage. Default
   α = 0.7 is only ~3 frames of averaging; with a soft gate 0.85–0.9 is safe. `warpBilinear` runs even at zero shift
   and resamples the history every frame (cumulative blur under continuous sub-pixel motion): add a zero-shift fast
   path and integer-shift nearest path.
3. **`SlidingMean`/`ExpIntegrator`/`TemporalMedian` loop over alpha** (25% wasted) and output without dither.
   `SlidingMean` uses Float32 sums (exact up to 2^24, fine) but a `Uint32Array` is faster. The `integrate` mode's
   "frames" means window for `mean` and 1/α for `exp`; label them separately. Neither locks AE (proposal 5).
4. **Binning `edge` kernel** references pixel `factor>>1` (off-centre for even factors) and calls `Math.exp` per
   pixel (LUT it). No keep-size option, so calibrations break on the recording (proposal 4).
5. **`QualityGate` metric** is noise-biased and exposure-dependent (proposal 6). `luckyMode` returns the input
   buffer (`{ frame: f }`) although `OutBuffer`'s comment forbids it; copy or document that lucky is exempt.
   The `[...scores].sort()` per frame is fine at 60 entries.
6. **`Deflicker`:** measuring in the gamma domain and applying a gamma-domain gain is consistent, good. Default to
   `usePercentile: true` for recordings (an organism entering the field moves the mean, not the median), and clamp the
   gain's *rate of change* (≤ 5%/frame) so a genuine brightness step is followed rather than fought for 20 frames.
7. **`hdrVideo`:** it is exposure fusion on 8-bit data, not HDR; the well-exposedness σ = 0.2 and 8-px coarse grid are
   sensible. Weight by luma of the *bright* frame only where it is not clipped (b ≥ 250 → weight 0) rather than
   symmetric Gaussians: clipped highlights currently still get some weight.
8. **Pipeline order:** the stabiliser resamples the frame before the denoiser and modes see it, so any residual jitter
   correction adds sub-pixel blur to the history. Acceptable; note it, and turn stabilisation off by default for
   `bin`/`integrate` where averaging already hides jitter.

## (b) Do not bother

- **NLM, BM3D, VBM4D live**: 2.6 s/MP measured for our NLM; a 480p preview would still miss frames. Keep NLM for stills.
- **Deep video denoisers in the browser** (FastDVDnet et al.): ~5 frames of context at full res through ONNX/WebGPU
  on a laptop is >100 ms/frame; and they are trained on Gaussian noise, not ISP+JPEG output.
- **Per-pixel sCMOS gain/offset/variance maps and dark-frame subtraction** on JPEG frames: FPN is below the JPEG
  noise floor after the ISP's black-level and lens-shading correction; only the flat/dust division (7) pays.
- **Bit-depth or dynamic-range recovery by averaging**: see "What the input allows"; sell it as noise reduction only.
- **Full per-pixel Kalman with velocity states**: the count-map recursion (1) is the steady-state Kalman gain for a
  static scene; the extra state buys nothing without per-pixel flow.
- **Dithered binning as a resolution trick**: software dithering does not add information; stage-dither
  super-resolution (existing `superres` mode) is the right tool.
- **Optical-flow motion compensation**: we know the stage shift exactly; organism motion is better handled by
  rejection (1) than by flow that the JPEG noise would corrupt.

## Sources

- Hasinoff et al., "Burst photography for HDR and low-light imaging on mobile cameras", TOG 2016, https://dl.acm.org/doi/10.1145/2980179.2980254 (pairwise Wiener merge, shrinkage `|D|²/(|D|²+cσ²)`).
- He & Sun, "Fast Guided Filter", 2015, https://arxiv.org/abs/1505.00996 (O(N/s²) subsampled coefficients).
- Huang et al., sCMOS-specific localisation, Nat. Methods 2013; Mandracchia et al., "Fast and accurate sCMOS noise correction", 2020, https://pubmed.ncbi.nlm.nih.gov/31901080/ (per-pixel maps only valid on raw sensor data).
- FFmpeg `hqdn3d` docs, https://ayosec.github.io/ffmpeg-filters-docs/8.0/Filters/Video/hqdn3d.html (luma/chroma spatial + temporal strengths, soft difference-dependent blending).
- AutoStakkert quality metrics (Gradient vs Edge), https://starfieldview.com/imaging-and-processing/autostakkert-high-quality-planetary-image-stacking/ ; PlanetarySystemStacker, https://github.com/Rolf-Hempel/PlanetarySystemStacker (multi-point local quality ranking).
- Punchihewa et al., "Effective quantization by averaging and dithering", Measurement 2006, https://www.sciencedirect.com/science/article/abs/pii/S0263224106000601 (averaging only recovers levels the noise dithers).
