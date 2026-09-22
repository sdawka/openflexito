/** Robustness-weighted drizzle for video super-resolution.
 *
 *  `drizzle()` averages every frame of the window wherever its drops land, so a specimen that moved
 *  between frames is smeared into the output (creative.md §2, "superres feeds blurred frames into
 *  the drizzle window"; addendum "Dithered SR robustness weight"). Wronski et al., *Handheld
 *  multi-frame super-resolution*, ACM ToG 38(4), 2019 §5.2 solve this with a per-pixel *robustness*
 *  weight: compare each frame, warped by its registered shift, with the reference frame; where the
 *  local difference is explained by noise the frame contributes fully, where it exceeds the noise
 *  by a margin (`k·σ`) its contribution falls to zero and the output there degrades gracefully to
 *  the reference frame alone (single-frame upsampling, never a hole).
 *
 *  This file keeps `drizzle.ts` untouched: `robustWeightMap()` computes the weight map on the
 *  (downscaled) grey planes the registration already produced, and `drizzleRobust()` re-implements
 *  the small splat loop with a per-pixel weight lookup. Geometry is identical to `drizzle()`: a
 *  frame's `dx`/`dy` is its shift *from* the reference (frame content = reference content shifted
 *  by (dx, dy)), and the drop of source pixel (x, y) is centred at ((x + 0.5 − dx)·scale,
 *  (y + 0.5 − dy)·scale). The reference is the frame at `refIndex` (default: the last one, the
 *  newest frame in `workers/videoSrWorker.ts`'s window). */

import type { DrizzleFrame, DrizzleResult } from './drizzle'
import type { Gray } from './sharpness'

/** Per-pixel weight in [0, 1] on a grid of its own size (any resolution; sampled nearest). */
export interface WeightMap { data: Float32Array; width: number; height: number }

export interface RobustDrizzleFrame extends DrizzleFrame { weightMap?: WeightMap }

export interface RobustOptions {
  /** Differences above `k·σ` are rejected (σ = robust noise estimate of the differences); the weight
   *  is 1 up to k·σ and falls as a Gaussian to ~0 at 2k·σ. Default 3. */
  k?: number
  /** Floor for σ in grey levels (0..255 scale), so a noiseless synthetic pair does not reject
   *  everything. Default 1. */
  minSigma?: number
  /** Weights below this are clamped to 0 (a rejected frame must contribute nothing, not 1e-9). Default 1e-3. */
  floor?: number
}

export interface RobustWeightResult {
  map: WeightMap
  /** σ used (grey levels) */
  sigma: number
  /** fraction of pixels whose weight fell below 0.5 (down-weighted) */
  rejectedFrac: number
}

function bilinear(g: Gray, x: number, y: number): number {
  const w = g.width, h = g.height
  if (x < 0) x = 0; else if (x > w - 1) x = w - 1
  if (y < 0) y = 0; else if (y > h - 1) y = h - 1
  const x0 = x | 0, y0 = y | 0, x1 = x0 + 1 < w ? x0 + 1 : x0, y1 = y0 + 1 < h ? y0 + 1 : y0
  const tx = x - x0, ty = y - y0
  const d = g.data, r0 = y0 * w, r1 = y1 * w
  return (d[r0 + x0] * (1 - tx) + d[r0 + x1] * tx) * (1 - ty) + (d[r1 + x0] * (1 - tx) + d[r1 + x1] * tx) * ty
}

/** Scratch buffers reused across calls (the worker calls this once per frame per window entry). */
let diffBuf: Float32Array | null = null
let smoothBuf: Float32Array | null = null
let sortBuf: Float32Array | null = null

/** Robustness weight map of `frame` against `ref` (both grey planes of the same size, e.g. the
 *  ≤ 410 px `grayDown` planes the registration used). `dx`/`dy` is the frame's shift from the
 *  reference **in the planes' pixel units**. The difference `frame(x, y) − ref(x − dx, y − dy)`
 *  (bilinear) is box-smoothed 3×3 (Wronski's local statistics, so single noisy pixels are not
 *  rejected), σ = 1.4826·MAD of the smoothed differences over the whole plane (static pixels
 *  dominate, so this is the noise level), and the weight is 1 for |d| ≤ k·σ, then
 *  `exp(−((|d| − kσ)/(kσ/2))²)`, clamped to 0 below `floor`. `out` (optional, `ref.width ×
 *  ref.height`) receives the map so the caller can reuse the allocation. */
export function robustWeightMap(ref: Gray, frame: Gray, dx: number, dy: number, opts: RobustOptions = {}, out?: Float32Array): RobustWeightResult {
  if (ref.width !== frame.width || ref.height !== frame.height) throw new Error('robustWeightMap: planes must have the same size')
  const w = ref.width, h = ref.height, n = w * h
  const k = opts.k ?? 3, minSigma = opts.minSigma ?? 1, floor = opts.floor ?? 1e-3
  if (!diffBuf || diffBuf.length !== n) { diffBuf = new Float32Array(n); smoothBuf = new Float32Array(n); sortBuf = new Float32Array(n) }
  const diff = diffBuf, smooth = smoothBuf!, sort = sortBuf!
  const map = out && out.length === n ? out : new Float32Array(n)
  const fd = frame.data
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) diff[y * w + x] = fd[y * w + x] - bilinear(ref, x - dx, y - dy)
  // 3x3 box of the signed difference (a mover is a coherent patch; noise averages down)
  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : y, yp = y + 1 < h ? y + 1 : y
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : x, xp = x + 1 < w ? x + 1 : x
      smooth[y * w + x] = (
        diff[ym * w + xm] + diff[ym * w + x] + diff[ym * w + xp] +
        diff[y * w + xm] + diff[y * w + x] + diff[y * w + xp] +
        diff[yp * w + xm] + diff[yp * w + x] + diff[yp * w + xp]) / 9
    }
  }
  // robust σ: 1.4826 · median(|d − median(d)|)
  sort.set(smooth); sort.sort()
  const med = sort[n >> 1]
  for (let i = 0; i < n; i++) sort[i] = Math.abs(smooth[i] - med)
  sort.sort()
  const sigma = Math.max(minSigma, 1.4826 * sort[n >> 1])
  const thr = k * sigma, inv = 2 / thr
  let rejected = 0
  for (let i = 0; i < n; i++) {
    const a = Math.abs(smooth[i] - med)
    let wgt = 1
    if (a > thr) { const u = (a - thr) * inv; wgt = Math.exp(-u * u); if (wgt < floor) wgt = 0 }
    map[i] = wgt
    if (wgt < 0.5) rejected++
  }
  return { map: { data: map, width: w, height: h }, sigma, rejectedFrac: rejected / n }
}

function overlap1d(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
}

/** Drizzle RGBA frames onto a `scale`× grid with per-pixel robustness weights. Same footprint
 *  geometry as `drizzle()`; a frame's `weight` (default 1) multiplies its whole contribution and its
 *  `weightMap` (any resolution, sampled nearest) multiplies per source pixel. Output cells that no
 *  drop with a non-zero weight reached are filled from the reference frame's nearest source pixel
 *  (the single-frame-upsampling fallback), so the output never has holes and, where every other
 *  frame is rejected, equals `drizzle([reference])` exactly wherever the reference covers. */
export function drizzleRobust(frames: RobustDrizzleFrame[], scale = 2, pixfrac = 0.5, refIndex = frames.length - 1): DrizzleResult {
  if (!frames.length) throw new Error('drizzleRobust: no frames')
  const { width: w0, height: h0 } = frames[0]
  const W = Math.round(w0 * scale), H = Math.round(h0 * scale)
  const sum = new Float32Array(W * H * 3)
  const weight = new Float32Array(W * H)
  const half = (pixfrac / 2) * scale
  let colIdx: Int32Array | null = null
  for (const f of frames) {
    const { data, width: w, height: h, dx, dy } = f
    const fw = f.weight ?? 1
    if (fw <= 0) continue
    const m = f.weightMap
    if (m) {
      if (!colIdx || colIdx.length !== w) colIdx = new Int32Array(w)
      for (let x = 0; x < w; x++) colIdx[x] = Math.min(m.width - 1, ((x + 0.5) * m.width / w) | 0)
    }
    for (let y = 0; y < h; y++) {
      const oy = (y + 0.5 - dy) * scale
      const y0 = Math.max(0, Math.floor(oy - half)), y1 = Math.min(H, Math.ceil(oy + half))
      if (y1 <= y0) continue
      const mrow = m ? Math.min(m.height - 1, ((y + 0.5) * m.height / h) | 0) * m.width : 0
      for (let x = 0; x < w; x++) {
        const pw = m ? fw * m.data[mrow + colIdx![x]] : fw
        if (pw <= 0) continue
        const ox = (x + 0.5 - dx) * scale
        const x0 = Math.max(0, Math.floor(ox - half)), x1 = Math.min(W, Math.ceil(ox + half))
        if (x1 <= x0) continue
        const si = (y * w + x) * 4
        const r = data[si], g = data[si + 1], b = data[si + 2]
        for (let oyp = y0; oyp < y1; oyp++) {
          const wy = overlap1d(oyp, oyp + 1, oy - half, oy + half)
          if (wy <= 0) continue
          const row = oyp * W
          for (let oxp = x0; oxp < x1; oxp++) {
            const wx = overlap1d(oxp, oxp + 1, ox - half, ox + half)
            if (wx <= 0) continue
            const wgt = wx * wy * pw, oi = row + oxp
            sum[oi * 3] += r * wgt; sum[oi * 3 + 1] += g * wgt; sum[oi * 3 + 2] += b * wgt
            weight[oi] += wgt
          }
        }
      }
    }
  }
  const out = new Uint8ClampedArray(W * H * 4)
  const ref = frames[Math.min(frames.length - 1, Math.max(0, refIndex))]
  let covered = 0
  for (let oy = 0; oy < H; oy++) for (let ox = 0; ox < W; ox++) {
    const i = oy * W + ox, wgt = weight[i]
    if (wgt > 0) {
      out[i * 4] = sum[i * 3] / wgt; out[i * 4 + 1] = sum[i * 3 + 1] / wgt; out[i * 4 + 2] = sum[i * 3 + 2] / wgt; covered++
    } else {
      // hole: nearest reference pixel (invert the drop-centre mapping)
      const sx = Math.min(ref.width - 1, Math.max(0, Math.floor((ox + 0.5) / scale - 0.5 + ref.dx + 0.5)))
      const sy = Math.min(ref.height - 1, Math.max(0, Math.floor((oy + 0.5) / scale - 0.5 + ref.dy + 0.5)))
      const si = (sy * ref.width + sx) * 4
      out[i * 4] = ref.data[si]; out[i * 4 + 1] = ref.data[si + 1]; out[i * 4 + 2] = ref.data[si + 2]
    }
    out[i * 4 + 3] = 255
  }
  return { data: out, width: W, height: H, coverage: covered / (W * H) }
}
