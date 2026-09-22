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
  // edge-aware: weight = exp(-(L - Lc)² / (2σ²)), σ = max(6, block luma spread / 4)
  const c = factor >> 1
  for (let oy = 0; oy < h; oy++) {
    for (let ox = 0; ox < w; ox++) {
      const ic = ((oy * factor + c) * width + ox * factor + c) * 4
      const lc = src[ic] * 0.299 + src[ic + 1] * 0.587 + src[ic + 2] * 0.114
      let lmin = 255, lmax = 0
      for (let dy = 0; dy < factor; dy++) {
        let i = ((oy * factor + dy) * width + ox * factor) * 4
        for (let dx = 0; dx < factor; dx++, i += 4) { const l = src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114; if (l < lmin) lmin = l; if (l > lmax) lmax = l }
      }
      const sigma = Math.max(6, (lmax - lmin) * 0.25), k = -1 / (2 * sigma * sigma)
      let r = 0, g = 0, b = 0, ws = 0
      for (let dy = 0; dy < factor; dy++) {
        let i = ((oy * factor + dy) * width + ox * factor) * 4
        for (let dx = 0; dx < factor; dx++, i += 4) {
          const l = src[i] * 0.299 + src[i + 1] * 0.587 + src[i + 2] * 0.114
          const d = l - lc
          const wgt = Math.exp(d * d * k)
          r += src[i] * wgt; g += src[i + 1] * wgt; b += src[i + 2] * wgt; ws += wgt
        }
      }
      const o = (oy * w + ox) * 4, iw = 1 / ws
      out[o] = r * iw; out[o + 1] = g * iw; out[o + 2] = b * iw; out[o + 3] = 255
    }
  }
  return { data: out, width: w, height: h }
}
