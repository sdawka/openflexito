# Video colour, tone and look: research notes

Scope: the live view and the recorder's frame chain (`services/frameChain.ts`, `process(rgba, target, t)`), fed 1640×1232 8-bit sRGB JPEG at ~18 fps from an IMX219 whose AE/AWB can be locked by `services/cameraLock.ts`. Everything below is a `FrameProcessor`; nothing edits StreamView or the recorder.

Budget reminder: one full-res RGBA frame is 2.02 MP / 8.1 MB. A single tight TS pass over it costs ~4–8 ms on a laptop; the 18 fps budget is 55 ms and the look processor already spends part of it. Anything that needs a blur, a histogram per tile or a second pass should measure statistics on a 1/8-scale copy (205×154, 32 k px, <0.3 ms) and apply the result at full resolution as a per-pixel table or a bilinearly upsampled gain map. Rule of thumb used throughout: **measure small, apply big, smooth in time**.

## Honest framing: what 8-bit sRGB JPEG allows

The stream has already been tone-mapped, gamma-encoded, white-balanced and JPEG-quantised on the Pi. Consequences:

- Highlights above 255 are gone. No "roll-off" recovers them; we can only shape the top of the curve so the *approach* to clipping looks gentle, and we can tell the user (zebra) or the camera (lower exposure/LED via RPC) to fix it at source. Real highlight headroom for video means the Pi lowering exposure and the browser lifting midtones, i.e. a deliberate under-exposed capture with a browser tone curve. That is worth doing for LED brightfield where the empty field is a bright uniform disc and is the *only* meaningful "log/flat profile" available on this hardware.
- Filmic/ACES curves are designed for scene-linear input. Applying them to sRGB values after `srgbToLinear` works but each 8-bit input step maps to ≥1 output step near black, so lifts >1.5 stops posterise and JPEG blocking becomes visible. Keep shadow lifts modest (≤ +0.4 in `Levels.gamma` terms) and dither (add ±0.5 LSB triangular noise before quantising) when a 1D curve has slope >2 anywhere.
- A 3D LUT of 33³ on 8-bit input is fine; nothing finer is perceptible.
- Chroma is 4:2:0 subsampled in the JPEG; saturation boosts >1.5 and channel-isolation views show the subsampling as colour bleed on edges. Operate on the luma for anything structural (local contrast, relief, peaking).

## Proposals, ranked by value for effort

### 1. Temporally stable auto-levels (video auto-contrast)

Benefit: brightfield video keeps a consistent black/white without the "pumping" that per-frame `autoLevels` would cause.

Algorithm (per frame, on the 1/8 copy):
1. Luma histogram (256 bins). Percentiles `lo = P(0.5 %)`, `hi = P(99.5 %)`.
2. Target state `(L, H)` follows an asymmetric EMA with deadband:
   `dL = lo - L; L += |dL| < 2 ? 0 : (dL > 0 ? aUp : aDown) * dL`, with `aDown = 0.3` (react fast when the scene gets darker/brighter beyond the current range, to avoid clipping) and `aUp = 0.03` (relax slowly). Same for H with roles swapped (fast when `hi > H`).
3. Scene change: if `|lo - L| > 40` or `|hi - H| > 40` or the histogram intersection with the previous frame `< 0.6`, snap `(L, H) = (lo, hi)`.
4. Stage motion: while `device.moving`, freeze `(L, H)` (do not update), and snap on the first frame after motion ends. A move changes content, not lighting.
5. Build a 256-entry 1D table `y = clamp((x - L) / (H - L))`, optionally with a soft knee over the top 8 % (see 3), apply to R, G, B at full res (one table lookup per channel, ~5 ms).

UI: on/off, strength (mixes table with identity), "protect highlights" (never lifts H above 250). Cost: ≈ 6 ms full res. Failure: a field that is genuinely all-white (empty slide) gets stretched to noise; guard with `H - L < 16 → identity`. This is what OBS's "auto exposure"-style filters and every camera AWB patent do: smooth, deadband, break on scene change ([USPTO 11457191](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11457191)).

### 2. Reference-anchored software white balance

Benefit: the colour of the empty background stays fixed across a recording even when the camera's AWB drifts or was locked at a bad moment, and the user can set "this is white" once.

Algorithm: with the camera AWB locked via `cameraLock`, per frame compute on the 1/8 copy the mean RGB of the brightest 30 % of pixels that are not clipped (>250) — in brightfield that *is* the illuminant. Grey-world on the whole frame is wrong for stained samples (a pink H&E field is not grey). Gains `g_c = ref_c / mean_c` where `ref` is either the first frame after lock ("anchor") or a user-clicked neutral (reuse `services/whiteBalance.svelte.ts`). Smooth gains with EMA `a = 0.05` and clamp to [0.7, 1.4]; freeze during `device.moving`. Apply as a per-channel 1D table so it composes with (1) into one table.

Interplay with the camera lock: this is the *fine* correction; the camera's own colour gains remain the coarse one. Offer "commit to camera" which pushes accumulated gains × current camera gains via `camera.set` and resets the software gains to 1, so the stream itself gets corrected and the browser does nothing. Do not run this while camera AWB is unlocked: two controllers with different time constants oscillate.

Cost: <1 ms measure, folded into (1)'s table. Failure: fluorescence/dark-field has no bright background — auto-disable when the 70th percentile luma < 60. Cited context: temporal smoothing of the white point with light-source change detection is the standard camera approach ([Barron, FFCC](https://arxiv.org/pdf/1611.07596)).

### 3. Video tone curve: soft-knee highlight roll-off + CDL grade

Benefit: LED brightfield backgrounds stop looking like a hard white wall; the user gets the four controls colourists actually use.

ASC CDL per channel: `out = clamp(in * slope + offset) ^ power`, then saturation on luma/chroma ([ASC CDL](https://en.wikipedia.org/wiki/ASC_CDL), [Pomfort](https://pomfort.com/article/an-in-depth-look-at-asc-cdl-based-color-controls/)). Add a soft knee: for `x > k` (default 0.85), `y = k + (1-k) * tanh((x-k)/(1-k))`. Bake all of it into the existing `Look` (levels+curves+mixer already exist; CDL is a friendlier parametrisation of the same 1D+mixer family and should just be a second UI over `bakeAdjustments`). For the full filmic (Narkowicz ACES fit already in `enhance.ts#filmic`) convert to linear first; it is meaningful only when the capture is under-exposed on purpose (see framing). Provide a "Flat capture" preset: sets camera exposure −1 EV via RPC and a browser curve that restores mid-grey, giving ~1 stop of usable highlight headroom in the recording.

Cost: zero extra (bakes into the look table/cube). Failure: powers <0.8 on 8-bit input posterise shadows — dither. Not affected by motion.

### 4. Temporally smoothed CLAHE (local contrast for video)

Benefit: low-contrast unstained or thick samples get the local contrast the stills Enhance panel gives, without tile-flicker.

Algorithm: run CLAHE's histogram stage on a downscaled luma (1/4, 410×308) with 8×8 tiles, 64 bins, clip 2.0. Keep the per-tile *cumulative mapping* `M_t[i]` (64 floats per tile) as state and EMA it: `M ← 0.85 M + 0.15 M_new`. Reset all `M` on scene change (histogram intersection < 0.6) and freeze during `device.moving`. Apply at full res with bilinear interpolation between the four neighbouring tile mappings, on luma only, then recombine with chroma (`rgbToYcbcr` exists). Strength slider mixes with identity. Smoothing the mapping, not the pixels, is the same idea behind scale-time equalisation for deflicker ([BlazeBVD](https://link.springer.com/chapter/10.1007/978-3-031-72643-9_3)).

Cost: histogram 2 ms, full-res apply ≈ 12–15 ms in TS (4 table lookups + lerp per pixel). Worth a WebGL2 pass if it becomes a default: upload the 8×8×64 mapping as a 2D texture and let the fragment shader do the bilinear lookup; then it is free. Failure: JPEG block noise in flat backgrounds gets amplified — clip ≤ 2 and a luma-gradient gate (skip where local variance < threshold). Alternative "clarity": guided filter `out = y + amount * (y - guided(y, r=16, eps=0.01))` on the 1/4 copy upsampled; smoother look, ~8 ms, no tile state. Retinex-lite (`log(y) - log(blur_σ=60(y))`) is the same as proposal 5 in log space; do not ship both.

### 5. Live background flattening

Benefit: uneven LED illumination and dust shadows disappear from the recording; the field looks like a properly Köhler-aligned scope.

Two modes:
- **Reference flat**: user moves to an empty area, presses "capture background" (or the flat is taken from `algo/flatField.ts`). Per channel `out = in * mean(bg) / max(bg, 8)`, precomputed as a full-res gain map (Float32 ×3 or a single luma gain if the tint is uniform), clamped [0.5, 3]. Cost: one multiply per channel, ≈ 5 ms. Exact, no temporal state, robust to motion.
- **Rolling estimate**: Gaussian σ≈80 px of each channel on the 1/8 copy (σ=10 there, three-box approximation, <1 ms), upsampled bilinearly, EMA `a = 0.02`, freeze during motion. Divides out slow illumination; halo on large dark objects because they leak into the estimate. Use max-of-median (rolling-ball style morphological closing on the 1/8 copy) instead of Gaussian to reduce that leak.

UI: mode, strength, "capture background", show-residual. Failure: sample covering the whole field makes the rolling estimate flatten the sample itself — cap the gain map's local range.

### 6. Pseudo-relief (DIC-like) and pseudo-phase views

Benefit: transparent, unstained samples become visible in brightfield video; a well-known trick in cell-culture teaching.

Relief shading: `r = y + k * (y(x+d, y+d) - y(x-d, y-d))` with `d = 1–2 px`, `k ≈ 1.5`, shear angle selectable (45° default); add 128 offset. That is a directional derivative, which is exactly what DIC optically produces ([MicroscopyU](https://www.microscopyu.com/tutorials/comparison-of-phase-contrast-and-dic-microscopy)). Compute on luma after a 3×3 blur to avoid JPEG ringing. Cost ≈ 4 ms. For an "integrated" look (structures rather than edges) apply the directional Hilbert transform: in the frequency domain multiply by `-i·sign(u·cosθ + v·sinθ)`; this is documented as an inversion of DIC's gradient contrast ([Arnison et al.](https://pubmed.ncbi.nlm.nih.gov/10886531/)). FFT at 1/2 res per frame ≈ 20 ms in TS; only worth it as a WebGL2 or opt-in feature.

Pseudo-phase / digital dark-field: high-pass `h = y - blur_σ=8(y)`, display `|h|` scaled (dark-field: background black, edges bright) or `128 + 2h` (phase-like). Cost ≈ 6 ms with the blur at 1/2 res. Motion: none of these carry temporal state; under motion nothing pumps. Failure: dark-field view amplifies noise and JPEG artefacts; gate with proposal 4's variance threshold, and remind users this is a visualisation, not phase data.

### 7. Focus peaking and zebra overlays (view target only)

Benefit: manual focusing on a phone screen and spotting clipped highlights before recording.

Peaking: `e = |Laplacian3x3(y)|` on the 1/2-res luma; threshold at the frame's 97th percentile of `e` (adaptive so the amount of highlight stays constant across samples), EMA the threshold (`a=0.2`), tint pixels above it with a fixed colour (default green; user-selectable red/blue). Zebra: pixels with any channel ≥ 250 get diagonal stripes `((x + y) >> 3) & 1`; a second level ≤ 4 gets the opposite stripe direction. Cost ≈ 3 ms; never runs for `record`. Failure: peaking on noisy dark frames highlights noise — the percentile threshold handles it partly; also skip when the 90th percentile of `e` < 3. Standard camera-monitor behaviour ([Videomaker](https://www.videomaker.com/article/c10/17022-shot-assist-tools-explained/)).

### 8. False colour, channel isolation, colour-blind-safe presets

Benefit: single-channel fluorescence recorded with a colour camera reads correctly and accessibly.

The machinery exists (`algo/colormaps.ts`, `Look.pseudo`). Add: (a) **channel isolation** as a `Look` with channel mixer rows `[0,1,0]` and the isolated channel mapped through a 1D colour map; (b) presets **Green/Magenta**, **Cyan/Red**, **Yellow/Blue** for two channels (green+red pixels → magenta remap: mixer `R'=R, G'=G, B'=R`), the combination Nature journals recommend over red/green ([quantixed 2026](https://quantixed.org/2026/07/21/colorblind-ii-microscopy-images-and-colour-blindness/), [the Node](https://thenode.biologists.com/color-blind-audiences/photo/)); (c) sequential maps Viridis/Cividis/Crameri-style batlow as pseudo-colour for intensity, which are perceptually uniform and CVD-safe; (d) a per-channel auto-scale from proposal 1's percentiles so a dim fluorophore fills the map. Cost: zero, it is the existing LUT path. Failure: 4:2:0 chroma and 8-bit make weak fluorescence very quantised — recommend RAW stills for anything quantitative.

### 9. Look preview split and A/B (UI, cheap)

A vertical wipe on the view canvas comparing chain-on and chain-off (draw the unprocessed `<img>` under, clip the processed canvas). Almost no code; large usability gain when tuning 1, 3 and 4.

## Where WebGL2 pays

CPU is fine for everything that is a per-pixel table or a single arithmetic pass (1, 2, 3, 5 reference mode, 6 relief, 7). Move to WebGL2 when a pass needs *neighbourhood* reads at full res every frame: smoothed CLAHE apply (4), Hilbert/large blur variants of 5/6, and if several processors run together and the chain exceeds ~35 ms. The existing `lutGl.ts` renderer already has the frame as a texture; adding a small uniform table (gain map, tile mappings) to that same draw is the cheapest path and avoids a second readback. Keep statistics (histograms, percentiles) on CPU at 1/8 scale; readback for stats is what makes GPU CLAHE awkward.

## Critique of the existing pipeline for video

- **Deflicker measures mean luma over the whole frame and corrects with a flat gain.** A bright object drifting in changes the mean and the gain "breathes" against it; the 50 % percentile option helps but should be the default. Better: measure the background only (top-30 % pixels, as in proposal 2) since LED flicker is multiplicative on the illuminant, and correct in linear light (`srgbToLinear`, gain, back) because a multiplicative flicker is linear, not gamma-space. `maxGainDelta 0.25` with `alpha 0.9` means a step change takes ~20 frames to become "normal"; fine for flicker, but it also fights a deliberate LED brightness change by the user — reset on `light.set` RPCs, not only on `device.moving`.
- **Deflicker gain saturates highlights**: gain >1 pushes 250 → 255 with no knee; fold the knee from proposal 3 in or clamp gain so `P99.5 * gain ≤ 255`.
- **Reset on the `moving` edge only** leaves the first frame after a move as the anchor while the AE may still be settling; hold reset for ~5 frames after motion stops (applies to all stateful processors here — a shared `sceneState` helper with `moving`, `framesSinceMove`, `histogramIntersection` would serve 1, 2, 4, 5 and deflicker).
- **Look composition happens in sRGB** with `input: 'linear'` as an option per LUT, but adjustments like saturation act on gamma-encoded values; acceptable for a "look", wrong for the WB and flat-field maths, which must be linear. Keep colour-science steps (2, 5) before order 900 and in linear.
- **`applyLookRgba` runs on CPU when the frame is already RGBA**, which is always the case once any earlier processor ran. Chaining two CPU processors costs two full passes; the plan should be one fused table (1+2+3 → single 3×256 table, then optional cube).
- **No dithering** anywhere; every 1D curve with slope >1 on 8-bit input bands visibly on the smooth LED background.

## Do not bother

- Full ACES output transform / OCIO-style colour management: the input is display-referred JPEG; the gains are imaginary.
- HDR (PQ/HLG) recording or 10-bit video output: nothing upstream has more than 8 bits.
- Per-frame full-resolution NLM/bilateral "beautify" before colour: too slow and the denoise processor already exists.
- True quantitative phase retrieval (TIE, DPC) from the single brightfield stream: needs asymmetric illumination pairs; a project on its own, not a colour feature.
- Learned AWB (FFCC and successors): a fixed LED illuminant and a lockable camera make a 30-line brightest-region estimate sufficient.
- Retinex and CLAHE together, or CLAHE on chroma: doubled cost, colour noise, no visual gain.
- Deflicker in the `view` target by default: the live view is a viewfinder; users want to see the flicker to fix the LED driver.

## Sources

[USPTO 11457191 AWB temporal stabilisation](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11457191) · [Barron, Fast Fourier Color Constancy](https://arxiv.org/pdf/1611.07596) · [ASC CDL (Wikipedia)](https://en.wikipedia.org/wiki/ASC_CDL) · [Pomfort, ASC-CDL colour controls](https://pomfort.com/article/an-in-depth-look-at-asc-cdl-based-color-controls/) · [BlazeBVD, blind video deflickering](https://link.springer.com/chapter/10.1007/978-3-031-72643-9_3) · [ImageMagick CLAHE](https://imagemagick.org/clahe/) · [Arnison et al., Hilbert transform for DIC](https://pubmed.ncbi.nlm.nih.gov/10886531/) · [MicroscopyU, phase contrast vs DIC](https://www.microscopyu.com/tutorials/comparison-of-phase-contrast-and-dic-microscopy) · [Videomaker, shot-assist tools](https://www.videomaker.com/article/c10/17022-shot-assist-tools-explained/) · [quantixed, microscopy and colour blindness](https://quantixed.org/2026/07/21/colorblind-ii-microscopy-images-and-colour-blindness/) · [the Node, colour-blind audiences](https://thenode.biologists.com/color-blind-audiences/photo/)
