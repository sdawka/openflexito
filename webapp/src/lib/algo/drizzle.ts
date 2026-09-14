/** Drizzle: combine several sub-pixel-shifted frames of the same scene onto a finer output grid
 *  (pixel-shift super-resolution). Each input pixel is a small square "drop" of side `pixfrac`
 *  (in input-pixel units, centred on the pixel) that is splatted onto the output grid at its
 *  measured position; every output cell accumulates the drop area that falls on it, weighted by
 *  source brightness, and the final value is the weighted average (Fielding/Hook & Fruchter
 *  "drizzle" resampling, as used for dithered astronomical exposures). A frame's `dx`/`dy` is its
 *  measured shift *from* the reference frame (frame content = reference content shifted by
 *  (dx, dy)): treating pixel indices as spanning [i, i+1) with their centre at i+0.5, a source
 *  pixel at (x, y) has its footprint centred at (((x + 0.5) - dx) * scale, ((y + 0.5) - dy) *
 *  scale) on the output grid (the +0.5 matters: without it, an unshifted frame's drops sit exactly
 *  on output-cell boundaries and split evenly between neighbours instead of landing cleanly).
 *  Output cells no drop ever reaches (holes at the border, or from very few frames) are filled from
 *  their nearest covered neighbour.
 *
 *  `pixfrac` default is 0.5 (not 1, which behaves like plain resampling-averaging): the unit test
 *  below shows the sharper reconstruction 0.5 already gives once registration is accurate (see
 *  fftTrack.ts / register.ts), matching superres-hdr-report.md's recommendation. */

import type { RawImage } from './raw'
import { prepareMosaic, desaturateHighlights, applyCcm, type DevelopOptions, type RgbF } from './rawdev'

export interface DrizzleFrame { data: Uint8ClampedArray; width: number; height: number; dx: number; dy: number; weight?: number }
export interface DrizzleResult { data: Uint8ClampedArray; width: number; height: number; coverage: number }

function overlap1d(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
}

/** Splat one input pixel's square drop onto the (sum, weight) accumulators. Shared by the RGBA
 *  drizzle below and by `drizzlePlane`/`drizzleBayer`, so raw (Float32/Uint16) planes accumulate
 *  with exactly the same footprint geometry as the RGBA path. `channels` values are read from
 *  `read(x, y, c)` and written scaled by `wgt` into `sum[oi * channels + c]`. */
function splat(
  w: number, h: number, dx: number, dy: number, scale: number, half: number, W: number, H: number,
  frameWeight: number, channels: number, read: (x: number, y: number, c: number) => number,
  sum: Float32Array, weight: Float32Array,
): void {
  for (let y = 0; y < h; y++) {
    const oy = (y + 0.5 - dy) * scale
    const y0 = Math.max(0, Math.floor(oy - half)), y1 = Math.min(H, Math.ceil(oy + half))
    if (y1 <= y0) continue
    for (let x = 0; x < w; x++) {
      const ox = (x + 0.5 - dx) * scale
      const x0 = Math.max(0, Math.floor(ox - half)), x1 = Math.min(W, Math.ceil(ox + half))
      if (x1 <= x0) continue
      for (let oyp = y0; oyp < y1; oyp++) {
        const wy = overlap1d(oyp, oyp + 1, oy - half, oy + half)
        if (wy <= 0) continue
        const row = oyp * W
        for (let oxp = x0; oxp < x1; oxp++) {
          const wx = overlap1d(oxp, oxp + 1, ox - half, ox + half)
          if (wx <= 0) continue
          const wgt = wx * wy * frameWeight, oi = row + oxp
          for (let c = 0; c < channels; c++) sum[oi * channels + c] += read(x, y, c) * wgt
          weight[oi] += wgt
        }
      }
    }
  }
}

/** Drizzle RGBA frames onto a `scale`x grid. `pixfrac` (0, 1] is the drop size relative to one
 *  input pixel; smaller sharpens but needs more frames/coverage, 1 behaves like plain averaging.
 *  A frame's optional `weight` (default 1) scales its contribution throughout — e.g. down-weighting
 *  a frame whose registration `quality` was marginal instead of dropping it outright. */
export function drizzle(frames: DrizzleFrame[], scale = 2, pixfrac = 0.5): DrizzleResult {
  if (!frames.length) throw new Error('drizzle: no frames')
  const { width: w0, height: h0 } = frames[0]
  const W = Math.round(w0 * scale), H = Math.round(h0 * scale)
  const sum = new Float32Array(W * H * 3)
  const weight = new Float32Array(W * H)
  const half = (pixfrac / 2) * scale
  for (const f of frames) {
    const { data, width: w, height: h, dx, dy } = f
    const fw = f.weight ?? 1
    if (fw <= 0) continue
    splat(w, h, dx, dy, scale, half, W, H, fw, 3, (x, y, c) => data[(y * w + x) * 4 + c], sum, weight)
  }
  const out = new Uint8ClampedArray(W * H * 4)
  let covered = 0
  for (let i = 0; i < W * H; i++) {
    const wgt = weight[i]
    if (wgt > 0) { out[i * 4] = sum[i * 3] / wgt; out[i * 4 + 1] = sum[i * 3 + 1] / wgt; out[i * 4 + 2] = sum[i * 3 + 2] / wgt; out[i * 4 + 3] = 255; covered++ }
  }
  fillHoles(out, weight, W, H)
  return { data: out, width: W, height: H, coverage: covered / (W * H) }
}

export interface DrizzlePlaneFrame { data: ArrayLike<number>; width: number; height: number; dx: number; dy: number; weight?: number }
export interface DrizzlePlaneResult { data: Float32Array; weight: Float32Array; width: number; height: number; coverage: number }

/** Single-channel drizzle: the same footprint accumulation as `drizzle()`, but for one scalar plane
 *  (linear-light Float32 or raw Uint16 samples) with Float32 accumulation and no 8-bit clamp or hole
 *  fill — callers (raw-plane averaging, `drizzleBayer`) compose several of these and decide what to
 *  do with uncovered cells themselves (e.g. leave `weight === 0` as "no data" rather than
 *  interpolating across CFA colours). */
export function drizzlePlane(frames: DrizzlePlaneFrame[], scale = 2, pixfrac = 0.5): DrizzlePlaneResult {
  if (!frames.length) throw new Error('drizzlePlane: no frames')
  const { width: w0, height: h0 } = frames[0]
  const W = Math.round(w0 * scale), H = Math.round(h0 * scale)
  const sum = new Float32Array(W * H)
  const weight = new Float32Array(W * H)
  const half = (pixfrac / 2) * scale
  for (const f of frames) {
    const { data, width: w, height: h, dx, dy } = f
    const fw = f.weight ?? 1
    if (fw <= 0) continue
    splat(w, h, dx, dy, scale, half, W, H, fw, 1, (x, y) => data[y * w + x], sum, weight)
  }
  let covered = 0
  const out = new Float32Array(W * H)
  for (let i = 0; i < W * H; i++) if (weight[i] > 0) { out[i] = sum[i] / weight[i]; covered++ }
  return { data: out, weight, width: W, height: H, coverage: covered / (W * H) }
}

/** Fill output cells with no drop coverage from the nearest covered cell (a few dilation passes
 *  over a small ring; drizzle holes are isolated single cells or thin borders, never large areas
 *  when frames sensibly overlap). */
function fillHoles(out: Uint8ClampedArray, weight: Float32Array, W: number, H: number): void {
  const done = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) done[i] = weight[i] > 0 ? 1 : 0
  let remaining = 0
  for (let i = 0; i < done.length; i++) if (!done[i]) remaining++
  if (!remaining) return
  for (let pass = 0; pass < 8 && remaining > 0; pass++) {
    let changed = false
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (done[i]) continue
      let sr = 0, sg = 0, sb = 0, n = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue
        const j = yy * W + xx
        if (weight[j] > 0) { sr += out[j * 4]; sg += out[j * 4 + 1]; sb += out[j * 4 + 2]; n++ }
      }
      if (n) { out[i * 4] = sr / n; out[i * 4 + 1] = sg / n; out[i * 4 + 2] = sb / n; out[i * 4 + 3] = 255; changed = true }
    }
    if (changed) for (let i = 0; i < done.length; i++) if (!done[i] && weight[i] === 0 && out[i * 4 + 3] === 255) { done[i] = 1; remaining-- }
    if (!changed) break
  }
}

/** Fill uncovered cells of a `drizzlePlane` result from their nearest covered neighbour, in place
 *  (same dilation idea as the RGBA `fillHoles`, generalised to one Float32 channel). Exported so
 *  `drizzleBayer` (three independent colour planes, each with its own coverage) can fill each plane
 *  the same way after combining CFA phases. */
export function fillPlaneHoles(data: Float32Array, weight: Float32Array, W: number, H: number): void {
  const done = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) done[i] = weight[i] > 0 ? 1 : 0
  let remaining = 0
  for (let i = 0; i < done.length; i++) if (!done[i]) remaining++
  if (!remaining) return
  for (let pass = 0; pass < 8 && remaining > 0; pass++) {
    let changed = false
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (done[i]) continue
      let s = 0, n = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue
        const j = yy * W + xx
        if (weight[j] > 0) { s += data[j]; n++ }
      }
      if (n) { data[i] = s / n; changed = true }
    }
    if (changed) {
      const filled = new Uint8Array(W * H)
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = y * W + x; if (!done[i]) filled[i] = 1 }
      for (let i = 0; i < done.length; i++) if (!done[i] && filled[i]) { done[i] = 1; remaining-- }
    }
    if (!changed) break
  }
}

export type BayerOrder = 'RGGB' | 'BGGR' | 'GRBG' | 'GBRG'

/** Which corner of each 2x2 CFA tile (x-offset, y-offset, both 0 or 1) carries which colour. */
const BAYER_PHASE: Record<BayerOrder, { r: [number, number]; g1: [number, number]; g2: [number, number]; b: [number, number] }> = {
  RGGB: { r: [0, 0], g1: [1, 0], g2: [0, 1], b: [1, 1] },
  BGGR: { r: [1, 1], g1: [1, 0], g2: [0, 1], b: [0, 0] },
  GRBG: { r: [1, 0], g1: [0, 0], g2: [1, 1], b: [0, 1] },
  GBRG: { r: [0, 1], g1: [0, 0], g2: [1, 1], b: [1, 0] },
}

export interface BayerFrame { data: ArrayLike<number>; width: number; height: number; dx: number; dy: number; weight?: number }
export interface DrizzleBayerResult {
  r: Float32Array; g: Float32Array; b: Float32Array
  /** per-site drizzle weight for each plane (0 = no drop ever reached the site); exposed so a caller
   *  that wants filled holes can run `fillPlaneHoles(plane, weight, width, height)` itself, per the
   *  "don't silently smooth" note below. */
  rWeight: Float32Array; gWeight: Float32Array; bWeight: Float32Array
  coverage: { r: number; g: number; b: number }
  width: number; height: number
}

/** Drizzle N raw Bayer mosaics (each already black-level subtracted, linear) onto a common `scale`x
 *  grid, one accumulator per CFA colour, producing linear RGB planes with **no demosaic step**: the
 *  classic 4-shot 1-mosaic-pixel dither pattern places a sample of every colour at every output
 *  site, so there is nothing to interpolate. `frames[i].dx/dy` is that frame's shift from the
 *  reference in full mosaic-pixel units (as measured by `register()`/`displacement()` on the
 *  mosaic, or on a demosaiced preview of it).
 *
 *  Each CFA colour only occupies every other mosaic row and column; a phase's samples are extracted
 *  as their own half-resolution plane and drizzled with `drizzlePlane`, offsetting the frame shift by
 *  the phase's tile corner (in mosaic-pixel units, i.e. half a phase-pixel) so all four phases (R, two
 *  greens, B) land in the same output coordinate frame. The two green phases (G1, G2, diagonal
 *  corners of the tile) are accumulated into one green plane, since they are the same colour filter.
 *  Coverage can be well under 1 even with 4 well-dithered frames if the shifts are not exactly the
 *  four tile corners (real stage moves), so callers should check `coverage` and fill holes with
 *  `fillPlaneHoles` before using a plane as the final image (this function does not fill holes
 *  itself: an uncovered site should stay flagged rather than be silently smoothed for callers that
 *  want to know how much of the reconstruction is real data). */
export function drizzleBayer(frames: BayerFrame[], bayer: BayerOrder, scale = 2, pixfrac = 0.5): DrizzleBayerResult {
  if (!frames.length) throw new Error('drizzleBayer: no frames')
  const { width: mw, height: mh } = frames[0]
  if (mw % 2 || mh % 2) throw new Error('drizzleBayer: mosaic dimensions must be even')
  const pw = mw / 2, ph = mh / 2
  const phases = BAYER_PHASE[bayer]

  // Extract one CFA phase (ox, oy in {0,1}) as its own half-resolution plane, with the frame's
  // shift re-expressed in that plane's pixel units, offset by the phase's position within the tile
  // (a G2 frame's samples sit half a phase-pixel from a G1 frame's even with zero stage motion).
  //
  // `drizzlePlane`'s splat centres phase-plane pixel index p's drop at continuous position
  // `(p + 0.5 - dx') * scale` — i.e. it assumes p's own physical sample sits at the *centre* of a
  // phase-plane cell of width 1 (= 2 mosaic pixels). The real sample is a single mosaic pixel at
  // mosaic column `2p + ox`, whose own centre (mosaic convention: pixel c spans [c, c+1)) is at
  // `2p + ox + 0.5`, not `2p + 1` (what the plain `+0.5` convention would put there for ox = 0).
  // Solving `(p + 0.5 - dx') * 2 = (2p + ox + 0.5) - dx` (mosaic-pixel shift `dx`, phase-plane
  // splat scale factor 2 relative to the mosaic) for dx' gives the `(dx - ox + 1) / 2` below —
  // without the `+1`, a frame at zero measured shift lands its own sample a full mosaic pixel away
  // from its true position (caught by a super-resolution regression test reconstructing a plain
  // ramp: every phase came out shifted low by one whole CFA-tile axis).
  function phasePlanes(ox: number, oy: number): DrizzlePlaneFrame[] {
    return frames.map((f) => {
      const { data, width: w, height: h, dx, dy, weight } = f
      const out = new Float32Array(pw * ph)
      for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) out[y * pw + x] = data[(y * 2 + oy) * w + (x * 2 + ox)]
      return { data: out, width: pw, height: ph, dx: (dx - ox + 1) / 2, dy: (dy - oy + 1) / 2, weight }
    })
  }

  const rPlane = drizzlePlane(phasePlanes(...phases.r), scale, pixfrac)
  const bPlane = drizzlePlane(phasePlanes(...phases.b), scale, pixfrac)
  // green: pool both phases into one accumulator by drizzling both frame sets together
  const gFrames = [...phasePlanes(...phases.g1), ...phasePlanes(...phases.g2)]
  const gPlane = drizzlePlane(gFrames, scale, pixfrac)

  return {
    r: rPlane.data, g: gPlane.data, b: bPlane.data,
    rWeight: rPlane.weight, gWeight: gPlane.weight, bWeight: bPlane.weight,
    coverage: { r: rPlane.coverage, g: gPlane.coverage, b: bPlane.coverage },
    width: rPlane.width, height: rPlane.height,
  }
}

/** One frame of a raw-plane super-resolution burst: a whole OFRW record (`algo/raw.ts#parseRaw`) plus
 *  its measured shift *from the reference frame*, in full mosaic-pixel units (register()/displacement()
 *  run on a demosaiced or green-plane proxy of the mosaic, since they assume a normal image, not
 *  CFA-patterned data — see `workers/superresWorker.ts`). */
export interface RawSuperresFrame { raw: RawImage; dx: number; dy: number; weight?: number }
export interface DrizzledRawResult { rgb: RgbF; coverage: { r: number; g: number; b: number } }

/** Raw-plane pixel-shift super-resolution: drizzle N Bayer mosaics onto a `scale`x grid with **no
 *  demosaic step** (`drizzleBayer`), then run the same downstream develop pipeline `rawdev.ts` uses
 *  for a single capture — white balance and lens-shading/flat-field correction per source frame
 *  (`prepareMosaic`, applied *before* drizzling, since shading is a function of the frame's own sensor
 *  position), then highlight desaturation and the colour matrix on the combined planes (`rawdev.ts`'s
 *  `desaturateHighlights`/`applyCcm`) — skipping only the demosaic interpolation that a per-frame RAW
 *  develop would otherwise need, because the 4-shot dither already has a real sample of every colour
 *  at every output site. Output cells no frame's drop reached are filled from their nearest covered
 *  neighbour (`fillPlaneHoles`) before the colour steps, one plane at a time, so an isolated hole in
 *  (say) red doesn't leave a magenta/green fringe in the final RGB.
 *
 *  `opts.gains`/`opts.ccm` are shared across the whole burst (the capture locks AE/AWB for the
 *  duration — see `services/photo/superres.ts` — so a single set of values is the right choice; a
 *  caller wanting per-frame values from each record's own trailer should resolve them once from the
 *  reference frame before calling this). `opts.demosaic` is ignored (there is nothing to demosaic). */
export function drizzleRawSuperres(frames: RawSuperresFrame[], scale: number, pixfrac: number, opts: DevelopOptions = {}): DrizzledRawResult {
  if (!frames.length) throw new Error('drizzleRawSuperres: no frames')
  const bayer = frames[0].raw.bayer.toUpperCase() as BayerOrder
  if (!(bayer in BAYER_PHASE)) throw new Error(`drizzleRawSuperres: unsupported bayer order ${frames[0].raw.bayer}`)
  const prepared: BayerFrame[] = frames.map((f) => ({
    data: prepareMosaic(f.raw, opts), width: f.raw.width, height: f.raw.height, dx: f.dx, dy: f.dy, weight: f.weight,
  }))
  const d = drizzleBayer(prepared, bayer, scale, pixfrac)
  fillPlaneHoles(d.r, d.rWeight, d.width, d.height)
  fillPlaneHoles(d.g, d.gWeight, d.width, d.height)
  fillPlaneHoles(d.b, d.bWeight, d.width, d.height)
  const { width: w, height: h } = d
  const rgb = new Float32Array(w * h * 3)
  for (let i = 0; i < w * h; i++) { rgb[i * 3] = d.r[i]; rgb[i * 3 + 1] = d.g[i]; rgb[i * 3 + 2] = d.b[i] }
  desaturateHighlights(rgb, opts.gains ?? [1, 1], opts.exposure ?? 1)
  if (opts.ccm) applyCcm(rgb, opts.ccm)
  return { rgb: { data: rgb, width: w, height: h }, coverage: d.coverage }
}
