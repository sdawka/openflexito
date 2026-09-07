/** Multi-scale focus fusion (Burt & Adelson pattern-selective fusion): each slice is decomposed into a
 *  Laplacian pyramid; at every level and position the coefficient with the strongest local energy is
 *  kept, and the low-pass residual is averaged. Slices are streamed one at a time so a 9-slice 8 MP
 *  stack needs only two pyramids of memory. Selection at fine levels keeps hairs and edges from the
 *  slice where they are sharp; the coarse levels carry brightness so seams do not show. */

export interface FuseResult { data: Uint8ClampedArray; width: number; height: number; contributions: number[] }
export interface FusePlanes { planes: [Float32Array<ArrayBufferLike>, Float32Array<ArrayBufferLike>, Float32Array<ArrayBufferLike>]; width: number; height: number; contributions: number[] }

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
function down(src: Float32Array, w: number, h: number, w2: number, h2: number): Float32Array {
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
function up(src: Float32Array, w2: number, h2: number, w: number, h: number): Float32Array {
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

export class PyramidFuser {
  private levels: Level[]
  private best: Float32Array[][]        // [level][channel] chosen Laplacian coefficients
  private bestEnergy: Float32Array[]    // [level]
  private bestIndex: Uint8Array         // level 0: which slice supplied each pixel
  private residual: Float32Array[]      // [channel] running sum of the coarsest Gaussian
  private count = 0
  constructor(public width: number, public height: number) {
    this.levels = levelsFor(width, height)
    this.best = this.levels.slice(0, -1).map((l) => [0, 1, 2].map(() => new Float32Array(l.w * l.h)))
    this.bestEnergy = this.levels.slice(0, -1).map((l) => new Float32Array(l.w * l.h).fill(-1))
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
    const { width: w, height: h } = this
    // Gaussian pyramids per channel plus a luminance pyramid for the selection energy
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
          if (l === 0) this.bestIndex[i] = index
        }
      }
      g = gNext; lum = lumNext
    }
    for (let c = 0; c < 3; c++) for (let i = 0; i < g[c].length; i++) this.residual[c][i] += g[c][i]
    this.count++
  }

  /** Collapse the pyramid: float planes on the input scale. */
  resultPlanes(): FusePlanes {
    const n = this.levels.length
    let cur: Float32Array[] = this.residual.map((r) => { const o = new Float32Array(r.length); for (let i = 0; i < r.length; i++) o[i] = r[i] / Math.max(1, this.count); return o })
    for (let l = n - 2; l >= 0; l--) {
      const lv = this.levels[l], nx = this.levels[l + 1]
      cur = cur.map((ch, c) => { const u = up(ch, nx.w, nx.h, lv.w, lv.h); const b = this.best[l][c]; for (let i = 0; i < u.length; i++) u[i] += b[i]; return u })
    }
    const { width: w, height: h } = this
    const counts = new Array(Math.max(1, this.count)).fill(0)
    for (let i = 0; i < w * h; i++) counts[this.bestIndex[i]]++
    return { planes: [cur[0], cur[1], cur[2]] as [Float32Array, Float32Array, Float32Array], width: w, height: h, contributions: counts.map((c) => c / (w * h)) }
  }

  /** 8-bit RGBA result (for 8-bit inputs). */
  result(): FuseResult {
    const r = this.resultPlanes(), { width: w, height: h } = this
    const out = new Uint8ClampedArray(w * h * 4)
    for (let i = 0, p = 0; i < w * h; i++, p += 4) { out[p] = r.planes[0][i]; out[p + 1] = r.planes[1][i]; out[p + 2] = r.planes[2][i]; out[p + 3] = 255 }
    return { data: out, width: w, height: h, contributions: r.contributions }
  }

  /** Per-pixel winning slice index at the finest level (which added slice supplied this pixel).
   *  Depth-from-focus: paired with each slice's z this gives a coarse per-pixel depth map. */
  depthIndex(): Uint8Array { return this.bestIndex }

  /** 16-bit interleaved RGB result (for 16-bit inputs). */
  result16(): { data: Uint16Array; width: number; height: number; contributions: number[] } {
    const r = this.resultPlanes(), { width: w, height: h } = this
    const out = new Uint16Array(w * h * 3)
    for (let i = 0, p = 0; i < w * h; i++, p += 3) { out[p] = Math.min(65535, Math.max(0, r.planes[0][i])); out[p + 1] = Math.min(65535, Math.max(0, r.planes[1][i])); out[p + 2] = Math.min(65535, Math.max(0, r.planes[2][i])) }
    return { data: out, width: w, height: h, contributions: r.contributions }
  }
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
