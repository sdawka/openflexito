/** Motion-compensated recursive temporal denoise for live video (`docs/image-pipeline/design.md`
 *  WP3). Unlike optical-flow-based video denoisers, openflexito knows the stage displacement between
 *  frames from the device's own position events (via the CSM calibration) or, failing that, the
 *  phase-correlation shift from `algo/register.ts` — so no per-frame flow estimation is needed here;
 *  the caller supplies `shiftPx` and this module only warps and blends.
 *
 *  `out = α·warp(prev, shift) + (1-α)·cur`, with a per-pixel confidence that pulls the *effective* α
 *  toward 0 where `|cur - warp(prev)|` exceeds `k·σ` (σ from `cur`'s luma via `estimateSigmaMad`, `k`
 *  fixed at 3): a genuinely moving object, an occlusion edge or a bad shift estimate shows up as a
 *  large residual after warping and is left un-blended (no ghosting) instead of being smeared into the
 *  composite. `maxShiftPx` guards against a wildly wrong shift (e.g. a stage jump reported as a huge
 *  displacement, or a scene cut) by skipping the blend entirely for that frame — the recursive state
 *  still updates from the unblended current frame, so a real large motion self-heals in one frame
 *  rather than corrupting the history.
 *
 *  σ is a scene-noise-floor estimate, not something that swings frame to frame, so it is only
 *  re-measured every `sigmaRefreshFrames` frames (default 8, or immediately after `reset()`) and
 *  cached in between: at 1640x1232 the MAD estimate's HH subband is ~500k coefficients, and even with
 *  `estimateSigmaMad`'s O(n) sort-free median (see `noise.ts`) that is measurable cost to pay every
 *  single frame for a value that does not actually change that fast. The per-frame blend loop itself
 *  is always exactly one pass over the RGBA buffer with no allocation. */

import type { DenoiseParams } from './denoise'
import { denoiseRgb } from './denoise'
import { estimateSigmaMad } from './noise'
import type { Plane } from './exposureFuse'

export interface TemporalDenoiserOptions {
  /** Base blend weight toward history, 0..1 (0.7-0.9 typical); scaled per-pixel by confidence. */
  alpha: number
  /** Displacement magnitude (px, either axis) beyond which a frame is treated as unrelated to the
   *  last one (scene cut / bad shift estimate) and the blend is skipped for that frame only. */
  maxShiftPx: number
  /** Optional spatial pre-denoise of the *current* frame before it enters the recursive blend
   *  (reduces the noise the temporal filter has to average out, at the cost of running a full spatial
   *  denoiser every frame — heavier than the temporal blend itself, so keep `method`/`strength` light
   *  for a live path, e.g. a small-radius guided filter rather than NLM). */
  spatial?: DenoiseParams
  /** Re-estimate σ (the confidence gate's noise floor) every this-many frames instead of every frame;
   *  the cached value is reused in between. Default 8. Re-estimated immediately after `reset()`. */
  sigmaRefreshFrames?: number
}

const CONFIDENCE_K = 3 // motion/ghost gate: |diff| > k*sigma starts pulling confidence toward 0

function warpBilinear(src: Uint8ClampedArray, w: number, h: number, dx: number, dy: number, out: Uint8ClampedArray): void {
  for (let y = 0; y < h; y++) {
    const sy = y - dy
    const y0 = Math.floor(sy), ty = sy - y0
    const cy0 = Math.min(h - 1, Math.max(0, y0)), cy1 = Math.min(h - 1, Math.max(0, y0 + 1))
    for (let x = 0; x < w; x++) {
      const sx = x - dx
      const x0 = Math.floor(sx), tx = sx - x0
      const cx0 = Math.min(w - 1, Math.max(0, x0)), cx1 = Math.min(w - 1, Math.max(0, x0 + 1))
      const p00 = (cy0 * w + cx0) * 4, p10 = (cy0 * w + cx1) * 4, p01 = (cy1 * w + cx0) * 4, p11 = (cy1 * w + cx1) * 4
      const o = (y * w + x) * 4
      for (let c = 0; c < 4; c++) {
        out[o + c] = (src[p00 + c] * (1 - tx) + src[p10 + c] * tx) * (1 - ty) + (src[p01 + c] * (1 - tx) + src[p11 + c] * tx) * ty
      }
    }
  }
}

/** Recursive motion-compensated temporal denoiser. `push` is allocation-free after the first frame
 *  (all working buffers are sized on the first call and reused) except for `spatial`, which is an
 *  optional heavier path that allocates through `denoiseRgb`. */
export class TemporalDenoiser {
  private alpha: number
  private maxShiftPx: number
  private spatial?: DenoiseParams
  private sigmaRefreshFrames: number
  private prev: Uint8ClampedArray | null = null
  private prevW = 0
  private prevH = 0
  private out: Uint8ClampedArray | null = null
  private warped: Uint8ClampedArray | null = null
  private lumaScratch: Float32Array | null = null
  private cachedSigma: number | null = null
  private frameCount = 0

  constructor(o: TemporalDenoiserOptions) {
    this.alpha = o.alpha
    this.maxShiftPx = o.maxShiftPx
    this.spatial = o.spatial
    this.sigmaRefreshFrames = Math.max(1, o.sigmaRefreshFrames ?? 8)
  }

  reset(): void {
    this.prev = null
    this.prevW = 0
    this.prevH = 0
    this.cachedSigma = null
    this.frameCount = 0
  }

  push(rgba: Uint8ClampedArray, w: number, h: number, shiftPx?: { dx: number; dy: number }): Uint8ClampedArray {
    const n = w * h
    if (!this.out || this.out.length !== rgba.length) {
      this.out = new Uint8ClampedArray(rgba.length)
      this.warped = new Uint8ClampedArray(rgba.length)
      this.lumaScratch = new Float32Array(n)
    }
    const cur = this.spatial ? this.applySpatial(rgba, w, h) : rgba

    if (!this.prev || this.prevW !== w || this.prevH !== h) {
      this.out.set(cur)
      if (!this.prev || this.prev.length !== rgba.length) this.prev = new Uint8ClampedArray(rgba.length)
      this.prev.set(this.out)
      this.prevW = w; this.prevH = h
      return this.out
    }

    const dx = shiftPx?.dx ?? 0, dy = shiftPx?.dy ?? 0
    if (Math.abs(dx) > this.maxShiftPx || Math.abs(dy) > this.maxShiftPx) {
      this.out.set(cur)
      this.prev.set(this.out)
      return this.out
    }

    warpBilinear(this.prev, w, h, dx, dy, this.warped!)

    if (this.cachedSigma === null || this.frameCount % this.sigmaRefreshFrames === 0) {
      for (let i = 0; i < n; i++) this.lumaScratch![i] = 0.299 * cur[i * 4] + 0.587 * cur[i * 4 + 1] + 0.114 * cur[i * 4 + 2]
      this.cachedSigma = Math.max(1, estimateSigmaMad(this.lumaScratch!, w, h))
    }
    this.frameCount++
    const kSigma = CONFIDENCE_K * this.cachedSigma

    for (let i = 0; i < n; i++) {
      const p = i * 4
      const cr = cur[p], cg = cur[p + 1], cb = cur[p + 2]
      const wr = this.warped![p], wg = this.warped![p + 1], wb = this.warped![p + 2]
      const curLuma = 0.299 * cr + 0.587 * cg + 0.114 * cb
      const warpLuma = 0.299 * wr + 0.587 * wg + 0.114 * wb
      const diff = Math.abs(curLuma - warpLuma)
      const conf = diff <= kSigma ? 1 : Math.max(0, 1 - (diff - kSigma) / kSigma)
      const a = this.alpha * conf
      this.out[p] = a * wr + (1 - a) * cr
      this.out[p + 1] = a * wg + (1 - a) * cg
      this.out[p + 2] = a * wb + (1 - a) * cb
      this.out[p + 3] = cur[p + 3]
    }
    this.prev.set(this.out)
    return this.out
  }

  private applySpatial(rgba: Uint8ClampedArray, w: number, h: number): Uint8ClampedArray {
    const n = w * h
    const r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n)
    for (let i = 0; i < n; i++) { const p = i * 4; r[i] = rgba[p] / 255; g[i] = rgba[p + 1] / 255; b[i] = rgba[p + 2] / 255 }
    const rp: Plane = { data: r, width: w, height: h }, gp: Plane = { data: g, width: w, height: h }, bp: Plane = { data: b, width: w, height: h }
    const dn = denoiseRgb({ r: rp, g: gp, b: bp }, this.spatial!)
    const out = new Uint8ClampedArray(rgba.length)
    for (let i = 0; i < n; i++) {
      const p = i * 4
      out[p] = dn.r.data[i] * 255; out[p + 1] = dn.g.data[i] * 255; out[p + 2] = dn.b.data[i] * 255; out[p + 3] = rgba[p + 3]
    }
    return out
  }
}
