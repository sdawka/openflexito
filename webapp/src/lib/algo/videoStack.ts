/** Temporal stacking primitives for video modes (`services/video/*`): everything here works on RGBA
 *  `Uint8ClampedArray` frames of one fixed size, keeps its own buffers, allocates nothing per frame
 *  after warm-up, and is pure (no DOM), so the recorder can call it once per decoded frame.
 *
 *  - `SlidingMean`: the mean of the last N frames (ring buffer + running sum) — a software "long
 *    exposure": noise falls by √N, moving things smear exactly as a real long exposure would.
 *  - `ExpIntegrator`: exponential integration `acc = (1-a)·acc + a·cur` with no motion gate (the gated
 *    variant is `algo/temporalDenoise.ts`); persistence like an ultrasound scanner's.
 *  - `TemporalMedian`: per-pixel median of the last 3 or 5 frames — rejects hot pixels, JPEG
 *    glitches and one-frame flicker without blurring steady content.
 *  - `QualityGate`: "lucky imaging" — keeps a frame only when its sharpness is above a running
 *    percentile of recent frames (AutoStakkert-style frame selection, applied live).
 *  - `frameSharpness`: mean |Laplacian| of the luma at a stride, the cheap metric the gate uses. */

/** ±0.5 LSB triangular (TPDF) dither table: an averaged 16-bit-ish mean re-quantised to 8 bits bands
 *  visibly on the smooth LED background and the video encoder then amplifies the bands; adding
 *  sub-LSB noise before rounding breaks them up (Punchihewa et al. 2006). One table, indexed by pixel
 *  with a per-frame offset so the pattern does not sit still. */
const DITHER_N = 4096
const DITHER = new Float32Array(DITHER_N)
{ let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 }; for (let i = 0; i < DITHER_N; i++) DITHER[i] = (rnd() + rnd() - 1) * 0.5 }
let ditherPhase = 0
/** Round `v` with dither for pixel `p` (call `nextDitherFrame()` once per frame). */
export function dither(v: number, p: number): number { return v + DITHER[(p + ditherPhase) & (DITHER_N - 1)] }
export function nextDitherFrame(): void { ditherPhase = (ditherPhase + 977) & (DITHER_N - 1) }

export class SlidingMean {
  private ring: Uint8ClampedArray[] = []
  private sum: Float32Array
  private head = 0
  count = 0
  readonly out: Uint8ClampedArray

  constructor(public readonly width: number, public readonly height: number, public readonly n: number) {
    if (n < 1) throw new Error('SlidingMean needs n >= 1')
    const len = width * height * 4
    this.sum = new Float32Array(len)
    this.out = new Uint8ClampedArray(len)
    for (let i = 0; i < n; i++) this.ring.push(new Uint8ClampedArray(len))
  }

  reset(): void { this.sum.fill(0); this.count = 0; this.head = 0 }

  /** Add a frame and return the mean of the window (the same `out` buffer each call). */
  push(frame: Uint8ClampedArray): Uint8ClampedArray {
    const slot = this.ring[this.head]
    const sum = this.sum, full = this.count === this.n
    if (full) for (let i = 0; i < sum.length; i += 4) { sum[i] += frame[i] - slot[i]; sum[i + 1] += frame[i + 1] - slot[i + 1]; sum[i + 2] += frame[i + 2] - slot[i + 2] }
    else for (let i = 0; i < sum.length; i += 4) { sum[i] += frame[i]; sum[i + 1] += frame[i + 1]; sum[i + 2] += frame[i + 2] }
    slot.set(frame)
    this.head = (this.head + 1) % this.n
    if (!full) this.count++
    const inv = 1 / this.count, out = this.out
    nextDitherFrame()
    for (let i = 0, p = 0; i < sum.length; i += 4, p++) { out[i] = dither(sum[i] * inv, p); out[i + 1] = dither(sum[i + 1] * inv, p); out[i + 2] = dither(sum[i + 2] * inv, p); out[i + 3] = 255 }
    return out
  }
}

export class ExpIntegrator {
  private acc: Float32Array
  readonly out: Uint8ClampedArray
  count = 0

  /** `alpha` is the weight of the new frame (0.05 = ~20-frame memory). */
  constructor(public readonly width: number, public readonly height: number, public alpha: number) {
    const len = width * height * 4
    this.acc = new Float32Array(len)
    this.out = new Uint8ClampedArray(len)
  }

  reset(): void { this.count = 0 }

  push(frame: Uint8ClampedArray): Uint8ClampedArray {
    const acc = this.acc, out = this.out
    if (this.count === 0) { for (let i = 0; i < acc.length; i += 4) { acc[i] = frame[i]; acc[i + 1] = frame[i + 1]; acc[i + 2] = frame[i + 2] } }
    else {
      // during warm-up use 1/count so the first frames average instead of being dominated by frame 0
      const a = Math.max(this.alpha, 1 / (this.count + 1))
      const b = 1 - a
      for (let i = 0; i < acc.length; i += 4) { acc[i] = b * acc[i] + a * frame[i]; acc[i + 1] = b * acc[i + 1] + a * frame[i + 1]; acc[i + 2] = b * acc[i + 2] + a * frame[i + 2] }
    }
    this.count++
    nextDitherFrame()
    for (let i = 0, p = 0; i < acc.length; i += 4, p++) { out[i] = dither(acc[i], p); out[i + 1] = dither(acc[i + 1], p); out[i + 2] = dither(acc[i + 2], p); out[i + 3] = 255 }
    return out
  }
}

export class TemporalMedian {
  private ring: Uint8ClampedArray[] = []
  private head = 0
  count = 0
  readonly out: Uint8ClampedArray

  constructor(public readonly width: number, public readonly height: number, public readonly n: 3 | 5) {
    const len = width * height * 4
    this.out = new Uint8ClampedArray(len)
    for (let i = 0; i < n; i++) this.ring.push(new Uint8ClampedArray(len))
  }

  reset(): void { this.count = 0; this.head = 0 }

  /** Median of the last `n` frames (mean of what is there while warming up). The median is found on
   *  the luma and that frame's RGB is copied, so there are no colour fringes from per-channel medians
   *  and only one channel is compared (a third of the cost). */
  push(frame: Uint8ClampedArray): Uint8ClampedArray {
    this.ring[this.head].set(frame)
    this.head = (this.head + 1) % this.n
    if (this.count < this.n) this.count++
    const out = this.out, r = this.ring, len = frame.length
    if (this.count < this.n) {
      const inv = 1 / this.count
      for (let i = 0; i < len; i += 4) { let s0 = 0, s1 = 0, s2 = 0; for (let k = 0; k < this.count; k++) { s0 += r[k][i]; s1 += r[k][i + 1]; s2 += r[k][i + 2] } out[i] = s0 * inv; out[i + 1] = s1 * inv; out[i + 2] = s2 * inv; out[i + 3] = 255 }
      return out
    }
    const L = (f: Uint8ClampedArray, i: number) => f[i] * 0.299 + f[i + 1] * 0.587 + f[i + 2] * 0.114
    if (this.n === 3) {
      const a = r[0], b = r[1], c = r[2]
      for (let i = 0; i < len; i += 4) {
        const x = L(a, i), y = L(b, i), z = L(c, i)
        const m = x > y ? (y > z ? b : (x > z ? c : a)) : (x > z ? a : (y > z ? c : b))
        out[i] = m[i]; out[i + 1] = m[i + 1]; out[i + 2] = m[i + 2]; out[i + 3] = 255
      }
    } else {
      const v = [0, 0, 0, 0, 0], ix = [0, 1, 2, 3, 4]
      for (let i = 0; i < len; i += 4) {
        for (let k = 0; k < 5; k++) { v[k] = L(r[k], i); ix[k] = k }
        // insertion sort of indices by luma; the 3rd is the median
        for (let k = 1; k < 5; k++) { const t = v[k], ti = ix[k]; let j = k - 1; while (j >= 0 && v[j] > t) { v[j + 1] = v[j]; ix[j + 1] = ix[j]; j-- } v[j + 1] = t; ix[j + 1] = ti }
        const m = r[ix[2]]
        out[i] = m[i]; out[i + 1] = m[i + 1]; out[i + 2] = m[i + 2]; out[i + 3] = 255
      }
    }
    return out
  }
}

/** Frame sharpness for quality gating: mean gradient magnitude of a 2×2 box-reduced luma, divided
 *  by its mean (AutoStakkert's "Gradient" metric, exposure-invariant; the 2×2 reduction and the
 *  gradient instead of a Laplacian keep JPEG noise from ranking noisy frames as sharp). `stride` is
 *  applied on the reduced grid (2 → ~125k taps at 1640×1232). */
export function frameSharpness(data: Uint8ClampedArray, width: number, height: number, stride = 2): number {
  const w2 = width >> 1, h2 = height >> 1
  if (w2 < 4 || h2 < 4) return 0
  const L2 = (x: number, y: number) => {
    const i = (2 * y * width + 2 * x) * 4, j = i + width * 4
    return (data[i] + data[i + 4] + data[j] + data[j + 4]) * 0.299 + (data[i + 1] + data[i + 5] + data[j + 1] + data[j + 5]) * 0.587 + (data[i + 2] + data[i + 6] + data[j + 2] + data[j + 6]) * 0.114
  }
  let grad = 0, mean = 0, n = 0
  for (let y = 1; y < h2 - 1; y += stride) {
    for (let x = 1; x < w2 - 1; x += stride) {
      const gx = L2(x + 1, y) - L2(x - 1, y), gy = L2(x, y + 1) - L2(x, y - 1)
      grad += Math.hypot(gx, gy); mean += L2(x, y); n++
    }
  }
  if (!n || mean <= 0) return 0
  return grad / mean
}

/** Keep a frame when its score is at or above the `keep` fraction's cut-off among the last `window`
 *  scores (keep = 0.3 → the sharpest 30 %). The first `minHistory` frames all pass so a recording
 *  never starts empty; a score history is kept across skipped frames. */
export class QualityGate {
  private scores: number[] = []
  kept = 0
  seen = 0

  constructor(public keep: number, public window = 60, public minHistory = 8) {}

  reset(): void { this.scores = []; this.kept = 0; this.seen = 0 }

  /** Current cut-off score, or null while warming up. */
  threshold(): number | null {
    if (this.scores.length < this.minHistory) return null
    const sorted = [...this.scores].sort((a, b) => a - b)
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((1 - this.keep) * sorted.length)))
    return sorted[idx]
  }

  accept(score: number): boolean {
    this.seen++
    const th = this.threshold()
    this.scores.push(score)
    if (this.scores.length > this.window) this.scores.shift()
    const ok = th == null || score >= th
    if (ok) this.kept++
    return ok
  }
}
