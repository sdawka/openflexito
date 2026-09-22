/** Grid Lucas–Kanade optical flow for visualisation: per `cell`×`cell` block of a box-reduced luma,
 *  solve the 2×2 normal equations `[ΣIx² ΣIxIy; ΣIxIy ΣIy²]·[u v]ᵀ = −[ΣIxIt ΣIyIt]ᵀ` on a
 *  3×3-blurred image, two coarse-to-fine levels (the coarse solution warps the fine estimate), reject
 *  cells whose smaller eigenvalue is below `tau` (aperture problem: flat or 1-D texture) and EMA the
 *  vectors over time. Cost is dominated by the reduction pass; the LK itself runs on ~30k pixels.
 *  The output is a coarse vector field the caller renders (HSV wheel: hue = direction, value =
 *  speed) or reads for statistics. Farnebäck costs 3–4× for no gain on a coarse grid. */

export interface FlowField { u: Float32Array; v: Float32Array; valid: Uint8Array; cw: number; ch: number; cell: number; /** analysis width in px */ width: number; height: number }

export interface GridFlowOptions { analysisWidth: number; cell: number; alpha: number; tau: number }
export const defaultGridFlowOptions: GridFlowOptions = { analysisWidth: 205, cell: 8, alpha: 0.3, tau: 40 }

export class GridFlow {
  private prev: Float32Array | null = null
  private cur: Float32Array
  private blur: Float32Array
  private aw: number; private ah: number
  private scale: number
  field: FlowField
  count = 0

  constructor(public readonly width: number, public readonly height: number, public opts: GridFlowOptions = defaultGridFlowOptions) {
    this.scale = Math.max(1, Math.round(width / opts.analysisWidth))
    this.aw = Math.floor(width / this.scale); this.ah = Math.floor(height / this.scale)
    this.cur = new Float32Array(this.aw * this.ah); this.blur = new Float32Array(this.aw * this.ah)
    const cw = Math.floor(this.aw / opts.cell), ch = Math.floor(this.ah / opts.cell)
    this.field = { u: new Float32Array(cw * ch), v: new Float32Array(cw * ch), valid: new Uint8Array(cw * ch), cw, ch, cell: opts.cell, width: this.aw, height: this.ah }
  }

  reset(): void { this.prev = null; this.count = 0; this.field.u.fill(0); this.field.v.fill(0); this.field.valid.fill(0) }

  /** Reduce `frame`, compute the flow from the previous frame to this one (analysis px per frame),
   *  then EMA into `field`. `stageShift` (analysis px) is subtracted from every vector so a pan does
   *  not paint the whole field one colour. */
  update(frame: Uint8ClampedArray, stageShift = { dx: 0, dy: 0 }): FlowField {
    const s = this.scale, aw = this.aw, ah = this.ah, w = this.width
    const cur = this.cur, inv = 1 / (s * s)
    cur.fill(0)
    for (let y = 0; y < ah * s; y++) { const ay = (y / s) | 0; for (let x = 0; x < aw * s; x++) { const i = (y * w + x) * 4; cur[ay * aw + ((x / s) | 0)] += (frame[i] * 0.299 + frame[i + 1] * 0.587 + frame[i + 2] * 0.114) * inv } }
    // 3×3 blur (σ≈1) so gradients are not JPEG noise
    const b = this.blur
    for (let y = 0; y < ah; y++) for (let x = 0; x < aw; x++) {
      let sum = 0, k = 0
      for (let dy = -1; dy <= 1; dy++) { const yy = y + dy; if (yy < 0 || yy >= ah) continue; for (let dx = -1; dx <= 1; dx++) { const xx = x + dx; if (xx < 0 || xx >= aw) continue; sum += cur[yy * aw + xx]; k++ } }
      b[y * aw + x] = sum / k
    }
    const f = this.field
    if (!this.prev) { this.prev = new Float32Array(b); this.count = 1; return f }
    const prev = this.prev, cell = f.cell, a = this.opts.alpha, tau = this.opts.tau
    for (let cy = 0; cy < f.ch; cy++) for (let cx = 0; cx < f.cw; cx++) {
      // coarse level: whole cell as one block with a 2× larger neighbourhood, then refine at the cell
      let u = 0, v = 0, ok = false
      for (let level = 1; level >= 0; level--) {
        const r = cell << level
        const x0 = Math.max(1, cx * cell + (cell >> 1) - (r >> 1)), y0 = Math.max(1, cy * cell + (cell >> 1) - (r >> 1))
        const x1 = Math.min(aw - 2, x0 + r), y1 = Math.min(ah - 2, y0 + r)
        let sxx = 0, sxy = 0, syy = 0, sxt = 0, syt = 0
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          const p = y * aw + x
          const ix = (b[p + 1] - b[p - 1]) * 0.5, iy = (b[p + aw] - b[p - aw]) * 0.5
          // temporal difference against the previous frame warped by the current estimate (bilinear)
          const px = x - u, py = y - v
          const wx = Math.min(aw - 2, Math.max(0, px)), wy = Math.min(ah - 2, Math.max(0, py))
          const ix0 = wx | 0, iy0 = wy | 0, tx = wx - ix0, ty = wy - iy0
          const pw = (prev[iy0 * aw + ix0] * (1 - tx) + prev[iy0 * aw + ix0 + 1] * tx) * (1 - ty) + (prev[(iy0 + 1) * aw + ix0] * (1 - tx) + prev[(iy0 + 1) * aw + ix0 + 1] * tx) * ty
          const it = b[p] - pw
          sxx += ix * ix; sxy += ix * iy; syy += iy * iy; sxt += ix * it; syt += iy * it
        }
        const tr = sxx + syy, det = sxx * syy - sxy * sxy
        const lmin = tr / 2 - Math.sqrt(Math.max(0, tr * tr / 4 - det))
        if (lmin < tau || det <= 1e-6) { ok = false; break }
        // solve [sxx sxy; sxy syy]·[du dv]ᵀ = −[sxt syt]ᵀ: the displacement of content from prev to cur
        const du = (sxy * syt - syy * sxt) / det, dv = (sxy * sxt - sxx * syt) / det
        u += du; v += dv
        ok = Math.hypot(u, v) < cell * 2
      }
      const k = cy * f.cw + cx
      if (ok) {
        const uu = u - stageShift.dx, vv = v - stageShift.dy
        f.u[k] = f.valid[k] ? f.u[k] + (uu - f.u[k]) * a : uu
        f.v[k] = f.valid[k] ? f.v[k] + (vv - f.v[k]) * a : vv
        f.valid[k] = 1
      } else { f.u[k] *= 1 - a; f.v[k] *= 1 - a; if (Math.hypot(f.u[k], f.v[k]) < 0.05) f.valid[k] = 0 }
    }
    this.prev.set(b)
    this.count++
    return f
  }

  /** Mean speed (analysis px/frame) over valid cells and the dominant direction (degrees). */
  stats(): { meanSpeed: number; directionDeg: number; validFrac: number } {
    const f = this.field
    let su = 0, sv = 0, sp = 0, n = 0
    for (let k = 0; k < f.u.length; k++) if (f.valid[k]) { su += f.u[k]; sv += f.v[k]; sp += Math.hypot(f.u[k], f.v[k]); n++ }
    return { meanSpeed: n ? sp / n : 0, directionDeg: n ? (Math.atan2(sv, su) * 180) / Math.PI : 0, validFrac: f.u.length ? n / f.u.length : 0 }
  }
}

/** Render a flow field over a dimmed grey copy of `frame`: hue = direction, saturation/value ∝
 *  speed / `vMax` (analysis px per frame; 0 = auto: the field's 95th percentile). Cells are
 *  bilinearly interpolated so the colour has no block edges. */
export function renderFlowHsv(frame: Uint8ClampedArray, w: number, h: number, f: FlowField, out: Uint8ClampedArray, vMax = 0, dim = 0.4): number {
  if (vMax <= 0) {
    const sp: number[] = []
    for (let k = 0; k < f.u.length; k++) if (f.valid[k]) sp.push(Math.hypot(f.u[k], f.v[k]))
    sp.sort((a, b) => a - b)
    vMax = sp.length ? Math.max(0.5, sp[Math.floor(sp.length * 0.95)]) : 1
  }
  const sx = f.width / w * (1 / f.cell), sy = f.height / h * (1 / f.cell)
  for (let y = 0; y < h; y++) {
    const fy = Math.min(f.ch - 1, Math.max(0, y * sy - 0.5)), y0 = fy | 0, y1 = Math.min(f.ch - 1, y0 + 1), ty = fy - y0
    for (let x = 0; x < w; x++) {
      const fx = Math.min(f.cw - 1, Math.max(0, x * sx - 0.5)), x0 = fx | 0, x1 = Math.min(f.cw - 1, x0 + 1), tx = fx - x0
      const k00 = y0 * f.cw + x0, k10 = y0 * f.cw + x1, k01 = y1 * f.cw + x0, k11 = y1 * f.cw + x1
      const u = (f.u[k00] * (1 - tx) + f.u[k10] * tx) * (1 - ty) + (f.u[k01] * (1 - tx) + f.u[k11] * tx) * ty
      const v = (f.v[k00] * (1 - tx) + f.v[k10] * tx) * (1 - ty) + (f.v[k01] * (1 - tx) + f.v[k11] * tx) * ty
      const i = (y * w + x) * 4
      const g = (frame[i] * 0.299 + frame[i + 1] * 0.587 + frame[i + 2] * 0.114) * dim
      const sp = Math.min(1, Math.hypot(u, v) / vMax)
      if (sp < 0.05) { out[i] = g; out[i + 1] = g; out[i + 2] = g; out[i + 3] = 255; continue }
      const hue = ((Math.atan2(v, u) / (2 * Math.PI)) + 1) % 1
      const [r, gg, b] = hsv(hue, sp, 1)
      out[i] = g + (r - g) * sp; out[i + 1] = g + (gg - g) * sp; out[i + 2] = g + (b - g) * sp; out[i + 3] = 255
    }
  }
  return vMax
}

function hsv(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s)
  const c = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6]
  return [c[0] * 255, c[1] * 255, c[2] * 255]
}
