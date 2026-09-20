/** Colour lookup tables: 1D and 3D LUT types, parsers for the common exchange formats (Adobe .cube,
 *  Autodesk .3dl, ImageJ .lut, Hald CLUT images, CSV ramps), samplers (linear/tetrahedral/trilinear)
 *  and the "look" pipeline (`applyLookRgba`/`applyLookFloat`) that combines an optional 1D curve and
 *  an optional 3D cube with a strength mix, an input colour space and pseudo-colour/invert flags.
 *
 *  Storage convention: `Lut3D.data` is laid out red-fastest (index = r + g*size + b*size*size, three
 *  floats per entry), the same order Adobe .cube files use. `toCube`/`parseCube` therefore round-trip
 *  the 3D grid without any reordering. Values are stored normalised 0..1 by default; `domainMin`/
 *  `domainMax` record the *input* range each grid axis maps from (a plain 0..1 cube declares 0/1).
 *
 *  Nothing here throws on a slightly malformed file if a sane reading exists (missing DOMAIN_MIN,
 *  stray blank lines, CRLF, tabs, a values-in-0..255 file with no header saying so); it throws only
 *  when the content genuinely cannot be interpreted as any known format. */

export interface Lut1D {
  size: number
  r: Float32Array
  g: Float32Array
  b: Float32Array
  domainMin: [number, number, number]
  domainMax: [number, number, number]
  title?: string
}

export interface Lut3D {
  size: number
  data: Float32Array // size^3 * 3, red fastest: idx = (r + g*size + b*size*size) * 3
  domainMin: [number, number, number]
  domainMax: [number, number, number]
  title?: string
}

export type Lut = Lut1D | Lut3D

export function isLut3D(l: Lut): l is Lut3D {
  return (l as Lut3D).data !== undefined
}

// ---------------------------------------------------------------------------------------------
// identity / construction
// ---------------------------------------------------------------------------------------------

export function identity1D(size = 256): Lut1D {
  const r = new Float32Array(size), g = new Float32Array(size), b = new Float32Array(size)
  for (let i = 0; i < size; i++) { const v = i / (size - 1); r[i] = v; g[i] = v; b[i] = v }
  return { size, r, g, b, domainMin: [0, 0, 0], domainMax: [1, 1, 1] }
}

export function identity3D(size = 33): Lut3D {
  const data = new Float32Array(size * size * size * 3)
  let o = 0
  for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
    data[o++] = r / (size - 1); data[o++] = g / (size - 1); data[o++] = b / (size - 1)
  }
  return { size, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1] }
}

/** Build a 1D LUT from colour stops (`[position 0..1, [r,g,b] 0..1]`, need not be sorted or cover the
 *  full range — the ends are held constant past the first/last stop). `interp: 'catmullRom'` gives a
 *  smoother ramp through the stops; 'linear' (default) is exact between stops with no overshoot. */
export function lut1DFromStops(
  stops: Array<[number, [number, number, number]]>, size = 256, interp: 'linear' | 'catmullRom' = 'linear',
): Lut1D {
  const sorted = [...stops].sort((a, b) => a[0] - b[0])
  const r = new Float32Array(size), g = new Float32Array(size), b = new Float32Array(size)
  for (let i = 0; i < size; i++) {
    const t = size === 1 ? 0 : i / (size - 1)
    const [rv, gv, bv] = interp === 'catmullRom' ? sampleStopsCatmullRom(sorted, t) : sampleStopsLinear(sorted, t)
    r[i] = rv; g[i] = gv; b[i] = bv
  }
  return { size, r, g, b, domainMin: [0, 0, 0], domainMax: [1, 1, 1] }
}

function sampleStopsLinear(stops: Array<[number, [number, number, number]]>, t: number): [number, number, number] {
  if (t <= stops[0][0]) return stops[0][1]
  const last = stops[stops.length - 1]
  if (t >= last[0]) return last[1]
  for (let i = 0; i < stops.length - 1; i++) {
    const [p0, c0] = stops[i], [p1, c1] = stops[i + 1]
    if (t >= p0 && t <= p1) {
      const f = p1 === p0 ? 0 : (t - p0) / (p1 - p0)
      return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f]
    }
  }
  return last[1]
}

function sampleStopsCatmullRom(stops: Array<[number, [number, number, number]]>, t: number): [number, number, number] {
  const n = stops.length
  if (t <= stops[0][0]) return stops[0][1]
  if (t >= stops[n - 1][0]) return stops[n - 1][1]
  let i = 0
  while (i < n - 2 && stops[i + 1][0] <= t) i++
  const p0 = stops[Math.max(0, i - 1)], p1 = stops[i], p2 = stops[i + 1], p3 = stops[Math.min(n - 1, i + 2)]
  const span = p2[0] - p1[0]
  const f = span === 0 ? 0 : (t - p1[0]) / span
  const out: [number, number, number] = [0, 0, 0]
  for (let c = 0; c < 3; c++) out[c] = catmullRom1(p0[1][c], p1[1][c], p2[1][c], p3[1][c], f)
  return out
}

function catmullRom1(y0: number, y1: number, y2: number, y3: number, t: number): number {
  const t2 = t * t, t3 = t2 * t
  return 0.5 * ((2 * y1) + (-y0 + y2) * t + (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 + (-y0 + 3 * y1 - 3 * y2 + y3) * t3)
}

// ---------------------------------------------------------------------------------------------
// sampling
// ---------------------------------------------------------------------------------------------

function clamp01(x: number): number { return x < 0 ? 0 : x > 1 ? 1 : x }

function sampleChannel(arr: Float32Array, size: number, dmin: number, dmax: number, v: number): number {
  const span = dmax - dmin
  let t = span === 0 ? 0 : (v - dmin) / span
  t = clamp01(t)
  const x = t * (size - 1)
  const i0 = Math.floor(x)
  const i1 = i0 + 1 < size ? i0 + 1 : size - 1
  const f = x - i0
  return arr[i0] + (arr[i1] - arr[i0]) * f
}

/** Apply a 1D LUT to an (r,g,b) triple, each channel through its own curve and domain. */
export function sample1D(l: Lut1D, r: number, g: number, b: number, out: Float32Array | number[], o = 0): void {
  out[o] = sampleChannel(l.r, l.size, l.domainMin[0], l.domainMax[0], r)
  out[o + 1] = sampleChannel(l.g, l.size, l.domainMin[1], l.domainMax[1], g)
  out[o + 2] = sampleChannel(l.b, l.size, l.domainMin[2], l.domainMax[2], b)
}

function cubeCoord(l: Lut3D, r: number, g: number, b: number): [number, number, number] {
  const sz = l.size - 1
  const rt = clamp01((r - l.domainMin[0]) / (l.domainMax[0] - l.domainMin[0] || 1)) * sz
  const gt = clamp01((g - l.domainMin[1]) / (l.domainMax[1] - l.domainMin[1] || 1)) * sz
  const bt = clamp01((b - l.domainMin[2]) / (l.domainMax[2] - l.domainMin[2] || 1)) * sz
  return [rt, gt, bt]
}

function corner(l: Lut3D, ri: number, gi: number, bi: number, ch: number): number {
  const size = l.size
  return l.data[((ri + gi * size + bi * size * size) * 3) + ch]
}

/** Trilinear interpolation of a 3D LUT: fast, but shows faint axis-aligned banding on smooth ramps. */
export function sampleTrilinear(l: Lut3D, r: number, g: number, b: number, out: Float32Array | number[], o = 0): void {
  const [rt, gt, bt] = cubeCoord(l, r, g, b)
  const r0 = Math.floor(rt), g0 = Math.floor(gt), b0 = Math.floor(bt)
  const r1 = Math.min(l.size - 1, r0 + 1), g1 = Math.min(l.size - 1, g0 + 1), b1 = Math.min(l.size - 1, b0 + 1)
  const fr = rt - r0, fg = gt - g0, fb = bt - b0
  for (let ch = 0; ch < 3; ch++) {
    const c000 = corner(l, r0, g0, b0, ch), c100 = corner(l, r1, g0, b0, ch)
    const c010 = corner(l, r0, g1, b0, ch), c110 = corner(l, r1, g1, b0, ch)
    const c001 = corner(l, r0, g0, b1, ch), c101 = corner(l, r1, g0, b1, ch)
    const c011 = corner(l, r0, g1, b1, ch), c111 = corner(l, r1, g1, b1, ch)
    const x00 = c000 + (c100 - c000) * fr, x10 = c010 + (c110 - c010) * fr
    const x01 = c001 + (c101 - c001) * fr, x11 = c011 + (c111 - c011) * fr
    const y0 = x00 + (x10 - x00) * fg, y1 = x01 + (x11 - x01) * fg
    out[o + ch] = y0 + (y1 - y0) * fb
  }
}

/** Tetrahedral interpolation of a 3D LUT (the six-case sort on fr/fg/fb): the standard method used by
 *  DaVinci Resolve, OBS and ffmpeg's `lut3d` filter for colour-accurate 3D LUT lookups, avoiding the
 *  axis-aligned artefacts trilinear shows on smooth gradients. */
export function sampleTetra(l: Lut3D, r: number, g: number, b: number, out: Float32Array | number[], o = 0): void {
  const [rt, gt, bt] = cubeCoord(l, r, g, b)
  const r0 = Math.floor(rt), g0 = Math.floor(gt), b0 = Math.floor(bt)
  const r1 = Math.min(l.size - 1, r0 + 1), g1 = Math.min(l.size - 1, g0 + 1), b1 = Math.min(l.size - 1, b0 + 1)
  const fr = rt - r0, fg = gt - g0, fb = bt - b0

  let p1r: number, p1g: number, p1b: number, p2r: number, p2g: number, p2b: number
  let w0: number, w1: number, w2: number, w3: number
  if (fr > fg) {
    if (fg > fb) { p1r = r1; p1g = g0; p1b = b0; p2r = r1; p2g = g1; p2b = b0; w0 = 1 - fr; w1 = fr - fg; w2 = fg - fb; w3 = fb }
    else if (fr > fb) { p1r = r1; p1g = g0; p1b = b0; p2r = r1; p2g = g0; p2b = b1; w0 = 1 - fr; w1 = fr - fb; w2 = fb - fg; w3 = fg }
    else { p1r = r0; p1g = g0; p1b = b1; p2r = r1; p2g = g0; p2b = b1; w0 = 1 - fb; w1 = fb - fr; w2 = fr - fg; w3 = fg }
  } else {
    if (fb > fg) { p1r = r0; p1g = g0; p1b = b1; p2r = r0; p2g = g1; p2b = b1; w0 = 1 - fb; w1 = fb - fg; w2 = fg - fr; w3 = fr }
    else if (fb > fr) { p1r = r0; p1g = g1; p1b = b0; p2r = r0; p2g = g1; p2b = b1; w0 = 1 - fg; w1 = fg - fb; w2 = fb - fr; w3 = fr }
    else { p1r = r0; p1g = g1; p1b = b0; p2r = r1; p2g = g1; p2b = b0; w0 = 1 - fg; w1 = fg - fr; w2 = fr - fb; w3 = fb }
  }
  for (let ch = 0; ch < 3; ch++) {
    const c000 = corner(l, r0, g0, b0, ch), c111 = corner(l, r1, g1, b1, ch)
    const cp1 = corner(l, p1r, p1g, p1b, ch), cp2 = corner(l, p2r, p2g, p2b, ch)
    out[o + ch] = w0 * c000 + w1 * cp1 + w2 * cp2 + w3 * c111
  }
}

// ---------------------------------------------------------------------------------------------
// look pipeline
// ---------------------------------------------------------------------------------------------

export interface Look {
  curve?: Lut1D
  cube?: Lut3D
  strength: number // 0..1
  input: 'srgb' | 'linear'
  pseudo: boolean // map Rec.601 luminance through `curve` as a colour map, ignoring the source colour
  invert: boolean
}

function linearToSrgb(x: number): number {
  x = clamp01(x)
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055
}

const scratch3: Float32Array = new Float32Array(3)

/** One pixel through the look pipeline (0..1 in, 0..1 out). `enc` is the sRGB-encoded input (linear
 *  input is sRGB-encoded first, per `Look.input`; the LUT curve/cube always operate in sRGB and the
 *  output is left sRGB-encoded — the caller re-linearises if it needs linear data back out). */
function applyLookPixel(look: Look, rIn: number, gIn: number, bIn: number, out: Float32Array | number[], o: number): void {
  const r = look.input === 'linear' ? linearToSrgb(rIn) : rIn
  const g = look.input === 'linear' ? linearToSrgb(gIn) : gIn
  const b = look.input === 'linear' ? linearToSrgb(bIn) : bIn
  let rC = r, gC = g, bC = b
  if (look.pseudo) {
    if (look.curve) {
      const luma = 0.299 * r + 0.587 * g + 0.114 * b
      sample1D(look.curve, luma, luma, luma, scratch3, 0)
      rC = scratch3[0]; gC = scratch3[1]; bC = scratch3[2]
    }
  } else if (look.curve) {
    sample1D(look.curve, r, g, b, scratch3, 0)
    rC = scratch3[0]; gC = scratch3[1]; bC = scratch3[2]
  }
  if (look.cube) {
    sampleTetra(look.cube, rC, gC, bC, scratch3, 0)
    rC = scratch3[0]; gC = scratch3[1]; bC = scratch3[2]
  }
  if (look.invert) { rC = 1 - rC; gC = 1 - gC; bC = 1 - bC }
  const rOut = r + (rC - r) * look.strength
  const gOut = g + (gC - g) * look.strength
  const bOut = b + (bC - b) * look.strength
  out[o] = rOut; out[o + 1] = gOut; out[o + 2] = bOut
}

function build1DTables(look: Look): [Uint8ClampedArray, Uint8ClampedArray, Uint8ClampedArray] {
  const tr = new Uint8ClampedArray(256), tg = new Uint8ClampedArray(256), tb = new Uint8ClampedArray(256)
  const tmp = new Float32Array(3)
  for (let i = 0; i < 256; i++) {
    applyLookPixel(look, i / 255, i / 255, i / 255, tmp, 0)
    tr[i] = Math.round(tmp[0] * 255); tg[i] = Math.round(tmp[1] * 255); tb[i] = Math.round(tmp[2] * 255)
  }
  return [tr, tg, tb]
}

/** Apply a look to an 8-bit RGBA buffer in place-compatible fashion (src/dst may be the same array).
 *  Fast path (no `cube`): a 256-entry per-channel table is built once. `pseudo` still needs the true
 *  per-pixel luminance, computed once per pixel and then run through the same three tables. With a
 *  `cube`, every pixel goes through tetrahedral sampling. */
export function applyLookRgba(src: Uint8ClampedArray, dst: Uint8ClampedArray, look: Look): void {
  const n = Math.min(src.length, dst.length)
  if (!look.cube) {
    const [tr, tg, tb] = build1DTables(look)
    if (look.pseudo) {
      const linear = look.input === 'linear'
      for (let i = 0; i + 3 < n; i += 4) {
        let R = src[i], G = src[i + 1], B = src[i + 2]
        if (linear) { R = linearToSrgb(R / 255) * 255; G = linearToSrgb(G / 255) * 255; B = linearToSrgb(B / 255) * 255 }
        let luma = Math.round(0.299 * R + 0.587 * G + 0.114 * B)
        luma = luma < 0 ? 0 : luma > 255 ? 255 : luma
        dst[i] = tr[luma]; dst[i + 1] = tg[luma]; dst[i + 2] = tb[luma]; dst[i + 3] = src[i + 3]
      }
    } else {
      for (let i = 0; i + 3 < n; i += 4) {
        dst[i] = tr[src[i]]; dst[i + 1] = tg[src[i + 1]]; dst[i + 2] = tb[src[i + 2]]; dst[i + 3] = src[i + 3]
      }
    }
    return
  }
  const tmp = new Float32Array(3)
  for (let i = 0; i + 3 < n; i += 4) {
    applyLookPixel(look, src[i] / 255, src[i + 1] / 255, src[i + 2] / 255, tmp, 0)
    dst[i] = Math.round(tmp[0] * 255); dst[i + 1] = Math.round(tmp[1] * 255); dst[i + 2] = Math.round(tmp[2] * 255)
    dst[i + 3] = src[i + 3]
  }
}

/** Same semantics as `applyLookRgba` but on 0..1 interleaved RGB (no alpha), for 16-bit/float pipelines. */
export function applyLookFloat(src: Float32Array, dst: Float32Array, look: Look): void {
  const n = Math.min(src.length, dst.length)
  const tmp = new Float32Array(3)
  for (let i = 0; i + 2 < n; i += 3) {
    applyLookPixel(look, src[i], src[i + 1], src[i + 2], tmp, 0)
    dst[i] = tmp[0]; dst[i + 1] = tmp[1]; dst[i + 2] = tmp[2]
  }
}

/** Bake a look (curve + cube + strength + pseudo + invert) into a single 3D LUT of the given size, for
 *  the GPU path (upload as a `sampler3D`) or for export via `toCube`. */
export function bakeLook(look: Look, size = 33): Lut3D {
  const data = new Float32Array(size * size * size * 3)
  const tmp = new Float32Array(3)
  let o = 0
  for (let bi = 0; bi < size; bi++) for (let gi = 0; gi < size; gi++) for (let ri = 0; ri < size; ri++) {
    applyLookPixel(look, ri / (size - 1), gi / (size - 1), bi / (size - 1), tmp, 0)
    data[o++] = tmp[0]; data[o++] = tmp[1]; data[o++] = tmp[2]
  }
  return { size, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1], title: 'baked-look' }
}

/** RGB float texture data for a 3D LUT, red-fastest — the same layout `Lut3D.data` already uses, so
 *  this is close to a pass-through; it exists so callers don't reach into `.data` directly. */
export function lutTo3DTexture(l: Lut3D): { size: number; data: Float32Array } {
  return { size: l.size, data: l.data }
}

// ---------------------------------------------------------------------------------------------
// .cube (Adobe / Resolve)
// ---------------------------------------------------------------------------------------------

function parseTriple(tokens: string[]): [number, number, number] {
  return [parseFloat(tokens[0]), parseFloat(tokens[1]), parseFloat(tokens[2])]
}

export function parseCube(text: string): Lut {
  const lines = text.split(/\r\n|\r|\n/)
  let title: string | undefined
  let domainMin: [number, number, number] | undefined
  let domainMax: [number, number, number] | undefined
  let size1D: number | undefined
  let size3D: number | undefined
  const rows: [number, number, number][] = []
  let maxSeen = 0

  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (/^TITLE\b/i.test(line)) {
      const m = line.match(/"([^"]*)"/)
      title = m ? m[1] : line.replace(/^TITLE\s*/i, '')
      continue
    }
    if (/^DOMAIN_MIN\b/i.test(line)) { domainMin = parseTriple(line.split(/\s+/).slice(1)); continue }
    if (/^DOMAIN_MAX\b/i.test(line)) { domainMax = parseTriple(line.split(/\s+/).slice(1)); continue }
    if (/^LUT_1D_SIZE\b/i.test(line)) { size1D = parseInt(line.split(/\s+/)[1], 10); continue }
    if (/^LUT_3D_SIZE\b/i.test(line)) { size3D = parseInt(line.split(/\s+/)[1], 10); continue }
    // any other keyword line we don't understand (e.g. LUT_1D_INPUT_RANGE) is ignored rather than fatal
    if (/^[A-Za-z_]/.test(line) && !/^[-\d.]/.test(line)) continue
    const tokens = line.split(/[\s\t]+/).filter(Boolean)
    if (tokens.length < 3) continue
    const row = parseTriple(tokens)
    if (row.some((v) => Number.isNaN(v))) continue
    for (const v of row) if (v > maxSeen) maxSeen = v
    rows.push(row)
  }

  if (rows.length === 0) throw new Error('parseCube: no data rows found')

  if (!domainMin && !domainMax && maxSeen > 1.5) {
    // some exporters write 0..255 (or 0..65535) values with no domain header; recover a sane domain
    const scale = maxSeen > 300 ? 65535 : 255
    domainMin = [0, 0, 0]; domainMax = [scale, scale, scale]
  }
  domainMin = domainMin ?? [0, 0, 0]
  domainMax = domainMax ?? [1, 1, 1]

  const is3D = size3D !== undefined || (size1D === undefined && Math.round(Math.cbrt(rows.length)) ** 3 === rows.length && rows.length > 4)
  if (is3D) {
    const size = size3D ?? Math.round(Math.cbrt(rows.length))
    const data = new Float32Array(size * size * size * 3)
    const n = Math.min(rows.length, size * size * size)
    for (let i = 0; i < n; i++) { data[i * 3] = rows[i][0]; data[i * 3 + 1] = rows[i][1]; data[i * 3 + 2] = rows[i][2] }
    return { size, data, domainMin, domainMax, title }
  }
  const size = size1D ?? rows.length
  const r = new Float32Array(size), g = new Float32Array(size), b = new Float32Array(size)
  const n = Math.min(rows.length, size)
  for (let i = 0; i < n; i++) { r[i] = rows[i][0]; g[i] = rows[i][1]; b[i] = rows[i][2] }
  return { size, r, g, b, domainMin, domainMax, title }
}

/** Serialise a `Lut1D` or `Lut3D` to Adobe .cube text (6 decimal places, red-fastest ordering for 3D
 *  cubes — the same order `Lut3D.data` is already stored in). */
export function toCube(l: Lut, title = l.title ?? 'Look'): string {
  const lines = [`TITLE "${title}"`]
  lines.push(`DOMAIN_MIN ${l.domainMin.map((v) => v.toFixed(6)).join(' ')}`)
  lines.push(`DOMAIN_MAX ${l.domainMax.map((v) => v.toFixed(6)).join(' ')}`)
  if (isLut3D(l)) {
    lines.push(`LUT_3D_SIZE ${l.size}`)
    lines.push('')
    for (let i = 0; i < l.size * l.size * l.size; i++) {
      const o = i * 3
      lines.push(`${l.data[o].toFixed(6)} ${l.data[o + 1].toFixed(6)} ${l.data[o + 2].toFixed(6)}`)
    }
  } else {
    lines.push(`LUT_1D_SIZE ${l.size}`)
    lines.push('')
    for (let i = 0; i < l.size; i++) lines.push(`${l.r[i].toFixed(6)} ${l.g[i].toFixed(6)} ${l.b[i].toFixed(6)}`)
  }
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------------------------
// .3dl (Autodesk Lustre / Flame) — text variant
// ---------------------------------------------------------------------------------------------

/** Loose parse of the Lustre/Flame .3dl text format (per Discreet's own comment in OpenColorIO's
 *  reader: "use a loose interpretation... to allow other 3D LUTs that look similar"). Header lines
 *  (`3DMESH`, `Mesh N M`, `#comment`) and any non-numeric line are skipped; the first line with more
 *  than 3 integers is the input-axis "shaper" line (used only to recover the input bit depth/domain);
 *  every remaining line of exactly 3 numbers is a data row. Row order sweeps **blue fastest, then
 *  green, then red** (confirmed from the worked example in Autodesk's own format comment: the first
 *  block of rows holds r=g=0 while b sweeps 0..N) — the opposite of .cube's red-fastest order, so rows
 *  are re-indexed into our red-fastest `Lut3D.data` on the way in. */
export function parse3dl(text: string): Lut3D {
  const lines = text.split(/\r\n|\r|\n/)
  let shaperMax: number | undefined
  const rows: [number, number, number][] = []
  let maxSeen = 0
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (/^[A-Za-z]/.test(line)) continue // 3DMESH, Mesh N M, LUT8, gamma 1.0, ...
    const tokens = line.split(/\s+/).filter(Boolean)
    const nums = tokens.map(Number)
    if (nums.some((v) => Number.isNaN(v))) continue
    if (nums.length > 3) { shaperMax = Math.max(...nums); continue } // shaper/axis line
    if (nums.length !== 3) continue
    const row: [number, number, number] = [nums[0], nums[1], nums[2]]
    for (const v of row) if (v > maxSeen) maxSeen = v
    rows.push(row)
  }
  if (rows.length === 0) throw new Error('parse3dl: no data rows found')

  const size = Math.max(2, Math.round(Math.cbrt(rows.length)))
  // infer the output bit depth from the largest value seen (Lustre allows the input/output depths to differ)
  const scale = shaperMax && shaperMax > maxSeen ? shaperMax
    : maxSeen <= 1.5 ? 1 : maxSeen <= 255.5 ? 255 : maxSeen <= 1023.5 ? 1023 : maxSeen <= 4095.5 ? 4095 : 65535

  const data = new Float32Array(size * size * size * 3)
  const n = Math.min(rows.length, size * size * size)
  for (let idx = 0; idx < n; idx++) {
    const r = Math.floor(idx / (size * size))
    const g = Math.floor(idx / size) % size
    const b = idx % size
    const o = (r + g * size + b * size * size) * 3
    const [rv, gv, bv] = rows[idx]
    data[o] = rv / scale; data[o + 1] = gv / scale; data[o + 2] = bv / scale
  }
  return { size, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1] }
}

// ---------------------------------------------------------------------------------------------
// ImageJ .lut (768-byte binary, optional 32-byte ICOL header, or text variant)
// ---------------------------------------------------------------------------------------------

export function parseImageJLut(buf: ArrayBuffer | string): Lut1D {
  if (typeof buf === 'string') return parseImageJLutText(buf)
  const bytes = new Uint8Array(buf)
  let offset = 0
  if (bytes.length === 800) {
    // 32-byte NIH Image header: 'ICOL' magic (big-endian 0x49434F4C), version, nColours, padding
    if (bytes[0] === 0x49 && bytes[1] === 0x43 && bytes[2] === 0x4f && bytes[3] === 0x4c) offset = 32
  }
  if (bytes.length - offset >= 768) {
    const size = 256
    const r = new Float32Array(size), g = new Float32Array(size), b = new Float32Array(size)
    for (let i = 0; i < size; i++) {
      r[i] = bytes[offset + i] / 255
      g[i] = bytes[offset + size + i] / 255
      b[i] = bytes[offset + size * 2 + i] / 255
    }
    return { size, r, g, b, domainMin: [0, 0, 0], domainMax: [1, 1, 1] }
  }
  // not a recognised binary size — try decoding as text (some tools mislabel the extension)
  return parseImageJLutText(new TextDecoder().decode(bytes))
}

function parseImageJLutText(text: string): Lut1D {
  const rows: [number, number, number][] = []
  let maxSeen = 0
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || /^[A-Za-z]/.test(line)) continue
    const tokens = line.split(/[\s,]+/).filter(Boolean).map(Number)
    if (tokens.some((v) => Number.isNaN(v))) continue
    let row: [number, number, number]
    if (tokens.length >= 4) row = [tokens[1], tokens[2], tokens[3]] // leading index/wavelength column
    else if (tokens.length === 3) row = [tokens[0], tokens[1], tokens[2]]
    else continue
    for (const v of row) if (v > maxSeen) maxSeen = v
    rows.push(row)
  }
  if (rows.length === 0) throw new Error('parseImageJLut: no data rows found')
  const scale = maxSeen > 1.5 ? 255 : 1
  const size = rows.length
  const r = new Float32Array(size), g = new Float32Array(size), b = new Float32Array(size)
  for (let i = 0; i < size; i++) { r[i] = rows[i][0] / scale; g[i] = rows[i][1] / scale; b[i] = rows[i][2] / scale }
  return { size, r, g, b, domainMin: [0, 0, 0], domainMax: [1, 1, 1] }
}

// ---------------------------------------------------------------------------------------------
// Hald CLUT
// ---------------------------------------------------------------------------------------------

/** Decode a Hald CLUT image (a square RGB(A) image whose pixel count is a perfect cube of the LUT's
 *  cube size — a "level N" Hald image is N^3 pixels wide/tall, encoding an N^2-sized cube) into a
 *  `Lut3D`. Pixels are read in raster order and decomposed red-fastest (`idx % size`, `(idx/size) %
 *  size`, `idx / size^2`), the standard generation order used by ImageMagick's `hald-clut` and GIMP —
 *  which happens to match our own red-fastest `Lut3D.data` layout exactly, so decoding is a straight
 *  copy once the cube size is known. */
export function haldToLut3D(rgba: Uint8ClampedArray, width: number, height: number): Lut3D {
  const total = width * height
  const size = Math.round(Math.cbrt(total))
  if (size < 2 || size * size * size !== total) throw new Error('haldToLut3D: image size is not a perfect Hald CLUT cube')
  const data = new Float32Array(size * size * size * 3)
  const channels = rgba.length >= total * 4 ? 4 : 3
  for (let idx = 0; idx < total; idx++) {
    const s = idx * channels
    data[idx * 3] = rgba[s] / 255
    data[idx * 3 + 1] = rgba[s + 1] / 255
    data[idx * 3 + 2] = rgba[s + 2] / 255
  }
  return { size, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1] }
}

// ---------------------------------------------------------------------------------------------
// CSV ramps
// ---------------------------------------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] | null {
  const m = hex.match(/^#?([0-9a-fA-F]{6})$/)
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255]
}

/** Parse a CSV/TSV colour ramp: `[index_or_wavelength] r g b` per row, or a single hex `#RRGGBB` per
 *  row. An optional leading column (index or wavelength) is ignored — row order defines the LUT. */
export function parseCsvRamp(text: string): Lut1D {
  const rows: [number, number, number][] = []
  let maxSeen = 0
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') && !/^#[0-9a-fA-F]{6}$/.test(line)) continue
    const tokens = line.split(/[,\t\s]+/).filter(Boolean)
    if (tokens.length === 1) {
      const hex = hexToRgb(tokens[0])
      if (hex) { rows.push(hex); continue }
      continue
    }
    const nums = tokens.map(Number)
    if (nums.some((v) => Number.isNaN(v))) continue
    let row: [number, number, number]
    if (nums.length >= 4) row = [nums[1], nums[2], nums[3]]
    else if (nums.length === 3) row = [nums[0], nums[1], nums[2]]
    else continue
    for (const v of row) if (v > maxSeen) maxSeen = v
    rows.push(row)
  }
  if (rows.length === 0) throw new Error('parseCsvRamp: no data rows found')
  const scale = maxSeen > 1.5 ? 255 : 1
  const size = rows.length
  const r = new Float32Array(size), g = new Float32Array(size), b = new Float32Array(size)
  for (let i = 0; i < size; i++) { r[i] = rows[i][0] / scale; g[i] = rows[i][1] / scale; b[i] = rows[i][2] / scale }
  return { size, r, g, b, domainMin: [0, 0, 0], domainMax: [1, 1, 1] }
}

// ---------------------------------------------------------------------------------------------
// format sniffing
// ---------------------------------------------------------------------------------------------

function looksLikeImageJBinary(buf: ArrayBuffer): boolean {
  return buf.byteLength === 768 || buf.byteLength === 800
}

/** Parse any of the supported LUT text/binary formats, sniffing by filename extension first and
 *  falling back to content inspection. */
export function parseLut(input: string | ArrayBuffer, filename?: string): Lut {
  const ext = filename?.toLowerCase().split('.').pop()
  if (input instanceof ArrayBuffer) {
    if (ext === 'lut' || looksLikeImageJBinary(input)) return parseImageJLut(input)
    // any other binary extension: try decoding as text and fall through to content sniffing
    const text = new TextDecoder().decode(input)
    return parseLutText(text, ext)
  }
  return parseLutText(input, ext)
}

function parseLutText(text: string, ext?: string): Lut {
  if (ext === 'cube') return parseCube(text)
  if (ext === '3dl') return parse3dl(text)
  if (ext === 'lut') return parseImageJLut(text)
  if (ext === 'csv' || ext === 'txt') return parseCsvRamp(text)
  const head = text.slice(0, 4000)
  if (/LUT_3D_SIZE|LUT_1D_SIZE|^\s*TITLE\b/im.test(head)) return parseCube(text)
  if (/^\s*3DMESH\b|^\s*Mesh\s+\d/im.test(head)) return parse3dl(text)
  // 256/768-ish rows of plain "r g b" with no headers looks like an ImageJ text LUT; anything else
  // (variable row count, hex colours, an index/wavelength column) is treated as a CSV ramp
  const nonComment = head.split(/\r\n|\r|\n/).filter((l) => l.trim() && !l.trim().startsWith('#'))
  if (nonComment.length >= 200 && nonComment.every((l) => /^[\d.\s]+$/.test(l.trim()))) return parseImageJLut(text)
  return parseCsvRamp(text)
}
