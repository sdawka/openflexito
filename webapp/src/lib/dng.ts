/** Minimal DNG writer: the uncompressed 16-bit CFA mosaic with the tags raw converters need
 *  (CFA pattern, black/white level, as-shot neutral, a ColorMatrix1 derived from the tuning file's
 *  colour matrix). Opens in RawTherapee, darktable and Lightroom. */

import type { RawImage } from './algo/raw'

const XYZ_TO_SRGB = [3.2404542, -1.5371385, -0.4985314, -0.9692660, 1.8760108, 0.0415560, 0.0556434, -0.2040259, 1.0572252]

export function invert3(m: ArrayLike<number>): number[] | null {
  const [a, b, c, d, e, f, g, h, i] = Array.from(m)
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g
  const det = a * A + b * B + c * C
  if (Math.abs(det) < 1e-12) return null
  return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det]
}
function mul3(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out = new Array(9).fill(0)
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) for (let k = 0; k < 3; k++) out[r * 3 + c] += a[r * 3 + k] * b[k * 3 + c]
  return out
}

/** XYZ(D65) -> camera RGB, from a camera-RGB -> sRGB(linear) matrix (tuning rpi.ccm). */
export function colorMatrixFromCcm(ccm: ArrayLike<number>): number[] | null {
  const inv = invert3(ccm)
  return inv ? mul3(inv, XYZ_TO_SRGB) : null
}

type Entry = { tag: number; type: number; count: number; value: Uint8Array }
const enc = new TextEncoder()
const u16 = (vals: number[]) => { const b = new Uint8Array(vals.length * 2), dv = new DataView(b.buffer); vals.forEach((v, i) => dv.setUint16(i * 2, v, true)); return b }
const u32 = (vals: number[]) => { const b = new Uint8Array(vals.length * 4), dv = new DataView(b.buffer); vals.forEach((v, i) => dv.setUint32(i * 4, v, true)); return b }
const rational = (vals: number[], den = 10000) => u32(vals.flatMap((v) => [Math.round(v * den), den]))
const srational = (vals: number[], den = 10000) => { const b = new Uint8Array(vals.length * 8), dv = new DataView(b.buffer); vals.forEach((v, i) => { dv.setInt32(i * 8, Math.round(v * den), true); dv.setInt32(i * 8 + 4, den, true) }); return b }
const ascii = (s: string) => { const t = enc.encode(s + '\0'); return t }

export interface DngOptions { gains?: [number, number]; ccm?: ArrayLike<number> | null; model?: string; make?: string }

export function encodeDng(raw: RawImage, opts: DngOptions = {}): Blob {
  const { width: w, height: h } = raw
  const bayer = raw.bayer.toUpperCase().padEnd(4, 'G')
  const cfa = Array.from(bayer).map((c) => (c === 'R' ? 0 : c === 'G' ? 1 : 2))
  const [gr, gb] = opts.gains ?? [1, 1]
  const model = opts.model ?? 'OpenFlexure openflexito IMX219', make = opts.make ?? 'OpenFlexure'
  const cm = opts.ccm ? colorMatrixFromCcm(opts.ccm) : null
  const dataBytes = w * h * 2
  const entries: Entry[] = [
    { tag: 254, type: 4, count: 1, value: u32([0]) },
    { tag: 256, type: 4, count: 1, value: u32([w]) },
    { tag: 257, type: 4, count: 1, value: u32([h]) },
    { tag: 258, type: 3, count: 1, value: u16([16]) },
    { tag: 259, type: 3, count: 1, value: u16([1]) },
    { tag: 262, type: 3, count: 1, value: u16([32803]) },
    { tag: 271, type: 2, count: make.length + 1, value: ascii(make) },
    { tag: 272, type: 2, count: model.length + 1, value: ascii(model) },
    { tag: 273, type: 4, count: 1, value: u32([0]) },          // strip offset, patched below
    { tag: 274, type: 3, count: 1, value: u16([1]) },
    { tag: 277, type: 3, count: 1, value: u16([1]) },
    { tag: 278, type: 4, count: 1, value: u32([h]) },
    { tag: 279, type: 4, count: 1, value: u32([dataBytes]) },
    { tag: 284, type: 3, count: 1, value: u16([1]) },
    { tag: 33421, type: 3, count: 2, value: u16([2, 2]) },
    { tag: 33422, type: 1, count: 4, value: new Uint8Array(cfa) },
    { tag: 50706, type: 1, count: 4, value: new Uint8Array([1, 4, 0, 0]) },
    { tag: 50707, type: 1, count: 4, value: new Uint8Array([1, 1, 0, 0]) },
    { tag: 50708, type: 2, count: model.length + 1, value: ascii(model) },
    { tag: 50714, type: 4, count: 1, value: u32([raw.blackLevel]) },
    { tag: 50717, type: 4, count: 1, value: u32([(1 << raw.bitDepth) - 1]) },
    ...(cm ? [{ tag: 50721, type: 10, count: 9, value: srational(cm) }] : []),
    { tag: 50728, type: 5, count: 3, value: rational([1 / gr, 1, 1 / gb]) },
    ...(cm ? [{ tag: 50778, type: 3, count: 1, value: u16([21]) }] : []),
  ].sort((a, b) => a.tag - b.tag)
  // layout: header(8) | IFD (2 + 12n + 4) | out-of-line values | image data
  const ifdSize = 2 + entries.length * 12 + 4
  let extra = 0
  for (const e of entries) if (e.value.length > 4) extra += e.value.length + (e.value.length & 1)
  const dataOffset = 8 + ifdSize + extra
  const total = dataOffset + dataBytes
  const buf = new Uint8Array(total), dv = new DataView(buf.buffer)
  buf.set([0x49, 0x49, 42, 0]); dv.setUint32(4, 8, true)
  dv.setUint16(8, entries.length, true)
  let p = 10, extraP = 8 + ifdSize
  for (const e of entries) {
    if (e.tag === 273) e.value = u32([dataOffset])
    dv.setUint16(p, e.tag, true); dv.setUint16(p + 2, e.type, true); dv.setUint32(p + 4, e.count, true)
    if (e.value.length <= 4) buf.set(e.value, p + 8)
    else { dv.setUint32(p + 8, extraP, true); buf.set(e.value, extraP); extraP += e.value.length + (e.value.length & 1) }
    p += 12
  }
  dv.setUint32(p, 0, true)  // next IFD
  // pixel data, little-endian 16-bit
  const px = new Uint8Array(raw.data.buffer, raw.data.byteOffset, dataBytes)
  buf.set(px, dataOffset)
  return new Blob([buf], { type: 'image/x-adobe-dng' })
}
