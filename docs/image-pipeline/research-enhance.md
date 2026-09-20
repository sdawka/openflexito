# Image Enhancement Algorithms for Browser-Based Microscopy (2026)

## Context
This report surveys algorithms for an open-source microscope web app (Svelte 5, TypeScript, Web Workers, WebGL2/WebGPU). The app already implements Richardson-Lucy and Wiener deconvolution, Mertens fusion, Reinhard tone mapping, Laplacian-pyramid focus-stack fusion, drizzle super-resolution, flat-field correction, phase-correlation registration, and video stabilisation.

---

## 1. Local Contrast Enhancement

### CLAHE (Contrast Limited Adaptive Histogram Equalization)
**Algorithm**: Partitions image into tile grid (~8×8 tiles), equalizes each tile's histogram independently with clip-limit (typical: 0.03 of tile area), then bilinearly interpolates borders between tiles.

**Parameters & Defaults**:
- Tile size: 8×8 to 32×32 px (smaller = more local detail, more artifacts)
- Clip limit: 0.01–0.03 (0 = no clipping, 1 = full dynamic range per tile)
- Bilinear interpolation: mandatory at tile boundaries to avoid seams
- Apply on: L channel (Lab) or luminance only (YCbCr), never RGB directly (colour shifts)

**Complexity**: O(H·W) with 256-bin histograms (histogram recompute per tile); modern GPU: ~2–5 ms on 1.3 MP, separable per row/column not possible.

**GPU-friendly**: Yes (GLSL compute shader: parallel histograms, interpolation), benefits from local memory; OES_texture_float required for 32-bit intermediates.

**Used by**: darktable "local contrast", RawTherapee "local contrast" panel, Lightroom does NOT expose raw CLAHE (uses proprietary adaptive tone instead).

### Local Laplacian Filters (Paris/Hasinoff 2011)
**Algorithm**: Gaussian pyramid downsampling → compute per-level Laplacian residuals → remap via piecewise-linear remapping functions → upsample + reconstruct.

**Parameters**:
- Pyramid levels: 4–5 (covers ~32 px to image size)
- Remapping function: per-level contrast/saturation curve (linear ramp with adjustable slope)
- Sigma (Gaussian blur): ~0.5× current level pixel size

**Complexity**: O(H·W) multi-scale (typically 4–5 levels), ~10–20 ms on 1.3 MP.

**GPU-friendly**: Yes (separable Gaussian blur, parallel upsampling); especially efficient for detail enhancement ("clarity" effect).

**Used by**: GIMP "Shadows-Highlights" (old), Photoshop "clarity", darktable does not expose directly but uses similar multi-scale in tone-curve.

### Guided Filter (Kaiming He et al., 2013)
**Algorithm**: Filters detail by fitting linear models (I = aG + b per patch) to preserve edges where guidance image G has edges.

**Parameters**:
- Radius r: 4–16 px (larger = more smoothing)
- Epsilon ε: 1–100 (regularization; typical 0.01² for 8-bit, 10⁻⁸ for float)
- Guidance image: luminance or input image itself

**Complexity**: O(H·W) with recursive mean box filters; ~2–3 ms on 1.3 MP.

**GPU-friendly**: Yes (separable box filtering via integral images or multi-pass blur), excellent for detail separation.

**Use case**: Edge-aware downsampling for HDR/tone-mapping, separating illumination from reflectance.

### Multi-Scale Retinex (MSRCR)
**Algorithm**: Sum of three Gaussian-blurred scales (typically σ ≈ 15, 80, 250 px), log-divide from each scale, restore colour via independent channel scaling.

**Parameters**:
- Scales: [15, 80, 250] px (covers local to global adaptation)
- Gain c: 0.5–1.5 (intensity restoration)
- Offset b: 0–255 (shadow lift)

**Complexity**: O(H·W) three convolutions, ~5–10 ms on 1.3 MP.

**GPU-friendly**: Yes (parallel Gaussian blur), separable per-channel.

**Colour restoration**: MSRCR + independent per-channel gain, or full "MSRCP" with optional saturation correction (multiply by ratio of original saturation to Retinex saturation).

**Used by**: ImageJ/Fiji "Auto-Enhance", old GIMP versions; modern RAW tools avoid it (too aggressive shadows).

---

## 2. Sharpening

### Unsharp Mask (Linear Sharpening)
**Algorithm**: (I – Gaussian_blur(I)) × amount + I; kernel = [0 -½ 0; -½ 5 -½; 0 -½ 0] × (amount/4).

**Parameters**:
- Radius: 0.5–2 px (typical: 1 px; controls frequency cutoff)
- Amount: 0.5–2 (strength; typical 0.8–1.0)
- Threshold: 0–10 (skip boost if gradient < threshold; prevents noise amplification)

**Complexity**: O(H·W) one Gaussian blur + one blend; ~2–3 ms on 1.3 MP.

**GPU-friendly**: Yes (separable Gaussian).

**Halos**: Occur when radius is too large relative to edge width; mitigate with threshold or edge-aware sharpening.

### Richardson-Lucy (RL) Deconvolution Sharpening
**Algorithm**: Iterative restoration: I_{n+1} = I_n × P\*(PSF ⊗ I_n)^{-1}, where PSF ⊗ = convolution, P\* = adjoint.

**Parameters**:
- Iterations: 3–10 (3–4 typical for "capture sharpening", 10+ for blur restoration)
- PSF: circular Gaussian σ ≈ 0.8–1.5 px (estimated from image or user-supplied)

**Complexity**: O(H·W × iterations); 10 iterations ~20–30 ms on 1.3 MP (requires FFT for speed).

**GPU-friendly**: Yes (WebGL2 via FFT.js or handwritten FFT shaders; cuFFT not available in browser).

**Blind deconvolution**: Estimate PSF sigma from Laplacian/Sobel edge variance: σ ≈ sqrt( sum(∇²I) / (H·W) ); fragile, use only for automated "auto-sharpen".

**Used by**: RawTherapee "RL deconvolution", darktable "sharpen" module uses RL with learned PSF.

### Edge-Aware Sharpening (Guided Filter + Unsharp)
**Algorithm**: High-pass = I – guided_filter(I, guidance=I, r=2px, ε=1); sharpen = I + high_pass × amount; eliminates halos.

**Complexity**: O(H·W); ~4–5 ms on 1.3 MP.

**GPU-friendly**: Yes.

**Used by**: Lightroom "edge detection" in clarity, darktable via bilateral sharpening.

---

## 3. Microscopy-Specific

### Background Subtraction

**Rolling Ball / Sliding Paraboloid**:
- Creates morphological opening (image eroded by a sphere of radius R, then dilated) with large radius (R = specimen feature size / 2).
- Background = morphological_opening(image, disk(R)).
- Corrected = image / background (linear light).

**Parameters**: Radius R: 10–100 px (estimate from specimen scale).

**Complexity**: O(H·W × R) for naive implementation; ~50–200 ms on 1.3 MP; GPU morphology via OpenGL compute ~5–10 ms.

**Pseudo-flat-field**: Divide by low-pass (Gaussian σ = 50–200 px) instead of full flat image; works for gentle uneven illumination.

### Uneven Illumination Correction (BaSiC)
**Algorithm** (Background and Shading Correction): Estimates additive background B and multiplicative shading S via maximum-likelihood on image stack I_k: max L = Σ log P(I_k | (d_k ⊗ S + B)), where d_k = sample.

- For single image: assume S = smoothly varying (Tikhonov regularization), fit B + S.
- Correction: (I – B) / S in linear light.

**Parameters**: Regularization λ ≈ 1–10 (strength of smoothness prior); polynomial degree 2–4.

**Complexity**: Nonlinear optimization on image pyramid; ~100–300 ms.

**GPU-friendly**: Moderate (iterative solver, typically CPU-bound).

### Vignette Correction
**Algorithm**: Radial polynomial model: vignette = 1 + a·r² + b·r⁴ + c·r⁶, where r = distance from optical axis (normalized to image corner ≈ 0.7).

**Parameters**:
- Estimate via flat-field image: V = flat_image / median(flat_image).
- Fit polynomial: min Σ (V – polynomial)².

**Correction**: I_corrected = I / vignette (linear light).

**Complexity**: O(H·W) one per-pixel multiply; FFT for polynomial fit ~1–2 ms on 1.3 MP.

**GPU-friendly**: Yes (LUT or runtime polynomial).

### Chromatic Aberration Correction

**Lateral CA** (per-channel radial scaling):
- Blue and red channels registered to green via radial scaling: I_r = resample(I_r, 1+δr × r²); I_b = resample(I_b, 1+δb × r²).
- δr, δb ≈ ±0.002–0.01 (parts-per-pixel per unit radius squared).

**Estimate from image**: phase-correlate green vs red/blue channels (with radial-scaling search space) on high-contrast regions.

**Transverse CA** (per-channel lateral shift):
- Shift via image resampling; typically combined with radial.

**Complexity**: Two resampling operations ~5–10 ms on 1.3 MP.

**GPU-friendly**: Yes (fragment shader with polyphase filtering or bicubic).

### Colour Deconvolution (H&E Staining)
**Algorithm** (Ruifrok & van der Laak, 2001): Assumes three stains (haematoxylin, eosin, background) with known absorption vectors. Solve: log(I/I0) = M × C, where M = stain matrix, C = stain concentrations.

**Parameters**:
- Stain vectors: H = [0.65, 0.70, 0.29], E = [0.07, 0.99, 0.11], B = [0.27, 0.57, 0.78] (normalized).
- Optical density: OD = -log(I / 255) in linear light.

**Correction**: C = M^{-1} × OD; separate stains.

**Complexity**: O(H·W) with 3×3 matrix inversion; ~1–2 ms on 1.3 MP.

**GPU-friendly**: Yes.

**Used by**: FIJI "Colour Deconvolution", essential for pathology microscopy.

---

## 4. Tone Mapping (Local Tone)

### Durand et al. (2002) Bilateral Filtering
**Algorithm**:
1. Decompose: I_in = illumination × reflectance.
2. Edge-preserving bilateral blur of log(illumination): B = bilateral(log(I), spatial_σ=8px, range_σ=0.1).
3. Compress illumination: log(I_base) = B, log(I_detail) = log(I) – B.
4. Reconstruct: I_out = exp(α × log(I_base) + log(I_detail)) × reflectance.

**Parameters**:
- Spatial σ: 8–16 px.
- Range σ: 0.05–0.2 (in log space; 0.1 ≈ 2× brightness change).
- Compression α: 0.5–1.0.

**Complexity**: O(H·W) via bilateral filter (can be approximated with box + Gaussian); ~10–20 ms on 1.3 MP.

**GPU-friendly**: Yes (domain-transform or grid-based bilateral, ~5 ms).

### Fattal et al. (2002) Gradient Domain
**Algorithm**:
1. Compute log-luminance gradients: ∇ log(L).
2. Attenuate large gradients: ∇L' = ∇L × (1 + α·|∇L|)^{-β}.
3. Reconstruct via Poisson solve: min Σ (∇I_out – ∇L')².

**Parameters**:
- Gradient attenuation α: 0.1–0.5.
- Exponent β: 1–2.

**Complexity**: Poisson solver ~100–200 ms (iterative or multigrid).

**GPU-friendly**: Moderate (Poisson solve inherently slow; multi-grid accelerates to ~20 ms).

### Mantiuk et al. (2006) Contrast Mapping
**Algorithm**: Similar to Fattal but with per-scale contrast preservation; less prone to halo artefacts.

**Complexity**: O(H·W) multi-scale; ~50–100 ms.

### Shadows/Highlights Recovery (Dodge & Burn)
**Algorithm**: Selective brightening via tone curve or layer blend; e.g., Curves with point [0, 10] lifts blacks, [255, 245] crushes highlights.

**Alternative (ACES-like filmic)**:
```
v = (v×(a·v + b)) / (v×(c·v + d) + e)
where a≈0.15, b≈0.50, c≈0.10, d≈0.20, e≈0.02 (typical values)
```
Provides smooth compression with natural rolloff.

**Complexity**: O(H·W) per-pixel; ~1 ms on 1.3 MP.

**GPU-friendly**: Yes (simple LUT or polynomial).

### Auto-Levels (Percentile Clipping)
**Algorithm**: Histogram clipping: black point = 0.1% percentile, white point = 99.9% percentile; linear stretch.

**Parameters**: Percentiles typically 0.1%–0.5% (avoid extreme clipping of single outliers).

**Complexity**: O(H·W) histogram + linear remap; ~2 ms on 1.3 MP.

---

## 5. Colour

### Saturation vs. Vibrance
**Saturation**: Uniform per-channel gain in HSV/HSL: S' = S × scale.
- **Vibrance**: Adaptive saturation that boosts muted colours and preserves saturated ones; typically via power curve in Lab: C' = C × (1 + (1 – C/C_max) × vibrance_strength).

**Complexity**: O(H·W) colour space conversion + per-pixel curve; ~1–2 ms on 1.3 MP.

### Hue/Sat/Luma Curves
**Algorithm**: Apply per-channel curves in HSL (Hue ↔ Hue, Sat ↔ Sat, Luma ↔ Luma) or Lab (a* ↔ a*, b* ↔ b*).
- Allows selective colour grading (e.g., boost red saturation while neutral saturation elsewhere).

**Complexity**: O(H·W) per-curve evaluation; ~2–5 ms on 1.3 MP.

### White Balance Refinement
**Grey-world assumption**: Average RGB = grey; scale channels to match reference grey.

**Retinex white balance** (Li et al.): Use Retinex per-channel to estimate illuminant, then correct via channel gains.

**Bradford-adapted colour temperature/tint**:
- Convert XYZ to cone response (Bradford matrix).
- Adjust D65 illuminant on cone space (temperature/tint sliders).
- Convert back to sRGB.

**Complexity**: 3×3 matrix multiply (Bradford) + channel gains; ~0.1 ms on 1.3 MP.

---

## 6. Learned Enhancement (Browser Models)

### Real-ESRGAN (Xintao Wang et al., 2021)
**Model**: GAN-based super-resolution; trained on synthetic degradation (blur, noise, compression).

**Parameters**:
- Architecture: RRDB (Residual in Residual Dense Block) backbone, 23 M parameters.
- Upscale factor: 2× or 4× (inputs, ONNX model files ~64–85 MB).
- Input: YCbCr (Y = luminance, Cb/Cr are subsampled by 2×; upsample Y, interpolate chroma).

**Complexity**: ~500 ms – 2 s per 1.3 MP image (ONNX.js inference, CPU-bound; GPU via WebGPU ~100–300 ms with proper batching).

**Web weights**: ONNX model at [github.com/xinntao/Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN); ~64 MB for 2× model. License: Apache 2.0 (permissive).

**Worth it for microscopy?**: Yes for low-mag / undersampled images; less useful if already Nyquist-sampled. Adds false detail on noise; use selectively (on low-noise stills, not live video).

### SwinIR (Liang et al., 2021) / Swin2SR
**Model**: Vision Transformer-based, comparable image quality to ESRGAN, slower inference (~1–2 s).

**Model size**: ~62.5 M parameters; ONNX ~250 MB.

**Advantage**: Better detail preservation on natural images; microscopy gains marginal.

**Complexity**: Similar to ESRGAN; not recommended for real-time use.

### Lightweight Alternatives
- **BSRGAN** (Blind Super-Resolution): Smaller (~16 M params), ~300 ms on 1.3 MP; good balance.
- **SRResNet** (perceptual loss): Smallest (~1.5 M params), ~100 ms; suitable for live preview.

---

## 7. Video-Specific

### Temporal Deflicker (Exposure Smoothing)
**Algorithm**: Per-frame exposure estimate (median of luminance histogram), low-pass filter exposure curve: E[i] = (E[i-1] + E[i] + E[i+1]) / 3; gain-correct frames: I_out[i] = I[i] × (E_ref / E[i]).

**Parameters**:
- Reference exposure E_ref: mean of E over sequence.
- Filter strength: 3-frame moving average (causal variant: E_out[i] = α·E_out[i-1] + (1-α)·E[i], α ≈ 0.7).

**Complexity**: O(H·W) per frame (histogram + per-pixel multiply); ~2–3 ms on 1.3 MP.

**GPU-friendly**: Yes (histogram reduction + multiply).

### Rolling-Average Exposure Smoothing
**Algorithm**: Accumulative averaging of raw pixel values (or log-luminance) over N recent frames; natural temporal smoothing without motion artifacts.

**Parameters**: Window N = 3–8 frames; trade latency for smoothness.

**Complexity**: O(H·W) per frame plus buffer management; ~1–2 ms on 1.3 MP.

### Chroma Denoise (MJPEG Blockiness)
**Algorithm**: MJPEG codec (4:2:0 subsampling) introduces chroma artifacts. Denoise via:
- **Bilateral filter on chroma**: spatial σ ≈ 2 px, range σ ≈ 5–10 (8-bit).
- **Guided filter**: guide by luma, radius ≈ 4 px.

**Complexity**: ~3–5 ms on 1.3 MP; typically only on chroma channels.

**GPU-friendly**: Yes.

### Sub-Pixel / Rotational Stabilisation
**Algorithm**: 
1. Phase-correlation of successive frames → translation (sub-pixel via sinc interpolation).
2. Log-polar transform to shift space → phase-correlation again → rotation & scale.
3. Estimate similarity transform (rotation θ, scale s, translation); feed into perspective warp.

**Complexity**: 3× FFT (linear translation + log-polar + inverse); ~30–50 ms on 1.3 MP.

**Simpler**: 2D translate-only via phase-correlation + Lanczos-3 warp; ~10 ms.

**Alternative (OBS/ffmpeg vidstab)**: Feature-based matching (SIFT/ORB), RANSAC for motion model; CPU-intensive (~100+ ms), more robust to occlusion.

**GPU-friendly**: FFT-based good; feature-based poor (feature extraction bottleneck).

---

## 8. Recommended Develop Pipeline

**Processing order** (RawTherapee/darktable convention):

### Linear Light (Sensor → Scene-Referred)
1. **Raw decode** (demosaic, white balance, gain correction to linear light).
2. **Lens correction**: chromatic aberration, vignette, distortion.
3. **Flat-field** (divide by measured flat or BaSiC illumination).
4. **Denoise** (spatial: bilateral/guided filter; or stack-average for stills).
5. **Deconvolution** (RL sharpening on flat field).

### Display Light (Scene → Display)
6. **Tone mapping**: local (Durand bilateral or Fattal) if needed; then global curve.
7. **Colour**: white balance refinement, saturation/vibrance, hue curves.
8. **Sharpening**: capture sharpening (RL 3 iterations) or edge-aware unsharp mask.
9. **Local contrast** (CLAHE or local Laplacian, on L or Y channel only).
10. **Output gamma / sRGB LUT** (ICC colour profile).

### Video-Specific Insert
- **Before step 6**: deflicker + rolling-average exposure smoothing (per-frame).
- **Before step 10**: temporal denoise (chroma via bilateral, optional luma via sparse spatial filtering).

### Notes
- **Denoise before deconvolution**: Sharpening amplifies noise; pre-filter to avoid artifacts.
- **CLAHE after tone mapping**: Local contrast works better on display-linear data; avoid before gamma.
- **Learned upsampling** (ESRGAN): insert after step 9 if needed; most effective on sharp, noise-free stills, not live video.

---

## Complex Parameters & Defaults Table

| Operation | Key Parameters | Typical Values | GPU Feasible |
|-----------|----------------|-----------------|--------------|
| **CLAHE** | tile size, clip limit | 8–16 px, 0.02 | Yes (3–5 ms) |
| **Local Laplacian** | pyramid levels, remapping σ | 4–5, 0.5× per level | Yes (10–20 ms) |
| **Guided filter** | radius, epsilon | 4–16 px, 0.01² | Yes (2–3 ms) |
| **Multi-Retinex** | scales, gain, offset | [15,80,250], 1.0, 0 | Yes (5–10 ms) |
| **Unsharp mask** | radius, amount, threshold | 1 px, 0.8, 0 | Yes (2–3 ms) |
| **RL deconvolution** | iterations, PSF σ | 3–10, 1.0 px | Yes (10 iterations @ 20–30 ms) |
| **Durand tone mapping** | spatial/range σ, α | 8 px / 0.1, 0.7 | Yes (5–10 ms) GPU bilateral |
| **Fattal gradient** | α, β | 0.2, 1.5 | Moderate (50–100 ms Poisson) |
| **Rolling ball BG** | radius | 10–100 px | Moderate (morphology @ 5–10 ms GPU) |
| **BaSiC illumination** | regularization λ | 1–10 | CPU (100–300 ms) |
| **Vignette polynom.** | degree, centre offset | 2–4, [0,0] | Yes (0.1 ms LUT) |
| **Colour deconv. (H&E)** | stain matrix | Ruifrok std | Yes (1–2 ms) |
| **Real-ESRGAN 2×** | ONNX model | ~65 MB | GPU WebGPU (100–300 ms) |
| **Temporal deflicker** | filter α | 0.7 (3-frame MA equiv) | Yes (2–3 ms) |
| **Video stabilise 2D** | FFT phase corr. | sub-pixel sinc | Yes (10 ms FFT) |

---

## Key References

1. **CLAHE**: K. Zuiderveld, "Contrast limited adaptive histogram equalization", in *Graphics Gems IV*, pp. 474–485, 1994.
2. **Guided Filter**: K. He et al., "Guided Image Filtering", TPAMI 35(6):1397–1409, 2013.
3. **Local Laplacian**: S. Paris & F. Durand, "A fast approximation of the bilateral filter using a signal processing approach", IJCV 81(1):24–52, 2009; refined by Hasinoff et al.
4. **Multi-Retinex**: D. Jobson et al., "A multiscale Retinex for bridging the gap between color images and the human observation of scenes", IEEE TIP 6(7):965–976, 1997.
5. **Durand Tone Mapping**: F. Durand & J. Dorsey, "Fast bilateral filtering for the display of high-dynamic-range images", SIGGRAPH 2002.
6. **Fattal Tone Mapping**: R. Fattal et al., "Gradient domain high dynamic range compression", SIGGRAPH 2002.
7. **Richardson-Lucy**: W. Richardson, "Bayesian-based iterative method of image restoration", JOSAA 29(12):2817–2823, 1972; L. Lucy, "An iterative technique for the rectification of observed distributions", Astron. J. 79(6):745–754, 1974.
8. **Real-ESRGAN**: X. Wang et al., "Real-ESRGAN: Practical algorithms for general image restoration", CVPR 2021, https://arxiv.org/abs/2107.10833.
9. **BaSiC Illumination Correction**: A. Peng et al., "A BaSiC tool for background and shading correction of optical microscopy images", Nat. Commun. 8:14836, 2017.
10. **Colour Deconvolution**: A. Ruifrok & D. Johnston, "Quantification of histochemical staining by color deconvolution", Anal. Quant. Cytol. Histol. 23(4):291–299, 2001.
11. **Chromatic Aberration**: W. Mullan, *Digital Photography: A Hands-On Introduction*, 2013, Ch. 11.
12. **FFT Phase Correlation Stabilisation**: B. Reddy & B. Chatterji, "An FFT-based technique for translation, rotation, and scale-invariant image registration", IEEE TIP 5(8):1266–1271, 1996.
13. **Bilateral Filtering**: S. Paris et al., "A gentle introduction to bilateral filtering", https://people.csail.mit.edu/sparis/bf_course/.

---

## Summary & Recommendations

For the microscope webapp, **prioritize**:

1. **CLAHE** (local contrast): simplest win, ~5 ms GPU, huge perceptual impact on flat-field-corrected images.
2. **Guided-filter detail separation**: foundation for multiple downstream uses (tone mapping, deconvolution PSF estimation).
3. **Edge-aware unsharp sharpening**: replace plain unsharp with guided-filter variant to avoid halos.
4. **Durand bilateral tone mapping** (optional): if HDR stacks are captured; 5–10 ms GPU.
5. **Temporal deflicker** (video only): critical for live view; trivial cost.
6. **Real-ESRGAN 2× upsampling** (deferred, optional): include as a "enhance" button on captured stills; ~300 ms GPU inference, 65 MB model, Apache 2.0 license.
7. **BaSiC or pseudo-flat-field** (CPU precompute, optional): for uneven LED illumination on samples; much cheaper than hardware flat-field, 100–300 ms one-time per session.

**Avoid (high cost, low ROI on microscopy)**:
- Fattal tone mapping (Poisson solver slow in browser; Durand bilateral is 5× faster).
- Swin2SR upsampling (no advantage over ESRGAN; 2× inference cost).
- Morphological background subtraction (rolling ball / sliding paraboloid: use Gaussian low-pass instead for speed).
- Learned denoise (BSRGAN, etc.): microscopy noise is salt-and-pepper; Wiener deconvolution already in place works better.
