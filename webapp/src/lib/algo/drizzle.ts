/** Drizzle: combine several sub-pixel-shifted frames of the same scene onto a finer output grid
 *  (pixel-shift super-resolution). Each input pixel is a small square "drop" of side `pixfrac`
 *  (in input-pixel units, centred on the pixel) that is splatted onto the output grid at its
 *  measured position; every output cell accumulates the drop area that falls on it, weighted by
 *  source brightness, and the final value is the weighted average (Fielding/Hook & Fruchter
 *  "drizzle" resampling, as used for dithered astronomical exposures). A frame's `dx`/`dy` is its
 *  measured shift *from* the reference frame (frame content = reference content shifted by
 *  (dx, dy)): treating pixel indices as spanning [i, i+1) with their centre at i+0.5, a source
 *  pixel at (x, y) has its footprint centred at (((x + 0.5) - dx) * scale, ((y + 0.5) - dy) *
 *  scale) on the output grid (the +0.5 matters: without it, an unshifted frame's drops sit exactly
 *  on output-cell boundaries and split evenly between neighbours instead of landing cleanly).
 *  Output cells no drop ever reaches (holes at the border, or from very few frames) are filled from
 *  their nearest covered neighbour. */

export interface DrizzleFrame { data: Uint8ClampedArray; width: number; height: number; dx: number; dy: number }
export interface DrizzleResult { data: Uint8ClampedArray; width: number; height: number; coverage: number }

function overlap1d(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
}

/** Drizzle RGBA frames onto a `scale`x grid. `pixfrac` (0, 1] is the drop size relative to one
 *  input pixel; smaller sharpens but needs more frames/coverage, 1 behaves like plain averaging. */
export function drizzle(frames: DrizzleFrame[], scale = 2, pixfrac = 0.8): DrizzleResult {
  if (!frames.length) throw new Error('drizzle: no frames')
  const { width: w0, height: h0 } = frames[0]
  const W = Math.round(w0 * scale), H = Math.round(h0 * scale)
  const sum = new Float32Array(W * H * 3)
  const weight = new Float32Array(W * H)
  const half = (pixfrac / 2) * scale
  for (const f of frames) {
    const { data, width: w, height: h, dx, dy } = f
    for (let y = 0; y < h; y++) {
      const oy = (y + 0.5 - dy) * scale
      const y0 = Math.max(0, Math.floor(oy - half)), y1 = Math.min(H, Math.ceil(oy + half))
      if (y1 <= y0) continue
      for (let x = 0; x < w; x++) {
        const ox = (x + 0.5 - dx) * scale
        const x0 = Math.max(0, Math.floor(ox - half)), x1 = Math.min(W, Math.ceil(ox + half))
        if (x1 <= x0) continue
        const p = (y * w + x) * 4
        const r = data[p], g = data[p + 1], b = data[p + 2]
        for (let oyp = y0; oyp < y1; oyp++) {
          const wy = overlap1d(oyp, oyp + 1, oy - half, oy + half)
          if (wy <= 0) continue
          const row = oyp * W
          for (let oxp = x0; oxp < x1; oxp++) {
            const wx = overlap1d(oxp, oxp + 1, ox - half, ox + half)
            if (wx <= 0) continue
            const wgt = wx * wy, oi = row + oxp
            sum[oi * 3] += r * wgt; sum[oi * 3 + 1] += g * wgt; sum[oi * 3 + 2] += b * wgt
            weight[oi] += wgt
          }
        }
      }
    }
  }
  const out = new Uint8ClampedArray(W * H * 4)
  let covered = 0
  for (let i = 0; i < W * H; i++) {
    const wgt = weight[i]
    if (wgt > 0) { out[i * 4] = sum[i * 3] / wgt; out[i * 4 + 1] = sum[i * 3 + 1] / wgt; out[i * 4 + 2] = sum[i * 3 + 2] / wgt; out[i * 4 + 3] = 255; covered++ }
  }
  fillHoles(out, weight, W, H)
  return { data: out, width: W, height: H, coverage: covered / (W * H) }
}

/** Fill output cells with no drop coverage from the nearest covered cell (a few dilation passes
 *  over a small ring; drizzle holes are isolated single cells or thin borders, never large areas
 *  when frames sensibly overlap). */
function fillHoles(out: Uint8ClampedArray, weight: Float32Array, W: number, H: number): void {
  const done = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) done[i] = weight[i] > 0 ? 1 : 0
  let remaining = 0
  for (let i = 0; i < done.length; i++) if (!done[i]) remaining++
  if (!remaining) return
  for (let pass = 0; pass < 8 && remaining > 0; pass++) {
    let changed = false
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (done[i]) continue
      let sr = 0, sg = 0, sb = 0, n = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue
        const j = yy * W + xx
        if (weight[j] > 0) { sr += out[j * 4]; sg += out[j * 4 + 1]; sb += out[j * 4 + 2]; n++ }
      }
      if (n) { out[i * 4] = sr / n; out[i * 4 + 1] = sg / n; out[i * 4 + 2] = sb / n; out[i * 4 + 3] = 255; changed = true }
    }
    if (changed) for (let i = 0; i < done.length; i++) if (!done[i] && weight[i] === 0 && out[i * 4 + 3] === 255) { done[i] = 1; remaining-- }
    if (!changed) break
  }
}
