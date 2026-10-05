/** Objective measure of the repeated per-tile shading left in a stitched mosaic (e2e helper).
 *
 *  Idea: fold the mosaic by the tile pitch. Every pixel is binned by its phase inside a tile period
 *  ((x mod pitchX) / pitchX, (y mod pitchY) / pitchY) and the pixels sharing a phase are averaged.
 *  A specimen is not periodic at the tile pitch, so its texture averages out and the folded image is
 *  nearly flat; vignetting or colour shading that every tile repeats survives the fold unchanged.
 *  With few tiles the texture does not average out per phase bin (a 2×2 scan folds to itself), so
 *  a smooth low-order surface (bicubic polynomial, weighted least squares) is fitted to the folded
 *  log-luminance and log-chroma (R/G, B/G) in linear light: the fit averages the texture over every
 *  bin while the shading, which is smooth by nature, passes through. The relative contrast of the
 *  fitted surfaces ((p95 − p5) / mean) is the residual shading; `fitRms` says how noisy the fold was
 *  and `floor` (opt-in) is the same figure folded at an incommensurate pitch (texture only).
 *  Values are in linear light (sRGB decoded with gamma 2.2), so a lens that leaves the corners at
 *  0.66 of the centre gives a `contrast` of roughly 0.3 when every tile shows its corners (less in
 *  a mosaic, where the overlap hides part of each tile).
 *
 *  Sensitivity: the texture floor scales as 1 / sqrt(N) with N ≈ tiles × (tile area / feature area).
 *  mosaicMetric.selftest.mjs prints the figures: with features ~1–3 % of the tile a 3×3 or 5×4 mosaic
 *  separates the fake camera's full shading (≈0.18–0.2) from none (≈0.07); with features ~10–20 % of
 *  the tile (the fake specimen's cells on a full-res still) a 5×4 mosaic cannot (≈0.25 either way),
 *  so the e2e needs a larger scan, a finer specimen, or a tile-overlap-based check for that case.
 *
 *  Intended use from app.mjs (the orchestrator wires it in):
 *    1. read the stitched gallery item: `scan.tiles` (col, row, width, height in tile px) and
 *       `scan.positions` (solved tile positions, tile px, same index as `tiles`);
 *    2. pitch in tile px = median over neighbours of positions[b].x − positions[a].x for
 *       (col+1, same row) and of .y for (row+1, same col); mosaic px = tile px × scale where
 *       scale = mosaic.width / (max(positions.x + tiles.width) − min(positions.x)) (the worker caps
 *       the mosaic at 8192 px, so it is not stored; `scan.stitch.analysisWidth` is unrelated);
 *    3. draw the mosaic blob on a canvas (createImageBitmap → getImageData) and call
 *       `tilePeriodicity(data, width, height, pitchX, pitchY)` — inside `page.evaluate` by passing
 *       `tilePeriodicitySource` and `new Function('return ' + src)()` it, since the page cannot import
 *       this file;
 *    4. assert `contrast` and `colourContrast` below thresholds (see mosaicMetric.selftest.mjs for the
 *       values a shading-free and a fake-camera-shaded mosaic give).
 *
 *  Runs in Node and in the browser: the function is self-contained (no closures, no imports) so its
 *  source can be shipped to the page as a string.
 */

/**
 * @param {Uint8ClampedArray|Uint8Array} rgba  mosaic pixels, 4 bytes per pixel
 * @param {number} width
 * @param {number} height
 * @param {number} pitchX  tile period across, mosaic px (may be fractional)
 * @param {number} pitchY  tile period down, mosaic px
 * @param {{ margin?: number, bins?: number, black?: number, floor?: boolean, returnFolded?: boolean }} [opts]
 *   margin: mosaic border to ignore (px, default 0); bins: phase bins across (default 32, rows scale
 *   with the pitch aspect); black: pixels whose R+G+B ≤ black or alpha < 128 count as uncovered
 *   (default 24); floor: also fold at an incommensurate pitch for a texture-only reference (off by
 *   default: with fewer than ~5 tiles per axis the scramble is poor and the figure misleading);
 *   returnFolded: include the folded planes and the fitted surfaces in the result.
 * @returns {{ contrast: number, colourContrast: number, rgContrast: number, bgContrast: number,
 *   rawContrast: number, fitRms: number, coverage: number, bins: [number, number],
 *   floor?: { contrast: number, colourContrast: number },
 *   phaseMean?: { width: number, height: number, lum: number[], rg: number[], bg: number[], fitLum: number[], fitRg: number[], fitBg: number[] } }}
 */
export function tilePeriodicity(rgba, width, height, pitchX, pitchY, opts) {
  const o = opts || {}
  const margin = o.margin || 0
  const black = o.black === undefined ? 24 : o.black
  const bx = Math.max(4, Math.round(o.bins || 32))
  const by = Math.max(4, Math.round(bx * pitchY / pitchX))
  const n = bx * by
  const lin = new Float64Array(256)
  for (let i = 0; i < 256; i++) lin[i] = Math.pow(i / 255, 2.2)
  // ---- fold: per-phase sums of linear r, g, b
  const fold = (px, py) => {
    const sr = new Float64Array(n), sg = new Float64Array(n), sb = new Float64Array(n), cnt = new Float64Array(n)
    let covered = 0, seen = 0
    for (let y = margin; y < height - margin; y++) {
      const fy = y - Math.floor(y / py) * py
      const row = Math.min(by - 1, Math.floor(fy / py * by)) * bx
      for (let x = margin; x < width - margin; x++) {
        const i = (y * width + x) * 4
        seen++
        const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2]
        if (rgba[i + 3] < 128 || r + g + b <= black) continue
        covered++
        const fx = x - Math.floor(x / px) * px
        const k = row + Math.min(bx - 1, Math.floor(fx / px * bx))
        sr[k] += lin[r]; sg[k] += lin[g]; sb[k] += lin[b]; cnt[k]++
      }
    }
    return { sr, sg, sb, cnt, coverage: seen ? covered / seen : 0 }
  }
  // ---- weighted least-squares fit of a bicubic polynomial (10 terms) to a per-bin value
  const basis = (u, v) => [1, u, v, u * u, u * v, v * v, u * u * u, u * u * v, u * v * v, v * v * v]
  const fitSurface = (val, w) => {
    const m = 10, A = Array.from({ length: m }, () => new Float64Array(m + 1))
    for (let yy = 0; yy < by; yy++) for (let xx = 0; xx < bx; xx++) {
      const k = yy * bx + xx
      if (!(w[k] > 0)) continue
      const f = basis((xx + 0.5) / bx - 0.5, (yy + 0.5) / by - 0.5)
      for (let i = 0; i < m; i++) { for (let j = 0; j < m; j++) A[i][j] += w[k] * f[i] * f[j]; A[i][m] += w[k] * f[i] * val[k] }
    }
    for (let c = 0; c < m; c++) {   // Gaussian elimination with partial pivoting
      let p = c
      for (let r = c + 1; r < m; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r
      const t = A[c]; A[c] = A[p]; A[p] = t
      if (Math.abs(A[c][c]) < 1e-12) continue
      for (let r = 0; r < m; r++) {
        if (r === c) continue
        const fac = A[r][c] / A[c][c]
        if (fac) for (let j = c; j <= m; j++) A[r][j] -= fac * A[c][j]
      }
    }
    const coef = A.map((row, i) => (Math.abs(row[i]) < 1e-12 ? 0 : row[m] / row[i]))
    const out = new Float64Array(n)
    let ss = 0, sw = 0
    for (let yy = 0; yy < by; yy++) for (let xx = 0; xx < bx; xx++) {
      const k = yy * bx + xx, f = basis((xx + 0.5) / bx - 0.5, (yy + 0.5) / by - 0.5)
      let v = 0
      for (let i = 0; i < m; i++) v += coef[i] * f[i]
      out[k] = v
      if (w[k] > 0) { ss += w[k] * (val[k] - v) * (val[k] - v); sw += w[k] }
    }
    return { fit: out, rms: sw ? Math.sqrt(ss / sw) : 0 }
  }
  // ---- (p95 − p5) / mean of exp(surface) over the populated bins
  const spread = (a, w) => {
    const v = []
    for (let k = 0; k < n; k++) if (w[k] > 0) v.push(Math.exp(a[k]))
    if (v.length < 4) return 0
    v.sort((p, q) => p - q)
    const mean = v.reduce((s, x) => s + x, 0) / v.length
    return mean > 0 ? (v[Math.floor(0.95 * (v.length - 1))] - v[Math.floor(0.05 * (v.length - 1))]) / mean : 0
  }
  const analyse = (px, py) => {
    const f = fold(px, py)
    const counts = Array.from(f.cnt).filter((c) => c > 0).sort((a, b) => a - b)
    const minCount = counts.length ? Math.max(1, counts[counts.length >> 1] * 0.2) : 1  // sparse bins are untrustworthy
    const w = new Float64Array(n), lum = new Float64Array(n), rg = new Float64Array(n), bg = new Float64Array(n)
    for (let k = 0; k < n; k++) {
      if (f.cnt[k] < minCount) continue
      const r = f.sr[k] / f.cnt[k], g = f.sg[k] / f.cnt[k], b = f.sb[k] / f.cnt[k]
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * b
      if (!(L > 1e-6) || !(g > 1e-6)) continue
      w[k] = f.cnt[k]; lum[k] = Math.log(L); rg[k] = Math.log(Math.max(1e-6, r) / g); bg[k] = Math.log(Math.max(1e-6, b) / g)
    }
    const fL = fitSurface(lum, w), fRg = fitSurface(rg, w), fBg = fitSurface(bg, w)
    const rgContrast = spread(fRg.fit, w), bgContrast = spread(fBg.fit, w)
    return {
      contrast: spread(fL.fit, w), colourContrast: Math.max(rgContrast, bgContrast), rgContrast, bgContrast,
      rawContrast: spread(lum, w), fitRms: fL.rms, coverage: f.coverage, w, lum, rg, bg, fL, fRg, fBg,
    }
  }
  const a = analyse(pitchX, pitchY)
  const res = {
    contrast: a.contrast, colourContrast: a.colourContrast, rgContrast: a.rgContrast, bgContrast: a.bgContrast,
    rawContrast: a.rawContrast, fitRms: a.fitRms, coverage: a.coverage, bins: [bx, by],
  }
  if (o.floor) {   // incommensurate pitch: the tiles' shading no longer lines up, only texture is left
    const px = Math.min(pitchX * 1.37, (width - 2 * margin) / 1.5), py = Math.min(pitchY * 0.81, (height - 2 * margin) / 1.5)
    const fl = analyse(px, py)
    res.floor = { contrast: fl.contrast, colourContrast: fl.colourContrast }
  }
  if (o.returnFolded) {
    res.phaseMean = { width: bx, height: by, lum: Array.from(a.lum), rg: Array.from(a.rg), bg: Array.from(a.bg),
      fitLum: Array.from(a.fL.fit), fitRg: Array.from(a.fRg.fit), fitBg: Array.from(a.fBg.fit) }
  }
  return res
}

/** The function's source, for `page.evaluate`: `const f = new Function('return ' + src)()`. */
export const tilePeriodicitySource = tilePeriodicity.toString()
