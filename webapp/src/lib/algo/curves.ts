/** Spline evaluators for user-drawn tone curves, and the adjustment stack (`bakeAdjustments`) that
 *  turns curves/levels/saturation/vibrance/hue/channel-mixer settings into a single baked 3D LUT for
 *  `Look.cube`. Pure, no DOM access; `algo/lut.ts` supplies the `Lut1D`/`Lut3D` types and samplers. */

import { identity3D, sample1D, type Lut1D, type Lut3D } from './lut'
import { applyCdl, isIdentityCdl, type Cdl } from './cdl'

export type CurveFn = (x: number) => number

/** Monotone cubic Hermite interpolation through `points` (Fritsch–Carlson): unlike a plain cubic or
 *  Catmull-Rom spline, this never overshoots between points, so a tone curve dragged through control
 *  points never introduces a dip/hump that clips or crushes values the user didn't touch. Points need
 *  not be sorted; x values are de-duplicated by keeping the last occurrence. Returns an evaluator
 *  clamped to the first/last point's y outside the point range. */
export function monotoneCubic(points: Array<[number, number]>): CurveFn {
  const pts = dedupeSortByX(points)
  const n = pts.length
  if (n === 0) return (x) => x
  if (n === 1) { const y = pts[0][1]; return () => y }
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  const d: number[] = new Array(n - 1)
  for (let i = 0; i < n - 1; i++) d[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i] || 1e-9)
  const m: number[] = new Array(n)
  m[0] = d[0]; m[n - 1] = d[n - 2]
  for (let i = 1; i < n - 1; i++) m[i] = (d[i - 1] + d[i]) / 2
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue }
    const alpha = m[i] / d[i], beta = m[i + 1] / d[i]
    if (alpha < 0) m[i] = 0
    if (beta < 0) m[i + 1] = 0
    const s = alpha * alpha + beta * beta
    if (s > 9) { const tau = 3 / Math.sqrt(s); m[i] = tau * alpha * d[i]; m[i + 1] = tau * beta * d[i] }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0]
    if (x >= xs[n - 1]) return ys[n - 1]
    let i = 0
    while (i < n - 2 && xs[i + 1] <= x) i++
    const h = xs[i + 1] - xs[i] || 1e-9
    const t = (x - xs[i]) / h
    const t2 = t * t, t3 = t2 * t
    const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2
    return h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1]
  }
}

/** Uniform Catmull-Rom spline through `points` (smoother than monotone cubic but can overshoot near
 *  sharp corners — used for colour-map stops, not tone curves). Endpoints are extended by mirroring
 *  the nearest segment so the spline is defined all the way to the first/last point. */
export function catmullRom(points: Array<[number, number]>): CurveFn {
  const pts = dedupeSortByX(points)
  const n = pts.length
  if (n === 0) return (x) => x
  if (n === 1) { const y = pts[0][1]; return () => y }
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  const at = (i: number): number => ys[i < 0 ? 0 : i >= n ? n - 1 : i]
  return (x: number) => {
    if (x <= xs[0]) return ys[0]
    if (x >= xs[n - 1]) return ys[n - 1]
    let i = 0
    while (i < n - 2 && xs[i + 1] <= x) i++
    const span = xs[i + 1] - xs[i] || 1e-9
    const t = (x - xs[i]) / span
    const t2 = t * t, t3 = t2 * t
    const y0 = at(i - 1), y1 = at(i), y2 = at(i + 1), y3 = at(i + 2)
    return 0.5 * ((2 * y1) + (-y0 + y2) * t + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 + (-y0 + 3 * y1 - 3 * y2 + y3) * t3)
  }
}

function dedupeSortByX(points: Array<[number, number]>): Array<[number, number]> {
  const byX = new Map<number, number>()
  for (const [x, y] of points) byX.set(x, y)
  return [...byX.entries()].sort((a, b) => a[0] - b[0])
}

/** Sample three per-channel curve evaluators (domain and range 0..1) into a `Lut1D`. */
export function curveToLut1D(curveR: CurveFn, curveG: CurveFn, curveB: CurveFn, size = 256): Lut1D {
  const r = new Float32Array(size), g = new Float32Array(size), b = new Float32Array(size)
  for (let i = 0; i < size; i++) {
    const x = i / (size - 1)
    r[i] = curveR(x); g[i] = curveG(x); b[i] = curveB(x)
  }
  return { size, r, g, b, domainMin: [0, 0, 0], domainMax: [1, 1, 1] }
}

/** Classic levels adjustment (Photoshop-style): remap `[black, white]` to `[0, 1]`, then apply a
 *  gamma. Same curve on all three channels. */
export function levelsToLut1D(black: number, white: number, gamma: number, size = 256): Lut1D {
  const evalChannel = (x: number): number => {
    const span = white - black || 1e-9
    const n = (x - black) / span
    const clamped = n < 0 ? 0 : n > 1 ? 1 : n
    return Math.pow(clamped, 1 / (gamma || 1e-9))
  }
  const r = new Float32Array(size), g = new Float32Array(size), b = new Float32Array(size)
  for (let i = 0; i < size; i++) { const v = evalChannel(i / (size - 1)); r[i] = v; g[i] = v; b[i] = v }
  return { size, r, g, b, domainMin: [0, 0, 0], domainMax: [1, 1, 1] }
}

/** Compose two 1D LUTs into one: `out(x) = second(first(x))`, per channel independently. Output
 *  resolution is the larger of the two inputs. */
export function composeLut1D(first: Lut1D, second: Lut1D): Lut1D {
  const size = Math.max(first.size, second.size)
  const r = new Float32Array(size), g = new Float32Array(size), b = new Float32Array(size)
  const tmp1 = new Float32Array(3), tmp2 = new Float32Array(3)
  for (let i = 0; i < size; i++) {
    const x = i / (size - 1)
    sample1D(first, x, x, x, tmp1, 0)
    sample1D(second, tmp1[0], tmp1[1], tmp1[2], tmp2, 0)
    r[i] = tmp2[0]; g[i] = tmp2[1]; b[i] = tmp2[2]
  }
  return { size, r, g, b, domainMin: [0, 0, 0], domainMax: [1, 1, 1] }
}

export interface CurveSet { r?: CurveFn; g?: CurveFn; b?: CurveFn }
export interface LevelsAdjust { black: number; white: number; gamma: number }
export type ChannelMixer = [[number, number, number], [number, number, number], [number, number, number]]

export interface Adjustments {
  /** ASC CDL grade node (`algo/cdl.ts`), applied after the channel mixer and before curves. */
  cdl?: Cdl
  /** Filmic tone curve (`filmicCurve`), same curve on all channels, applied after the CDL and before
   *  the user's curves. */
  filmic?: CurveFn
  curves?: CurveSet
  levels?: LevelsAdjust
  saturation?: number // -1..1, 0 = no change
  vibrance?: number // -1..1, 0 = no change; scales less on already-saturated colours
  hue?: number // degrees, rotates hue in HSL
  channelMixer?: ChannelMixer
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0))
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  return [h / 6, s, l]
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1
  if (t > 1) t -= 1
  if (t < 1 / 6) return p + (q - p) * 6 * t
  if (t < 1 / 2) return q
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
  return p
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)]
}

/** Bake curves, levels, saturation/vibrance, hue rotation and a channel mixer into one 3D LUT
 *  (`Look.cube`). Order: channel mixer, CDL, filmic, per-channel curves, levels, hue rotation, then saturation/
 *  vibrance (luma-preserving: each channel is pulled toward/away from Rec.601 luma, so overall
 *  brightness doesn't shift). With no options set this is exactly `identity3D(size)`. */
export function bakeAdjustments(adj: Adjustments, size = 33): Lut3D {
  const cdl = adj.cdl && !isIdentityCdl(adj.cdl) ? adj.cdl : undefined
  const filmic = adj.filmic
  const hasAny = adj.curves || adj.levels || adj.saturation || adj.vibrance || adj.hue || adj.channelMixer || cdl || filmic
  if (!hasAny) return identity3D(size)

  const mixer = adj.channelMixer
  const cr = adj.curves?.r, cg = adj.curves?.g, cb = adj.curves?.b
  const lv = adj.levels
  const hueDeg = adj.hue ?? 0
  const sat = adj.saturation ?? 0
  const vib = adj.vibrance ?? 0

  const levelsFn = lv ? (x: number): number => {
    const span = lv.white - lv.black || 1e-9
    const n = (x - lv.black) / span
    const clamped = n < 0 ? 0 : n > 1 ? 1 : n
    return Math.pow(clamped, 1 / (lv.gamma || 1e-9))
  } : null

  const data = new Float32Array(size * size * size * 3)
  const cdlTmp = new Float32Array(3)
  let o = 0
  for (let bi = 0; bi < size; bi++) for (let gi = 0; gi < size; gi++) for (let ri = 0; ri < size; ri++) {
    let r = ri / (size - 1), g = gi / (size - 1), b = bi / (size - 1)

    if (mixer) {
      const r2 = mixer[0][0] * r + mixer[0][1] * g + mixer[0][2] * b
      const g2 = mixer[1][0] * r + mixer[1][1] * g + mixer[1][2] * b
      const b2 = mixer[2][0] * r + mixer[2][1] * g + mixer[2][2] * b
      r = r2; g = g2; b = b2
    }
    if (cdl) { applyCdl(cdl, clamp01(r), clamp01(g), clamp01(b), cdlTmp, 0); r = cdlTmp[0]; g = cdlTmp[1]; b = cdlTmp[2] }
    if (filmic) { r = filmic(clamp01(r)); g = filmic(clamp01(g)); b = filmic(clamp01(b)) }
    if (cr) r = cr(clamp01(r))
    if (cg) g = cg(clamp01(g))
    if (cb) b = cb(clamp01(b))
    if (levelsFn) { r = levelsFn(clamp01(r)); g = levelsFn(clamp01(g)); b = levelsFn(clamp01(b)) }

    if (hueDeg) {
      const [h, s, l] = rgbToHsl(clamp01(r), clamp01(g), clamp01(b))
      let h2 = h + hueDeg / 360
      h2 -= Math.floor(h2)
      ;[r, g, b] = hslToRgb(h2, s, l)
    }

    if (sat || vib) {
      r = clamp01(r); g = clamp01(g); b = clamp01(b)
      const luma = 0.299 * r + 0.587 * g + 0.114 * b
      const cmax = Math.max(r, g, b), cmin = Math.min(r, g, b)
      const curSat = cmax - cmin
      const vibFactor = vib * (1 - curSat)
      const factor = 1 + sat + vibFactor
      r = luma + (r - luma) * factor
      g = luma + (g - luma) * factor
      b = luma + (b - luma) * factor
    }

    data[o++] = clamp01(r); data[o++] = clamp01(g); data[o++] = clamp01(b)
  }
  return { size, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1], title: 'baked-adjustments' }
}

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x }

// ---------------------------------------------------------------------------------------------
// Filmic presets (docs/video-research/colour.md proposal 3 + addendum)
// ---------------------------------------------------------------------------------------------

export type FilmicPreset = 'neutral' | 'soft' | 'flat'
export const FILMIC_PRESETS: FilmicPreset[] = ['neutral', 'soft', 'flat']
export const FILMIC_DEFAULT_EXPOSURE = 1.15

function srgbDecode(x: number): number { return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4) }
function srgbEncode(x: number): number { return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055 }

/** Narkowicz's ACES fit (same constants as `enhance.ts#filmic`, duplicated here so `curves.ts` stays
 *  free of the RgbPlanes machinery). Scene-linear in, display-linear 0..1 out. */
function acesFit(x: number): number {
  const a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14
  const y = (x * (a * x + b)) / (x * (c * x + d) + e)
  return y < 0 ? 0 : y > 1 ? 1 : y
}

/** Filmic tone presets as monotone 0..1 → 0..1 curve evaluators, meant for display-referred (sRGB)
 *  input as the live JPEG stream is:
 *   - `neutral`: identity.
 *   - `soft`: sRGB decode → ×exposure → Narkowicz ACES fit → sRGB encode. The fit gives a gentle
 *     shoulder so an LED brightfield background approaches white smoothly instead of hitting a wall;
 *     the exposure scale (default 1.15) puts mid-grey back roughly where it was, since the fit alone
 *     darkens mids. Only meaningful when the capture is a little under-exposed (the research doc
 *     recommends ~0.3–0.5 EV under).
 *   - `flat`: log-ish `log2(1 + k·lin) / log2(1 + k)` with k = 8 on the exposure-scaled linear value,
 *     then sRGB encode. Lifts shadows a lot; on 8-bit input that posterises, so the UI warns.
 *  All presets map 0 → 0; `soft`/`flat` map 1 → slightly below 1 (the fit never quite reaches white
 *  at exposure ≈ 1), which is the intended roll-off. */
export function filmicCurve(preset: FilmicPreset, exposure = FILMIC_DEFAULT_EXPOSURE): CurveFn {
  if (preset === 'neutral') return (x) => x
  const ex = exposure > 1e-6 ? exposure : 1e-6
  if (preset === 'soft') {
    return (x) => clamp01(srgbEncode(acesFit(srgbDecode(clamp01(x)) * ex)))
  }
  const k = 8
  const norm = 1 / Math.log2(1 + k)
  return (x) => clamp01(srgbEncode(clamp01(Math.log2(1 + k * srgbDecode(clamp01(x)) * ex) * norm)))
}

/** `filmicCurve` sampled into a 1D LUT (same curve on all three channels). */
export function filmicLut1D(preset: FilmicPreset, exposure = FILMIC_DEFAULT_EXPOSURE, size = 256): Lut1D {
  const f = filmicCurve(preset, exposure)
  return curveToLut1D(f, f, f, size)
}
