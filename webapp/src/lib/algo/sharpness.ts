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
