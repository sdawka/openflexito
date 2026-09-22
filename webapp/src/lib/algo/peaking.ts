/** Focus peaking and zebra overlays (`docs/video-research/colour.md` proposal 7): viewfinder aids
 *  painted onto an RGBA frame in place. Pure maths, no DOM; `services/peakingProcessor.ts` wires it
 *  into the frame chain for the `view` target only.
 *
 *  Peaking: luma at half resolution (2×2 box), 3×3 box blur (kills JPEG ringing), Sobel gradient
 *  magnitude, then a threshold at the frame's 97th percentile of the magnitude histogram. The
 *  percentile is self-normalising (the *amount* of highlighted edge stays roughly constant across
 *  samples) and is smoothed across frames by an EMA (`FocusPeaker`, τ ≈ 0.5 s at the caller's frame
 *  rate) so it doesn't flicker; when the 90th percentile is below `minP90` the frame is treated as
 *  featureless (out of focus / empty) and nothing is painted, otherwise peaking would light up noise.
 *  Each half-res pixel above the threshold paints its 2×2 full-res block in the peaking colour.
 *
 *  Zebra: any channel ≥ `hi` (default 250) gets diagonal stripes `((x + y) >> 3) & 1`; every channel
 *  ≤ `lo` (default 4) gets the opposite direction `((x - y) >> 3) & 1`. Stripes are white on clipped
 *  highlights and mid-grey on crushed shadows so both read on their backgrounds. */

export interface PeakingStats {
  /** 97th percentile of the Sobel magnitude (the raw, un-smoothed threshold candidate). */
  p97: number
  /** 90th percentile, used as the "is there anything in focus at all" gate. */
  p90: number
}

/** Half-resolution luma of an RGBA frame (2×2 box; odd trailing rows/cols dropped). */
export function halfLuma(rgba: Uint8ClampedArray, width: number, height: number, out?: Float32Array): { data: Float32Array; width: number; height: number } {
  const w = width >> 1, h = height >> 1
  const data = out && out.length === w * h ? out : new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const r0 = (2 * y) * width, r1 = r0 + width
    for (let x = 0; x < w; x++) {
      const i0 = (r0 + 2 * x) * 4, i1 = i0 + 4, i2 = (r1 + 2 * x) * 4, i3 = i2 + 4
      const l =
        (0.299 * (rgba[i0] + rgba[i1] + rgba[i2] + rgba[i3]) +
          0.587 * (rgba[i0 + 1] + rgba[i1 + 1] + rgba[i2 + 1] + rgba[i3 + 1]) +
          0.114 * (rgba[i0 + 2] + rgba[i1 + 2] + rgba[i2 + 2] + rgba[i3 + 2])) * 0.25
      data[y * w + x] = l
    }
  }
  return { data, width: w, height: h }
}

/** 3×3 box blur with clamped borders. */
export function blur3(src: Float32Array, w: number, h: number, out?: Float32Array): Float32Array {
  const dst = out && out.length === w * h ? out : new Float32Array(w * h)
  const inv = 1 / 9
  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : 0, yp = y < h - 1 ? y + 1 : h - 1
    for (let x = 0; x < w; x++) {
      const xm = x > 0 ? x - 1 : 0, xp = x < w - 1 ? x + 1 : w - 1
      dst[y * w + x] = (
        src[ym * w + xm] + src[ym * w + x] + src[ym * w + xp] +
        src[y * w + xm] + src[y * w + x] + src[y * w + xp] +
        src[yp * w + xm] + src[yp * w + x] + src[yp * w + xp]) * inv
    }
  }
  return dst
}

/** Sobel gradient magnitude (`sqrt(gx² + gy²)`), border pixels 0. */
export function sobelMagnitude(src: Float32Array, w: number, h: number, out?: Float32Array): Float32Array {
  const dst = out && out.length === w * h ? out : new Float32Array(w * h)
  dst.fill(0)
  for (let y = 1; y < h - 1; y++) {
    const rm = (y - 1) * w, r0 = y * w, rp = (y + 1) * w
    for (let x = 1; x < w - 1; x++) {
      const a = src[rm + x - 1], b = src[rm + x], c = src[rm + x + 1]
      const d = src[r0 + x - 1], f = src[r0 + x + 1]
      const g = src[rp + x - 1], hh = src[rp + x], i = src[rp + x + 1]
      const gx = (c + 2 * f + i) - (a + 2 * d + g)
      const gy = (g + 2 * hh + i) - (a + 2 * b + c)
      dst[r0 + x] = Math.sqrt(gx * gx + gy * gy)
    }
  }
  return dst
}

const HIST_BINS = 1024
const HIST_MAX = 1024 // Sobel magnitude on 0..255 luma peaks at ~1443; anything above the last bin is clipped into it

/** 90th/97th percentiles of the magnitude via a fixed-width histogram (values ≥ HIST_MAX share the top bin). */
export function edgePercentiles(mag: Float32Array, hist?: Uint32Array): PeakingStats {
  const h = hist && hist.length === HIST_BINS ? hist : new Uint32Array(HIST_BINS)
  h.fill(0)
  const n = mag.length
  for (let i = 0; i < n; i++) {
    let b = mag[i] | 0
    if (b >= HIST_MAX) b = HIST_BINS - 1
    h[b]++
  }
  const t90 = n * 0.9, t97 = n * 0.97
  let acc = 0, p90 = -1, p97 = -1
  for (let b = 0; b < HIST_BINS; b++) {
    acc += h[b]
    if (p90 < 0 && acc >= t90) p90 = b
    if (acc >= t97) { p97 = b; break }
  }
  return { p90: p90 < 0 ? 0 : p90, p97: p97 < 0 ? HIST_BINS - 1 : p97 }
}

export interface PeakingOptions {
  /** RGB 0..255 to paint edges with. */
  colour: [number, number, number]
  /** Skip painting when the 90th percentile of the edge magnitude is below this (noise-only frame). */
  minP90?: number
}

/** Paint every full-res 2×2 block whose half-res magnitude reaches `threshold` (`>=`: the threshold is a
 *  histogram-bin integer, and with a strict `>` a frame whose top bin holds ≥ 3 % of pixels would paint
 *  nothing) with `colour`.
 *  Returns the number of half-res pixels painted. */
export function paintPeaking(
  rgba: Uint8ClampedArray, width: number, mag: Float32Array, hw: number, hh: number, threshold: number, colour: [number, number, number],
): number {
  const [cr, cg, cb] = colour
  let count = 0
  for (let y = 0; y < hh; y++) {
    const r0 = (2 * y) * width, r1 = r0 + width
    for (let x = 0; x < hw; x++) {
      if (mag[y * hw + x] < threshold) continue
      count++
      const i0 = (r0 + 2 * x) * 4, i1 = i0 + 4, i2 = (r1 + 2 * x) * 4, i3 = i2 + 4
      rgba[i0] = cr; rgba[i0 + 1] = cg; rgba[i0 + 2] = cb
      rgba[i1] = cr; rgba[i1 + 1] = cg; rgba[i1 + 2] = cb
      rgba[i2] = cr; rgba[i2 + 1] = cg; rgba[i2 + 2] = cb
      rgba[i3] = cr; rgba[i3 + 1] = cg; rgba[i3 + 2] = cb
    }
  }
  return count
}

export interface ZebraOptions { hi?: number; lo?: number }

/** Stripe clipped highlights (`any channel ≥ hi`, `/`-diagonal) and crushed shadows (`all channels ≤ lo`,
 *  `\`-diagonal) in place. Returns `{ hi, lo }` pixel counts (all such pixels, striped or not). */
export function paintZebra(rgba: Uint8ClampedArray, width: number, height: number, o: ZebraOptions = {}): { hi: number; lo: number } {
  const hi = o.hi ?? 250, lo = o.lo ?? 4
  let nHi = 0, nLo = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
      if (r >= hi || g >= hi || b >= hi) {
        nHi++
        if (((x + y) >> 3) & 1) { rgba[i] = 255; rgba[i + 1] = 255; rgba[i + 2] = 255 }
        else { rgba[i] = 40; rgba[i + 1] = 40; rgba[i + 2] = 40 }
      } else if (r <= lo && g <= lo && b <= lo) {
        nLo++
        if (((x - y) >> 3) & 1) { rgba[i] = 128; rgba[i + 1] = 128; rgba[i + 2] = 128 }
      }
    }
  }
  return { hi: nHi, lo: nLo }
}

export interface FocusPeakerOptions {
  /** EMA time constant for the threshold, seconds. */
  tauS?: number
  /** Noise gate on the 90th percentile (default 3). */
  minP90?: number
}

/** Stateful peaking driver: keeps the scratch buffers and the EMA'd threshold. Call `process` once
 *  per frame with the frame's timestamp in seconds; pass `freeze: true` (stage moving) to paint with
 *  the last threshold without updating it. */
export class FocusPeaker {
  private luma?: Float32Array
  private blurred?: Float32Array
  private mag?: Float32Array
  private hist = new Uint32Array(HIST_BINS)
  private threshold = -1
  private lastT = NaN
  readonly tauS: number
  readonly minP90: number
  /** Stats of the last analysed frame (for tests/HUD). */
  last: PeakingStats & { threshold: number; painted: number; gated: boolean } = { p90: 0, p97: 0, threshold: 0, painted: 0, gated: false }

  constructor(o: FocusPeakerOptions = {}) {
    this.tauS = o.tauS ?? 0.5
    this.minP90 = o.minP90 ?? 3
  }

  reset(): void { this.threshold = -1; this.lastT = NaN }

  /** Analyse and paint in place. `tS` is the frame time in seconds (any monotone clock). */
  process(rgba: Uint8ClampedArray, width: number, height: number, tS: number, colour: [number, number, number], freeze = false): void {
    const hw = width >> 1, hh = height >> 1
    if (hw < 3 || hh < 3) return
    const n = hw * hh
    if (!this.luma || this.luma.length !== n) {
      this.luma = new Float32Array(n); this.blurred = new Float32Array(n); this.mag = new Float32Array(n)
    }
    halfLuma(rgba, width, height, this.luma)
    blur3(this.luma, hw, hh, this.blurred)
    sobelMagnitude(this.blurred!, hw, hh, this.mag)
    const stats = edgePercentiles(this.mag!, this.hist)

    if (!freeze || this.threshold < 0) {
      if (this.threshold < 0 || !Number.isFinite(this.lastT)) this.threshold = stats.p97
      else {
        const dt = Math.max(0, tS - this.lastT)
        const a = dt <= 0 ? 0 : 1 - Math.exp(-dt / this.tauS)
        this.threshold += a * (stats.p97 - this.threshold)
      }
      this.lastT = tS
    }
    const gated = stats.p90 < this.minP90
    const painted = gated ? 0 : paintPeaking(rgba, width, this.mag!, hw, hh, this.threshold, colour)
    this.last = { ...stats, threshold: this.threshold, painted, gated }
  }
}

/** Parse `#rgb` / `#rrggbb` / `rgb(r,g,b)` into 0..255 components; unknown strings → default green. */
export function parseColour(s: string, fallback: [number, number, number] = [0, 255, 0]): [number, number, number] {
  const t = s.trim()
  let m = /^#([0-9a-f]{6})$/i.exec(t)
  if (m) { const v = parseInt(m[1], 16); return [(v >> 16) & 255, (v >> 8) & 255, v & 255] }
  m = /^#([0-9a-f]{3})$/i.exec(t)
  if (m) { const v = m[1]; return [parseInt(v[0] + v[0], 16), parseInt(v[1] + v[1], 16), parseInt(v[2] + v[2], 16)] }
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(t)
  if (m) return [Math.min(255, +m[1]), Math.min(255, +m[2]), Math.min(255, +m[3])]
  return fallback
}
