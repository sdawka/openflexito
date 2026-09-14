/** Multi-scale focus fusion (Burt & Adelson pattern-selective fusion, Mertens-style consistency).
 *
 *  Each slice is decomposed into a Laplacian pyramid. A per-pixel *weight map* is computed once per
 *  slice from the fine-band Laplacian energy (5×5 box of |lap| over the finest `bands` levels), raised
 *  to `power` (a softmax over log-energy with temperature 1/power: equal energies blend, a 2× sharper
 *  slice dominates), and Gaussian-pyramided; every level's coefficient is the weight-normalised sum
 *  over the slices with that level's weights (`selection: 'consistent'`). Deriving the coarse weights
 *  from the fine-level map instead of an independent per-level argmax removes the classic PMax halo:
 *  a defocused slice's blurred edge carries more low-frequency energy a few pixels off the edge than
 *  the sharp slice does, so a per-level argmax took its glow into the result. Where every slice is
 *  below the noise floor (k × the 5th-percentile energy of the first slice, i.e. its flattest pixels) the weights
 *  are equal, so featureless background is averaged instead of amplified by picking the largest
 *  noise excursion. Slices are streamed one at a time so a 9-slice 8 MP stack needs only two
 *  pyramids of memory plus the accumulators. `selection: 'perLevelMax'` keeps the previous hard
 *  per-level selection for comparison.
 *
 *  Depth: `depthIndex()` is the finest-level winner per pixel (hard), `depthSoft()` the weight-
 *  averaged slice index (fractional, smoother) and `depthConfidence()` the winner's share of the
 *  weight (0 = tie, 1 = unambiguous). `hybridFuse` (Zerene DMap-style) re-reads the aligned slices
 *  along a spatially smoothed depth surface where the confidence is high and blends with the
 *  pyramid result elsewhere: cleaner on smooth surfaces, needs the slices kept in memory. */

export interface FuseResult { data: Uint8ClampedArray; width: number; height: number; contributions: number[] }
export interface FusePlanes { planes: [Float32Array<ArrayBufferLike>, Float32Array<ArrayBufferLike>, Float32Array<ArrayBufferLike>]; width: number; height: number; contributions: number[] }

export interface FuseOptions {
  /** 'consistent' (default): weights from the fine-band energy, Gaussian-pyramided to every level;
   *  'perLevelMax': independent hard argmax of the smoothed energy at each level (previous behaviour). */
  selection?: 'consistent' | 'perLevelMax'
  /** softmax selectivity: weight = (energy / scale)^power; higher = harder selection. Default 6. */
  power?: number
  /** noise floor = noiseK × the 5th-percentile energy of the first slice; energies below it are clamped to it. Default 2. */
  noiseK?: number
  /** explicit noise floor (energy units of the finest band), overriding the estimate. */
  noise?: number
  /** how many of the finest Laplacian bands feed the weight map (1 = level 0 only). Default 2. */
  bands?: number
  /** how much of the next-coarser level's (upsampled) weights each level inherits; 0 = plain Gaussian
   *  weight pyramid (Mertens), 1 = default. */
  inherit?: number
}

interface Level { w: number; h: number }

function levelsFor(w: number, h: number, minSize = 24): Level[] {
  const out: Level[] = [{ w, h }]
  while (Math.min(out[out.length - 1].w, out[out.length - 1].h) > minSize * 2) {
    const l = out[out.length - 1]
    out.push({ w: Math.ceil(l.w / 2), h: Math.ceil(l.h / 2) })
  }
  return out
}

/** 2× downsample with a [1 4 6 4 1]/16 separable kernel (edge clamped). */
export function down(src: Float32Array, w: number, h: number, w2: number, h2: number): Float32Array {
  const tmp = new Float32Array(w2 * h), out = new Float32Array(w2 * h2)
  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x2 = 0; x2 < w2; x2++) {
      const x = 2 * x2
      const xm2 = x - 2 < 0 ? 0 : x - 2, xm1 = x - 1 < 0 ? 0 : x - 1, xp1 = x + 1 >= w ? w - 1 : x + 1, xp2 = x + 2 >= w ? w - 1 : x + 2
      tmp[y * w2 + x2] = (src[row + xm2] + 4 * src[row + xm1] + 6 * src[row + (x >= w ? w - 1 : x)] + 4 * src[row + xp1] + src[row + xp2]) / 16
    }
  }
  for (let y2 = 0; y2 < h2; y2++) {
    const y = 2 * y2
    const ym2 = y - 2 < 0 ? 0 : y - 2, ym1 = y - 1 < 0 ? 0 : y - 1, yc = y >= h ? h - 1 : y, yp1 = y + 1 >= h ? h - 1 : y + 1, yp2 = y + 2 >= h ? h - 1 : y + 2
    for (let x2 = 0; x2 < w2; x2++) {
      out[y2 * w2 + x2] = (tmp[ym2 * w2 + x2] + 4 * tmp[ym1 * w2 + x2] + 6 * tmp[yc * w2 + x2] + 4 * tmp[yp1 * w2 + x2] + tmp[yp2 * w2 + x2]) / 16
    }
  }
  return out
}

/** Bilinear 2× upsample to exactly w×h. */
export function up(src: Float32Array, w2: number, h2: number, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const fy = Math.min(h2 - 1, Math.max(0, (y + 0.5) / 2 - 0.5)), y0 = Math.floor(fy), y1 = Math.min(h2 - 1, y0 + 1), ty = fy - y0
    for (let x = 0; x < w; x++) {
      const fx = Math.min(w2 - 1, Math.max(0, (x + 0.5) / 2 - 0.5)), x0 = Math.floor(fx), x1 = Math.min(w2 - 1, x0 + 1), tx = fx - x0
      out[y * w + x] = (src[y0 * w2 + x0] * (1 - tx) + src[y0 * w2 + x1] * tx) * (1 - ty) + (src[y1 * w2 + x0] * (1 - tx) + src[y1 * w2 + x1] * tx) * ty
    }
  }
  return out
}

/** 5×5 box blur of |v| (energy smoothing, so selection is not decided by single noisy pixels). */
function energy(lap: Float32Array, w: number, h: number): Float32Array {
  const a = new Float32Array(w * h), tmp = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) a[i] = Math.abs(lap[i])
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0
    for (let k = -2; k <= 2; k++) s += a[y * w + Math.min(w - 1, Math.max(0, x + k))]
    tmp[y * w + x] = s
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0
    for (let k = -2; k <= 2; k++) s += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x]
    a[y * w + x] = s
  }
  return a
}

/** Noise floor of a selection-energy map: a low percentile (default 5 %) of the energies over a
 *  subsample of the image. The flattest few percent of any frame carry noise only, so this tracks the
 *  sensor/JPEG noise even when most of the frame is textured (a median-of-|Laplacian| estimator would
 *  read texture as noise on a densely detailed specimen and average away real detail). */
export function noiseEnergy(e: Float32Array, percentile = 0.05): number {
  const step = Math.max(1, Math.floor(e.length / 65536))
  const s: number[] = []
  for (let i = 0; i < e.length; i += step) s.push(e[i])
  s.sort((a, b) => a - b)
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * percentile))] : 0
}

export class PyramidFuser {
  private levels: Level[]
  private opts: Required<Omit<FuseOptions, 'noise'>> & { noise?: number }
  // consistent selection: weighted sums per level (A = Σ W·coef per channel, B = Σ W)
  private accA: Float32Array[][] = []
  private accB: Float32Array[] = []
  private residualW: Float32Array | null = null
  private scale = 0                     // energy normalisation (from the first slice)
  private floor = 0                     // noise floor in energy units
  private bestEnergy0: Float32Array     // level 0: strongest energy seen
  private bestWeight0: Float32Array     // level 0: winner's post-inheritance weight (Ws[0] at the time it won)
  private softIndex: Float32Array       // level 0: Σ W·index
  // per-level max selection (legacy)
  private best: Float32Array[][] = []
  private bestEnergy: Float32Array[] = []
  private bestIndex: Uint8Array         // level 0: which slice supplied each pixel
  private residual: Float32Array[]      // [channel] running sum of the coarsest Gaussian
  private count = 0
  constructor(public width: number, public height: number, opts: FuseOptions = {}) {
    this.opts = { selection: opts.selection ?? 'consistent', power: opts.power ?? 6, noiseK: opts.noiseK ?? 2, bands: opts.bands ?? 2, inherit: opts.inherit ?? 1, noise: opts.noise }
    this.levels = levelsFor(width, height)
    const fine = this.levels.slice(0, -1)
    if (this.opts.selection === 'consistent') {
      this.accA = fine.map((l) => [0, 1, 2].map(() => new Float32Array(l.w * l.h)))
      this.accB = fine.map((l) => new Float32Array(l.w * l.h))
      const last = this.levels[this.levels.length - 1]
      this.residualW = new Float32Array(last.w * last.h)
    } else {
      this.best = fine.map((l) => [0, 1, 2].map(() => new Float32Array(l.w * l.h)))
      this.bestEnergy = fine.map((l) => new Float32Array(l.w * l.h).fill(-1))
    }
    this.bestEnergy0 = new Float32Array(width * height).fill(-1)
    this.bestWeight0 = new Float32Array(width * height)
    this.softIndex = new Float32Array(width * height)
    this.bestIndex = new Uint8Array(width * height)
    const last = this.levels[this.levels.length - 1]
    this.residual = [0, 1, 2].map(() => new Float32Array(last.w * last.h))
  }

  /** Add one slice (RGBA 8-bit, already aligned). */
  add(rgba: Uint8ClampedArray, index: number): void {
    const { width: w, height: h } = this
    const planes: [Float32Array, Float32Array, Float32Array] = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)]
    for (let i = 0, p = 0; i < w * h; i++, p += 4) { planes[0][i] = rgba[p]; planes[1][i] = rgba[p + 1]; planes[2][i] = rgba[p + 2] }
    this.addPlanes(planes, index)
  }

  /** Add one slice as float RGB planes on any linear scale (8-bit values, 16-bit values, ...). */
  addPlanes(planes: [Float32Array, Float32Array, Float32Array], index: number): void {
    if (this.opts.selection === 'perLevelMax') return this.addPerLevelMax(planes, index)
    const { width: w, height: h, levels } = this
    const n = levels.length
    // luminance Gaussian pyramid, Laplacian energies of the finest `bands` levels, combined at level 0
    const lums: Float32Array[] = [new Float32Array(w * h)]
    for (let i = 0; i < w * h; i++) lums[0][i] = 0.299 * planes[0][i] + 0.587 * planes[1][i] + 0.114 * planes[2][i]
    for (let l = 0; l < n - 1; l++) lums.push(down(lums[l], levels[l].w, levels[l].h, levels[l + 1].w, levels[l + 1].h))
    const bands = Math.min(this.opts.bands, n - 1)
    let sel: Float32Array | null = null
    for (let b = bands - 1; b >= 0; b--) {
      const cur = levels[b], nxt = levels[b + 1]
      const lumUp = up(lums[b + 1], nxt.w, nxt.h, cur.w, cur.h)
      const lap = new Float32Array(cur.w * cur.h)
      for (let i = 0; i < lap.length; i++) lap[i] = lums[b][i] - lumUp[i]
      const e = energy(lap, cur.w, cur.h)
      if (sel) { const u = up(sel, nxt.w, nxt.h, cur.w, cur.h); for (let i = 0; i < e.length; i++) e[i] += u[i] }
      sel = e
    }
    const E = sel!
    if (!this.count) {
      let m = 0; for (let i = 0; i < E.length; i++) m += E[i]
      this.scale = Math.max(1e-6, m / E.length)
      this.floor = this.opts.noise ?? this.opts.noiseK * noiseEnergy(E)
    }
    // weight map: (max(E, floor) / scale)^power; depth bookkeeping at level 0
    const { power } = this.opts, inv = 1 / this.scale, fl = this.floor
    let W: Float32Array = new Float32Array(w * h)
    const be = this.bestEnergy0
    for (let i = 0; i < W.length; i++) {
      const e = E[i]
      W[i] = Math.pow((e > fl ? e : fl) * inv, power)
      if (e > be[i]) { be[i] = e; this.bestIndex[i] = index }
    }
    // weight pyramid: Gaussian-downsampled, then each level inherits the coarser one (`inherit` × the
    // upsampled coarser weights). Where the fine weights are tied at the floor, the decision that the
    // coarse levels make (from a strong edge nearby) is thereby also made at the fine levels: without
    // this the coarse coefficients came from the sharp slice while the fine ones were averaged, and
    // the sharp slice's low-pass overshoot around edges was left uncancelled (dark/bright ring).
    const Ws: Float32Array[] = [W]
    for (let l = 0; l < n - 1; l++) Ws.push(down(Ws[l], levels[l].w, levels[l].h, levels[l + 1].w, levels[l + 1].h))
    const { inherit } = this.opts
    if (inherit > 0) for (let l = n - 2; l >= 0; l--) {
      const u = up(Ws[l + 1], levels[l + 1].w, levels[l + 1].h, levels[l].w, levels[l].h), t = Ws[l]
      for (let i = 0; i < t.length; i++) t[i] += inherit * u[i]
    }
    // depthSoft/depthConfidence compare a per-slice weight against the accumulated total B = accB[0]
    // (below), which sums every slice's *post-inheritance* level-0 weight (Ws[0], just folded above) —
    // not the raw pow(e·inv, power) each slice started with. Accumulate softIndex, and record the
    // winner's weight, from Ws[0] here so both stay on the same scale as B (using the raw value made
    // depthSoft/depthConfidence collapse toward the uniform mean/1÷N regardless of the actual sharpness
    // gap, since inheritance can multiply weights well past their raw value).
    { const Ws0 = Ws[0], bw = this.bestWeight0, bi = this.bestIndex, si = this.softIndex; for (let i = 0; i < Ws0.length; i++) { si[i] += Ws0[i] * index; if (bi[i] === index) bw[i] = Ws0[i] } }
    // per level: Laplacian coefficients weighted by that level's weights
    let g: Float32Array[] = planes
    for (let l = 0; l < n - 1; l++) {
      const cur = levels[l], nxt = levels[l + 1]
      const gNext = g.map((ch) => down(ch, cur.w, cur.h, nxt.w, nxt.h))
      const ups = gNext.map((ch) => up(ch, nxt.w, nxt.h, cur.w, cur.h))
      const A = this.accA[l], B = this.accB[l], Wl = Ws[l]
      for (let i = 0; i < Wl.length; i++) {
        const wi = Wl[i]
        A[0][i] += wi * (g[0][i] - ups[0][i]); A[1][i] += wi * (g[1][i] - ups[1][i]); A[2][i] += wi * (g[2][i] - ups[2][i])
        B[i] += wi
      }
      g = gNext
    }
    W = Ws[n - 1]
    const rw = this.residualW!
    for (let i = 0; i < rw.length; i++) { rw[i] += W[i]; for (let c = 0; c < 3; c++) this.residual[c][i] += W[i] * g[c][i] }
    this.count++
  }

  private addPerLevelMax(planes: [Float32Array, Float32Array, Float32Array], index: number): void {
    const { width: w, height: h } = this
    let g: Float32Array<ArrayBufferLike>[] = planes
    let lum: Float32Array<ArrayBufferLike> = new Float32Array(w * h)
    for (let i = 0; i < w * h; i++) lum[i] = 0.299 * g[0][i] + 0.587 * g[1][i] + 0.114 * g[2][i]
    for (let l = 0; l < this.levels.length - 1; l++) {
      const cur = this.levels[l], nxt = this.levels[l + 1]
      const gNext = g.map((ch) => down(ch, cur.w, cur.h, nxt.w, nxt.h))
      const lumNext = down(lum, cur.w, cur.h, nxt.w, nxt.h)
      const lumUp = up(lumNext, nxt.w, nxt.h, cur.w, cur.h)
      const lap = new Float32Array(cur.w * cur.h)
      for (let i = 0; i < lap.length; i++) lap[i] = lum[i] - lumUp[i]
      const e = energy(lap, cur.w, cur.h)
      const ups = gNext.map((ch) => up(ch, nxt.w, nxt.h, cur.w, cur.h))
      const be = this.bestEnergy[l], bc = this.best[l]
      for (let i = 0; i < lap.length; i++) {
        if (e[i] > be[i]) {
          be[i] = e[i]
          bc[0][i] = g[0][i] - ups[0][i]; bc[1][i] = g[1][i] - ups[1][i]; bc[2][i] = g[2][i] - ups[2][i]
          if (l === 0) { this.bestIndex[i] = index; this.bestEnergy0[i] = e[i] }
        }
        if (l === 0) this.softIndex[i] += e[i] * index
      }
      g = gNext; lum = lumNext
    }
    for (let c = 0; c < 3; c++) for (let i = 0; i < g[c].length; i++) this.residual[c][i] += g[c][i]
    this.count++
  }

  /** Collapse the pyramid: float planes on the input scale. */
  resultPlanes(): FusePlanes {
    const n = this.levels.length, consistent = this.opts.selection === 'consistent'
    let cur: Float32Array[] = this.residual.map((r) => {
      const o = new Float32Array(r.length)
      for (let i = 0; i < r.length; i++) o[i] = consistent ? (this.residualW![i] > 0 ? r[i] / this.residualW![i] : 0) : r[i] / Math.max(1, this.count)
      return o
    })
    for (let l = n - 2; l >= 0; l--) {
      const lv = this.levels[l], nx = this.levels[l + 1]
      cur = cur.map((ch, c) => {
        const u = up(ch, nx.w, nx.h, lv.w, lv.h)
        if (consistent) { const A = this.accA[l][c], B = this.accB[l]; for (let i = 0; i < u.length; i++) if (B[i] > 0) u[i] += A[i] / B[i] }
        else { const b = this.best[l][c]; for (let i = 0; i < u.length; i++) u[i] += b[i] }
        return u
      })
    }
    const { width: w, height: h } = this
    const counts = new Array(Math.max(1, this.count)).fill(0)
    for (let i = 0; i < w * h; i++) counts[this.bestIndex[i]]++
    return { planes: [cur[0], cur[1], cur[2]] as [Float32Array, Float32Array, Float32Array], width: w, height: h, contributions: counts.map((c) => c / (w * h)) }
  }

  /** 8-bit RGBA result (for 8-bit inputs). */
  result(): FuseResult {
    const r = this.resultPlanes(), { width: w, height: h } = this
    return { data: packRgba8(r.planes, w, h), width: w, height: h, contributions: r.contributions }
  }

  /** Per-pixel winning slice index at the finest level (which added slice supplied this pixel).
   *  Depth-from-focus: paired with each slice's z this gives a coarse per-pixel depth map. */
  depthIndex(): Uint8Array { return this.bestIndex }

  /** Weight-averaged slice index per pixel (fractional): Σ W·index / Σ W at the finest level. Smoother
   *  than the hard winner between two slices of similar sharpness; equals the mean index where nothing
   *  is in focus in any slice. */
  depthSoft(): Float32Array {
    const out = new Float32Array(this.softIndex.length)
    const B = this.opts.selection === 'consistent' ? this.accB[0] : null
    if (B) { for (let i = 0; i < out.length; i++) out[i] = B[i] > 0 ? this.softIndex[i] / B[i] : 0 }
    else { // legacy: energy-weighted mean is not tracked exactly; fall back to the hard index
      for (let i = 0; i < out.length; i++) out[i] = this.bestIndex[i]
    }
    return out
  }

  /** How unambiguous the finest-level winner is: (winner's weight share − 1/N) / (1 − 1/N) in 0..1, and
   *  0 wherever the winner's energy is at the noise floor. Only meaningful for 'consistent' selection.
   *  The share is the winner's post-inheritance weight (`bestWeight0`, same scale as `B`) over the total
   *  accumulated weight `B`, so it actually reaches 1 when one slice dominates. */
  depthConfidence(): Float32Array {
    const out = new Float32Array(this.bestIndex.length), N = Math.max(2, this.count)
    if (this.opts.selection !== 'consistent') { out.fill(1); return out }
    const B = this.accB[0], bw = this.bestWeight0, fl = this.floor
    for (let i = 0; i < out.length; i++) {
      if (!(this.bestEnergy0[i] > fl) || !(B[i] > 0)) continue
      const share = bw[i] / B[i]
      out[i] = Math.max(0, Math.min(1, (share - 1 / N) / (1 - 1 / N)))
    }
    return out
  }

  /** 16-bit interleaved RGB result (for 16-bit inputs). */
  result16(): { data: Uint16Array; width: number; height: number; contributions: number[] } {
    const r = this.resultPlanes(), { width: w, height: h } = this
    return { data: packRgb16(r.planes, w, h), width: w, height: h, contributions: r.contributions }
  }
}

// ---- hybrid (DMap-style) fusion --------------------------------------------------------------------

export interface HybridOptions {
  /** cell size (px) of the smoothed depth surface. Default 16. */
  cell?: number
  /** 3×3 smoothing passes on the cell grid. Default 2. */
  passes?: number
  /** confidence below `lo` uses the pyramid result only, above `hi` the depth-surface result only. Default 0.35 / 0.75. */
  lo?: number
  hi?: number
}

/** Zerene DMap-style fusion blended with the pyramid result. The fractional depth (`soft`, slice index
 *  per pixel) is averaged over `cell`×`cell` blocks weighted by `confidence`, smoothed on the block grid
 *  and interpolated back per pixel; each output pixel then reads the aligned slices at that depth
 *  (linear between the two nearest slices). Where the block confidence is high this replaces the
 *  pyramid result (no selection artefacts on smooth surfaces); where it is low (nothing in focus, ties)
 *  the pyramid result stands. `slices` are the aligned inputs, RGBA 8-bit (stride 4) or RGB 16-bit
 *  (stride 3), in `index` order; output planes are on the input scale. */
export function hybridFuse(pyr: FusePlanes, soft: Float32Array, confidence: Float32Array, slices: (Uint8ClampedArray | Uint16Array)[], opts: HybridOptions = {}): FusePlanes {
  const { width: w, height: h } = pyr, cell = opts.cell ?? 16, passes = opts.passes ?? 2, lo = opts.lo ?? 0.35, hi = opts.hi ?? 0.75
  const n = slices.length
  if (n < 2) return pyr
  const cellsX = Math.ceil(w / cell), cellsY = Math.ceil(h / cell)
  const num = new Float32Array(cellsX * cellsY), den = new Float32Array(cellsX * cellsY), cnt = new Float32Array(cellsX * cellsY)
  for (let y = 0; y < h; y++) { const cy = Math.floor(y / cell) * cellsX; for (let x = 0; x < w; x++) { const i = y * w + x, c = cy + Math.floor(x / cell); num[c] += confidence[i] * soft[i]; den[c] += confidence[i]; cnt[c]++ } }
  const depth = new Float32Array(cellsX * cellsY), conf = new Float32Array(cellsX * cellsY)
  for (let c = 0; c < depth.length; c++) { depth[c] = den[c] > 0 ? num[c] / den[c] : NaN; conf[c] = cnt[c] ? den[c] / cnt[c] : 0 }
  // fill cells without any confident pixel from their neighbours, then smooth (confidence-weighted)
  for (let c = 0; c < depth.length; c++) if (Number.isNaN(depth[c])) { let s = 0, k = 0; for (let d = 0; d < depth.length; d++) if (!Number.isNaN(depth[d])) { s += depth[d]; k++ } depth[c] = k ? s / k : 0 }
  for (let p = 0; p < passes; p++) {
    const nd = new Float32Array(depth.length), nc = new Float32Array(conf.length)
    for (let y = 0; y < cellsY; y++) for (let x = 0; x < cellsX; x++) {
      let sd = 0, sw = 0, sc = 0, k = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const yy = y + dy, xx = x + dx
        if (yy < 0 || yy >= cellsY || xx < 0 || xx >= cellsX) continue
        const c = yy * cellsX + xx, wgt = conf[c] + 1e-3
        sd += depth[c] * wgt; sw += wgt; sc += conf[c]; k++
      }
      nd[y * cellsX + x] = sd / sw; nc[y * cellsX + x] = sc / k
    }
    depth.set(nd); conf.set(nc)
  }
  const stride = slices[0] instanceof Uint16Array ? 3 : 4
  const out = pyr.planes.map((p) => new Float32Array(p)) as [Float32Array, Float32Array, Float32Array]
  const smooth = (t: number) => { const u = Math.max(0, Math.min(1, (t - lo) / (hi - lo))); return u * u * (3 - 2 * u) }
  for (let y = 0; y < h; y++) {
    const fy = Math.min(cellsY - 1, Math.max(0, (y + 0.5) / cell - 0.5)), y0 = Math.floor(fy), y1 = Math.min(cellsY - 1, y0 + 1), ty = fy - y0
    for (let x = 0; x < w; x++) {
      const fx = Math.min(cellsX - 1, Math.max(0, (x + 0.5) / cell - 0.5)), x0 = Math.floor(fx), x1 = Math.min(cellsX - 1, x0 + 1), tx = fx - x0
      const c00 = y0 * cellsX + x0, c01 = y0 * cellsX + x1, c10 = y1 * cellsX + x0, c11 = y1 * cellsX + x1
      const a = smooth((conf[c00] * (1 - tx) + conf[c01] * tx) * (1 - ty) + (conf[c10] * (1 - tx) + conf[c11] * tx) * ty)
      if (a <= 0) continue
      const d = Math.max(0, Math.min(n - 1, (depth[c00] * (1 - tx) + depth[c01] * tx) * (1 - ty) + (depth[c10] * (1 - tx) + depth[c11] * tx) * ty))
      const k0 = Math.min(n - 1, Math.floor(d)), k1 = Math.min(n - 1, k0 + 1), f = d - k0
      const i = y * w + x, p = i * stride, s0 = slices[k0], s1 = slices[k1]
      for (let c = 0; c < 3; c++) {
        const v = s0[p + c] * (1 - f) + s1[p + c] * f
        out[c][i] = out[c][i] * (1 - a) + v * a
      }
    }
  }
  return { planes: out, width: w, height: h, contributions: pyr.contributions }
}

/** Pack float RGB planes (any pipeline's output: `PyramidFuser.resultPlanes()` or `hybridFuse`'s
 *  result) to 8-bit RGBA, clamping to the valid range. */
export function packRgba8(planes: [Float32Array, Float32Array, Float32Array], width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4)
  for (let i = 0, p = 0; i < width * height; i++, p += 4) { out[p] = planes[0][i]; out[p + 1] = planes[1][i]; out[p + 2] = planes[2][i]; out[p + 3] = 255 }
  return out
}

/** Pack float RGB planes to 16-bit interleaved RGB, clamping to 0..65535. */
export function packRgb16(planes: [Float32Array, Float32Array, Float32Array], width: number, height: number): Uint16Array {
  const out = new Uint16Array(width * height * 3)
  for (let i = 0, p = 0; i < width * height; i++, p += 3) {
    out[p] = Math.min(65535, Math.max(0, planes[0][i])); out[p + 1] = Math.min(65535, Math.max(0, planes[1][i])); out[p + 2] = Math.min(65535, Math.max(0, planes[2][i]))
  }
  return out
}

/** Unpack an interleaved slice (8-bit RGBA or 16-bit RGB) back to float RGB planes, the form
 *  `hybridFuse` and the pyramid accumulate in — the inverse of `packRgba8`/`packRgb16`. */
export function unpackPlanes(data: Uint8ClampedArray | Uint16Array, width: number, height: number): [Float32Array, Float32Array, Float32Array] {
  const n = width * height, planes: [Float32Array, Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]
  const stride = data instanceof Uint16Array ? 3 : 4
  for (let i = 0, p = 0; i < n; i++, p += stride) { planes[0][i] = data[p]; planes[1][i] = data[p + 1]; planes[2][i] = data[p + 2] }
  return planes
}

/** Integer translation of float planes (dx, dy shift the content; edges replicate). */
export function translatePlanes(planes: [Float32Array, Float32Array, Float32Array], w: number, h: number, dx: number, dy: number): [Float32Array, Float32Array, Float32Array] {
  if (!dx && !dy) return planes
  return planes.map((src) => {
    const out = new Float32Array(src.length)
    for (let y = 0; y < h; y++) {
      const sy = Math.min(h - 1, Math.max(0, y - dy))
      for (let x = 0; x < w; x++) out[y * w + x] = src[sy * w + Math.min(w - 1, Math.max(0, x - dx))]
    }
    return out
  }) as [Float32Array, Float32Array, Float32Array]
}

/** Integer translation of an RGBA image (dx, dy shift the content; edges replicate). */
export function translateRgba(src: Uint8ClampedArray, w: number, h: number, dx: number, dy: number): Uint8ClampedArray {
  if (!dx && !dy) return src
  const out = new Uint8ClampedArray(src.length)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(h - 1, Math.max(0, y - dy))
    for (let x = 0; x < w; x++) {
      const sx = Math.min(w - 1, Math.max(0, x - dx)), s = (sy * w + sx) * 4, d = (y * w + x) * 4
      out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2]; out[d + 3] = 255
    }
  }
  return out
}
