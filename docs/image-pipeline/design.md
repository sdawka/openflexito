# Image pipeline overhaul: custom LUTs, denoising, enhancement, recording

Design written 2026-09-20 from the four research notes in this folder (`research-*.md`, Haiku surveys; treat
numbers as indicative, verify anything you rely on) and a map of the webapp's integration points. Everything
runs in the browser (CLAUDE.md rule: the Pi only relays). Pure maths in `webapp/src/lib/algo` with vitest
tests; services orchestrate; components never `fetch`.

## Decisions

- **Frame chain.** `services/frameChain.ts` (written by the lead) is the one place per-frame processors plug
  in for the live view (`view`), the recorder (`record`) and time-lapse playback (`playback`). LUT, live
  denoise, deflicker and stabilisation register processors; StreamView, the recorder and TimelapseViewer call
  `frameChain.run(target, frame, t)`. Nobody edits another package's component to add a stage.
- **LUTs** are first-class: parsed in `algo/lut.ts` (.cube 1D/3D, .3dl text, ImageJ .lut binary/text, Hald
  CLUT PNG pixels, CSV ramps), applied by tetrahedral interpolation on CPU and by a WebGL2 `sampler3D` path
  for real-time. Built-in scientific maps (`algo/colormaps.ts`) are generated in code (Matplotlib tables are
  CC0; ImageJ maps are public domain and reproduced from their control points), never shipped as binaries.
  A "look" = optional 1D curve LUT + optional 3D LUT + strength + input space (sRGB | linear) + pseudo-colour
  mode (apply a 1D map to luminance) + invert. Looks are stored in IndexedDB (`store/lutDb.ts`) and can be
  exported as `.cube`.
- **Denoising** is classical and dependency-free by default: wavelet shrinkage (BayesShrink / SURE, CDF or
  Daubechies-4, 3 levels) with sigma from MAD or from the RAW noise model through a generalised Anscombe
  transform; fast integral-image Non-Local Means as the quality option; guided filter for chroma and as an
  edge-aware base; motion-compensated recursive temporal denoise for video using the known stage shift (from
  `device` position events via the CSM calibration when available, else the phase-correlation shift from
  `algo/register.ts`). Learned denoisers are **not** shipped now (no verified GPL-compatible ONNX weights with
  stable Hugging Face ids); `algo/denoise.ts` exposes a `Denoiser` interface so an ONNX-backed one can be added
  later via `onnxruntime-web` (already a transitive dependency of Transformers.js).
- **Enhancement toolbox** (`algo/enhance.ts`): CLAHE on luminance, unsharp mask with threshold, edge-aware
  sharpen via guided-filter high-pass, auto-levels by percentile, pseudo-flat-field (divide by large Gaussian
  low-pass), polynomial vignette correction, lateral chromatic-aberration correction (per-channel radial
  scale), colour deconvolution (Ruifrok H&E / H-DAB), saturation/vibrance, shadows/highlights, filmic curve.
  A single `developPipeline()` in `algo/pipeline.ts` runs an `EnhanceParams` object in the canonical order
  (linear-light steps first: flat-field, vignette, CA, denoise, deconvolve; then display-space: tone,
  colour, sharpen, CLAHE, LUT). The existing `deconvolve.ts` (RL/Wiener) is reused for the deconvolution step.
- **Recording** moves to WebCodecs `VideoEncoder` + `mediabunny` (MPL-2.0, verified on npm) producing
  fast-start MP4 (H.264 by default, VP9/AV1 when the encoder exists) with the device frame timestamp
  (`MjpegFrame.t`, ns) as the per-frame timestamp so playback speed equals real time regardless of drops.
  MediaRecorder stays as the fallback when `VideoEncoder` is unavailable, with the WebM duration header fixed
  after recording. The capture loop, the frame chain and the encoder are decoupled by a bounded queue
  (drop-oldest when the encoder is behind, counted in the item's meta). Time-lapse export encodes stored
  frames at an exact fps in a worker. A deflicker processor and a sub-pixel stabiliser round out video.
- **Gallery**: an Enhance panel in the Viewer runs `developPipeline` in a worker on the item's best source
  (16-bit RGB when a RAW develop exists, else the JPEG), previews, and "Save as new photo" writes a new item
  with `meta.enhance = params` and a name suffix. The look (LUT) is applied on display and on export.

## Work packages and file ownership

| WP | Model | Owns (create/edit) | Must not edit |
|----|-------|--------------------|---------------|
| 1 LUT core | sonnet | `algo/lut.ts`, `algo/colormaps.ts`, `algo/curves.ts`, `algo/__tests__/{lut,colormaps,curves}.test.ts` | anything outside `lib/algo` |
| 2 LUT UI | sonnet | `lib/gfx/lutGl.ts`, `store/lutDb.ts`, `store/look.svelte.ts`, `services/lookProcessor.ts`, `components/LookPanel.svelte`, `components/StreamView.svelte`, `components/TimelapseViewer.svelte`, `components/Viewer.svelte` (LUT display only), `routes/Live.svelte` (add panel), settings (additive), e2e block "look" | recorder, algo files of WP1/3, Gallery enhance UI |
| 3 Enhance core | sonnet | `algo/denoise.ts`, `algo/enhance.ts`, `algo/pipeline.ts`, `algo/temporalDenoise.ts`, `algo/noise.ts`, tests | anything outside `lib/algo` |
| 4 Enhance UI | sonnet | `workers/enhanceWorker.ts`, `services/enhance.svelte.ts`, `services/denoiseProcessor.ts`, `components/EnhancePanel.svelte`, `routes/Gallery.svelte`, `components/Viewer.svelte` (enhance UI), gallery.ts (meta fields, additive), settings (additive), e2e block "enhance" | StreamView, recorder, LUT files |
| 5 Video | sonnet | `services/recorder.svelte.ts`, `services/videoEncoder.ts`, `workers/encodeWorker.ts`, `services/timelapseExport.ts`, `algo/stabilize.ts`, `algo/deflicker.ts`, `services/deflickerProcessor.ts`, `api/mjpegStream.ts`, `components/TimelapseViewer.svelte` (export button only), gallery.ts (video fields, additive), settings (video group), e2e block "video" | StreamView, LUT/enhance files |

Shared files edited by several packages (`store/settings.svelte.ts`, `routes/Settings.svelte`,
`store/gallery.ts`, `e2e/app.mjs`, `components/Viewer.svelte`, `components/TimelapseViewer.svelte`): make
small additive edits, re-read the file immediately before each edit, never rewrite it, and put e2e steps in a
block that starts with `// --- <wp name> ---` appended at the end of `e2e/app.mjs`. Do not run the e2e suite
from an agent (one fake device, one suite at a time); the lead runs it at integration.

## Contracts

### `algo/lut.ts` (WP1)

```ts
export interface Lut1D { size: number; r: Float32Array; g: Float32Array; b: Float32Array; domainMin: [n,n,n]; domainMax: [n,n,n]; title?: string }
export interface Lut3D { size: number; data: Float32Array /* size^3*3, red fastest */; domainMin; domainMax; title?: string }
export type Lut = Lut1D | Lut3D
export function parseLut(text: string | ArrayBuffer, filename?: string): Lut      // sniff by extension then content
export function parseCube(text: string): Lut
export function parse3dl(text: string): Lut3D
export function parseImageJLut(buf: ArrayBuffer | string): Lut1D
export function haldToLut3D(rgba: Uint8ClampedArray, width: number, height: number): Lut3D
export function parseCsvRamp(text: string): Lut1D
export function identity1D(size?: number): Lut1D; export function identity3D(size?: number): Lut3D
export function lut1DFromStops(stops: Array<[pos: number, rgb: [n,n,n]]>, size = 256, interp?: 'linear'|'catmullRom'): Lut1D
export function sample1D(l: Lut1D, r: number, g: number, b: number, out: Float32Array | number[], o = 0): void
export function sampleTetra(l: Lut3D, r, g, b, out, o = 0): void  // tetrahedral
export function sampleTrilinear(l: Lut3D, r, g, b, out, o = 0): void
export interface Look { curve?: Lut1D; cube?: Lut3D; strength: number /*0..1*/; input: 'srgb'|'linear'; pseudo: boolean /* map luminance through curve */; invert: boolean }
export function applyLookRgba(src: Uint8ClampedArray, dst: Uint8ClampedArray, look: Look): void        // 8-bit, with a 256-entry cache for 1D-only looks
export function applyLookFloat(src: Float32Array, dst: Float32Array, look: Look): void               // 0..1 interleaved RGB
export function bakeLook(look: Look, size = 33): Lut3D                                              // for the GPU path and export
export function toCube(l: Lut, title?: string): string
export function lutTo3DTexture(l: Lut3D): { size: number; data: Float32Array /* RGB float, red fastest */ }
```
`algo/curves.ts`: `monotoneCubic(points: [x,y][]) => (x:number)=>number`, `catmullRom`, `curveToLut1D(...)`,
`levelsToLut1D(black, white, gamma)`, `composeLut1D(a, b)`; `bakeAdjustments({ curves, levels, saturation, vibrance, hue, channelMixer }) => Lut3D`.
`algo/colormaps.ts`: `export const COLORMAPS: Record<string, { name: string; group: 'scientific'|'imagej'|'basic'; licence: string; build(): Lut1D }>` including grays, viridis, magma, inferno, plasma, cividis, fire, ice, spectrum, hilo, red, green, blue, cyan, magenta, yellow, `16 colors`, `3-3-2 RGB`, phase, glasbey-lite (generated), plus `colormapPreview(name, width)` returning RGBA bytes.

### `algo/denoise.ts`, `algo/noise.ts`, `algo/enhance.ts`, `algo/pipeline.ts` (WP3)

```ts
// noise.ts
export function estimateSigmaMad(plane: Float32Array, w: number, h: number): number         // HH wavelet MAD / 0.6745
export interface NoiseModel { gain: number /* e-/DN or DN variance per DN */; readSigma: number; black: number; white: number }
export function anscombe(plane: Float32Array, m: NoiseModel): Float32Array; export function anscombeInverse(...)  // generalised, unbiased inverse
// denoise.ts
export interface Plane { data: Float32Array; width: number; height: number }
export type DenoiseMethod = 'wavelet' | 'nlm' | 'guided' | 'bilateral' | 'none'
export interface DenoiseParams { method: DenoiseMethod; strength: number /* 0..2, scales sigma */; sigma?: number /* absolute, 0..1 units; undefined = estimate */; chroma: number /* extra chroma smoothing 0..1 */; patch?: number; search?: number }
export function denoisePlane(p: Plane, params: DenoiseParams, sigma: number): Plane
export function denoiseRgb(planes: { r,g,b }, params: DenoiseParams, sigmaHint?: number): { r,g,b }  // luma/chroma split (YCbCr), chroma via guided filter
export function waveletShrink(p: Plane, sigma: number, o?: { levels?: number; rule?: 'bayes'|'sure'|'soft' }): Plane
export function nlmFast(p: Plane, sigma: number, o?: { patch?: number; search?: number; h?: number }): Plane
export function guidedFilter(p: Plane, guide: Plane, radius: number, eps: number): Plane
export function bilateral(p: Plane, sigmaS: number, sigmaR: number): Plane
export function boxFilter(p: Plane, radius: number): Plane; export function gaussianBlur(p: Plane, sigma: number): Plane   // separable, reused everywhere
// temporalDenoise.ts
export class TemporalDenoiser { constructor(o: { alpha: number; maxShiftPx: number; spatial?: DenoiseParams }); push(rgba: Uint8ClampedArray, w, h, shiftPx?: {dx,dy}): Uint8ClampedArray; reset(): void }
// enhance.ts
export function clahe(luma: Plane, o: { tiles: number; clip: number; bins?: number }): Plane
export function unsharpMask(p: Plane, o: { radius: number; amount: number; threshold: number }): Plane
export function edgeAwareSharpen(p: Plane, o: { radius: number; amount: number; eps: number }): Plane
export function autoLevels(planes, o: { lowPct: number; highPct: number; perChannel: boolean }): planes
export function pseudoFlatField(planes, sigma: number): planes
export function vignetteCorrect(planes, o: { a: number; b: number; c: number; cx?: number; cy?: number }): planes
export function chromaticAberration(planes, o: { red: number; blue: number }): planes   // radial scale
export function colourDeconvolve(rgb, stains: 'he' | 'hdab' | [[..],[..],[..]]): { c1: Plane; c2: Plane; c3: Plane }
export function saturationVibrance(planes, o: { saturation: number; vibrance: number }): planes
export function shadowsHighlights(planes, o: { shadows: number; highlights: number; radius: number }): planes
export function filmic(planes, o: { contrast: number; white: number }): planes
export function rgbToYcbcr / ycbcrToRgb (float planes)
// pipeline.ts
export interface EnhanceParams { flatField?: {sigma}; vignette?; ca?; denoise?: DenoiseParams; deconvolve?: { method:'rl'|'wiener'; sigma: number; iterations: number; noise?: number }; autoLevels?; shadowsHighlights?; filmic?; colour?: { saturation; vibrance }; sharpen?: { mode:'unsharp'|'edge'; radius; amount; threshold }; clahe?: { tiles; clip }; look?: Look }
export const DEFAULT_ENHANCE: EnhanceParams
export function developPipeline(input: { data: Uint8ClampedArray | Uint16Array; width; height; linear: boolean /* true for 16-bit linear RGB from rawdev */; noise?: NoiseModel }, params: EnhanceParams, onProgress?: (stage: string, frac: number) => void): { data: Uint8ClampedArray | Uint16Array; width; height }
```
All functions pure, allocation-conscious (reuse buffers where cheap), and tested with synthetic images
(PSNR improves on a noisy ramp; CLAHE increases local contrast; sharpen raises Laplacian variance; the
pipeline is idempotent with `DEFAULT_ENHANCE` (identity)). Target: 1 MP through wavelet + CLAHE + sharpen
under ~400 ms on a laptop in a worker.

### Frame chain processors (WP2, WP4, WP5)

`services/lookProcessor.ts` (WP2): order 900, enabled(view) when `look.active`, enabled(record) when
`look.active && settings.lookBakeIntoRecording`, enabled(playback) when `look.active`. GPU path when the
input is a `CanvasImageSource` and WebGL2 exists; CPU `applyLookRgba` otherwise.
`services/denoiseProcessor.ts` (WP4): order 100, `TemporalDenoiser` fed with the stage shift since the
previous frame (`device` position events × CSM calibration when calibrated, else 0 and reset on `device.moving`).
`services/deflickerProcessor.ts` (WP5): order 50, per-frame gain normalisation with an EMA of luma.
Stabilisation stays inside the recorder (it needs the crop margin) but uses the improved `algo/stabilize.ts`.

### Recorder (WP5)

`RecorderOptions` grows: `container: 'mp4' | 'webm'`, `codec: 'h264' | 'vp9' | 'av1' | 'auto'`,
`quality: 'high' | 'medium' | 'low' | { bitrateMbps }`, `keyframeS`, `stabilize`, `deflicker`. Result item
meta: codec string, container, bitrate, fps (measured), frames encoded / dropped-by-queue / duplicated, and
the existing per-frame log. `saveVideo` gets the blob with the right MIME. Fallback path keeps the old
MediaRecorder behaviour and fixes the WebM duration. Time-lapse export: `services/timelapseExport.ts`
`exportTimelapse(item, { fps, codec, quality, look? }) => Blob` in `workers/encodeWorker.ts` using
`VideoEncoder` + mediabunny; a button in TimelapseViewer downloads it with `algo/naming.ts` names.

## Acceptance

`cd webapp && npm run check && npx vitest --run && npm run build` clean; new unit tests for every algo file;
e2e steps for: pick a built-in LUT and see the live canvas change; upload a .cube; enhance a gallery photo
and save it; record 3 s of video with the look baked and see an mp4 item; export a time-lapse to mp4. The lead
runs the full e2e once all packages are merged.
