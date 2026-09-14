/** Minimal DNG writer: the uncompressed 16-bit CFA mosaic with the tags raw converters need (CFA
 *  pattern, black/white level, active area, as-shot neutral, a ColorMatrix1 that includes the white
 *  balance so RawTherapee/darktable/Lightroom estimate the right illuminant), an EXIF IFD
 *  (ExposureTime, ISO, DateTimeOriginal) and, when a measured flat field is supplied, GainMap opcodes
 *  in OpcodeList2 so the converter applies the same vignetting correction as `rawdev.develop`.
 *
 *  Colour: libcamera's CCM maps *white-balanced* camera RGB to linear sRGB, so
 *      sRGB = CCM · diag(gr, 1, gb) · camRGB
 *  and DNG's ColorMatrix1 (XYZ -> unbalanced camera RGB) is
 *      diag(1/gr, 1, 1/gb) · inv(CCM) · (XYZ -> sRGB),
 *  with AsShotNeutral = (1/gr, 1, 1/gb) the camera's response to the scene white. The matrix is scaled
 *  so that its response to the D65 white peaks at 1 (readers only use its direction). */

import type { RawImage } from './raw'
import type { FlatField } from './flatField'

export const XYZ_TO_SRGB = [3.2404542, -1.5371385, -0.4985314, -0.9692660, 1.8760108, 0.0415560, 0.0556434, -0.2040259, 1.0572252]
/** XYZ of the D65 white point (the sRGB white), i.e. inv(XYZ_TO_SRGB) · (1, 1, 1). */
export const D65_XYZ = [0.95047, 1.0, 1.08883]

export function invert3(m: ArrayLike<number>): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = Array.from(m)
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-12) return null
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det]
}
export function mul3(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out = new Array(9).fill(0)
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) out[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c]
  return out
}
export function mulVec3(m: ArrayLike<number>, v: ArrayLike<number>): number[] {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]]
}

/** XYZ(D65) -> unbalanced camera RGB, from the camera-RGB -> sRGB(linear) matrix (tuning rpi.ccm) and
 *  the white-balance gains the CCM was applied after. Returns null when the CCM is singular or the
 *  result is not a sensible camera matrix (a non-positive response to white). */
export function colorMatrixFromCcm(ccm: ArrayLike<number>, gains: [number, number] = [1, 1]): number[] | null {
  const inv = invert3(ccm)
  if (!inv) return null
  const [gr, gb] = gains
  if (!(gr > 0) || !(gb > 0)) return null
  const unbalance = [1 / gr, 0, 0, 0, 1, 0, 0, 0, 1 / gb]
  const cm = mul3(unbalance, mul3(inv, XYZ_TO_SRGB))
  // sanity: the camera's response to the D65 white must be positive in every channel
  const white = mulVec3(cm, D65_XYZ)
  const peak = Math.max(...white)
  if (!white.every((v) => v > 0) || !(peak > 0) || !isFinite(peak)) return null
  return cm.map((v) => v / peak)
}

type Entry = { tag: number; type: number; count: number; value: Uint8Array }
const enc = new TextEncoder()
const u16 = (vals: number[]) => { const b = new Uint8Array(vals.length * 2), dv = new DataView(b.buffer); vals.forEach((v, i) => dv.setUint16(i * 2, v, true)); return b }
const u32 = (vals: number[]) => { const b = new Uint8Array(vals.length * 4), dv = new DataView(b.buffer); vals.forEach((v, i) => dv.setUint32(i * 4, v, true)); return b }
const rational = (vals: number[], den = 10000) => u32(vals.flatMap((v) => [Math.round(v * den), den]))
const srational = (vals: number[], den = 10000) => { const b = new Uint8Array(vals.length * 8), dv = new DataView(b.buffer); vals.forEach((v, i) => { dv.setInt32(i * 8, Math.round(v * den), true); dv.setInt32(i * 8 + 4, den, true) }); return b }
const ascii = (s: string) => enc.encode(s + '\0')
const asciiEntry = (tag: number, s: string): Entry => ({ tag, type: 2, count: s.length + 1, value: ascii(s) })

/** Exposure time as a RATIONAL with a denominator that keeps microsecond precision. */
function exposureRational(seconds: number): Uint8Array {
  return u32([Math.round(seconds * 1_000_000), 1_000_000])
}

/** EXIF/TIFF timestamp "YYYY:MM:DD HH:MM:SS" in local time. */
export function exifDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}:${p(d.getMonth() + 1)}:${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** GainMap opcode (id 9) parameters, DNG 1.3. */
export interface GainMapOpcode {
  top: number; left: number; bottom: number; right: number
  plane: number; planes: number; rowPitch: number; colPitch: number
  mapPointsV: number; mapPointsH: number
  mapSpacingV: number; mapSpacingH: number; mapOriginV: number; mapOriginH: number
  mapPlanes: number
  map: Float32Array
}

/** One GainMap per CFA cell so each colour gets its own field. Opcode lists are big-endian regardless
 *  of the TIFF byte order. Flags = 1 (optional: a reader that does not know the opcode may skip it). */
export function gainMapOpcodes(f: FlatField, bayer: string, width: number, height: number): GainMapOpcode[] {
  const order = bayer.toUpperCase().padEnd(4, 'G')
  const ops: GainMapOpcode[] = []
  for (let cell = 0; cell < 4; cell++) {
    const cy = cell >> 1, cx = cell & 1
    const map = order[cell] === 'R' ? f.r : order[cell] === 'B' ? f.b : f.g
    ops.push({
      top: cy, left: cx, bottom: height, right: width, plane: 0, planes: 1, rowPitch: 2, colPitch: 2,
      mapPointsV: f.rows, mapPointsH: f.cols,
      // grid values sit at cell centres: origin half a cell in, spacing one cell (normalised to the area)
      mapSpacingV: 1 / f.rows, mapSpacingH: 1 / f.cols, mapOriginV: 0.5 / f.rows, mapOriginH: 0.5 / f.cols,
      mapPlanes: 1, map,
    })
  }
  return ops
}

export function encodeOpcodeList(ops: GainMapOpcode[]): Uint8Array {
  const size = 4 + ops.reduce((s, o) => s + 16 + 76 + 4 * o.map.length, 0)
  const out = new Uint8Array(size), dv = new DataView(out.buffer)
  let p = 0
  dv.setUint32(p, ops.length); p += 4
  for (const o of ops) {
    dv.setUint32(p, 9); p += 4                       // OpcodeID GainMap
    out.set([1, 3, 0, 0], p); p += 4                 // DNGVersion 1.3.0.0
    dv.setUint32(p, 1); p += 4                       // Flags: optional
    dv.setUint32(p, 76 + 4 * o.map.length); p += 4   // parameter bytes
    for (const v of [o.top, o.left, o.bottom, o.right, o.plane, o.planes, o.rowPitch, o.colPitch, o.mapPointsV, o.mapPointsH]) { dv.setUint32(p, v); p += 4 }
    for (const v of [o.mapSpacingV, o.mapSpacingH, o.mapOriginV, o.mapOriginH]) { dv.setFloat64(p, v); p += 8 }
    dv.setUint32(p, o.mapPlanes); p += 4
    for (let i = 0; i < o.map.length; i++) { dv.setFloat32(p, o.map[i]); p += 4 }
  }
  return out
}

/** Parse an OpcodeList (only GainMap opcodes are decoded; others are returned as ids). */
export function decodeOpcodeList(bytes: Uint8Array): { gainMaps: GainMapOpcode[]; ids: number[] } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const n = dv.getUint32(0)
  let p = 4
  const gainMaps: GainMapOpcode[] = [], ids: number[] = []
  for (let k = 0; k < n; k++) {
    const id = dv.getUint32(p); const len = dv.getUint32(p + 12); p += 16
    ids.push(id)
    if (id === 9) {
      const u = (i: number) => dv.getUint32(p + i * 4)
      const o: GainMapOpcode = {
        top: u(0), left: u(1), bottom: u(2), right: u(3), plane: u(4), planes: u(5), rowPitch: u(6), colPitch: u(7), mapPointsV: u(8), mapPointsH: u(9),
        mapSpacingV: dv.getFloat64(p + 40), mapSpacingH: dv.getFloat64(p + 48), mapOriginV: dv.getFloat64(p + 56), mapOriginH: dv.getFloat64(p + 64),
        mapPlanes: dv.getUint32(p + 72), map: new Float32Array(0),
      }
      const cnt = o.mapPointsV * o.mapPointsH * o.mapPlanes
      o.map = new Float32Array(cnt)
      for (let i = 0; i < cnt; i++) o.map[i] = dv.getFloat32(p + 76 + 4 * i)
      gainMaps.push(o)
    }
    p += len
  }
  return { gainMaps, ids }
}

export interface DngOptions {
  gains?: [number, number]
  ccm?: ArrayLike<number> | null
  model?: string
  make?: string
  /** exposure time in microseconds and analogue gain of the still (EXIF ExposureTime, ISOSpeedRatings) */
  exposureUs?: number | null
  analogueGain?: number | null
  /** capture time (default now) */
  when?: Date
  /** measured flat field -> GainMap opcodes (OpcodeList2) */
  flatField?: FlatField | null
  software?: string
}

/** ISO speed rating from libcamera's analogue gain: the Raspberry Pi convention (picamera2, rpicam-apps)
 *  is ISO ≈ 100 × AnalogueGain, i.e. unity gain is rated ISO 100. Recorded as a nominal value only. */
export function isoFromGain(gain: number): number {
  return Math.max(1, Math.min(65535, Math.round(gain * 100)))
}

/** Serialise an IFD (entries sorted by tag) at `offset`; out-of-line values follow the entry table. */
function ifdBytes(entries: Entry[], offset: number): Uint8Array {
  entries.sort((a, b) => a.tag - b.tag)
  const tableSize = 2 + entries.length * 12 + 4
  let extra = 0
  for (const e of entries) if (e.value.length > 4) extra += e.value.length + (e.value.length & 1)
  const out = new Uint8Array(tableSize + extra), dv = new DataView(out.buffer)
  dv.setUint16(0, entries.length, true)
  let p = 2, extraP = tableSize
  for (const e of entries) {
    dv.setUint16(p, e.tag, true); dv.setUint16(p + 2, e.type, true); dv.setUint32(p + 4, e.count, true)
    if (e.value.length <= 4) out.set(e.value, p + 8)
    else { dv.setUint32(p + 8, offset + extraP, true); out.set(e.value, extraP); extraP += e.value.length + (e.value.length & 1) }
    p += 12
  }
  dv.setUint32(p, 0, true)  // next IFD
  return out
}
function ifdSize(entries: Entry[]): number {
  let extra = 0
  for (const e of entries) if (e.value.length > 4) extra += e.value.length + (e.value.length & 1)
  return 2 + entries.length * 12 + 4 + extra
}

export function encodeDng(raw: RawImage, opts: DngOptions = {}): Blob {
  const { width: w, height: h } = raw
  const bayer = raw.bayer.toUpperCase().padEnd(4, 'G')
  const cfa = Array.from(bayer).map((c) => (c === 'R' ? 0 : c === 'G' ? 1 : 2))
  const [gr, gb] = opts.gains ?? [1, 1]
  const model = opts.model ?? 'OpenFlexure openflexito IMX219', make = opts.make ?? 'OpenFlexure'
  const cm = opts.ccm ? colorMatrixFromCcm(opts.ccm, [gr, gb]) : null
  const when = opts.when ?? new Date()
  const stamp = exifDateTime(when)
  const dataBytes = w * h * 2

  // EXIF sub-IFD
  const exif: Entry[] = [
    { tag: 36864, type: 7, count: 4, value: enc.encode('0230') },   // ExifVersion 2.3
    asciiEntry(36867, stamp),                                      // DateTimeOriginal
    asciiEntry(36868, stamp),                                      // DateTimeDigitized
  ]
  if (opts.exposureUs && opts.exposureUs > 0) exif.push({ tag: 33434, type: 5, count: 1, value: exposureRational(opts.exposureUs / 1e6) })
  if (opts.analogueGain && opts.analogueGain > 0) exif.push({ tag: 34855, type: 3, count: 1, value: u16([isoFromGain(opts.analogueGain)]) })

  const ifd0: Entry[] = [
    { tag: 254, type: 4, count: 1, value: u32([0]) },
    { tag: 256, type: 4, count: 1, value: u32([w]) },
    { tag: 257, type: 4, count: 1, value: u32([h]) },
    { tag: 258, type: 3, count: 1, value: u16([16]) },
    { tag: 259, type: 3, count: 1, value: u16([1]) },
    { tag: 262, type: 3, count: 1, value: u16([32803]) },
    asciiEntry(271, make),
    asciiEntry(272, model),
    { tag: 273, type: 4, count: 1, value: u32([0]) },          // strip offset, patched below
    { tag: 274, type: 3, count: 1, value: u16([1]) },
    { tag: 277, type: 3, count: 1, value: u16([1]) },
    { tag: 278, type: 4, count: 1, value: u32([h]) },
    { tag: 279, type: 4, count: 1, value: u32([dataBytes]) },
    { tag: 284, type: 3, count: 1, value: u16([1]) },
    asciiEntry(305, opts.software ?? 'openflexito'),
    asciiEntry(306, stamp),                                      // DateTime
    { tag: 33421, type: 3, count: 2, value: u16([2, 2]) },
    { tag: 33422, type: 1, count: 4, value: new Uint8Array(cfa) },
    { tag: 34665, type: 4, count: 1, value: u32([0]) },        // ExifIFD pointer, patched below
    { tag: 50706, type: 1, count: 4, value: new Uint8Array([1, 4, 0, 0]) },
    { tag: 50707, type: 1, count: 4, value: new Uint8Array([1, 3, 0, 0]) },   // backward version 1.3 (opcodes)
    asciiEntry(50708, model),
    { tag: 50714, type: 4, count: 1, value: u32([raw.blackLevel]) },
    { tag: 50717, type: 4, count: 1, value: u32([(1 << raw.bitDepth) - 1]) },
    { tag: 50728, type: 5, count: 3, value: rational([1 / gr, 1, 1 / gb]) },
    { tag: 50730, type: 10, count: 1, value: srational([0], 100) },          // BaselineExposure 0
    { tag: 50829, type: 4, count: 4, value: u32([0, 0, h, w]) },             // ActiveArea top,left,bottom,right
  ]
  if (cm) {
    ifd0.push({ tag: 50721, type: 10, count: 9, value: srational(cm) })
    ifd0.push({ tag: 50778, type: 3, count: 1, value: u16([21]) })            // CalibrationIlluminant1 = D65
  }
  if (opts.flatField) {
    const list = encodeOpcodeList(gainMapOpcodes(opts.flatField, bayer, w, h))
    ifd0.push({ tag: 51009, type: 7, count: list.length, value: list })    // OpcodeList2
  }

  // layout: header(8) | IFD0 (+values) | Exif IFD (+values) | image data
  const s0 = ifdSize(ifd0), s1 = ifdSize(exif)
  const exifOffset = 8 + s0 + (s0 & 1)
  const dataOffset = exifOffset + s1 + (s1 & 1)
  for (const e of ifd0) { if (e.tag === 273) e.value = u32([dataOffset]); if (e.tag === 34665) e.value = u32([exifOffset]) }
  const buf = new Uint8Array(dataOffset + dataBytes), dv = new DataView(buf.buffer)
  buf.set([0x49, 0x49, 42, 0]); dv.setUint32(4, 8, true)
  buf.set(ifdBytes(ifd0, 8), 8)
  buf.set(ifdBytes(exif, exifOffset), exifOffset)
  // pixel data, little-endian 16-bit
  const px = new Uint8Array(raw.data.buffer, raw.data.byteOffset, dataBytes)
  buf.set(px, dataOffset)
  return new Blob([buf], { type: 'image/x-adobe-dng' })
}

/** Read the IFD0 and EXIF tags of a DNG/TIFF written by `encodeDng` (little-endian only), for tests
 *  and for showing capture settings in the gallery. Values: numbers, arrays or strings. */
export function readTiffTags(bytes: Uint8Array): { ifd0: Map<number, unknown>; exif: Map<number, unknown> } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const readIfd = (off: number): Map<number, unknown> => {
    const out = new Map<number, unknown>()
    const n = dv.getUint16(off, true)
    for (let i = 0; i < n; i++) {
      const p = off + 2 + i * 12
      const tag = dv.getUint16(p, true), type = dv.getUint16(p + 2, true), count = dv.getUint32(p + 4, true)
      const sizes: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 10: 8 }
      const size = (sizes[type] ?? 1) * count
      const vp = size <= 4 ? p + 8 : dv.getUint32(p + 8, true)
      let v: unknown
      if (type === 2) v = new TextDecoder().decode(bytes.subarray(vp, vp + count - 1))
      else if (type === 1 || type === 7) v = Array.from(bytes.subarray(vp, vp + count))
      else if (type === 3) v = Array.from({ length: count }, (_, k) => dv.getUint16(vp + 2 * k, true))
      else if (type === 4) v = Array.from({ length: count }, (_, k) => dv.getUint32(vp + 4 * k, true))
      else if (type === 5) v = Array.from({ length: count }, (_, k) => dv.getUint32(vp + 8 * k, true) / dv.getUint32(vp + 8 * k + 4, true))
      else if (type === 10) v = Array.from({ length: count }, (_, k) => dv.getInt32(vp + 8 * k, true) / dv.getInt32(vp + 8 * k + 4, true))
      out.set(tag, v)
    }
    return out
  }
  const ifd0 = readIfd(dv.getUint32(4, true))
  const exifOff = (ifd0.get(34665) as number[] | undefined)?.[0]
  return { ifd0, exif: exifOff ? readIfd(exifOff) : new Map() }
}
