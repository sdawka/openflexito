/** `developPipeline`: runs an `EnhanceParams` object over an image in the canonical order from
 *  `docs/image-pipeline/design.md` (WP3). Linear-light steps (pseudo-flat-field, vignette, chromatic
 *  aberration, denoise, deconvolution, filmic) run first, on a decoded-to-linear copy when the input
 *  is display-referred sRGB and any of those stages is requested; the result is then encoded back to
 *  sRGB and the display-space steps (auto-levels, shadows/highlights, colour, sharpen, CLAHE, look)
 *  run on that. Every stage is opt-in: an `undefined` param skips the stage entirely (no allocation,
 *  no work), so `DEFAULT_ENHANCE` (everything undefined) is a byte-exact identity — checked directly
 *  by returning the input untouched rather than round-tripping it through float planes.
 *
 *  Deviation from the design doc's written order: the doc lists `filmic` after `autoLevels` /
 *  `shadowsHighlights` (i.e. in display space) but its own prose flags that as wrong and says filmic
 *  belongs in linear space just before the sRGB encode — this implementation follows that correction
 *  (filmic runs with the other linear-light stages, immediately before encoding). */

import type { RgbPlanes, Plane } from './exposureFuse'
import { planesToInterleaved, interleavedToPlanes } from './exposureFuse'
import type { DenoiseParams } from './denoise'
import { denoiseRgb } from './denoise'
import type { NoiseModel } from './noise'
import { anscombe, anscombeInverse, estimateSigmaMad } from './noise'
import {
  pseudoFlatField, vignetteCorrect, chromaticAberration, autoLevels, shadowsHighlights,
  saturationVibrance, filmic, clahe, unsharpMask, edgeAwareSharpen, rgbToYcbcr, ycbcrToRgb,
} from './enhance'
import { wiener, richardsonLucy, makePsf } from './deconvolve'
import type { Look } from './lut'
import { applyLookFloat } from './lut'

export interface EnhanceParams {
  flatField?: { sigma: number }
  vignette?: { a: number; b: number; c: number; cx?: number; cy?: number }
  ca?: { red: number; blue: number }
  denoise?: DenoiseParams
  deconvolve?: { method: 'rl' | 'wiener'; sigma: number; iterations: number; noise?: number }
  autoLevels?: { lowPct: number; highPct: number; perChannel: boolean }
  shadowsHighlights?: { shadows: number; highlights: number; radius: number }
  filmic?: { contrast: number; white: number }
  colour?: { saturation: number; vibrance: number }
  sharpen?: { mode: 'unsharp' | 'edge'; radius: number; amount: number; threshold: number }
  clahe?: { tiles: number; clip: number }
  look?: Look
}

export const DEFAULT_ENHANCE: EnhanceParams = {}

export interface DevelopInput {
  data: Uint8ClampedArray | Uint16Array
  width: number
  height: number
  /** true: `data` is 16-bit linear RGB (interleaved, 0..65535, e.g. from `rawdev.developLinear` scaled
   *  to 16 bits). false/undefined: `data` is 8-bit display-referred sRGB RGBA. */
  linear?: boolean
  /** Sensor noise model (from the RAW trailer); when given, `denoise` runs through the generalised
   *  Anscombe transform instead of a blind MAD sigma estimate. */
  noise?: NoiseModel
}
export interface DevelopOutput {
  data: Uint8ClampedArray | Uint16Array
  width: number
  height: number
}

function isIdentity(p: EnhanceParams): boolean {
  return !p.flatField && !p.vignette && !p.ca && !p.denoise && !p.deconvolve && !p.autoLevels
    && !p.shadowsHighlights && !p.filmic && !p.colour && !p.sharpen && !p.clahe && !p.look
}

function srgbEncode(v: number): number { return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055 }
function srgbDecode(v: number): number { return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }

function mapPlanes(planes: RgbPlanes, f: (v: number) => number): RgbPlanes {
  const n = planes.width * planes.height
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n)
  for (let i = 0; i < n; i++) { r[i] = f(planes.r[i]); g[i] = f(planes.g[i]); b[i] = f(planes.b[i]) }
  return { r, g, b, width: planes.width, height: planes.height }
}

function inputToPlanes(input: DevelopInput): { planes: RgbPlanes; alpha?: Uint8ClampedArray } {
  const { data, width, height } = input
  const n = width * height
  const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n)
  if (data instanceof Uint16Array) {
    for (let i = 0, p = 0; i < n; i++, p += 3) { r[i] = data[p] / 65535; g[i] = data[p + 1] / 65535; b[i] = data[p + 2] / 65535 }
    return { planes: { r, g, b, width, height } }
  }
  const alpha = new Uint8ClampedArray(n)
  for (let i = 0, p = 0; i < n; i++, p += 4) { r[i] = data[p] / 255; g[i] = data[p + 1] / 255; b[i] = data[p + 2] / 255; alpha[i] = data[p + 3] }
  return { planes: { r, g, b, width, height }, alpha }
}
function planesToOutput(planes: RgbPlanes, as16: boolean, alpha?: Uint8ClampedArray): DevelopOutput {
  const n = planes.width * planes.height
  if (as16) {
    const out = new Uint16Array(n * 3)
    for (let i = 0, p = 0; i < n; i++, p += 3) {
      out[p] = Math.round(Math.min(1, Math.max(0, planes.r[i])) * 65535)
      out[p + 1] = Math.round(Math.min(1, Math.max(0, planes.g[i])) * 65535)
      out[p + 2] = Math.round(Math.min(1, Math.max(0, planes.b[i])) * 65535)
    }
    return { data: out, width: planes.width, height: planes.height }
  }
  const out = new Uint8ClampedArray(n * 4)
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    out[p] = Math.round(Math.min(1, Math.max(0, planes.r[i])) * 255)
    out[p + 1] = Math.round(Math.min(1, Math.max(0, planes.g[i])) * 255)
    out[p + 2] = Math.round(Math.min(1, Math.max(0, planes.b[i])) * 255)
    out[p + 3] = alpha ? alpha[i] : 255
  }
  return { data: out, width: planes.width, height: planes.height }
}

function denoiseWithModel(planes: RgbPlanes, params: DenoiseParams, model: NoiseModel): RgbPlanes {
  const scale = Math.max(1, model.white - model.black)
  const toDn: Plane[] = [planes.r, planes.g, planes.b].map((p) => ({ data: Float32Array.from(p, (v) => v * scale), width: planes.width, height: planes.height }))
  const z = toDn.map((p) => ({ data: anscombe(p.data, model), width: p.width, height: p.height }))
  const dn = denoiseRgb({ r: z[0], g: z[1], b: z[2] }, params)
  const inv = [dn.r, dn.g, dn.b].map((p) => anscombeInverse(p.data, model))
  const from = (a: Float32Array): Float32Array => Float32Array.from(a, (v) => Math.min(1, Math.max(0, v / scale)))
  return { r: from(inv[0]), g: from(inv[1]), b: from(inv[2]), width: planes.width, height: planes.height }
}

// Deconvolution's FFT (fft2d in fft.ts) pads to the next power of two of max(width, height, psfSize),
// so a full-plane pass on a large photo is prohibitively expensive: at 3280x2464 that's a 4096x4096
// Float64 transform per channel per FFT call (richardsonLucy does 4 per iteration) — minutes of CPU
// and ~1GB of scratch buffers. Above DECONV_TILE_MAX in either dimension, the plane is instead
// processed in tiles with a reflect-padded overlap of >= 6*sigma + psfSize (enough that the tile's own
// FFT-domain PSF support cannot "see" past the overlap into the discarded region), each tile
// deconvolved independently and only its interior copied back — the same well-known overlap-and-
// discard scheme block-processed convolution/deconvolution has always used to bound FFT size. Small
// planes (the common case: gallery previews, live-view crops) take the original single-pass path
// unchanged.
//
// The tile's interior size is chosen so `interior + 2*overlap` lands on (not just under) the target
// FFT grid `DECONV_TARGET_N`: since the FFT pads to the *next* power of two, picking an interior that
// leaves the padded tile just over a power-of-two boundary (e.g. 512 + a few px of overlap -> 1024)
// silently doubles every transform's cost for no benefit. `psfSizeFor` similarly keeps the PSF grid no
// bigger than the sigma actually needs (a sigma=1.5 blur doesn't need a fixed 64x64 kernel), since the
// PSF size feeds directly into the overlap and thus into how much of `DECONV_TARGET_N` is "wasted" on
// redundant border context rather than new interior pixels.
const DECONV_TARGET_N = 512
const DECONV_TILE_MAX = 512

function psfSizeFor(sigma: number): number {
  const need = Math.max(16, Math.ceil(sigma * 8))
  let n = 16
  while (n < need) n *= 2
  return n
}

function reflectIdx(i: number, n: number): number {
  if (n <= 1) return 0
  const period = 2 * (n - 1)
  const m = ((i % period) + period) % period
  return m >= n ? period - m : m
}

function runDeconvChannel(data: Float32Array, width: number, height: number, method: 'rl' | 'wiener', psf: Float64Array, psfSize: number, iterations: number, noise: number): Float32Array {
  const img = { data, width, height }
  return method === 'wiener' ? wiener(img, psf, psfSize, noise) : richardsonLucy(img, psf, psfSize, iterations)
}

/** Extracts a `tw`x`th` tile at `(tx0,ty0)` plus `overlap` px of reflect-101-extended context on every
 *  side (so a tile at the image border still gets real, mirrored content instead of a zero/edge
 *  smear), as one padded `Float32Array`. */
function extractPaddedTile(data: Float32Array, width: number, height: number, tx0: number, ty0: number, tw: number, th: number, overlap: number): { data: Float32Array; width: number; height: number } {
  const padW = tw + 2 * overlap, padH = th + 2 * overlap
  const out = new Float32Array(padW * padH)
  for (let y = 0; y < padH; y++) {
    const sy = reflectIdx(ty0 - overlap + y, height)
    const srow = sy * width, orow = y * padW
    for (let x = 0; x < padW; x++) out[orow + x] = data[srow + reflectIdx(tx0 - overlap + x, width)]
  }
  return { data: out, width: padW, height: padH }
}

function deconvolveChannelTiled(
  data: Float32Array, width: number, height: number, method: 'rl' | 'wiener', psf: Float64Array, psfSize: number,
  iterations: number, noise: number, overlap: number, tileInterior: number,
): Float32Array {
  if (width <= DECONV_TILE_MAX && height <= DECONV_TILE_MAX) return runDeconvChannel(data, width, height, method, psf, psfSize, iterations, noise)
  const out = new Float32Array(width * height)
  for (let ty0 = 0; ty0 < height; ty0 += tileInterior) {
    const th = Math.min(tileInterior, height - ty0)
    for (let tx0 = 0; tx0 < width; tx0 += tileInterior) {
      const tw = Math.min(tileInterior, width - tx0)
      const tile = extractPaddedTile(data, width, height, tx0, ty0, tw, th, overlap)
      const result = runDeconvChannel(tile.data, tile.width, tile.height, method, psf, psfSize, iterations, noise)
      for (let y = 0; y < th; y++) {
        const srow = (overlap + y) * tile.width + overlap, drow = (ty0 + y) * width + tx0
        for (let x = 0; x < tw; x++) out[drow + x] = result[srow + x]
      }
    }
  }
  return out
}

function deconvolveRgb(planes: RgbPlanes, o: { method: 'rl' | 'wiener'; sigma: number; iterations: number; noise?: number }): RgbPlanes {
  const psfSize = psfSizeFor(o.sigma)
  const psf = makePsf(psfSize, { sigma: o.sigma })
  const overlap = Math.ceil(6 * o.sigma) + psfSize
  const tileInterior = Math.max(64, DECONV_TARGET_N - 2 * overlap)
  const run = (data: Float32Array): Float32Array =>
    deconvolveChannelTiled(data, planes.width, planes.height, o.method, psf, psfSize, o.iterations, o.noise ?? 0.01, overlap, tileInterior)
  return { r: run(planes.r), g: run(planes.g), b: run(planes.b), width: planes.width, height: planes.height }
}

function sharpenLuma(planes: RgbPlanes, o: { mode: 'unsharp' | 'edge'; radius: number; amount: number; threshold: number }): RgbPlanes {
  const { y, cb, cr } = rgbToYcbcr(planes)
  const yOut = o.mode === 'unsharp' ? unsharpMask(y, { radius: o.radius, amount: o.amount, threshold: o.threshold })
    : edgeAwareSharpen(y, { radius: o.radius, amount: o.amount, eps: Math.max(1e-6, o.threshold) })
  return ycbcrToRgb({ y: yOut, cb, cr })
}
function claheLuma(planes: RgbPlanes, o: { tiles: number; clip: number }): RgbPlanes {
  const { y, cb, cr } = rgbToYcbcr(planes)
  const yOut = clahe(y, { tiles: o.tiles, clip: o.clip })
  return ycbcrToRgb({ y: yOut, cb, cr })
}

/** Runs `params` over `input` in the canonical order (see module doc). `onProgress(stage, frac)` is
 *  called once per stage that actually runs (`frac` cumulative 0..1 across the stages that will run,
 *  not the full potential list), in execution order. */
export function developPipeline(input: DevelopInput, params: EnhanceParams, onProgress?: (stage: string, frac: number) => void): DevelopOutput {
  if (isIdentity(params)) {
    const data = input.data instanceof Uint16Array ? input.data.slice() : (input.data as Uint8ClampedArray).slice()
    return { data, width: input.width, height: input.height }
  }

  const as16 = input.data instanceof Uint16Array
  const { planes: inputPlanes, alpha } = inputToPlanes(input)

  const needsLinearStage = !!(params.flatField || params.vignette || params.ca || params.denoise || params.deconvolve || params.filmic)
  const wasEncoded = !input.linear // true if input.data is sRGB-encoded (needs decode before linear-light stages)
  let planes = needsLinearStage && wasEncoded ? mapPlanes(inputPlanes, srgbDecode) : inputPlanes

  type Stage = [string, () => void]
  const linearStages: Stage[] = []
  if (params.flatField) linearStages.push(['flatField', () => { planes = pseudoFlatField(planes, params.flatField!.sigma) }])
  if (params.vignette) linearStages.push(['vignette', () => { planes = vignetteCorrect(planes, params.vignette!) }])
  if (params.ca) linearStages.push(['ca', () => { planes = chromaticAberration(planes, params.ca!) }])
  if (params.denoise) linearStages.push(['denoise', () => {
    planes = input.noise ? denoiseWithModel(planes, params.denoise!, input.noise)
      : denoiseRgbPlanes(planes, params.denoise!)
  }])
  if (params.deconvolve) linearStages.push(['deconvolve', () => { planes = deconvolveRgb(planes, params.deconvolve!) }])
  if (params.filmic) linearStages.push(['filmic', () => { planes = filmic(planes, params.filmic!) }])

  const displayStages: Stage[] = []
  if (params.autoLevels) displayStages.push(['autoLevels', () => { planes = autoLevels(planes, params.autoLevels!) }])
  if (params.shadowsHighlights) displayStages.push(['shadowsHighlights', () => { planes = shadowsHighlights(planes, params.shadowsHighlights!) }])
  if (params.colour) displayStages.push(['colour', () => { planes = saturationVibrance(planes, params.colour!) }])
  if (params.sharpen) displayStages.push(['sharpen', () => { planes = sharpenLuma(planes, params.sharpen!) }])
  if (params.clahe) displayStages.push(['clahe', () => { planes = claheLuma(planes, params.clahe!) }])
  if (params.look) displayStages.push(['look', () => {
    const interleaved = planesToInterleaved(planes)
    const out = new Float32Array(interleaved.length)
    applyLookFloat(interleaved, out, params.look!)
    planes = interleavedToPlanes(out, planes.width, planes.height)
  }])

  const total = linearStages.length + displayStages.length
  let done = 0
  for (const [name, run] of linearStages) { run(); done++; onProgress?.(name, done / total) }
  if (needsLinearStage && wasEncoded) planes = mapPlanes(planes, srgbEncode)
  else if (!wasEncoded && displayStages.length > 0) planes = mapPlanes(planes, srgbEncode) // 16-bit linear input entering display-space stages
  for (const [name, run] of displayStages) { run(); done++; onProgress?.(name, done / total) }

  return planesToOutput(planes, as16, alpha)
}

// Thin wrapper kept separate from denoiseWithModel so the "no NoiseModel" path stays a one-liner call
// into denoise.ts's own RgbPlanes-shaped API without an extra plane-wrapping layer duplicated here.
function denoiseRgbPlanes(planes: RgbPlanes, params: DenoiseParams): RgbPlanes {
  const wrap = (p: Float32Array): Plane => ({ data: p, width: planes.width, height: planes.height })
  const sigma = estimateSigmaMad(planes.r, planes.width, planes.height)
  const dn = denoiseRgb({ r: wrap(planes.r), g: wrap(planes.g), b: wrap(planes.b) }, params, sigma)
  return { r: dn.r.data, g: dn.g.data, b: dn.b.data, width: planes.width, height: planes.height }
}
