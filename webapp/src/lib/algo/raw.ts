/** Parse the device's raw records and basic stats.
 *
 *  OFRW record (`/raw.bin`, `/flat.bin`, raw items of `/bracket.bin`; reference: device
 *  `openflexito/rawfmt.py`):
 *      0   4  magic "OFRW"
 *      4   4  width u32 LE          8   4  height u32 LE
 *      12  2  bit_depth u16 LE      (10 single frame, 16 when `frames > 1` were averaged)
 *      14  2  black_level u16 LE    (same scale as the pixels: 64 at 10 bit, 4096 at 16 bit)
 *      16  8  bayer, ASCII NUL padded
 *      24  N  pixels: LE uint16 (w·h·2 bytes) or, when the trailer says `packed`, SBGGR10_CSI2P
 *             (4 pixels in 5 bytes, w·h·5/4 bytes, rows contiguous)
 *      then, v2 only: JSON trailer, its length u32 LE, magic "OFRM".
 *  A v1 record (header + pixels, no trailer) still parses; `meta` is then null.
 *
 *  OFBK bracket container (`/bracket.bin`): "OFBK", count u32 LE, then count × { meta_len u32,
 *  meta JSON, data_len u32, data (JPEG or a complete OFRW record) }. */

export interface RawImage {
  width: number
  height: number
  bitDepth: number
  blackLevel: number
  /** brightest code value (1023 at 10 bit, 65472 for a 16-bit average); defaults to 2^bitDepth - 1 */
  whiteLevel: number
  bayer: string           // e.g. 'BGGR' (order of the 2x2 cell, row-major)
  data: Uint16Array
  /** v2 trailer (the still's own metadata), null for a v1 record */
  meta: RawTrailer | null
}

/** The OFRW v2 trailer / `X-Frame` of a raw or still capture (all keys present, values may be null). */
export interface RawTrailer {
  version: number
  width: number; height: number; bit_depth: number; black_level: number; white_level: number; bayer: string
  packed: boolean; frames: number; frame_timestamps: number[] | null
  ts: number | null; exposure: number | null; gain: number | null; digital_gain: number | null
  colour_gains: number[] | null; colour_temperature: number | null; lux: number | null; focus_fom: number | null
  frame_duration: number | null; ccm: number[] | null; ccm_ct: number | null
  flat: boolean; still: boolean; matched: boolean; t: number
  [k: string]: unknown
}

export const RAW_MAGIC = 'OFRW'
export const RAW_TRAILER_MAGIC = 'OFRM'
export const BRACKET_MAGIC = 'OFBK'
const HEADER_SIZE = 4 + 4 + 4 + 2 + 2 + 8

const magicAt = (dv: DataView, off: number) => String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3))

/** Read the v2 trailer if the record has one (null otherwise or when the JSON is malformed). */
export function parseRawTrailer(buf: ArrayBuffer, end = buf.byteLength): { meta: RawTrailer; start: number } | null {
  if (end < HEADER_SIZE + 8) return null
  const dv = new DataView(buf)
  if (magicAt(dv, end - 4) !== RAW_TRAILER_MAGIC) return null
  const len = dv.getUint32(end - 8, true)
  const start = end - 8 - len
  if (len <= 0 || start < HEADER_SIZE) return null
  try {
    const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, start, len))) as RawTrailer
    return meta && typeof meta === 'object' ? { meta, start } : null
  } catch { return null }
}

/** SBGGR10_CSI2P -> uint16: 4 pixels in 5 bytes, byte 4 holds the low 2 bits of pixels 0..3. */
export function unpackCsi2p10(b: Uint8Array, count: number): Uint16Array {
  const out = new Uint16Array(count)
  for (let i = 0, o = 0; o + 3 < count && i + 4 < b.length; i += 5, o += 4) {
    const lo = b[i + 4]
    out[o] = (b[i] << 2) | (lo & 3)
    out[o + 1] = (b[i + 1] << 2) | ((lo >> 2) & 3)
    out[o + 2] = (b[i + 2] << 2) | ((lo >> 4) & 3)
    out[o + 3] = (b[i + 3] << 2) | ((lo >> 6) & 3)
  }
  return out
}

export function parseRaw(buf: ArrayBuffer, byteOffset = 0, byteLength = buf.byteLength - byteOffset): RawImage {
  const dv = new DataView(buf, byteOffset, byteLength)
  if (byteLength < HEADER_SIZE || magicAt(dv, 0) !== RAW_MAGIC) throw new Error('not an openflexito raw capture')
  const width = dv.getUint32(4, true), height = dv.getUint32(8, true)
  const bitDepth = dv.getUint16(12, true), blackLevel = dv.getUint16(14, true)
  let bayer = ''
  for (let i = 0; i < 8; i++) { const c = dv.getUint8(16 + i); if (c) bayer += String.fromCharCode(c) }
  const trailer = byteOffset === 0 && byteLength === buf.byteLength ? parseRawTrailer(buf) : parseRawTrailer(buf.slice(byteOffset, byteOffset + byteLength))
  const meta = trailer?.meta ?? null
  const pixelsEnd = trailer ? trailer.start : byteLength
  const n = width * height
  const packed = meta ? !!meta.packed : pixelsEnd - HEADER_SIZE < n * 2 && pixelsEnd - HEADER_SIZE >= Math.ceil((n * 5) / 4)
  let data: Uint16Array
  if (packed) {
    const need = Math.ceil((n * 5) / 4)
    if (pixelsEnd - HEADER_SIZE < need) throw new Error('raw capture truncated')
    data = unpackCsi2p10(new Uint8Array(buf, byteOffset + HEADER_SIZE, need), n)
  } else {
    if (pixelsEnd - HEADER_SIZE < n * 2) throw new Error('raw capture truncated')
    // copy so the array is aligned regardless of header size
    data = new Uint16Array(buf.slice(byteOffset + HEADER_SIZE, byteOffset + HEADER_SIZE + n * 2))
  }
  const whiteLevel = typeof meta?.white_level === 'number' && meta.white_level > 0 ? meta.white_level : (1 << bitDepth) - 1
  return { width, height, bitDepth, blackLevel, whiteLevel, bayer: bayer || 'BGGR', data, meta }
}

export interface BracketItem { meta: Record<string, any>; data: Uint8Array }

/** Split an OFBK container into its items (JPEG bytes or OFRW records, per `meta.kind`). */
export function parseBracket(buf: ArrayBuffer): BracketItem[] {
  const dv = new DataView(buf)
  if (buf.byteLength < 8 || magicAt(dv, 0) !== BRACKET_MAGIC) throw new Error('not an openflexito bracket')
  const count = dv.getUint32(4, true)
  const items: BracketItem[] = []
  let p = 8
  for (let i = 0; i < count; i++) {
    if (p + 4 > buf.byteLength) throw new Error('bracket truncated')
    const metaLen = dv.getUint32(p, true); p += 4
    const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, p, metaLen))); p += metaLen
    const dataLen = dv.getUint32(p, true); p += 4
    if (p + dataLen > buf.byteLength) throw new Error('bracket truncated')
    items.push({ meta, data: new Uint8Array(buf, p, dataLen) }); p += dataLen
  }
  return items
}

export interface BayerPlanes { r: Float32Array; g1: Float32Array; g2: Float32Array; b: Float32Array; width: number; height: number }

/** Split the mosaic into the four colour planes (each width/2 x height/2), black level subtracted. */
export function splitBayer(img: RawImage): BayerPlanes {
  const w = img.width >> 1, h = img.height >> 1
  const planes = [new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h), new Float32Array(w * h)]
  const bl = img.blackLevel
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (2 * y) * img.width + 2 * x, i = y * w + x
      planes[0][i] = img.data[o] - bl
      planes[1][i] = img.data[o + 1] - bl
      planes[2][i] = img.data[o + img.width] - bl
      planes[3][i] = img.data[o + img.width + 1] - bl
    }
  }
  // map cell positions to colours according to the Bayer order string
  const order = img.bayer.toUpperCase().padEnd(4, 'G')
  const byColour: Record<string, Float32Array[]> = { R: [], G: [], B: [] }
  for (let k = 0; k < 4; k++) (byColour[order[k]] ?? byColour.G).push(planes[k])
  return { r: byColour.R[0] ?? planes[3], g1: byColour.G[0] ?? planes[1], g2: byColour.G[1] ?? planes[2], b: byColour.B[0] ?? planes[0], width: w, height: h }
}

/** Percentile of a numeric array (linear interpolation), without sorting the whole array when large. */
export function percentile(values: ArrayLike<number>, p: number, sampleLimit = 2_000_000): number {
  const n = values.length
  const step = Math.max(1, Math.floor(n / sampleLimit))
  const arr = new Float64Array(Math.ceil(n / step))
  for (let i = 0, j = 0; i < n; i += step) arr[j++] = values[i]
  arr.sort()
  const idx = (p / 100) * (arr.length - 1)
  const lo = Math.floor(idx), hi = Math.ceil(idx)
  return lo === hi ? arr[lo] : arr[lo] + (arr[hi] - arr[lo]) * (idx - lo)
}

/** Brightest-pixel level across all colour planes (black level already removed). */
export function rawLevel(planes: BayerPlanes, pct = 99.9): number {
  return Math.max(percentile(planes.r, pct), percentile(planes.g1, pct), percentile(planes.g2, pct), percentile(planes.b, pct))
}

/** Mean of several raw frames of the same size in the browser (fallback for a device without
 *  `frames=N`, or to combine separate captures). Frames are checked for an integer shift against the
 *  first on the green plane (a stage twitch between frames); a frame shifted by more than
 *  `maxShiftPx` is dropped, smaller shifts are compensated in whole Bayer cells. Output keeps the
 *  input scale (10 bit), rounded. */
export function averageRaws(frames: RawImage[], maxShiftPx = 16): { raw: RawImage; shifts: { dx: number; dy: number }[]; used: number } {
  if (!frames.length) throw new Error('averageRaws: no frames')
  const ref = frames[0], w = ref.width, h = ref.height
  const sum = new Float64Array(w * h), cnt = new Uint16Array(w * h)
  const shifts: { dx: number; dy: number }[] = []
  let used = 0
  const refG = greenCoarse(ref, 4)
  for (const f of frames) {
    if (f.width !== w || f.height !== h) throw new Error('averageRaws: frame size mismatch')
    let dx = 0, dy = 0
    if (f !== ref) {
      const s = coarseShift(refG, greenCoarse(f, 4), Math.ceil(maxShiftPx / 8) + 1)
      dx = s.dx * 8; dy = s.dy * 8   // coarse cell = 4 Bayer cells = 8 px
    }
    shifts.push({ dx, dy })
    if (Math.abs(dx) > maxShiftPx || Math.abs(dy) > maxShiftPx) continue
    used++
    const scale = f.bitDepth === ref.bitDepth ? 1 : ((1 << ref.bitDepth) - 1) / ((1 << f.bitDepth) - 1)
    for (let y = Math.max(0, -dy); y < Math.min(h, h - dy); y++) {
      const sy = y + dy
      for (let x = Math.max(0, -dx); x < Math.min(w, w - dx); x++) {
        const i = y * w + x
        sum[i] += (f.data[sy * w + x + dx] - f.blackLevel) * scale; cnt[i]++
      }
    }
  }
  const data = new Uint16Array(w * h)
  for (let i = 0; i < data.length; i++) data[i] = cnt[i] ? Math.round(sum[i] / cnt[i] + ref.blackLevel) : ref.data[i]
  return { raw: { ...ref, data, meta: ref.meta ? { ...ref.meta, frames: used } : null }, shifts, used }
}

/** Green plane (g1) box-downsampled by `f` cells (black level removed). */
function greenCoarse(img: RawImage, f: number): { data: Float32Array; width: number; height: number } {
  const p = splitBayer(img)
  const w = Math.floor(p.width / f), h = Math.floor(p.height / f)
  const out = new Float32Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0
    for (let dy = 0; dy < f; dy++) for (let dx = 0; dx < f; dx++) s += p.g1[(y * f + dy) * p.width + x * f + dx]
    out[y * w + x] = s / (f * f)
  }
  return { data: out, width: w, height: h }
}

/** Integer shift (in coarse cells) of `img` relative to `ref` minimising the mean absolute difference. */
function coarseShift(ref: { data: Float32Array; width: number; height: number }, img: { data: Float32Array; width: number; height: number }, search: number): { dx: number; dy: number } {
  const { width: w, height: h } = ref
  let best = Infinity, bdx = 0, bdy = 0
  for (let dy = -search; dy <= search; dy++) for (let dx = -search; dx <= search; dx++) {
    let s = 0, n = 0
    for (let y = Math.max(0, -dy); y < Math.min(h, h - dy); y += 2) for (let x = Math.max(0, -dx); x < Math.min(w, w - dx); x += 2) {
      s += Math.abs(ref.data[y * w + x] - img.data[(y + dy) * w + x + dx]); n++
    }
    const m = n ? s / n : Infinity
    if (m < best - 1e-9 || (Math.abs(m - best) <= 1e-9 && Math.abs(dx) + Math.abs(dy) < Math.abs(bdx) + Math.abs(bdy))) { best = m; bdx = dx; bdy = dy }
  }
  return { dx: bdx, dy: bdy }
}
