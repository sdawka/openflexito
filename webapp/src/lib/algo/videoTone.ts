/** Tone and structure helpers for video modes, built for temporal stability: anything that adapts
 *  to the picture does so through slow exponential averages with hysteresis, so a recording never
 *  "pumps" when an organism swims through or the lamp flickers.
 *
 *  - `StableLevels`: auto-levels whose black/white points are the EMA of the frame's low/high luma
 *    percentiles (ImageJ's Enhance Contrast per frame would flicker); a new target only moves the
 *    points when it differs by more than `deadband`, and then at `rate` per frame. A scene change
 *    (percentiles jump by more than `jump`) snaps immediately.
 *  - `localContrast`: clarity — the luma minus its large-scale mean (box blur on a `factor`× coarse
 *    grid, bilinearly upsampled), scaled by `amount` and added back. One coarse pass + one full pass.
 *  - `relief`: pseudo-DIC shading — the directional derivative of the luma along `angle`, added to
 *    mid-grey (or mixed with the frame), the way a differential interference contrast image looks:
 *    edges cast light and shadow, flat areas go grey. */

export class StableLevels {
  black = 0
  white = 255
  private init = false
  /** `rate` relaxes the range slowly; `rateOut` reacts fast when content falls *outside* the current
   *  range (so nothing clips while waiting for the slow average). `knee` > 0 rolls the top of the
   *  curve into white softly instead of clipping it (`knee` = where the roll-off starts, 0.85). */
  constructor(public lowPct = 0.5, public highPct = 99.5, public rate = 0.03, public deadband = 2, public jump = 40, public rateOut = 0.3, public knee = 0) {}

  reset(): void { this.init = false }

  /** Update from a frame (sampled at `stride` pixels) and return the 256-entry LUT for this frame.
   *  `frozen` keeps the range where it is (stage moving: content changes, lighting does not). */
  update(data: Uint8ClampedArray, lut: Uint8ClampedArray, stride = 4, frozen = false): Uint8ClampedArray {
    const hist = new Uint32Array(256)
    let n = 0
    for (let i = 0; i < data.length; i += 4 * stride) { hist[(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0]++; n++ }
    let lo = 0, hi = 255, acc = 0
    const loN = n * this.lowPct / 100, hiN = n * this.highPct / 100
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= loN) { lo = v; break } }
    acc = 0
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= hiN) { hi = v; break } }
    if (hi - lo < 8) hi = lo + 8
    if (!this.init || Math.abs(lo - this.black) > this.jump || Math.abs(hi - this.white) > this.jump) { this.black = lo; this.white = hi; this.init = true }
    else if (!frozen) {
      const dl = lo - this.black, dh = hi - this.white
      if (Math.abs(dl) > this.deadband) this.black += dl * (dl < 0 ? this.rateOut : this.rate)   // darker than the range: react fast
      if (Math.abs(dh) > this.deadband) this.white += dh * (dh > 0 ? this.rateOut : this.rate)   // brighter than the range: react fast
    }
    // an (almost) empty field has nothing to stretch: identity rather than amplified noise
    if (this.white - this.black < 16) { for (let v = 0; v < 256; v++) lut[v] = v; return lut }
    const b = this.black, s = 1 / Math.max(1, this.white - b), k = this.knee
    for (let v = 0; v < 256; v++) {
      let x = (v - b) * s
      if (k > 0 && x > k) x = k + (1 - k) * Math.tanh((x - k) / (1 - k))
      const o = x * 255
      lut[v] = o < 0 ? 0 : o > 255 ? 255 : o
    }
    return lut
  }
}

/** Reference-anchored software white balance for brightfield video: the illuminant is the mean
 *  colour of the brightest 30 % of unclipped pixels; per-channel gains bring it to the anchor
 *  (the first measurement, or a caller-set neutral) with slow EMA and a [0.7, 1.4] clamp. Disabled
 *  automatically when there is no bright background (70th-percentile luma < 60: dark-field,
 *  fluorescence). Use with the camera's own AWB locked, otherwise two controllers oscillate. */
export class AnchoredWhiteBalance {
  gains: [number, number, number] = [1, 1, 1]
  anchor: [number, number, number] | null = null
  active = false
  constructor(public rate = 0.05) {}

  reset(): void { this.anchor = null; this.gains = [1, 1, 1]; this.active = false }

  /** Measure `data` (sampled at `stride`) and update the gains; `frozen` skips the update. */
  update(data: Uint8ClampedArray, stride = 4, frozen = false): void {
    const lum: number[] = [], idx: number[] = []
    for (let i = 0; i < data.length; i += 4 * stride) {
      const l = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
      if (l < 250) { lum.push(l); idx.push(i) }
    }
    if (lum.length < 16) { this.active = false; return }
    const order = idx.map((_, k) => k).sort((a, b) => lum[b] - lum[a])
    const p70 = lum[order[Math.floor(order.length * 0.7)]]
    if (p70 < 60) { this.active = false; return }
    this.active = true
    const take = Math.max(1, Math.floor(order.length * 0.3))
    let r = 0, g = 0, b = 0
    for (let k = 0; k < take; k++) { const i = idx[order[k]]; r += data[i]; g += data[i + 1]; b += data[i + 2] }
    r /= take; g /= take; b /= take
    if (!this.anchor) { this.anchor = [r, g, b]; return }
    if (frozen) return
    const target: [number, number, number] = [this.anchor[0] / Math.max(1, r), this.anchor[1] / Math.max(1, g), this.anchor[2] / Math.max(1, b)]
    for (let c = 0; c < 3; c++) {
      const t = Math.max(0.7, Math.min(1.4, target[c]))
      this.gains[c] += (t - this.gains[c]) * this.rate
    }
  }

  /** Bake the gains into three per-channel 256-entry tables (composes with `StableLevels`' table). */
  luts(base: Uint8ClampedArray, out: [Uint8ClampedArray, Uint8ClampedArray, Uint8ClampedArray]): void {
    for (let c = 0; c < 3; c++) { const g = this.active ? this.gains[c] : 1; for (let v = 0; v < 256; v++) { const x = Math.min(255, v * g); out[c][v] = base[x | 0] } }
  }
}

export function applyLut3(data: Uint8ClampedArray, luts: [Uint8ClampedArray, Uint8ClampedArray, Uint8ClampedArray], out: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) { out[i] = luts[0][data[i]]; out[i + 1] = luts[1][data[i + 1]]; out[i + 2] = luts[2][data[i + 2]]; out[i + 3] = 255 }
}

/** Live background flattening (rolling estimate): the per-channel large-scale mean of the frame,
 *  measured on a `factor`× coarse grid, smoothed in space (two 3×3 passes) and in time (EMA
 *  `rate`), divided out: `out = in · mean(bg) / bg`, gain clamped to [0.5, 3]. Uneven LED
 *  illumination and dust shadows disappear; a sample covering the whole field is partly flattened
 *  too (the honest limit of an estimate without an empty reference frame). */
export class BackgroundFlattener {
  private bg: Float32Array | null = null
  private cw = 0; private ch = 0
  constructor(public factor = 32, public rate = 0.05) {}

  reset(): void { this.bg = null }

  update(data: Uint8ClampedArray, w: number, h: number, out: Uint8ClampedArray, frozen = false): void {
    const f = this.factor, cw = Math.ceil(w / f), ch = Math.ceil(h / f), n = cw * ch
    const cur = new Float32Array(n * 3), cnt = new Uint32Array(n)
    for (let y = 0; y < h; y += 2) {
      const cy = (y / f) | 0
      for (let x = 0; x < w; x += 2) {
        const i = (y * w + x) * 4, c = cy * cw + ((x / f) | 0)
        cur[c * 3] += data[i]; cur[c * 3 + 1] += data[i + 1]; cur[c * 3 + 2] += data[i + 2]; cnt[c]++
      }
    }
    for (let c = 0; c < n; c++) { const k = cnt[c] || 1; cur[c * 3] /= k; cur[c * 3 + 1] /= k; cur[c * 3 + 2] /= k }
    for (let pass = 0; pass < 2; pass++) {
      const sm = new Float32Array(n * 3)
      for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
        let r = 0, g = 0, b = 0, k = 0
        // replicate-padded so border cells keep their own level instead of being pulled inward
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = Math.min(ch - 1, Math.max(0, cy + dy)), xx = Math.min(cw - 1, Math.max(0, cx + dx)); const c = (yy * cw + xx) * 3; r += cur[c]; g += cur[c + 1]; b += cur[c + 2]; k++ }
        const c = (cy * cw + cx) * 3; sm[c] = r / k; sm[c + 1] = g / k; sm[c + 2] = b / k
      }
      cur.set(sm)
    }
    if (!this.bg || this.cw !== cw || this.ch !== ch) { this.bg = cur; this.cw = cw; this.ch = ch }
    else if (!frozen) { const bg = this.bg, a = this.rate; for (let i = 0; i < bg.length; i++) bg[i] += (cur[i] - bg[i]) * a }
    const bg = this.bg
    let mr = 0, mg = 0, mb = 0
    for (let c = 0; c < n; c++) { mr += bg[c * 3]; mg += bg[c * 3 + 1]; mb += bg[c * 3 + 2] }
    mr /= n; mg /= n; mb /= n
    const gain = (m: number, v: number) => Math.max(0.5, Math.min(3, m / Math.max(8, v)))
    for (let y = 0; y < h; y++) {
      const fy = Math.min(ch - 1, Math.max(0, (y + 0.5) / f - 0.5)), y0 = fy | 0, y1 = Math.min(ch - 1, y0 + 1), ty = fy - y0
      for (let x = 0; x < w; x++) {
        const fx = Math.min(cw - 1, Math.max(0, (x + 0.5) / f - 0.5)), x0 = fx | 0, x1 = Math.min(cw - 1, x0 + 1), tx = fx - x0
        const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty
        const c00 = (y0 * cw + x0) * 3, c10 = (y0 * cw + x1) * 3, c01 = (y1 * cw + x0) * 3, c11 = (y1 * cw + x1) * 3
        const br = bg[c00] * w00 + bg[c10] * w10 + bg[c01] * w01 + bg[c11] * w11
        const bgc = bg[c00 + 1] * w00 + bg[c10 + 1] * w10 + bg[c01 + 1] * w01 + bg[c11 + 1] * w11
        const bb = bg[c00 + 2] * w00 + bg[c10 + 2] * w10 + bg[c01 + 2] * w01 + bg[c11 + 2] * w11
        const i = (y * w + x) * 4
        out[i] = data[i] * gain(mr, br); out[i + 1] = data[i + 1] * gain(mg, bgc); out[i + 2] = data[i + 2] * gain(mb, bb); out[i + 3] = 255
      }
    }
  }
}

export function applyLut(data: Uint8ClampedArray, lut: Uint8ClampedArray, out: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) { out[i] = lut[data[i]]; out[i + 1] = lut[data[i + 1]]; out[i + 2] = lut[data[i + 2]]; out[i + 3] = 255 }
}

/** Coarse box mean of the luma (factor×factor cells); returns the cell grid. */
export function coarseLuma(data: Uint8ClampedArray, w: number, h: number, factor: number, out?: Float32Array): { grid: Float32Array; cw: number; ch: number } {
  const cw = Math.ceil(w / factor), ch = Math.ceil(h / factor)
  const grid = out && out.length === cw * ch ? out : new Float32Array(cw * ch)
  const cnt = new Uint16Array(cw * ch)
  grid.fill(0)
  for (let y = 0; y < h; y++) {
    const cy = (y / factor) | 0
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const c = cy * cw + ((x / factor) | 0)
      grid[c] += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114; cnt[c]++
    }
  }
  for (let c = 0; c < grid.length; c++) grid[c] /= cnt[c] || 1
  // one 3×3 box smoothing pass so the cell grid has no visible steps after upsampling
  const sm = new Float32Array(grid.length)
  for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
    let s = 0, k = 0
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const yy = cy + dy, xx = cx + dx; if (yy >= 0 && yy < ch && xx >= 0 && xx < cw) { s += grid[yy * cw + xx]; k++ } }
    sm[cy * cw + cx] = s / k
  }
  grid.set(sm)
  return { grid, cw, ch }
}

function sampleGrid(grid: Float32Array, cw: number, ch: number, factor: number, x: number, y: number): number {
  const fx = Math.min(cw - 1, Math.max(0, (x + 0.5) / factor - 0.5)), fy = Math.min(ch - 1, Math.max(0, (y + 0.5) / factor - 0.5))
  const x0 = fx | 0, y0 = fy | 0, x1 = Math.min(cw - 1, x0 + 1), y1 = Math.min(ch - 1, y0 + 1), tx = fx - x0, ty = fy - y0
  return (grid[y0 * cw + x0] * (1 - tx) + grid[y0 * cw + x1] * tx) * (1 - ty) + (grid[y1 * cw + x0] * (1 - tx) + grid[y1 * cw + x1] * tx) * ty
}

/** Clarity: add `amount` × (luma − large-scale mean) to every channel. `factor` sets the scale
 *  (16 → structures under ~16 px are enhanced, illumination gradients are not). */
export function localContrast(data: Uint8ClampedArray, w: number, h: number, factor: number, amount: number, out: Uint8ClampedArray): void {
  const { grid, cw, ch } = coarseLuma(data, w, h, factor)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4
    const l = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
    const d = (l - sampleGrid(grid, cw, ch, factor, x, y)) * amount
    out[i] = data[i] + d; out[i + 1] = data[i + 1] + d; out[i + 2] = data[i + 2] + d; out[i + 3] = 255
  }
}

/** Digital dark-field / pseudo-phase: high-pass of the luma against its `factor`-scale mean.
 *  `'darkfield'` shows |high-pass| × gain on black (background dark, edges bright); `'phase'` shows
 *  128 + gain × high-pass (a phase-contrast-like grey rendering). Visualisations, not phase data. */
export function highPassView(data: Uint8ClampedArray, w: number, h: number, factor: number, gain: number, style: 'darkfield' | 'phase', out: Uint8ClampedArray): void {
  const { grid, cw, ch } = coarseLuma(data, w, h, factor)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4
    const l = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
    const hp = (l - sampleGrid(grid, cw, ch, factor, x, y)) * gain
    const v = style === 'darkfield' ? Math.abs(hp) : 128 + hp
    out[i] = v; out[i + 1] = v; out[i + 2] = v; out[i + 3] = 255
  }
}

/** Pseudo-DIC relief: directional derivative of the luma along `angleDeg` (0 = light from the left),
 *  scaled by `strength`, on a mid-grey base mixed with the original frame by `mix` (0 = pure relief,
 *  1 = original + shading). */
export function relief(data: Uint8ClampedArray, w: number, h: number, angleDeg: number, strength: number, mix: number, out: Uint8ClampedArray): void {
  const a = (angleDeg * Math.PI) / 180, ux = Math.cos(a), uy = Math.sin(a)
  // luma with a 3×3 box blur, so JPEG ringing does not read as relief
  const lum = new Float32Array(w * h)
  for (let p = 0, i = 0; p < lum.length; p++, i += 4) lum[p] = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
  const blur = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, k = 0
    for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= h) continue; for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= w) continue; s += lum[yy * w + xx]; k++ } }
    blur[y * w + x] = s / k
  }
  const L = (x: number, y: number) => blur[y * w + x]
  for (let y = 0; y < h; y++) {
    const y0 = y > 0 ? y - 1 : y, y1 = y < h - 1 ? y + 1 : y
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : x, x1 = x < w - 1 ? x + 1 : x
      const gx = (L(x1, y) - L(x0, y)) * 0.5, gy = (L(x, y1) - L(x, y0)) * 0.5
      const d = (gx * ux + gy * uy) * strength
      const i = (y * w + x) * 4
      const base = 128 + d
      out[i] = data[i] * mix + base * (1 - mix) + d * mix
      out[i + 1] = data[i + 1] * mix + base * (1 - mix) + d * mix
      out[i + 2] = data[i + 2] * mix + base * (1 - mix) + d * mix
      out[i + 3] = 255
    }
  }
}
