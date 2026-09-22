/** Kymograph sampling: one row per frame along a user line (bilinear luma or RGB, averaged over a
 *  `band`-px perpendicular strip, as ImageJ's KymographBuilder does), appended to a scrolling
 *  space–time image whose slopes are velocities. Pure: the mode owns the line and the canvas. */

export interface LinePx { x0: number; y0: number; x1: number; y1: number }

/** Sample `line` (image px) into `out` (RGB triplets, `length` samples), averaging `band` px across. */
export function sampleLine(data: Uint8ClampedArray, w: number, h: number, line: LinePx, length: number, band: number, out: Float32Array): void {
  const dx = line.x1 - line.x0, dy = line.y1 - line.y0, len = Math.hypot(dx, dy) || 1
  const nx = -dy / len, ny = dx / len   // unit normal
  const half = (band - 1) / 2
  for (let k = 0; k < length; k++) {
    const t = length === 1 ? 0 : k / (length - 1)
    let r = 0, g = 0, b = 0, n = 0
    for (let j = 0; j < band; j++) {
      const off = j - half
      const x = line.x0 + dx * t + nx * off, y = line.y0 + dy * t + ny * off
      if (x < 0 || y < 0 || x > w - 1 || y > h - 1) continue
      const x0 = x | 0, y0 = y | 0, x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), tx = x - x0, ty = y - y0
      const p00 = (y0 * w + x0) * 4, p10 = (y0 * w + x1) * 4, p01 = (y1 * w + x0) * 4, p11 = (y1 * w + x1) * 4
      r += (data[p00] * (1 - tx) + data[p10] * tx) * (1 - ty) + (data[p01] * (1 - tx) + data[p11] * tx) * ty
      g += (data[p00 + 1] * (1 - tx) + data[p10 + 1] * tx) * (1 - ty) + (data[p01 + 1] * (1 - tx) + data[p11 + 1] * tx) * ty
      b += (data[p00 + 2] * (1 - tx) + data[p10 + 2] * tx) * (1 - ty) + (data[p01 + 2] * (1 - tx) + data[p11 + 2] * tx) * ty
      n++
    }
    out[k * 3] = n ? r / n : 0; out[k * 3 + 1] = n ? g / n : 0; out[k * 3 + 2] = n ? b / n : 0
  }
}

/** Scrolling space–time image: `push(row)` appends at the bottom and scrolls older rows up. */
export class Kymograph {
  readonly image: Uint8ClampedArray
  rows = 0
  constructor(public readonly length: number, public readonly height: number) {
    this.image = new Uint8ClampedArray(length * height * 4)
    for (let i = 3; i < this.image.length; i += 4) this.image[i] = 255
  }
  reset(): void { this.rows = 0; this.image.fill(0); for (let i = 3; i < this.image.length; i += 4) this.image[i] = 255 }
  push(row: Float32Array): void {
    const L = this.length, img = this.image
    if (this.rows >= this.height) img.copyWithin(0, L * 4, L * 4 * this.height)
    const y = Math.min(this.rows, this.height - 1)
    for (let k = 0; k < L; k++) { const o = (y * L + k) * 4; img[o] = row[k * 3]; img[o + 1] = row[k * 3 + 1]; img[o + 2] = row[k * 3 + 2]; img[o + 3] = 255 }
    if (this.rows < this.height) this.rows++
  }
}
