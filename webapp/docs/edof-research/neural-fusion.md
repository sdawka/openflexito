# Neural few-frame EDOF: can 4 full-field frames + a "DLSS-style" net give a wide depth of field?

Research note, 2026-09-28. Question from the user: *"can't we use just those four frames at higher
resolution and pass it through some kind of DLSS type of neural network later to get a wider depth
of field?"* Scope: live extended focus (`src/lib/algo/sweepFuse.ts`, device `/edof.bin`), "full" fast
mode (`device/openflexito/config.py` `fast_modes.full`: sensor 1640×1232 binned to 820×616, 40 fps
max), about 4 frames per ~100 ms useful z leg. Browser constraints: plain http, so no WebGPU, no
WebCodecs, no SharedArrayBuffer (so single-threaded WASM); WebGL2 and WASM SIMD available.

Legend: **[measured]** = run here; **[paper]** = stated by the cited source; **[unverified]** = my
recollection or inference, not checked against a source in this session.

## TL;DR

1. **Physics first.** A network can only *select* or *restore* information that is in the frames. If
   part of the depth is sharp in no frame, the fine detail there is attenuated (brightfield defocus
   OTF drops toward zero at high spatial frequency), and a net "recovering" it is inferring it from
   priors, i.e. hallucinating. With 4 frames the real question is whether 4 frames span the sweep at
   ≤ ~1 depth of field spacing. If they do, classical per-block argmax already works; if they do not,
   no browser-sized net fixes it honestly.
2. **The continuous sweep is the best lever, and it's not neural.** Because z moves *during* each
   exposure, each frame is a small focal-sweep image (Nagahara et al. 2008): if the exposure is close
   to the frame period, the 4 frames tile the whole sweep with no gaps, and each frame's blur is
   nearly depth-invariant over its sub-range, so it can be deconvolved with one integrated PSF
   (`algo/deconvolve.ts` already has Wiener/RL with a Gaussian PSF). Cheap, deterministic, no training.
3. **Learned fusion that only picks among real pixels** (a net that predicts per-pixel frame weights
   / a focal-index map, like StackMFF-V2 or MCFU-Net) is the safe learned option: it cannot invent
   structure, it can be tiny, and it can be trained self-supervised from our own dense stacks.
   Expected gain over the current argmax + motion gate is modest (cleaner seams, better flat-region
   and noise handling), not "wider depth of field".
4. **Pixel-generating nets** (U-Net/FocusDeep regression, and especially diffusion "generative MFIF")
   can make in-between depths look sharp. That is exactly the hallucination risk; not acceptable as
   the default for a scientific instrument, at best an opt-in, labelled post-process.
5. **Browser cost [measured]:** onnxruntime-web WASM, one thread, Apple M5: a 30 k-param 2-level
   U-Net (7.5 GFLOP) on 4×624×832 takes **177 ms**; a 0.5 M-param 3-level U-Net (42 GFLOP) **830 ms**;
   a 2 M-param one (169 GFLOP) **3.1 s**; the 0.5 M net at 1640×1232 **3.3 s**. So only a tiny net is
   near-realtime at 820×616; anything bigger is offline post-processing of a recording. A typical
   Intel/AMD laptop is probably 2–4× slower [unverified].

**Recommendation:** do not build a DLSS-style reconstruction net. Do (a) the exposure/sweep-geometry
fixes and integrated-PSF deconvolution in the existing classical pipeline, then (b) if seams/noise
still bother users, a tiny learned *weight-map* fusion trained from our own dense stacks, run offline
on recordings first. Details and ranking at the end.

---

## 1. Learned multi-focus fusion (MFIF) from few slices

**What exists.**

- *General MFIF.* Most learned MFIF work fuses **image pairs** (natural-photo datasets such as
  Lytro); stacks are handled by iterative pairwise fusion, which accumulates error. Stack-level
  methods are recent: **StackMFF** (3D-conv end-to-end stack fusion, Applied Intelligence 2025,
  trained on stacks synthesised from all-in-focus images + monocular depth), **StackMFF-V2**
  ("one-shot fusion via focal depth regression": the net regresses a per-pixel focal index and the
  output pixel is *gathered from the input stack*, weights in repo, MIT licence), V3/V4 in review
  [paper/repo]. https://github.com/Xinzhe99/StackMFF-Series ,
  https://github.com/Xinzhe99/StackMFF-V2 ,
  https://link.springer.com/article/10.1007/s10489-025-06383-8 ,
  https://www.sciencedirect.com/science/article/abs/pii/S0952197625026983
- *Real-world focus stacking.* Araujo et al., "Towards Real-World Focus Stacking with Deep
  Learning" (2023): FocusDeep (deformable-conv alignment + fusion + residual reconstruction, a
  burst-SR design), trained on 94 real 30-frame raw bursts with **pseudo ground truth from Helicon
  Focus**; "on par with commercial solutions", more noise-tolerant; fixed burst length, order-dependent,
  needs ECC pre-alignment, not robust to large misalignment [paper]. Note prior learned work was
  "limited to 2–4 images". https://arxiv.org/abs/2311.17846 ,
  https://github.com/araujoalexandre/FocusStackingDataset
- *Microscopy.*
  - MCFU-Net, U-Net regression focus maps for confocal (thin linear structures), slice selection via
    per-channel max pooling [paper]. https://pmc.ncbi.nlm.nih.gov/articles/PMC8513773
  - FFusionCGAN: end-to-end cGAN for **few-focus** cytopathology slides [paper].
    https://arxiv.org/abs/2001.00692
  - EDoF-CNN (Manescu et al. 2019, thick blood-film malaria): CNN EDOF from **lower-resolution stacks
    with fewer focal planes**, beating multi-scale classical fusion on those degraded stacks, judged by
    downstream parasite detection; the low-res/few-plane inputs were **simulated from dense stacks**
    [paper]. https://arxiv.org/abs/1906.07496
  - "Rethinking low-cost microscopy workflow: image enhancement using deep based EDoF methods"
    (Array/ScienceDirect 2022) — relevant to low-cost scopes; page returned 403 here, content
    **unverified**. https://www.sciencedirect.com/science/article/pii/S2667305322001077
  - DL-EDOF data set + method (2024) [paper, not read in detail].
    https://pmc.ncbi.nlm.nih.gov/articles/PMC11300757/

**Do they beat classic fusion when slices are sparse?** The evidence is indirect:

- Where they "win" with fewer planes (EDoF-CNN, FFusionCGAN), the net is producing pixels, and the
  metric is either perceptual similarity to a dense-stack fusion or a downstream task. That means the
  net learned to sharpen/restore the between-plane content from the training domain's priors. That
  is legitimate *within a narrow, well-characterised domain* (one stain, one objective, one sample
  type) and risky outside it.
- Selection-style nets (focal-index / weight map) cannot do better than the best real frame per
  pixel. Their advantage over hand-crafted argmax is robustness (noise, flat regions, seams,
  halo artefacts near depth edges), not extra depth of field.
- DFV (Yang et al., CVPR 2022) shows depth-from-focus with sub-frame accuracy from **as few as 3
  frames** via probability regression, with uncertainty [paper] — i.e. few frames are enough to
  *locate* depth; *sharpness* at in-between depths is a different matter.
  https://arxiv.org/abs/2112.01712 ; minimal focal stack follow-up:
  https://arxiv.org/abs/2604.01603

## 2. Recovering in-between focal planes (refocusing, completion, single-image EDOF, diffusion)

- **Deep-Z** (Wu et al., Nature Methods 2019): a GAN refocuses a single **fluorescence** widefield
  image to user-defined surfaces, ~20× DOF gain for C. elegans neurons, trained on registered
  axial stacks of the same system [paper]. https://www.nature.com/articles/s41592-019-0622-5 ,
  https://arxiv.org/abs/1901.11252 . Caveats: fluorescence (incoherent, sparse emitters, the defocus
  model is simple); trained per microscope/sample type; I recall the authors report degradation for
  dense/continuous samples [unverified]; patented (US 11946854,
  https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/11946854); public weights not found
  [unverified]. Our case is brightfield (partially coherent transmitted light, phase + absorption,
  defocus turns phase into intensity and can invert contrast), so Deep-Z does not transfer as-is.
- **Recurrent-MZ** (Huang et al., Light Sci Appl 2021): a recurrent CNN fuses **a few sparse axial
  planes** (fluorescence) into a volume, ~50× DOF of a 63×/1.4 objective, 30× fewer scans, tolerant
  to plane order and unknown axial position errors [paper]. The closest published analogue to
  "4 frames → full depth", but again fluorescence, per-system training, sparse samples.
  https://www.nature.com/articles/s41377-021-00506-9
- **Single-image EDOF / refocus for label-free**: PostFocus (2024) detects out-of-focus phase-contrast
  time-lapse frames and restores them with a DDPM, averaging 5 samples; validated with sharpness
  metrics and downstream segmentation; code https://github.com/kwu14victor/PostFocus [paper].
  Brightfield EDOF networks also exist that pair a low-NA input with a high-NA target
  (https://arxiv.org/abs/1805.08970 review) [paper, not read in detail].
- **Diffusion MFIF**: "Generative Multi-Focus Image Fusion" (Xie et al., 2025): deterministic
  StackMFF-V4 fusion, then IFControlNet (latent diffusion) "to reconstruct missing content"; the
  abstract has no hallucination discussion [paper]. https://arxiv.org/abs/2512.21495
- **Focal stack interpolation**: in graphics, per-pixel selection/interpolation between slices is
  classical (Jacobs et al., Stanford: https://graphics.stanford.edu/papers/focalstack/focalstack.pdf);
  neural focal-sweep interpolation exists mostly for *rendering* refocus from a known scene, not for
  recovering unmeasured detail [search results only].

**Hallucination risk (be explicit).** Anything that outputs pixels not traceable to a measured
frame can create "morphologically plausible but fictitious" structure, which is harder to spot than
blur (MicroDiffuse3D, https://pmc.ncbi.nlm.nih.gov/articles/PMC13178444/ ; physics-informed DDPM,
https://www.nature.com/articles/s44172-024-00331-z ; HalluGen,
https://arxiv.org/abs/2512.03345). Standard mitigations: physics-informed/data-consistency terms,
uncertainty maps, comparison against a conventional reconstruction, quantitative rather than visual
validation. For openflexito this translates to: never make a generative result the default, label
it in gallery metadata, keep the classical composite alongside, and show a per-pixel "taken from
frame k / inferred" confidence map.

Physics note [inference, standard optics]: in brightfield, a feature ~1–2 DOF from the nearest
frame is blurred but mostly still present (recoverable by deconvolution with noise amplification);
several DOF away, the defocus transfer function has near-zeros and oscillates, so fine detail is
genuinely lost. DOF of a 0.65 NA objective is on the order of 1–1.5 µm (λ/NA² ≈ 1.3 µm at 550 nm)
[unverified for our exact optics]. So the target should be frame spacing ≤ ~1 DOF over the leg.

## 3. Motion between the 4 frames

- Burst-SR style nets align in feature space with deformable convolutions (FocusDeep; burst
  restoration e.g. BIPNet, https://arxiv.org/abs/2110.03680), or use optical flow first and fuse
  after; flow is unreliable under large motion/occlusion and — specific to focus stacks — under the
  **appearance change caused by defocus** (flow/NCC assume brightness constancy; defocus violates it)
  [paper + inference]. A cascaded defocus-and-similarity attention network for multi-focus +
  misaligned inputs exists (Information Fusion 2023,
  https://www.sciencedirect.com/science/article/abs/pii/S1566253523004414) [abstract only].
- HDR deghosting is the closest mature analogue (motion-attention fusion, "reject history where it
  doesn't match"): https://pmc.ncbi.nlm.nih.gov/articles/PMC9610388/
- Our current approach (reference frame = middle of the useful sweep, per-block motion gate on block
  mean luminance, no blending across frames) is the right conservative baseline: moving things
  appear once, at the reference time. A learned version would replace the hand-tuned gate with a
  learned "is this block the same content" classifier. Training it needs moving-specimen data, which
  dense static stacks don't have: synthesise motion by warping (translations, small elastic flows) the
  input slices while keeping the target at the reference time [inference].
- At 40 fps, the 4 frames span ~75–100 ms; a swimming protist moves many µm in that time, so for
  fast movers even a perfect aligner has only 1–2 frames of the moving object at a usable focus —
  there is simply no data to fuse for it. The motion gate's output (object sharp only at reference
  depth) is the honest answer [inference].

## 4. The DLSS analogy: what transfers

DLSS 2 is a temporal upsampler: each frame is rendered at low res with a **sub-pixel jitter**
(Halton), and a convolutional autoencoder combines the current low-res frame with the
**reprojected high-res history**, using **engine-provided exact motion vectors, depth and exposure**,
deciding per pixel how much history to keep or reject.
https://www.nvidia.com/en-us/geforce/news/nvidia-dlss-2-0-a-big-leap-in-ai-rendering/ ; FSR 2 is the
non-neural equivalent: https://gpuopen.com/download/GDC_FidelityFX_Super_Resolution_2_0.pdf

What transfers:
- **Accumulate real samples, learn only the accept/reject decision.** DLSS mostly does not invent
  detail; it gathers real samples over time and the net arbitrates. The analogue is a
  history-carrying fusion: keep a running all-in-focus composite plus a per-pixel "best focus
  measure so far + age", update from each new leg, reject history where the motion gate says the
  content changed. That is `LiveStacker`-like and needs no net; a tiny net could make the reject
  decision [inference].
- **Known motion vectors.** DLSS relies on exact engine motion. Our exact "motion" is the stage: z
  per frame from timestamps (already done) and x/y stage moves (CSM calibration); specimen motion is
  not known and must be estimated, which is the hard part.
- **Jitter for super-resolution.** 820×616 is 2×2-binned 1640×1232. Pixel-shift SR already exists
  (`services/photo/superres.ts`, `algo/drizzle.ts`); natural specimen/stage jitter could be
  exploited like Wronski et al.'s handheld burst SR (https://sites.google.com/view/handheld-super-res/),
  but that is a separate axis (resolution), not depth of field.

What does not transfer:
- DLSS's missing information is *spatial sampling* (resolved by jitter over time). Ours is
  *axial*: detail at a depth nobody focused on is not sampled by any frame, jitter or not.
- DLSS trains on unlimited perfectly aligned ground truth (the renderer at 16K). We only have dense
  static stacks, whose fusion is itself an estimate.
- DLSS runs on tensor cores at ~1 ms; we have single-thread WASM or hand-written WebGL2.

## 5. Browser feasibility (no WebGPU, no threads)

- Runtimes: onnxruntime-web WASM (SIMD; multi-thread only when crossOriginIsolated, else 3–4×
  slower for larger models), WebGL EP is in maintenance mode, fewer ops, not a default fallback
  (https://github.com/microsoft/onnxruntime/issues/32241 ,
  https://onnxruntime.ai/docs/tutorials/web/ ). The installed Transformers.js 4.2.0 exposes devices
  `cpu`, `wasm`, `webgpu`, `webnn*` — **no WebGL** [measured: `node_modules/@huggingface/transformers/src/utils/devices.js`];
  our `aiWorker.ts` already falls back to `wasm`. For a custom image-to-image net, onnxruntime-web
  directly (already in `node_modules` as a Transformers.js dependency) is simpler than a Transformers.js
  pipeline. A hand-written WebGL2 fragment-shader CNN (convs as texture passes, like `lib/gfx/lutGl.ts`)
  is possible for a fixed tiny architecture and likely ~5–20× faster than single-thread WASM [unverified].
- **Benchmark [measured]**, onnxruntime-web 1.26.0-dev WASM in Node, `numThreads = 1`, Apple M5,
  4-channel input (4 grey frames), plain U-Net (3×3 conv + ReLU, max-pool, nearest upsample, skips),
  median of 3 runs after warm-up:

  | net | params | GFLOP | input | time |
  |---|---|---|---|---|
  | base 8, 2 levels | 30 k | 7.5 | 4×624×832 | 177 ms |
  | base 16, 3 levels | 0.49 M | 42 | 4×624×832 | 830 ms |
  | base 32, 3 levels | 1.9 M | 169 | 4×624×832 | 3.1 s |
  | base 16, 3 levels | 0.49 M | 165 | 4×1232×1640 | 3.3 s |

  ≈ 45–55 GFLOP/s effective. Colour triples input and roughly the first-layer cost. Scripts were
  throwaway (scratchpad), easy to recreate: build the ONNX with `onnx.helper`, time
  `InferenceSession.run` with `ort.env.wasm.numThreads = 1`.
- Implications: at ~3 composites/s, realtime needs ≤ ~300 ms per composite including decode and the
  rest of the worker — only the ~30 k-param class fits, on a fast machine. Published MFIF nets
  (StackMFF with 3D convs, FocusDeep with deformable conv, diffusion) are far beyond this and
  deformable conv isn't a standard ONNX op in ORT web [unverified]. Offline post-processing of a
  recorded session (frames already stored as the EDOF stream) at 1–5 s per composite is feasible.
- Diffusion: hundreds of MB of weights, many denoising steps, each far more than 169 GFLOP —
  minutes per frame on single-thread WASM [inference]. Not feasible.

## 6. Training data: self-supervision from our own dense stacks

Feasible and the right way if we train anything:
- **Target:** all-in-focus fusion of a dense slow stack (`services/photo/focusStack.ts`, RAW fine
  stack via `algo/pyramidFuse.ts`; `sweepStack.ts` for H.264 sweeps). Pseudo ground truth, like
  Araujo et al. using Helicon; the net can at best match our dense fusion.
- **Input simulation:** pick 4 slices spanning the leg range and, to mimic a moving-z exposure,
  average the dense slices covered by each simulated exposure window (a synthetic focal sweep);
  bin 2×2 and JPEG-compress at the fast mode's quality to match `/edof.bin`; add sensor noise;
  optionally warp for motion. This is the EDoF-CNN recipe (simulated low-res few-plane stacks from
  dense ones).
- **Split and domain:** hold out whole specimens, not crops; per-objective/illumination models are
  likely needed. Tens to low hundreds of stacks per domain is the scale in the literature (Araujo:
  94 bursts) [paper].
- **Where it runs:** training is PyTorch offline (a GPU box or Colab), exported to ONNX; the repo
  rule (all image maths in `lib/algo`, pure TS) would need an explicit exception for model inference,
  as it already has for `aiWorker.ts`. Weights would be downloaded, not bundled.
- **Validation:** compare against dense-stack fusion on held-out specimens, *and* report where the
  net's output deviates from every input frame (a hallucination map); a selection-only net passes
  this by construction.

## Ranked options

| # | Option | Effort | Risk | Expected benefit |
|---|---|---|---|---|
| 1 | **Sweep geometry + exposure**: set exposure ≈ frame period during `/edof.bin` so frames tile z without gaps; choose leg length so frame spacing ≤ ~1 DOF (i.e. range ≈ 4 DOF in full mode, or accept fewer composites/s with longer legs); report "frames per DOF" in the UI | Low | Low | Removes "sharp in no frame" gaps; this is the real limit |
| 2 | **Integrated-PSF deconvolution** of each frame (or of the composite) with a Gaussian IPSF (`algo/deconvolve.ts` `wiener`/`richardsonLucy`, sigma calibrated once from a static sweep), then the existing argmax + motion gate | Low–medium | Low (ringing/noise if over-driven) | Sharper sub-range content; deterministic, fully explainable (Nagahara focal sweep) |
| 3 | **History accumulation** (DLSS idea without the net): running composite with per-pixel best focus + age, motion-gated rejection, across legs | Medium | Low | Static regions reach full-sweep quality over several legs even with few frames per leg |
| 4 | **Tiny learned weight-map fusion** (≤ ~50 k params, outputs per-block/pixel frame weights; StackMFF-V2/MCFU-Net style), self-supervised from dense stacks; offline on recordings first, realtime only if ~200 ms holds on target laptops | Medium–high (training pipeline outside the repo) | Low–moderate (can't invent structure; domain shift → wrong picks) | Cleaner seams/flat regions/noise than hand-tuned argmax; no DOF gain beyond the frames |
| 5 | **Pixel-regression net** (U-Net/FocusDeep-like) trained on our stacks, offline, labelled output + deviation map | High | Moderate–high (hallucination between frames, domain shift) | Can make between-frame depths look sharper; needs rigorous validation |
| 6 | **Diffusion / generative MFIF, Deep-Z-style refocusing** | Very high | High (hallucination; fluorescence-only evidence for Deep-Z/Recurrent-MZ; not runnable in browser) | Not recommended |

**Answer to the user's question:** partly. Four higher-resolution frames per sweep are fine *if*
they cover the sweep contiguously at about one depth of field apart; then the gain comes from
exposure/sweep settings and focal-sweep deconvolution, not from a neural net. A "DLSS-type" net that
invents the in-between focal planes would make the picture look sharper by guessing, which is the
wrong trade-off for a microscope; the DLSS idea worth borrowing is accumulating real samples over
time with a learned or hand-made accept/reject rule.
