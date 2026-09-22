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
    if (full) for (let i = 0; i < sum.length; i++) sum[i] += frame[i] - slot[i]
    else for (let i = 0; i < sum.length; i++) sum[i] += frame[i]
    slot.set(frame)
    this.head = (this.head + 1) % this.n
    if (!full) this.count++
    const inv = 1 / this.count, out = this.out
    for (let i = 0; i < sum.length; i += 4) { out[i] = sum[i] * inv; out[i + 1] = sum[i + 1] * inv; out[i + 2] = sum[i + 2] * inv; out[i + 3] = 255 }
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
    if (this.count === 0) { for (let i = 0; i < acc.length; i++) acc[i] = frame[i] }
    else {
      // during warm-up use 1/count so the first frames average instead of being dominated by frame 0
      const a = Math.max(this.alpha, 1 / (this.count + 1))
      const b = 1 - a
      for (let i = 0; i < acc.length; i++) acc[i] = b * acc[i] + a * frame[i]
    }
    this.count++
    for (let i = 0; i < acc.length; i += 4) { out[i] = acc[i]; out[i + 1] = acc[i + 1]; out[i + 2] = acc[i + 2]; out[i + 3] = 255 }
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

  /** Median of the last `n` frames (mean of what is there while warming up). */
  push(frame: Uint8ClampedArray): Uint8ClampedArray {
    this.ring[this.head].set(frame)
    this.head = (this.head + 1) % this.n
    if (this.count < this.n) this.count++
    const out = this.out, r = this.ring, len = frame.length
    if (this.count < this.n) {
      const inv = 1 / this.count
      for (let i = 0; i < len; i++) { let s = 0; for (let k = 0; k < this.count; k++) s += r[k][i]; out[i] = s * inv }
      return out
    }
    if (this.n === 3) {
      const a = r[0], b = r[1], c = r[2]
      for (let i = 0; i < len; i++) {
        const x = a[i], y = b[i], z = c[i]
        out[i] = x > y ? (y > z ? y : (x > z ? z : x)) : (x > z ? x : (y > z ? z : y))
      }
    } else {
      const v = [0, 0, 0, 0, 0]
      for (let i = 0; i < len; i++) {
        for (let k = 0; k < 5; k++) v[k] = r[k][i]
        // partial insertion sort to the 3rd element
        for (let k = 1; k < 5; k++) { const t = v[k]; let j = k - 1; while (j >= 0 && v[j] > t) { v[j + 1] = v[j]; j-- } v[j + 1] = t }
        out[i] = v[2]
      }
    }
    return out
  }
}

/** Mean |Laplacian| of the luma over a coarse grid (stride 2 by default: ~500k taps at 1640×1232,
 *  a couple of ms). Scale-free: only compared to itself over time. */
export function frameSharpness(data: Uint8ClampedArray, width: number, height: number, stride = 2): number {
  let sum = 0, n = 0
  const luma = (i: number) => data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114
  for (let y = stride; y < height - stride; y += stride) {
    for (let x = stride; x < width - stride; x += stride) {
      const i = (y * width + x) * 4
      const c = luma(i)
      const l = 4 * c - luma(i - 4 * stride) - luma(i + 4 * stride) - luma(i - width * 4 * stride) - luma(i + width * 4 * stride)
      sum += Math.abs(l); n++
    }
  }
  return n ? sum / n : 0
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
