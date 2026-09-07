/** Focus stacking and LED-exposure fusion for full-resolution photos, pure TS.
 *
 *  Both work the same way: the image is divided into `cell`×`cell` blocks, each source image gets
 *  one weight per block (focus: local Laplacian energy^4, i.e. "how sharp is this block here";
 *  exposure: how well exposed the block is), the weight maps are smoothed so seams do not show,
 *  and the output is the per-pixel weighted average of the sources. Working per block keeps an
 *  8 MP × 5 image stack affordable in the browser (the per-pixel pass is a single multiply-add per
 *  source). */

export interface Rgba { data: Uint8ClampedArray; width: number; height: number }

export interface CellMaps { cellsX: number; cellsY: number; cell: number; sharpness: Float32Array; luminance: Float32Array }

/** Per-block Laplacian energy (sharpness) and mean luminance (0..1) of one image. */
export function cellMaps(img: Rgba, cell = 8): CellMaps {
  const { data, width: w, height: h } = img
  const cellsX = Math.ceil(w / cell), cellsY = Math.ceil(h / cell)
  const sharpness = new Float32Array(cellsX * cellsY), luminance = new Float32Array(cellsX * cellsY), count = new Float32Array(cellsX * cellsY)
  const lum = new Float32Array(w * h)
  for (let i = 0, p = 0; i < w * h; i++, p += 4) lum[i] = (0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]) / 255
  for (let y = 0; y < h; y++) {
    const cy = Math.floor(y / cell)
    for (let x = 0; x < w; x++) {
      const i = y * w + x, c = cy * cellsX + Math.floor(x / cell)
      luminance[c] += lum[i]; count[c]++
      if (x > 0 && y > 0 && x < w - 1 && y < h - 1) {
        const lap = 4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - w] - lum[i + w]
        sharpness[c] += lap * lap
      }
    }
  }
  for (let c = 0; c < count.length; c++) { luminance[c] /= count[c] || 1; sharpness[c] /= count[c] || 1 }
  return { cellsX, cellsY, cell, sharpness, luminance }
}

/** 3×3 box blur, `passes` times, in place on a cell map. */
export function smooth(map: Float32Array, cellsX: number, cellsY: number, passes = 2): Float32Array {
  let src: Float32Array = map, dst: Float32Array = new Float32Array(map.length)
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < cellsY; y++) for (let x = 0; x < cellsX; x++) {
      let s = 0, n = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx
        if (yy >= 0 && yy < cellsY && xx >= 0 && xx < cellsX) { s += src[yy * cellsX + xx]; n++ }
      }
      dst[y * cellsX + x] = s / n
    }
    ;[src, dst] = [dst, src]
  }
  if (src !== map) map.set(src)
  return map
}

/** Normalise N weight maps so they sum to 1 per cell (uniform where all are ~0). */
function normalise(weights: Float32Array[]): void {
  const n = weights[0].length
  for (let c = 0; c < n; c++) {
    let s = 0
    for (const w of weights) s += w[c]
    if (s < 1e-12) for (const w of weights) w[c] = 1 / weights.length
    else for (const w of weights) w[c] /= s
  }
}

/** Weighted average of the sources using per-cell weights (already normalised), interpolated
 *  bilinearly between cell centres so no block boundaries appear in the output. */
export function blend(images: Rgba[], weights: Float32Array[], cellsX: number, cell: number): Rgba {
  const { width: w, height: h } = images[0]
  const cellsY = Math.ceil(h / cell)
  const out = new Uint8ClampedArray(w * h * 4)
  const n = images.length
  const wt = new Float32Array(n)
  for (let y = 0; y < h; y++) {
    const fy = Math.min(cellsY - 1, Math.max(0, (y + 0.5) / cell - 0.5)), y0 = Math.floor(fy), y1 = Math.min(cellsY - 1, y0 + 1), ty = fy - y0
    for (let x = 0; x < w; x++) {
      const fx = Math.min(cellsX - 1, Math.max(0, (x + 0.5) / cell - 0.5)), x0 = Math.floor(fx), x1 = Math.min(cellsX - 1, x0 + 1), tx = fx - x0
      const c00 = y0 * cellsX + x0, c01 = y0 * cellsX + x1, c10 = y1 * cellsX + x0, c11 = y1 * cellsX + x1
      const p = (y * w + x) * 4
      let r = 0, g = 0, b = 0, sum = 0
      for (let i = 0; i < n; i++) {
        const wi = weights[i]
        const v = (wi[c00] * (1 - tx) + wi[c01] * tx) * (1 - ty) + (wi[c10] * (1 - tx) + wi[c11] * tx) * ty
        wt[i] = v; sum += v
      }
      for (let i = 0; i < n; i++) {
        const v = wt[i] / (sum || 1), d = images[i].data
        r += v * d[p]; g += v * d[p + 1]; b += v * d[p + 2]
      }
      out[p] = r; out[p + 1] = g; out[p + 2] = b; out[p + 3] = 255
    }
  }
  return { data: out, width: w, height: h }
}

/** Downscaled luminance of an RGBA image (for alignment by phase correlation). */
export function grayDown(rgba: Uint8ClampedArray, w: number, h: number, maxW = 410): { data: Float32Array; width: number; height: number } {
  const f = Math.max(1, Math.floor(w / maxW)), gw = Math.floor(w / f), gh = Math.floor(h / f)
  const data = new Float32Array(gw * gh)
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    let s = 0
    for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) { const p = ((y * f + j) * w + x * f + i) * 4; s += 0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2] }
    data[y * gw + x] = s / (f * f)
  }
  return { data, width: gw, height: gh }
}

export interface StackResult { image: Rgba; contributions: number[] /* share of the picture taken from each slice, sums to 1 */ }

/** Focus stack: at each block prefer the source with the highest local sharpness (weights ∝ energy^4). */
export function focusStack(images: Rgba[], cell = 8): StackResult {
  if (images.length === 1) return { image: images[0], contributions: [1] }
  const maps = images.map((im) => cellMaps(im, cell))
  const { cellsX, cellsY } = maps[0]
  const weights = maps.map((m) => {
    const w = new Float32Array(m.sharpness.length)
    for (let c = 0; c < w.length; c++) w[c] = m.sharpness[c] ** 2  // energy is already squared: ^2 here = ^4 on |lap|
    return w
  })
  // sharper-wins at cell level, then smooth so the choice fades over neighbouring blocks
  normalise(weights)
  for (const w of weights) smooth(w, cellsX, cellsY, 2)
  normalise(weights)
  const n = weights[0].length
  const contributions = weights.map((w) => { let s = 0; for (let c = 0; c < n; c++) s += w[c]; return s / n })
  return { image: blend(images, weights, cellsX, cell), contributions }
}

/** Exposure fusion of the same scene under different illumination: prefer well-exposed blocks
 *  (Gaussian around mid grey, σ 0.2, as in Mertens et al.) so highlights come from the dark frames
 *  and shadows from the bright ones. */
export function exposureFuse(images: Rgba[], cell = 8): Rgba {
  if (images.length === 1) return images[0]
  const maps = images.map((im) => cellMaps(im, cell))
  const { cellsX, cellsY } = maps[0]
  const weights = maps.map((m) => {
    const w = new Float32Array(m.luminance.length)
    for (let c = 0; c < w.length; c++) w[c] = Math.exp(-((m.luminance[c] - 0.5) ** 2) / (2 * 0.2 ** 2)) + 1e-4
    return w
  })
  normalise(weights)
  for (const w of weights) smooth(w, cellsX, cellsY, 3)
  normalise(weights)
  return blend(images, weights, cellsX, cell)
}

/** Total Laplacian energy of an image: a crude "how much is in focus" figure for tests and progress. */
export function totalSharpness(img: Rgba, cell = 8): number {
  const m = cellMaps(img, cell)
  let s = 0
  for (const v of m.sharpness) s += v
  return s
}
