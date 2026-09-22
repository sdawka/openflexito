/** Software binning of RGBA frames for video: `factor`×`factor` blocks → one output pixel.
 *
 *  What it buys on the Pi's 8-bit ISP/JPEG stream: read noise and JPEG ringing average down by
 *  ~factor (2×2 ≈ halves σ), the encoder gets a quarter of the pixels (much lower bitrate for the
 *  same visual quality, or the same bitrate with far fewer compression artefacts), and a dim
 *  fluorescence view becomes usable. It cannot recover dynamic range the sensor already clipped.
 *
 *  Two kernels:
 *  - `mean`: the plain box mean (what a sensor's charge binning does).
 *  - `edge`: an edge-aware mean — inside each block, pixels are weighted by how close their luma is to
 *    the block's central pixel (a one-block bilateral filter, σ from the block's own spread), so a
 *    sharp edge that cuts through a block stays a step instead of a smear. Costs ~2× the mean. */

export type BinKernel = 'mean' | 'edge'

export interface BinnedFrame { data: Uint8ClampedArray; width: number; height: number }

// exp(x) for x in [-16, 0] through a 1024-entry table
const EXP_N = 1024, EXP_T = new Float32Array(EXP_N + 1)
for (let i = 0; i <= EXP_N; i++) EXP_T[i] = Math.exp(-16 * i / EXP_N)
function expLut(x: number): number { if (x >= 0) return 1; if (x <= -16) return EXP_T[EXP_N]; return EXP_T[Math.round(-x / 16 * EXP_N)] }

/** Bilinear upscale of a binned frame back to `w`×`h` (so the recording keeps the source frame size
 *  and every calibration/scale-bar/measurement made on the stream stays valid). */
export function upscaleRgba(src: Uint8ClampedArray, sw: number, sh: number, w: number, h: number, out?: Uint8ClampedArray): BinnedFrame {
  if (!out || out.length !== w * h * 4) out = new Uint8ClampedArray(w * h * 4)
  const fx = sw / w, fy = sh / h
  for (let y = 0; y < h; y++) {
    const sy = Math.min(sh - 1, Math.max(0, (y + 0.5) * fy - 0.5)), y0 = sy | 0, y1 = Math.min(sh - 1, y0 + 1), ty = sy - y0
    for (let x = 0; x < w; x++) {
      const sx = Math.min(sw - 1, Math.max(0, (x + 0.5) * fx - 0.5)), x0 = sx | 0, x1 = Math.min(sw - 1, x0 + 1), tx = sx - x0
      const p00 = (y0 * sw + x0) * 4, p10 = (y0 * sw + x1) * 4, p01 = (y1 * sw + x0) * 4, p11 = (y1 * sw + x1) * 4, o = (y * w + x) * 4
      for (let c = 0; c < 3; c++) out[o + c] = (src[p00 + c] * (1 - tx) + src[p10 + c] * tx) * (1 - ty) + (src[p01 + c] * (1 - tx) + src[p11 + c] * tx) * ty
      out[o + 3] = 255
    }
  }
  return { data: out, width: w, height: h }
}

export function binnedSize(width: number, height: number, factor: number): { w: number; h: number } {
  return { w: Math.max(1, Math.floor(width / factor)), h: Math.max(1, Math.floor(height / factor)) }
}

/** Bin `src` (width×height RGBA) by `factor` into `out` (allocated when omitted or wrongly sized). */
export function binRgba(src: Uint8ClampedArray, width: number, height: number, factor: number, kernel: BinKernel = 'mean', out?: Uint8ClampedArray): BinnedFrame {
  const { w, h } = binnedSize(width, height, factor)
  if (!out || out.length !== w * h * 4) out = new Uint8ClampedArray(w * h * 4)
  const n = factor * factor, inv = 1 / n
  if (kernel === 'mean') {
    for (let oy = 0; oy < h; oy++) {
      for (let ox = 0; ox < w; ox++) {
        let r = 0, g = 0, b = 0
        for (let dy = 0; dy < factor; dy++) {
          let i = ((oy * factor + dy) * width + ox * factor) * 4
          for (let dx = 0; dx < factor; dx++, i += 4) { r += src[i]; g += src[i + 1]; b += src[i + 2] }
        }
        const o = (oy * w + ox) * 4
        out[o] = r * inv; out[o + 1] = g * inv; out[o + 2] = b * inv; out[o + 3] = 255
      }
    }
    return { data: out, width: w, height: h }
  }
  // edge-aware: weight = exp(-(L - Lref)² / (2σ²)) with Lref the luma of the block's *majority side*
  // (the block mean's side of the median: mean-referenced, so even factors have no off-centre bias),
  // σ = max(6, block luma spread / 4); exp through a 256-entry table on |d| (no Math.exp per pixel)
  const lum = new Float32Array(n)
  for (let oy = 0; oy < h; oy++) {
    for (let ox = 0; ox < w; ox++) {
      let lmin = 255, lmax = 0, lsum = 0, k2 = 0
      for (let dy = 0; dy < factor; dy++) {
        let i = ((oy * factor + dy) * width + ox * factor) * 4
        for (let dx = 0; dx < factor; dx++, i += 4, k2++) { const l = src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114; lum[k2] = l; lsum += l; if (l < lmin) lmin = l; if (l > lmax) lmax = l }
      }
      const mean = lsum * inv, mid = (lmin + lmax) * 0.5
      // reference: mean of the pixels on the mean's side of the mid-point (the majority side of an edge)
      let ref = 0, rn = 0
      for (let k = 0; k < n; k++) if ((lum[k] >= mid) === (mean >= mid)) { ref += lum[k]; rn++ }
      const lc = rn ? ref / rn : mean
      const sigma = Math.max(6, (lmax - lmin) * 0.25), kk = -1 / (2 * sigma * sigma)
      let r = 0, g = 0, b = 0, ws = 0
      k2 = 0
      for (let dy = 0; dy < factor; dy++) {
        let i = ((oy * factor + dy) * width + ox * factor) * 4
        for (let dx = 0; dx < factor; dx++, i += 4, k2++) {
          const d = lum[k2] - lc
          const wgt = expLut(d * d * kk)
          r += src[i] * wgt; g += src[i + 1] * wgt; b += src[i + 2] * wgt; ws += wgt
        }
      }
      const o = (oy * w + ox) * 4, iw = 1 / ws
      out[o] = r * iw; out[o + 1] = g * iw; out[o + 2] = b * iw; out[o + 3] = 255
    }
  }
  return { data: out, width: w, height: h }
}
