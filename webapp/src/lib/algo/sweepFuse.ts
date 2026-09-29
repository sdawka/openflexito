/** Live extended depth of field from a continuous z sweep (device `/edof.bin`, `api/edofStream.ts`).
 *
 *  The stage sweeps z back and forth in legs while the camera runs a fast sensor mode; every leg's
 *  frames are fused into one composite, emitted when the leg completes. The specimen may be moving,
 *  so the fusion never blends several frames into a pixel (averaging and pyramid fusion leave
 *  double images of anything that moved): each 16×16 block takes its pixels from the single
 *  sharpest frame of the leg, and only the block borders are feathered, by bilinear interpolation
 *  of the per-block choice (the same feathering as `LiveStacker`'s weights).
 *
 *  Two rules keep the argmax honest:
 *  - flat blocks (background, no texture): when the best energy is not clearly above the block's
 *    median over the leg (`flatRatio`), noise alone would pick a random frame per leg and the
 *    background would flicker, so the block takes the reference frame instead — the frame nearest
 *    the middle of the leg's useful sweep. The test uses energies pooled over the 3×3 blocks
 *    around it (a single block's energy is too noisy for a 1.25 ratio), or flatRatio² on its own;
 *  - motion gate: a block only considers frames whose coarse content (block mean luminance) matches
 *    the reference frame's, within `motionTol + motionRel·σ` grey levels. Defocus barely changes a
 *    block's mean, a moving object does; without the gate a block the object crossed in one frame
 *    would pick that frame (the only one with texture there) and the object would appear once per
 *    block it visited. With it, moving things appear once, where they were at the reference time.
 *    The gate is dilated by one block, because a block's choice is feathered into its neighbours.
 *    Objects much smaller than a block (under ~10 % of its area) can slip through the gate.
 *
 *  Energies are smoothed over three neighbouring frames before the argmax: a sweep crosses a
 *  block's depth of field over several frames, noise does not, so this stabilises the choice.
 *
 *  Backlash: after each reversal the first `backlash_z` steps do not move the stage (dead band);
 *  frames exposed then are all at the leg's starting z. They are harmless in the argmax, but
 *  `usefulFraction` reports how many frames were in the moving part and the reference time is the
 *  middle of the moving part. `suggestBacklash` estimates the dead band from a static scene. */

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b), n = s.length
  return n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN
}

export interface SweepLegStart { leg: number; t_cmd?: number; t_ack: number; steps: number; step_us: number; z0?: number }
export interface SweepLegEnd { leg: number; t_end: number; z1?: number; cancelled?: boolean }

/** A set of frames fused into one composite: a sweep leg, or a fixed time window when there is no sweep. */
export interface LegGroup {
  /** leg number, or window index */
  id: number
  /** leg number, null for a time window */
  leg: number | null
  /** ns: frames with t0 ≤ ts ≤ t1 belong here (t1 is Infinity until the leg end is known) */
  t0: number
  t1: number
  start?: SweepLegStart
  end?: SweepLegEnd
}

/** Groups frames into legs by timestamp: a frame belongs to leg k when t_ack(k) ≤ ts ≤ t_end(k);
 *  frames between legs or before any leg belong to none. A leg is complete once its end is known and
 *  a frame with ts > t_end has arrived (frames arrive in time order), or on `flush`/`expireEnded`.
 *  Until the first leg record, and only when `windowMs` > 0, frames are grouped by fixed time
 *  windows instead (the camera-only mode, steps = 0); the first leg record closes that window. */
export class LegGrouper {
  private pending: LegGroup[] = []
  private win: LegGroup | null = null
  private sawLeg = false
  private lastTs = -Infinity
  windowNs: number

  constructor(opts: { windowMs?: number } = {}) { this.windowNs = Math.max(0, opts.windowMs ?? 0) * 1e6 }

  reset(): void { this.pending = []; this.win = null; this.sawLeg = false; this.lastTs = -Infinity }

  /** A leg started; returns groups this completes (an open time window). A previous leg whose end
   *  never arrived ends where this one was commanded. */
  startLeg(l: SweepLegStart): LegGroup[] {
    const done: LegGroup[] = []
    if (this.win) { done.push(this.win); this.win = null }
    this.sawLeg = true
    for (const g of this.pending) if (g.t1 === Infinity) g.t1 = Math.min(l.t_cmd ?? l.t_ack, l.t_ack)
    this.pending.push({ id: l.leg, leg: l.leg, t0: l.t_ack, t1: Infinity, start: l })
    return done.concat(this.completeBefore(this.lastTs))
  }

  /** A leg ended; returns it when a later frame was already seen. */
  endLeg(e: SweepLegEnd): LegGroup[] {
    const g = this.pending.find((p) => p.leg === e.leg)
    if (g) { g.end = e; g.t1 = e.t_end }
    return this.completeBefore(this.lastTs)
  }

  /** Assign a frame; returns its group (or null) and the groups it completes. Handle `completed`
   *  before adding the frame to its group. */
  frame(ts: number | null): { group: LegGroup | null; completed: LegGroup[] } {
    if (ts == null) return { group: null, completed: [] }
    if (ts > this.lastTs) this.lastTs = ts
    if (!this.sawLeg && this.windowNs > 0) {
      const id = Math.floor(ts / this.windowNs), completed: LegGroup[] = []
      if (this.win && this.win.id !== id) {
        if (id < this.win.id) return { group: null, completed }
        completed.push(this.win); this.win = null
      }
      this.win ??= { id, leg: null, t0: id * this.windowNs, t1: (id + 1) * this.windowNs - 1 }
      return { group: this.win, completed }
    }
    const completed = this.completeBefore(ts)
    const group = this.pending.find((g) => g.t0 <= ts && ts <= g.t1) ?? null
    return { group, completed }
  }

  /** Complete every pending group (the stream stopped). */
  flush(): LegGroup[] {
    const out = this.win ? [this.win, ...this.pending] : this.pending
    this.pending = []; this.win = null
    return out
  }

  /** Complete the legs whose end is known (no later frame came in time). */
  expireEnded(): LegGroup[] {
    const out = this.pending.filter((g) => g.end)
    this.pending = this.pending.filter((g) => !g.end)
    return out
  }

  private completeBefore(ts: number): LegGroup[] {
    const out = this.pending.filter((g) => g.t1 < ts)
    if (out.length) this.pending = this.pending.filter((g) => g.t1 >= ts)
    return out
  }
}

/** ns at which the stage starts moving in `leg`: the first `backlash` steps after a reversal are a dead band. */
export function deadBandEnd(leg: SweepLegStart, backlash: number): number {
  return leg.t_ack + Math.max(0, Math.min(Math.abs(leg.steps), backlash)) * leg.step_us * 1e3
}

/** Fraction of the leg's duration spent in the backlash dead band (0..1). */
export function deadBandFraction(leg: SweepLegStart, end: SweepLegEnd | undefined, backlash: number): number {
  const t1 = end?.t_end ?? leg.t_ack + Math.abs(leg.steps) * leg.step_us * 1e3
  if (!(t1 > leg.t_ack)) return 0
  return Math.min(1, (deadBandEnd(leg, backlash) - leg.t_ack) / (t1 - leg.t_ack))
}

/** Drops backlash dead-band frames before they are decoded. Every frame of a leg's dead band is at
 *  the leg's starting z, and each could still win a block, stretching the composite's time window
 *  over the whole leg instead of the stage's actual motion; so only the last dead-band frame is
 *  kept (it stands for the band's end z). It is held until the next frame shows it was the last.
 *  Frames outside any leg, or without a time, pass straight through. Counts per leg feed `useful`. */
export class DeadBandFilter<T> {
  private legs: SweepLegStart[] = []
  private held: { item: T; leg: number } | null = null
  private counts = new Map<number, { dead: number; moving: number }>()
  skipped = 0

  constructor(public backlash: number) {}

  reset(): void { this.legs = []; this.held = null; this.counts.clear(); this.skipped = 0 }

  startLeg(l: SweepLegStart): void {
    this.legs.push(l)
    if (this.legs.length > 4) this.counts.delete(this.legs.shift()!.leg)
  }

  /** Offer a frame (in time order); returns the frames to decode, in order. */
  offer(ts: number | null, item: T): T[] {
    const out: T[] = []
    let leg: SweepLegStart | undefined
    if (ts != null) for (let i = this.legs.length - 1; i >= 0; i--) if (this.legs[i].t_ack <= ts) { leg = this.legs[i]; break }
    if (!leg || ts == null) return this.release(out, item)
    const c = this.counts.get(leg.leg) ?? { dead: 0, moving: 0 }
    this.counts.set(leg.leg, c)
    if (ts < deadBandEnd(leg, this.backlash)) {
      c.dead++
      if (this.held && this.held.leg === leg.leg) this.skipped++
      else if (this.held) out.push(this.held.item)
      this.held = { item, leg: leg.leg }
      return out
    }
    c.moving++
    return this.release(out, item)
  }

  /** Release the held frame (stream ended). */
  flush(): T[] { return this.release([]) }

  /** Fraction of the leg's frames that were exposed after its dead band (skipped frames included). */
  useful(leg: number): number {
    const c = this.counts.get(leg)
    if (c) this.counts.delete(leg)
    return c && c.dead + c.moving ? c.moving / (c.dead + c.moving) : 0
  }

  private release(out: T[], item?: T): T[] {
    if (this.held) { out.push(this.held.item); this.held = null }
    if (item !== undefined) out.push(item)
    return out
  }
}

/** Fraction of the frame times that fell in the moving part of the leg (after the dead band). */
export function usefulFraction(times: ArrayLike<number>, leg: SweepLegStart, backlash: number): number {
  if (!times.length) return 0
  const t = deadBandEnd(leg, backlash)
  let n = 0
  for (let i = 0; i < times.length; i++) if (times[i] >= t) n++
  return n / times.length
}

/** Time the composite's reference frame should be nearest to: the middle of the leg's moving part. */
export function legMidTime(leg: SweepLegStart, end: SweepLegEnd | undefined, backlash: number): number {
  const t1 = end?.t_end ?? leg.t_ack + Math.abs(leg.steps) * leg.step_us * 1e3
  const t0 = Math.min(deadBandEnd(leg, backlash), t1)
  return (t0 + t1) / 2
}

/** Step (from t_ack, fractional) at which a leg's focus curve peaks, or null when the curve has no
 *  clear interior peak (peak at an end, or below `prominence` × its median). Parabolic sub-frame fit. */
export function legPeakStep(times: ArrayLike<number>, focus: ArrayLike<number>, leg: SweepLegStart, prominence = 1.5): number | null {
  const n = Math.min(times.length, focus.length)
  if (n < 5 || !(leg.step_us > 0)) return null
  let k = 0
  for (let i = 1; i < n; i++) if (focus[i] > focus[k]) k = i
  if (k === 0 || k === n - 1) return null
  if (!(focus[k] >= prominence * median(Array.from({ length: n }, (_, i) => focus[i])))) return null
  const a = focus[k - 1], b = focus[k], c = focus[k + 1], den = a - 2 * b + c
  const off = den < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0
  const dt = off >= 0 ? times[k + 1] - times[k] : times[k] - times[k - 1]
  return (times[k] + off * dt - leg.t_ack) / (leg.step_us * 1e3)
}

/** Backlash (steps) from the focus peaks of a static scene. An up leg starting at physical Zlo peaks
 *  at step b + (z* − Zlo); the down leg back from Zhi = Zlo + S − b peaks at step S + Zlo − z*; so
 *  b = k_up + k_down − S whatever the peak's depth z*. Uses the medians of each direction; null
 *  unless there are ≥ `minEach` peaks per direction that agree within `maxSpread` steps (MAD). */
export function suggestBacklash(peaks: readonly { dir: number; peakStep: number }[], steps: number, minEach = 3, maxSpread = 20): number | null {
  const up = peaks.filter((p) => p.dir > 0).map((p) => p.peakStep), dn = peaks.filter((p) => p.dir < 0).map((p) => p.peakStep)
  if (up.length < minEach || dn.length < minEach) return null
  const mu = median(up), md = median(dn)
  const mad = (v: number[], m: number) => median(v.map((x) => Math.abs(x - m)))
  if (mad(up, mu) > maxSpread || mad(dn, md) > maxSpread) return null
  const b = mu + md - Math.abs(steps)
  return b >= -maxSpread && b <= Math.abs(steps) ? Math.max(0, Math.round(b)) : null
}

/** 3×3 box sum over a cx×cy grid (edges sum what exists). */
function box3(a: ArrayLike<number>, cx: number, cy: number): Float32Array {
  const row = new Float32Array(a.length), out = new Float32Array(a.length)
  for (let y = 0; y < cy; y++) for (let x = 0; x < cx; x++) {
    const i = y * cx + x
    row[i] = a[i] + (x > 0 ? a[i - 1] : 0) + (x < cx - 1 ? a[i + 1] : 0)
  }
  for (let y = 0; y < cy; y++) for (let x = 0; x < cx; x++) {
    const i = y * cx + x
    out[i] = row[i] + (y > 0 ? row[i - cx] : 0) + (y < cy - 1 ? row[i + cx] : 0)
  }
  return out
}

export interface SweepFuseResult {
  composite: Uint8ClampedArray
  frames: number
  /** per block: index of the frame it took its pixels from */
  chosen: Int32Array
  /** blocks without clear texture that took the reference frame */
  flatBlocks: number
  /** blocks where the motion gate rejected at least one frame */
  motionBlocks: number
  /** first/last frame time, and the reference frame's time (the time moving things are shown at) */
  t0: number
  t1: number
  tMid: number
  /** per frame, in order: time and whole-frame focus energy (for `legPeakStep`) */
  times: Float64Array
  focus: Float32Array
}

export interface SweepFuseOptions {
  cell?: number
  flatRatio?: number
  /** motion gate: allowed block-mean difference to the reference, grey levels, plus `motionRel`·σ */
  motionTol?: number
  motionRel?: number
  /** frames kept per leg; beyond this every other frame is dropped and the rest are subsampled */
  maxFrames?: number
}

/** Per-block argmax fusion of one leg's frames; see the file comment. Keeps a reference to every
 *  frame passed to `add` until `finish`/`reset`: do not modify them. */
export class SweepFuser {
  readonly cell: number
  flatRatio: number
  motionTol: number
  motionRel: number
  readonly maxFrames: number
  readonly cellsX: number
  readonly cellsY: number
  private frames: Uint8ClampedArray[] = []
  private times: number[] = []
  private energy: Float32Array[] = []
  private mean: Float32Array[] = []
  private sd: Float32Array[] = []
  private stride = 1
  private offered = 0
  private lum: Float32Array
  private bx: Int32Array
  private w2: number; private h2: number

  constructor(public readonly width: number, public readonly height: number, opts: SweepFuseOptions = {}) {
    this.cell = Math.max(2, opts.cell ?? 16) & ~1
    this.flatRatio = opts.flatRatio ?? 1.25
    this.motionTol = opts.motionTol ?? 6
    this.motionRel = opts.motionRel ?? 0.3
    this.maxFrames = Math.max(2, opts.maxFrames ?? 64)
    this.cellsX = Math.ceil(width / this.cell); this.cellsY = Math.ceil(height / this.cell)
    this.w2 = width >> 1; this.h2 = height >> 1
    this.lum = new Float32Array(this.w2 * this.h2)
    const half = this.cell >> 1
    this.bx = Int32Array.from({ length: this.w2 }, (_, x) => Math.min(this.cellsX - 1, Math.floor(x / half)))
  }

  get count(): number { return this.frames.length }

  reset(): void {
    this.frames = []; this.times = []; this.energy = []; this.mean = []; this.sd = []
    this.stride = 1; this.offered = 0
  }

  /** Add one frame (RGBA, width×height) exposed at `t` ns: computes its block statistics only. */
  add(rgba: Uint8ClampedArray, t: number): void {
    if (rgba.length < this.width * this.height * 4) throw new Error('frame size does not match the fuser')
    if (this.offered++ % this.stride) return
    if (this.frames.length >= this.maxFrames) {
      // too many frames for one leg: keep every other one and subsample from now on
      const keep = <T>(a: T[]) => a.filter((_, i) => i % 2 === 0)
      this.frames = keep(this.frames); this.times = keep(this.times); this.energy = keep(this.energy)
      this.mean = keep(this.mean); this.sd = keep(this.sd); this.stride *= 2
    }
    const { width: w, w2, h2, lum, bx, cellsX } = this
    const nb = cellsX * this.cellsY, half = this.cell >> 1
    const e = new Float32Array(nb), sum = new Float32Array(nb), sq = new Float32Array(nb), cnt = new Float32Array(nb)
    // 2×2-averaged luminance (noise-robust, 4× cheaper), block sums on the way
    for (let y = 0; y < h2; y++) {
      const cy = Math.min(this.cellsY - 1, Math.floor(y / half)) * cellsX
      let p = 2 * y * w * 4, q = p + w * 4, o = y * w2
      for (let x = 0; x < w2; x++, p += 8, q += 8, o++) {
        const l = (0.299 * (rgba[p] + rgba[p + 4] + rgba[q] + rgba[q + 4])
          + 0.587 * (rgba[p + 1] + rgba[p + 5] + rgba[q + 1] + rgba[q + 5])
          + 0.114 * (rgba[p + 2] + rgba[p + 6] + rgba[q + 2] + rgba[q + 6])) * 0.25
        lum[o] = l
        const c = cy + bx[x]
        sum[c] += l; sq[c] += l * l; cnt[c]++
      }
    }
    // Laplacian energy per block
    for (let y = 1; y < h2 - 1; y++) {
      const cy = Math.min(this.cellsY - 1, Math.floor(y / half)) * cellsX
      let i = y * w2 + 1
      for (let x = 1; x < w2 - 1; x++, i++) {
        const lap = 4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - w2] - lum[i + w2]
        e[cy + bx[x]] += lap * lap
      }
    }
    for (let c = 0; c < nb; c++) {
      const n = cnt[c] || 1, m = sum[c] / n
      sum[c] = m; sq[c] = Math.sqrt(Math.max(0, sq[c] / n - m * m))
    }
    this.frames.push(rgba); this.times.push(t); this.energy.push(e); this.mean.push(sum); this.sd.push(sq)
  }

  /** Fuse the frames added since the last finish/reset and clear them. The reference frame (used
   *  by flat blocks and the motion gate) is the one nearest `tMid`, by default the middle of the
   *  frame times. Null when no frame was added. */
  finish(tMid?: number): SweepFuseResult | null {
    const n = this.frames.length
    if (!n) { this.reset(); return null }
    const { frames, times, cellsX, cellsY, cell, width: w, height: h } = this
    const nb = cellsX * cellsY
    const t0 = times[0], t1 = times[n - 1], target = tMid ?? (t0 + t1) / 2
    let ref = 0
    for (let i = 1; i < n; i++) if (Math.abs(times[i] - target) < Math.abs(times[ref] - target)) ref = i
    // energies smoothed over three neighbouring frames
    const E = this.energy.map((_, f) => {
      const a = this.energy[Math.max(0, f - 1)], b = this.energy[f], c = this.energy[Math.min(n - 1, f + 1)]
      const out = new Float32Array(nb)
      for (let k = 0; k < nb; k++) out[k] = (a[k] + 2 * b[k] + c[k]) * 0.25
      return out
    })
    const focus = new Float32Array(n)
    for (let f = 0; f < n; f++) { let s = 0; const e = this.energy[f]; for (let k = 0; k < nb; k++) s += e[k]; focus[f] = s }
    const { flatRatio, motionTol, motionRel, mean, sd } = this
    // flat test: one block's energy is a sum of only 64 noisy Laplacian terms, so noise alone beats
    // a 1.25 ratio in most flat blocks over a 30-frame leg. A block is textured when the energy
    // pooled over its 3×3 neighbourhood beats flatRatio, or its own energy beats flatRatio² (a block
    // whose neighbours focus at other depths, where the pooled curve is flat)
    const P = E.map((e) => box3(e, cellsX, cellsY))
    // motion gate, dilated by one block: a block's choice is also feathered across half of each
    // neighbour, so a frame is only eligible where it matches the reference in all nine
    const moved = this.mean.map((m, f) => {
      const d = new Uint8Array(nb), s = sd[f], mr = mean[ref], sr = sd[ref]
      for (let c = 0; c < nb; c++) d[c] = Math.abs(m[c] - mr[c]) > motionTol + motionRel * Math.max(s[c], sr[c]) ? 1 : 0
      return box3(d, cellsX, cellsY)
    })
    const chosen = new Int32Array(nb), scratch = new Float32Array(n), scratchE = new Float32Array(n)
    let flatBlocks = 0, motionBlocks = 0
    for (let c = 0; c < nb; c++) {
      let best = -1, bi = ref, cnt = 0, pBest = 0
      for (let f = 0; f < n; f++) {
        if (f !== ref && moved[f][c]) continue
        const e = E[f][c], p = P[f][c]
        scratch[cnt] = p; scratchE[cnt++] = e
        if (p > pBest) pBest = p
        if (e > best) { best = e; bi = f }
      }
      if (cnt < n) motionBlocks++
      const med = scratch.subarray(0, cnt).sort()[cnt >> 1], medE = scratchE.subarray(0, cnt).sort()[cnt >> 1]
      const clear = pBest > flatRatio * med || best > flatRatio * flatRatio * medE
      if (!clear) { chosen[c] = ref; flatBlocks++ } else chosen[c] = bi
    }
    // composite: per pixel the bilinear interpolation of the per-block choice between block centres;
    // where the four surrounding blocks agree (most of the image) whole row segments are copied
    const out = new Uint8ClampedArray(w * h * 4)
    const segs: number[] = [] // x0 value boundaries: [x0, xa, xb] triples
    {
      let prev = -1
      for (let x = 0; x < w; x++) {
        const fx = Math.min(cellsX - 1, Math.max(0, (x + 0.5) / cell - 0.5)), x0 = Math.floor(fx)
        if (x0 !== prev) { if (prev >= 0) segs.push(x); segs.push(x0, x); prev = x0 }
      }
      segs.push(w)
    }
    const txs = new Float32Array(w)
    for (let x = 0; x < w; x++) { const fx = Math.min(cellsX - 1, Math.max(0, (x + 0.5) / cell - 0.5)); txs[x] = fx - Math.floor(fx) }
    for (let y = 0; y < h; y++) {
      const fy = Math.min(cellsY - 1, Math.max(0, (y + 0.5) / cell - 0.5)), y0 = Math.floor(fy), y1 = Math.min(cellsY - 1, y0 + 1), ty = fy - y0
      const r0 = y0 * cellsX, r1 = y1 * cellsX, row = y * w * 4
      for (let s = 0; s < segs.length; s += 3) {
        const x0 = segs[s], xa = segs[s + 1], xb = segs[s + 2], x1 = Math.min(cellsX - 1, x0 + 1)
        const f00 = chosen[r0 + x0], f01 = chosen[r0 + x1], f10 = chosen[r1 + x0], f11 = chosen[r1 + x1]
        const pa = row + xa * 4, pb = row + xb * 4
        if (f00 === f01 && f00 === f10 && f00 === f11) { out.set(frames[f00].subarray(pa, pb), pa); continue }
        const A = frames[f00], B = frames[f01], C = frames[f10], D = frames[f11]
        for (let x = xa, p = pa; x < xb; x++, p += 4) {
          const tx = txs[x]
          const a00 = (1 - tx) * (1 - ty), a01 = tx * (1 - ty), a10 = (1 - tx) * ty, a11 = tx * ty
          out[p] = A[p] * a00 + B[p] * a01 + C[p] * a10 + D[p] * a11
          out[p + 1] = A[p + 1] * a00 + B[p + 1] * a01 + C[p + 1] * a10 + D[p + 1] * a11
          out[p + 2] = A[p + 2] * a00 + B[p + 2] * a01 + C[p + 2] * a10 + D[p + 2] * a11
          out[p + 3] = 255
        }
      }
    }
    const res: SweepFuseResult = {
      composite: out, frames: n, chosen, flatBlocks, motionBlocks, t0, t1, tMid: times[ref],
      times: Float64Array.from(times), focus,
    }
    this.reset()
    return res
  }
}
