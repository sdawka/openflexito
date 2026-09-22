/** Reference flat-field and dark-frame correction for video (`docs/video-research/quality.md`,
 *  proposal 7 and the addendum's "dark frame + hot-pixel list + live flat division"): the user
 *  records a blank field (LED on, sample removed) and optionally a dark (LED off) with the camera's
 *  AE/AWB locked; afterwards every frame is corrected with one multiply-add per channel:
 *
 *      out = D + (cur − D) · G,   G = clamp(mean(F − D) / (F − D), 0.5, 4)   per channel
 *
 *  in a gamma-2.2-linearised domain (JPEG pixels are display-referred; dividing them directly would
 *  over-correct the shadows). F and D are the means of the frames fed to `addReference`/`addDark`.
 *
 *  Both maps live on a coarse grid (`cell` px, default 8; normalised image coordinates like
 *  `flatField.ts`, so a map made at one stream size still applies at another), which is the "blur
 *  ≈ 8 px" that stops JPEG block noise in F from printing through, makes `toJson()` small enough
 *  for IndexedDB, and turns `apply` into one horizontal lerp per pixel after a vertical lerp per
 *  row. Two extra 3×3 box passes on the grid smooth the cell edges.
 *
 *  Hot pixels are found on the full-res dark mean: any channel above its median + 6·MAD (MAD
 *  floored at one code so a clean dark flags nothing) is listed and replaced in every output
 *  frame by the median of its eight neighbours in that channel. The list is only valid at the
 *  size it was measured on; `fromJson` drops it when the frame size differs.
 *
 *  `strength` blends the gain toward unity (G' = 1 + (G − 1)·strength), the report's UI knob.
 *  Units 0..255 throughout; `apply` allocates nothing after the first frame of a given size. */

export interface VideoFlatJson {
  cols: number
  rows: number
  /** frame size the maps were measured on */
  width: number
  height: number
  /** per-channel linear gains, row-major cols×rows×3 */
  gain: number[]
  /** per-channel linear dark level, cols×rows×3, or null when no dark was recorded */
  dark: number[] | null
  /** hot pixels as flat [x0, y0, x1, y1, ...] at width×height */
  hot: number[]
  frames: number
  darkFrames: number
  /** mean luma (0..255, display-referred) of the reference, so a caller can flag a stale map */
  meanLuma: number
  when?: string
}

/** v/255 → linear, kept on a 0..255 scale */
const LIN = new Float32Array(256).map((_, v) => 255 * Math.pow(v / 255, 2.2))
/** linear·16 (0..4080) → display code */
const ENC = new Uint8ClampedArray(4096).map((_, i) => 255 * Math.pow(i / 16 / 255, 1 / 2.2))

function median8(d: Uint8ClampedArray, w: number, h: number, x: number, y: number, c: number, buf: Float64Array): number {
  let n = 0
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (!dx && !dy) continue
    const xx = x + dx, yy = y + dy
    if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
    buf[n++] = d[(yy * w + xx) * 4 + c]
  }
  const s = buf.subarray(0, n).sort()
  return n ? (n & 1 ? s[n >> 1] : 0.5 * (s[(n >> 1) - 1] + s[n >> 1])) : 0
}

/** Median and MAD of a plane of 0..255 values via two 256-bin histograms. */
function medianMad(v: Float32Array, stride: number, offset: number): { med: number; mad: number } {
  const hist = new Uint32Array(256)
  let n = 0
  for (let i = offset; i < v.length; i += stride) { hist[Math.min(255, Math.max(0, Math.round(v[i])))]++; n++ }
  const pick = (hst: Uint32Array) => { let acc = 0; for (let k = 0; k < 256; k++) { acc += hst[k]; if (acc * 2 >= n) return k } return 255 }
  const med = pick(hist)
  hist.fill(0)
  for (let i = offset; i < v.length; i += stride) hist[Math.min(255, Math.abs(Math.round(v[i]) - med))]++
  return { med, mad: pick(hist) }
}

/** Two 3×3 box passes on a cols×rows×3 grid. Outside the grid the value is linearly extrapolated
 *  from the two nearest cells, so a smooth ramp (vignetting) is not biased at the edges the way a
 *  clamped or mirrored border would bias it. */
function smoothGrid(g: Float32Array, cols: number, rows: number, passes = 2): void {
  const tmp = new Float32Array(g.length)
  const at = (x: number, y: number, c: number): number => {
    const xi = Math.max(0, Math.min(cols - 1, x)), yi = Math.max(0, Math.min(rows - 1, y))
    let v = g[(yi * cols + xi) * 3 + c]
    // slope per cell toward the outside = (edge − inner) / (edge − inner index); the inner cell is
    // at xi + 1 on the low side and xi − 1 on the high side, so the divisor is −1 or +1 respectively
    if (x !== xi && cols > 1) { const inner = x < 0 ? 1 : cols - 2; v += (x - xi) * (g[(yi * cols + xi) * 3 + c] - g[(yi * cols + inner) * 3 + c]) / (xi - inner) }
    if (y !== yi && rows > 1) { const inner = y < 0 ? 1 : rows - 2; v += (y - yi) * (g[(yi * cols + xi) * 3 + c] - g[(inner * cols + xi) * 3 + c]) / (yi - inner) }
    return v
  }
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) for (let c = 0; c < 3; c++) {
      let s = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += at(x + dx, y + dy, c)
      tmp[(y * cols + x) * 3 + c] = s / 9
    }
    g.set(tmp)
  }
}

export class VideoFlat {
  /** grid cell size in px at the measured frame size */
  readonly cell: number
  private w = 0; private h = 0
  private cols = 0; private rows = 0
  private refSum: Float64Array | null = null   // coarse, linear, cols×rows×3
  private refN: Float64Array | null = null     // pixels per cell
  private darkSum: Float32Array | null = null  // full res, linear, w×h×3
  frames = 0
  darkFrames = 0
  /** ready to `apply` */
  gain: Float32Array | null = null
  dark: Float32Array | null = null
  /** hot pixel indices (y·w + x) at the measured size */
  hot: Uint32Array = new Uint32Array(0)
  meanLuma = 0
  // per-size apply scratch
  private aw = 0; private ah = 0
  private gRow!: Float32Array; private dRow!: Float32Array
  private x0!: Int32Array; private fx!: Float32Array
  private med = new Float64Array(8)

  constructor(cell = 8) { this.cell = cell }

  get ready(): boolean { return !!this.gain }

  /** Forget the accumulators and the result. */
  clear(): void { this.refSum = this.refN = this.darkSum = null; this.frames = this.darkFrames = 0; this.gain = this.dark = null; this.hot = new Uint32Array(0); this.w = this.h = 0 }

  private begin(w: number, h: number): void {
    if (this.w === w && this.h === h) return
    if (this.frames || this.darkFrames) throw new Error(`VideoFlat: frame size changed (${this.w}×${this.h} → ${w}×${h}) while accumulating`)
    this.w = w; this.h = h
    this.cols = Math.ceil(w / this.cell); this.rows = Math.ceil(h / this.cell)
  }

  /** Accumulate one blank-field frame (LED on, sample removed). */
  addReference(rgba: Uint8ClampedArray, w: number, h: number): void {
    this.begin(w, h)
    const { cols, cell } = this
    if (!this.refSum) { this.refSum = new Float64Array(cols * this.rows * 3); this.refN = new Float64Array(cols * this.rows) }
    const S = this.refSum, N = this.refN!
    let lum = 0
    for (let y = 0; y < h; y++) {
      const cy = (y / cell) | 0
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, k = cy * cols + ((x / cell) | 0)
        S[k * 3] += LIN[rgba[i]]; S[k * 3 + 1] += LIN[rgba[i + 1]]; S[k * 3 + 2] += LIN[rgba[i + 2]]
        N[k]++
        lum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]
      }
    }
    this.meanLuma += (lum / (w * h) - this.meanLuma) / (this.frames + 1)
    this.frames++
  }

  /** Accumulate one dark frame (LED off); kept at full res for the hot-pixel search. */
  addDark(rgba: Uint8ClampedArray, w: number, h: number): void {
    this.begin(w, h)
    if (!this.darkSum) this.darkSum = new Float32Array(w * h * 3)
    const D = this.darkSum
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) { D[j] += LIN[rgba[i]]; D[j + 1] += LIN[rgba[i + 1]]; D[j + 2] += LIN[rgba[i + 2]] }
    this.darkFrames++
  }

  /** Coarse dark mean (linear) and the hot-pixel list from the full-res dark mean. */
  private reduceDark(): Float32Array | null {
    if (!this.darkSum || !this.darkFrames) return null
    const { w, h, cols, rows, cell } = this
    const D = this.darkSum, inv = 1 / this.darkFrames
    for (let j = 0; j < D.length; j++) D[j] *= inv
    const thr = [0, 1, 2].map((c) => { const { med, mad } = medianMad(D, 3, c); return med + 6 * Math.max(1, mad) })
    const hot: number[] = []
    const coarse = new Float32Array(cols * rows * 3), n = new Float32Array(cols * rows)
    for (let y = 0; y < h; y++) {
      const cy = (y / cell) | 0
      for (let x = 0; x < w; x++) {
        const p = y * w + x, j = p * 3, k = cy * cols + ((x / cell) | 0)
        if (D[j] > thr[0] || D[j + 1] > thr[1] || D[j + 2] > thr[2]) { hot.push(p); continue }   // hot pixels do not pollute the cell mean
        coarse[k * 3] += D[j]; coarse[k * 3 + 1] += D[j + 1]; coarse[k * 3 + 2] += D[j + 2]; n[k]++
      }
    }
    for (let k = 0; k < n.length; k++) { const q = 1 / (n[k] || 1); coarse[k * 3] *= q; coarse[k * 3 + 1] *= q; coarse[k * 3 + 2] *= q }
    this.hot = Uint32Array.from(hot)
    return coarse
  }

  /** Build the gain map (and dark map) from what was accumulated. Returns false without a reference. */
  finalize(): boolean {
    if (!this.refSum || !this.frames) return false
    const { cols, rows } = this
    const dark = this.reduceDark()
    const F = new Float32Array(cols * rows * 3)
    const S = this.refSum, N = this.refN!
    const mean = [0, 0, 0]
    for (let k = 0; k < N.length; k++) for (let c = 0; c < 3; c++) {
      const f = S[k * 3 + c] / (N[k] || 1) - (dark ? dark[k * 3 + c] : 0)
      F[k * 3 + c] = f
      mean[c] += f / N.length
    }
    const G = new Float32Array(cols * rows * 3)
    for (let k = 0; k < N.length; k++) for (let c = 0; c < 3; c++) {
      const g = mean[c] / Math.max(1e-3, F[k * 3 + c])
      G[k * 3 + c] = Math.min(4, Math.max(0.5, g))
    }
    smoothGrid(G, cols, rows)
    if (dark) smoothGrid(dark, cols, rows)
    this.gain = G; this.dark = dark
    // the reference sums are kept so a dark captured *after* the reference can be folded in by a
    // second finalize(); `clear()` drops everything
    return true
  }

  private prepare(w: number, h: number): void {
    if (this.aw === w && this.ah === h) return
    this.aw = w; this.ah = h
    const { cols } = this
    this.gRow = new Float32Array(cols * 3); this.dRow = new Float32Array(cols * 3)
    this.x0 = new Int32Array(w); this.fx = new Float32Array(w)
    const cw = w / cols
    for (let x = 0; x < w; x++) {
      const u = Math.min(cols - 1, Math.max(0, (x + 0.5) / cw - 0.5))
      this.x0[x] = Math.max(0, Math.min(cols - 2, u | 0))
      this.fx[x] = cols > 1 ? u - this.x0[x] : 0
    }
  }

  /** Correct one frame into `out` (RGBA, same size). `strength` blends the gain toward 1. */
  apply(rgba: Uint8ClampedArray, w: number, h: number, out: Uint8ClampedArray, strength = 1): void {
    const G = this.gain
    if (!G) { out.set(rgba); return }
    this.prepare(w, h)
    const { cols, rows, dark, gRow, dRow, x0, fx } = this
    const ch = h / rows
    for (let y = 0; y < h; y++) {
      const v = Math.min(rows - 1, Math.max(0, (y + 0.5) / ch - 0.5))
      const y0 = Math.max(0, Math.min(rows - 2, v | 0)), fy = rows > 1 ? v - y0 : 0, y1 = Math.min(rows - 1, y0 + 1)
      for (let k = 0; k < cols * 3; k++) {
        const g = G[y0 * cols * 3 + k] * (1 - fy) + G[y1 * cols * 3 + k] * fy
        gRow[k] = 1 + (g - 1) * strength
        dRow[k] = dark ? dark[y0 * cols * 3 + k] * (1 - fy) + dark[y1 * cols * 3 + k] * fy : 0
      }
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4, a = x0[x] * 3, b = Math.min(cols - 1, x0[x] + 1) * 3, f = fx[x]
        for (let c = 0; c < 3; c++) {
          const g = gRow[a + c] * (1 - f) + gRow[b + c] * f
          const d = dRow[a + c] * (1 - f) + dRow[b + c] * f
          const lin = d + (LIN[rgba[i + c]] - d) * g
          out[i + c] = ENC[Math.max(0, Math.min(4080, (lin * 16) | 0))]
        }
        out[i + 3] = 255
      }
    }
    if (this.hot.length && w === this.w && h === this.h) {
      for (const p of this.hot) {
        const x = p % w, y = (p / w) | 0
        for (let c = 0; c < 3; c++) out[p * 4 + c] = median8(out, w, h, x, y, c, this.med)
      }
    }
  }

  toJson(): VideoFlatJson | null {
    if (!this.gain) return null
    const r4 = (v: number) => Math.round(v * 1e4) / 1e4
    const hot: number[] = []
    for (const p of this.hot) hot.push(p % this.w, (p / this.w) | 0)
    return {
      cols: this.cols, rows: this.rows, width: this.w, height: this.h,
      gain: Array.from(this.gain, r4), dark: this.dark ? Array.from(this.dark, r4) : null, hot,
      frames: this.frames, darkFrames: this.darkFrames, meanLuma: r4(this.meanLuma), when: new Date().toISOString(),
    }
  }

  static fromJson(j: VideoFlatJson): VideoFlat {
    const f = new VideoFlat(Math.ceil(j.width / j.cols))
    f.w = j.width; f.h = j.height; f.cols = j.cols; f.rows = j.rows
    f.gain = Float32Array.from(j.gain); f.dark = j.dark ? Float32Array.from(j.dark) : null
    f.frames = j.frames; f.darkFrames = j.darkFrames; f.meanLuma = j.meanLuma
    const hot: number[] = []
    for (let k = 0; k + 1 < j.hot.length; k += 2) hot.push(j.hot[k + 1] * j.width + j.hot[k])
    f.hot = Uint32Array.from(hot)
    return f
  }
}
