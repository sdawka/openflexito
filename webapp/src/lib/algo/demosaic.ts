/** Demosaicing of a float Bayer mosaic (1.0 = sensor white, black level removed, white balanced).
 *  Three methods, all pure TS, all returning interleaved float RGB:
 *   - 'bilinear': the textbook average of the neighbours; fast, soft, coloured zippers on edges.
 *   - 'malvar':   Malvar-He-Cutler (ICASSP 2004) 5×5 linear filters, gradient-corrected; the ISP-class
 *                 default, coefficients checked against the paper.
 *   - 'rcd':      a directional method following the structure of Luis Sansal's RCD (Ratio Corrected
 *                 Demosaicing): a vertical/horizontal discriminator from local gradient energy, green at
 *                 red/blue sites interpolated along the dominant direction with a low-pass ratio
 *                 correction (so a smooth colour gradient does not turn into a luminance step), then
 *                 red/blue as green plus gradient-weighted colour differences (diagonal at the opposite
 *                 colour's sites, directional at green sites). It is not a port of RCD's exact 9-tap
 *                 polynomial filters, but it removes the zipper Malvar leaves on fine 1-D structure
 *                 (see demosaic.test.ts, which measures colour-fringe energy on a grey stripe target). */

export type DemosaicMethod = 'bilinear' | 'malvar' | 'rcd'

/** Colour of the mosaic cell at (x, y) for a 2×2 Bayer order string such as 'BGGR'. */
export function cellColour(bayer: string, x: number, y: number): 'R' | 'G' | 'B' {
  const o = bayer.toUpperCase().padEnd(4, 'G')
  return o[((y & 1) << 1) | (x & 1)] as 'R' | 'G' | 'B'
}

export function demosaic(m: Float32Array, w: number, h: number, bayer: string, method: DemosaicMethod = 'malvar'): Float32Array {
  if (method === 'rcd') return demosaicRcd(m, w, h, bayer)
  if (method === 'bilinear') return demosaicBilinear(m, w, h, bayer)
  return demosaicMalvar(m, w, h, bayer)
}

/** Malvar-He-Cutler (2004) 5×5 linear demosaic. Returns float RGB planes interleaved. */
export function demosaicMalvar(m: Float32Array, w: number, h: number, bayer: string): Float32Array {
  const out = new Float32Array(w * h * 3)
  const at = (x: number, y: number) => m[(y < 0 ? -y : y >= h ? 2 * h - 2 - y : y) * w + (x < 0 ? -x : x >= w ? 2 * w - 2 - x : x)]
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = cellColour(bayer, x, y), o = (y * w + x) * 3
    const p = at(x, y)
    const n4 = at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)
    const d4 = at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1)
    const far4 = at(x - 2, y) + at(x + 2, y) + at(x, y - 2) + at(x, y + 2)
    const farH = at(x - 2, y) + at(x + 2, y), farV = at(x, y - 2) + at(x, y + 2)
    const nH = at(x - 1, y) + at(x + 1, y), nV = at(x, y - 1) + at(x, y + 1)
    if (c !== 'G') {
      // green at a red/blue site
      const g = (4 * p + 2 * n4 - far4) / 8
      // the opposite colour at this site (diagonal neighbours)
      const other = (6 * p + 2 * d4 - 1.5 * far4) / 8
      out[o + 1] = g
      if (c === 'R') { out[o] = p; out[o + 2] = other } else { out[o + 2] = p; out[o] = other }
    } else {
      // at a green site: the row neighbours are one colour, the column neighbours the other
      const rowColour = cellColour(bayer, x + 1, y)   // colour of horizontal neighbours
      const horiz = (5 * p + 4 * nH - farH * 1 + 0.5 * farV - d4) / 8   // Malvar: G at R/B row: 5, 4 (row nbrs), -1 (row far), 1/2 (col far), -1 (diag)
      const vert = (5 * p + 4 * nV - farV * 1 + 0.5 * farH - d4) / 8
      out[o + 1] = p
      if (rowColour === 'R') { out[o] = horiz; out[o + 2] = vert } else { out[o + 2] = horiz; out[o] = vert }
    }
  }
  return out
}

export function demosaicBilinear(m: Float32Array, w: number, h: number, bayer: string): Float32Array {
  const out = new Float32Array(w * h * 3)
  const at = (x: number, y: number) => m[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = cellColour(bayer, x, y), o = (y * w + x) * 3, here = at(x, y)
    const cross = (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) / 4
    const diag = (at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1)) / 4
    const horiz = (at(x - 1, y) + at(x + 1, y)) / 2, vert = (at(x, y - 1) + at(x, y + 1)) / 2
    if (c === 'G') { out[o + 1] = here; if (cellColour(bayer, x + 1, y) === 'R') { out[o] = horiz; out[o + 2] = vert } else { out[o + 2] = horiz; out[o] = vert } }
    else if (c === 'R') { out[o] = here; out[o + 1] = cross; out[o + 2] = diag }
    else { out[o + 2] = here; out[o + 1] = cross; out[o] = diag }
  }
  return out
}

/** Mirror a coordinate into [0, n). */
const mirror = (i: number, n: number) => (i < 0 ? -i : i >= n ? 2 * n - 2 - i : i)

/** RCD-style directional demosaic (see the module comment). */
export function demosaicRcd(m: Float32Array, w: number, h: number, bayer: string): Float32Array {
  const n = w * h
  const out = new Float32Array(n * 3)
  const eps = 1e-5
  const order = bayer.toUpperCase().padEnd(4, 'G')
  const colourAt = (x: number, y: number) => order[((y & 1) << 1) | (x & 1)]
  // padded read (mirror at the borders): index maths inline for speed on 8 MP
  const px = (x: number, y: number) => m[mirror(y, h) * w + mirror(x, w)]

  // ---- step 1: vertical / horizontal discrimination from local gradient energy (all CFA sites)
  // V energy: squared vertical differences of same-colour (distance 2) and interleaved (distance 1)
  // samples over a 5-tall column; H the same along the row. Smoothed over a 3×3 neighbourhood so the
  // decision does not flip pixel to pixel.
  const vEnergy = new Float32Array(n), hEnergy = new Float32Array(n)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0, hh = 0
    for (let k = -1; k <= 1; k++) {
      const a = px(x + k, y - 2), b = px(x + k, y - 1), c = px(x + k, y), d = px(x + k, y + 1), e = px(x + k, y + 2)
      v += (a - c) * (a - c) + (c - e) * (c - e) + 0.5 * ((b - d) * (b - d))
      const a2 = px(x - 2, y + k), b2 = px(x - 1, y + k), d2 = px(x + 1, y + k), e2 = px(x + 2, y + k), c2 = px(x, y + k)
      hh += (a2 - c2) * (a2 - c2) + (c2 - e2) * (c2 - e2) + 0.5 * ((b2 - d2) * (b2 - d2))
    }
    vEnergy[y * w + x] = v; hEnergy[y * w + x] = hh
  }
  // direction weight: 1 = interpolate vertically (vertical structure: low vertical energy), 0 = horizontally
  const vhDir = new Float32Array(n)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0, hh = 0
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const i = mirror(y + dy, h) * w + mirror(x + dx, w)
      v += vEnergy[i]; hh += hEnergy[i]
    }
    vhDir[y * w + x] = (hh + eps) / (v + hh + 2 * eps)
  }

  // ---- step 2: low-pass of the mosaic (colour-blind local mean) for the ratio correction
  const lpf = new Float32Array(n)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    lpf[y * w + x] = (4 * px(x, y) + 2 * (px(x - 1, y) + px(x + 1, y) + px(x, y - 1) + px(x, y + 1))
      + px(x - 1, y - 1) + px(x + 1, y - 1) + px(x - 1, y + 1) + px(x + 1, y + 1)) / 16
  }
  const lp = (x: number, y: number) => lpf[mirror(y, h) * w + mirror(x, w)]

  // ---- step 3: green everywhere (copied at green sites, directional ratio-corrected estimate elsewhere)
  const G = new Float32Array(n)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x
    if (colourAt(x, y) === 'G') { G[i] = m[i]; continue }
    const c = m[i]
    const nG = px(x, y - 1), sG = px(x, y + 1), wG = px(x - 1, y), eG = px(x + 1, y)
    // gradients along each half-direction (mixed-colour and same-colour differences)
    const nGrad = eps + Math.abs(nG - sG) + Math.abs(c - px(x, y - 2)) + Math.abs(nG - px(x, y - 3)) + Math.abs(px(x, y - 2) - px(x, y - 4))
    const sGrad = eps + Math.abs(sG - nG) + Math.abs(c - px(x, y + 2)) + Math.abs(sG - px(x, y + 3)) + Math.abs(px(x, y + 2) - px(x, y + 4))
    const wGrad = eps + Math.abs(wG - eG) + Math.abs(c - px(x - 2, y)) + Math.abs(wG - px(x - 3, y)) + Math.abs(px(x - 2, y) - px(x - 4, y))
    const eGrad = eps + Math.abs(eG - wG) + Math.abs(c - px(x + 2, y)) + Math.abs(eG - px(x + 3, y)) + Math.abs(px(x + 2, y) - px(x + 4, y))
    // ratio correction: scale the neighbour's green by the local low-pass ratio between here and there
    const l0 = lp(x, y)
    const nEst = nG * (1 + (l0 - lp(x, y - 2)) / (eps + l0 + lp(x, y - 2)))
    const sEst = sG * (1 + (l0 - lp(x, y + 2)) / (eps + l0 + lp(x, y + 2)))
    const wEst = wG * (1 + (l0 - lp(x - 2, y)) / (eps + l0 + lp(x - 2, y)))
    const eEst = eG * (1 + (l0 - lp(x + 2, y)) / (eps + l0 + lp(x + 2, y)))
    const vEst = (sGrad * nEst + nGrad * sEst) / (nGrad + sGrad)
    const hEst = (eGrad * wEst + wGrad * eEst) / (wGrad + eGrad)
    const d = vhDir[i]
    G[i] = Math.max(0, d * vEst + (1 - d) * hEst)
  }
  const gAt = (x: number, y: number) => G[mirror(y, h) * w + mirror(x, w)]

  // ---- step 4: red/blue at the opposite colour's sites (diagonal neighbours carry that colour)
  //      colour difference (cfa - G) interpolated along the less-varying diagonal
  const other = new Float32Array(n)   // R at B sites, B at R sites
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const col = colourAt(x, y)
    if (col === 'G') continue
    const i = y * w + x
    const cNW = px(x - 1, y - 1) - gAt(x - 1, y - 1), cSE = px(x + 1, y + 1) - gAt(x + 1, y + 1)
    const cNE = px(x + 1, y - 1) - gAt(x + 1, y - 1), cSW = px(x - 1, y + 1) - gAt(x - 1, y + 1)
    // diagonal discrimination: energy of colour-difference change along each diagonal
    const pGrad = eps + Math.abs(cNW - cSE) + Math.abs(px(x - 2, y - 2) - px(x, y)) + Math.abs(px(x, y) - px(x + 2, y + 2))
    const qGrad = eps + Math.abs(cNE - cSW) + Math.abs(px(x + 2, y - 2) - px(x, y)) + Math.abs(px(x, y) - px(x - 2, y + 2))
    const pEst = (cNW + cSE) / 2, qEst = (cNE + cSW) / 2
    other[i] = G[i] + (qGrad * pEst + pGrad * qEst) / (pGrad + qGrad)
  }

  // ---- step 5: assemble; red/blue at green sites from the directional colour differences of the
  //      row and column neighbours (one colour lies horizontally, the other vertically)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, o = i * 3, col = colourAt(x, y)
    out[o + 1] = G[i]
    if (col === 'R') { out[o] = m[i]; out[o + 2] = Math.max(0, other[i]); continue }
    if (col === 'B') { out[o + 2] = m[i]; out[o] = Math.max(0, other[i]); continue }
    // green site: horizontal neighbours are rowColour, vertical are the other colour
    const rowColour = colourAt(x + 1, y)
    const g0 = G[i]
    // horizontal colour difference, gradient-weighted between west and east
    const wd = px(x - 1, y) - gAt(x - 1, y), ed = px(x + 1, y) - gAt(x + 1, y)
    const wGr = eps + Math.abs(px(x - 1, y) - px(x + 1, y)) + Math.abs(gAt(x, y) - gAt(x - 2, y))
    const eGr = eps + Math.abs(px(x + 1, y) - px(x - 1, y)) + Math.abs(gAt(x, y) - gAt(x + 2, y))
    const hDiff = (eGr * wd + wGr * ed) / (wGr + eGr)
    const nd = px(x, y - 1) - gAt(x, y - 1), sd = px(x, y + 1) - gAt(x, y + 1)
    const nGr = eps + Math.abs(px(x, y - 1) - px(x, y + 1)) + Math.abs(gAt(x, y) - gAt(x, y - 2))
    const sGr = eps + Math.abs(px(x, y + 1) - px(x, y - 1)) + Math.abs(gAt(x, y) - gAt(x, y + 2))
    const vDiff = (sGr * nd + nGr * sd) / (nGr + sGr)
    const hVal = Math.max(0, g0 + hDiff), vVal = Math.max(0, g0 + vDiff)
    if (rowColour === 'R') { out[o] = hVal; out[o + 2] = vVal } else { out[o + 2] = hVal; out[o] = vVal }
  }
  return out
}
