/** Image sharpness metrics on greyscale float arrays (used by step-wise autofocus and tracking). */

export interface Gray { data: Float32Array; width: number; height: number }

export function toGray(img: ImageData): Gray {
  const { width, height, data } = img
  const out = new Float32Array(width * height)
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = 0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]
  return { data: out, width, height }
}

/** Variance of the 4-neighbour Laplacian: robust, cheap, monotonic near focus. */
export function laplacianVariance(g: Gray): number {
  const { data, width: w, height: h } = g
  let sum = 0, sum2 = 0, n = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const l = 4 * data[i] - data[i - 1] - data[i + 1] - data[i - w] - data[i + w]
      sum += l; sum2 += l * l; n++
    }
  }
  const mean = sum / n
  return sum2 / n - mean * mean
}

/** Sum of squared horizontal + vertical gradients (Tenengrad without threshold). */
export function gradientEnergy(g: Gray): number {
  const { data, width: w, height: h } = g
  let e = 0
  for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
    const i = y * w + x, dx = data[i + 1] - data[i], dy = data[i + w] - data[i]
    e += dx * dx + dy * dy
  }
  return e / ((w - 1) * (h - 1))
}

/** Normalised variance after Sun, Duthaler & Nelson 2004. Divergence: they use variance / mean,
 *  which still scales linearly with a global gain; here it is variance / mean^2 (squared
 *  coefficient of variation), so tiles or frames with different exposure, LED level or shading
 *  score alike. 0 for a black image. */
export function normalisedVariance(g: Gray): number {
  const { data } = g
  const n = data.length
  if (!n) return 0
  let sum = 0
  for (let i = 0; i < n; i++) sum += data[i]
  const mean = sum / n
  if (!(mean > 0)) return 0
  let v = 0
  for (let i = 0; i < n; i++) { const d = data[i] - mean; v += d * d }
  return v / n / (mean * mean)
}

/** Brenner gradient: mean of squared differences between pixels `step` apart horizontally. */
export function brenner(g: Gray, step = 2): number {
  const { data, width: w, height: h } = g
  if (w <= step) return 0
  let e = 0, n = 0
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w - step; x++) { const d = data[row + x + step] - data[row + x]; e += d * d; n++ }
  }
  return n ? e / n : 0
}

/** `metric` over a grid x grid tiling, aggregated as the second-sharpest tile: one piece of debris or
 *  one saturated spot cannot dominate the score (the maximum is dropped), but neither can empty glass
 *  (any two textured tiles out of sixteen carry the curve). The median used before went flat on sparse specimens (measured on the Pi: a 3×3
 *  scan over debris gave fine-curve contrasts of 1.1 while the whole-frame Laplacian peaked 20×),
 *  because more than half of the 16 tiles were featureless. Tiles smaller than 3 px fall back to the
 *  whole image. */
export function tileMetric(g: Gray, metric: (g: Gray) => number, grid = 4): number {
  const { data, width: w, height: h } = g
  const gx = Math.max(1, Math.min(Math.floor(grid), Math.floor(w / 3))), gy = Math.max(1, Math.min(Math.floor(grid), Math.floor(h / 3)))
  if (gx * gy === 1) return metric(g)
  const vals: number[] = []
  for (let ty = 0; ty < gy; ty++) for (let tx = 0; tx < gx; tx++) {
    const x0 = Math.floor((tx * w) / gx), x1 = Math.floor(((tx + 1) * w) / gx)
    const y0 = Math.floor((ty * h) / gy), y1 = Math.floor(((ty + 1) * h) / gy)
    const tw = x1 - x0, th = y1 - y0
    const out = new Float32Array(tw * th)
    for (let y = 0; y < th; y++) out.set(data.subarray((y0 + y) * w + x0, (y0 + y) * w + x1), y * tw)
    const v = metric({ data: out, width: tw, height: th })
    if (Number.isFinite(v)) vals.push(v)
  }
  if (!vals.length) return NaN
  vals.sort((a, b) => b - a)
  return vals[Math.min(vals.length - 1, 1)]
}

export type FocusMetricName = 'laplacian' | 'nv' | 'brenner'

export function focusMetric(name: FocusMetricName): (g: Gray) => number {
  switch (name) {
    case 'nv': return normalisedVariance
    case 'brenner': return (g) => brenner(g)
    default: return laplacianVariance
  }
}
