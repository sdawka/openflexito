import { describe, expect, it } from 'vitest'
import { parseRaw, parseRawTrailer, parseBracket, unpackCsi2p10, splitBayer, averageRaws, RAW_MAGIC, RAW_TRAILER_MAGIC, BRACKET_MAGIC, type RawTrailer } from '../raw'

// Byte layouts follow device/openflexito/rawfmt.py and the device.md handoff exactly.
const HEADER_SIZE = 4 + 4 + 4 + 2 + 2 + 8

function writeHeader(width: number, height: number, bitDepth: number, blackLevel: number, bayer: string): Uint8Array {
  const b = new Uint8Array(HEADER_SIZE), dv = new DataView(b.buffer)
  b.set([...RAW_MAGIC].map((c) => c.charCodeAt(0)), 0)
  dv.setUint32(4, width, true); dv.setUint32(8, height, true)
  dv.setUint16(12, bitDepth, true); dv.setUint16(14, blackLevel, true)
  for (let i = 0; i < bayer.length && i < 8; i++) b[16 + i] = bayer.charCodeAt(i)
  return b
}

function packCsi2p10(pixels: Uint16Array): Uint8Array {
  const out = new Uint8Array(Math.ceil((pixels.length * 5) / 4))
  for (let i = 0, o = 0; i + 3 < pixels.length; i += 4, o += 5) {
    const p0 = pixels[i], p1 = pixels[i + 1], p2 = pixels[i + 2], p3 = pixels[i + 3]
    out[o] = p0 >> 2; out[o + 1] = p1 >> 2; out[o + 2] = p2 >> 2; out[o + 3] = p3 >> 2
    out[o + 4] = (p0 & 3) | ((p1 & 3) << 2) | ((p2 & 3) << 4) | ((p3 & 3) << 6)
  }
  return out
}

/** Build a v2 OFRW record: header + pixels (+ trailer JSON + length + "OFRM" when `trailer` is given). */
function buildOfrw(o: { width: number; height: number; bitDepth?: number; blackLevel?: number; bayer?: string; pixels: Uint16Array; packed?: boolean; trailer?: Partial<RawTrailer> | null }): ArrayBuffer {
  const bitDepth = o.bitDepth ?? 10, blackLevel = o.blackLevel ?? 64, bayer = o.bayer ?? 'BGGR'
  const header = writeHeader(o.width, o.height, bitDepth, blackLevel, bayer)
  const body = o.packed ? packCsi2p10(o.pixels) : new Uint8Array(o.pixels.buffer, o.pixels.byteOffset, o.pixels.byteLength)
  const parts: Uint8Array[] = [header, body]
  if (o.trailer !== null && o.trailer !== undefined) {
    const json = new TextEncoder().encode(JSON.stringify(o.trailer))
    const lenAndMagic = new Uint8Array(8), dv = new DataView(lenAndMagic.buffer)
    dv.setUint32(0, json.length, true)
    lenAndMagic.set([...RAW_TRAILER_MAGIC].map((c) => c.charCodeAt(0)), 4)
    parts.push(json, lenAndMagic)
  }
  const total = parts.reduce((s, p) => s + p.length, 0)
  const out = new Uint8Array(total)
  let p = 0; for (const part of parts) { out.set(part, p); p += part.length }
  return out.buffer
}

const trailer = (extra: Partial<RawTrailer> = {}): RawTrailer => ({
  version: 2, width: 8, height: 8, bit_depth: 10, black_level: 64, white_level: 1023, bayer: 'BGGR',
  packed: false, frames: 1, frame_timestamps: null, ts: 12345, exposure: 500, gain: 1.5, digital_gain: 1,
  colour_gains: [1.8, 1.6], colour_temperature: null, lux: 400, focus_fom: null, frame_duration: 33333,
  ccm: null, ccm_ct: null, flat: false, still: true, matched: true, t: 999, ...extra,
})

describe('parseRaw', () => {
  it('parses a v1 record (no trailer) unchanged', () => {
    const pixels = new Uint16Array(8 * 8).map((_, i) => 64 + (i % 100))
    const buf = buildOfrw({ width: 8, height: 8, pixels, trailer: null })
    const img = parseRaw(buf)
    expect(img.width).toBe(8); expect(img.height).toBe(8); expect(img.bitDepth).toBe(10)
    expect(img.blackLevel).toBe(64); expect(img.whiteLevel).toBe(1023); expect(img.bayer).toBe('BGGR')
    expect(img.meta).toBeNull()
    expect(Array.from(img.data.subarray(0, 4))).toEqual(Array.from(pixels.subarray(0, 4)))
  })

  it('parses a v2 trailer (device.md §2 keys) and honours its white_level', () => {
    const pixels = new Uint16Array(8 * 8).fill(4096 + 64)
    const buf = buildOfrw({ width: 8, height: 8, bitDepth: 16, blackLevel: 4096, pixels, trailer: trailer({ bit_depth: 16, black_level: 4096, white_level: 65472, frames: 4 }) })
    const img = parseRaw(buf)
    expect(img.meta).not.toBeNull()
    expect(img.meta!.frames).toBe(4)
    expect(img.meta!.colour_gains).toEqual([1.8, 1.6])
    expect(img.whiteLevel).toBe(65472)
    const t = parseRawTrailer(buf)
    expect(t?.meta.still).toBe(true)
    expect(t?.meta.matched).toBe(true)
  })

  it('unpacks SBGGR10_CSI2P (4 pixels in 5 bytes) identically via parseRaw and the reference decoder', () => {
    const pixels = new Uint16Array(64)
    for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 7) % 1024
    const buf = buildOfrw({ width: 8, height: 8, pixels, packed: true, trailer: trailer({ packed: true }) })
    const img = parseRaw(buf)
    expect(img.meta?.packed).toBe(true)
    expect(Array.from(img.data)).toEqual(Array.from(pixels))
    // cross-check against the handoff's reference unpack loop directly
    const raw = new Uint8Array(buf, HEADER_SIZE, Math.ceil((64 * 5) / 4))
    expect(Array.from(unpackCsi2p10(raw, 64))).toEqual(Array.from(pixels))
  })

  it('throws on truncated data and on a bad magic', () => {
    const pixels = new Uint16Array(8 * 8)
    const buf = buildOfrw({ width: 8, height: 8, pixels, trailer: null })
    expect(() => parseRaw(buf.slice(0, HEADER_SIZE + 4))).toThrow()
    const bad = new Uint8Array(buf.slice(0)); bad[0] = 0
    expect(() => parseRaw(bad.buffer)).toThrow()
  })
})

describe('parseBracket', () => {
  it('splits an OFBK container into its items (jpeg + raw kinds)', () => {
    const jpegBytes = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])
    const rawPixels = new Uint16Array(4 * 4).fill(200)
    const rawBuf = new Uint8Array(buildOfrw({ width: 4, height: 4, pixels: rawPixels, trailer: null }))
    const items = [
      { meta: { index: 0, factor: 0.5, kind: 'jpeg' }, data: jpegBytes },
      { meta: { index: 1, factor: 1, kind: 'raw' }, data: rawBuf },
    ]
    const magic = new Uint8Array([...BRACKET_MAGIC].map((c) => c.charCodeAt(0)))
    const parts: Uint8Array[] = [magic, new Uint8Array(4)]
    new DataView(parts[1].buffer).setUint32(0, items.length, true)
    for (const it of items) {
      const metaJson = new TextEncoder().encode(JSON.stringify(it.meta))
      const metaLen = new Uint8Array(4); new DataView(metaLen.buffer).setUint32(0, metaJson.length, true)
      const dataLen = new Uint8Array(4); new DataView(dataLen.buffer).setUint32(0, it.data.length, true)
      parts.push(metaLen, metaJson, dataLen, it.data)
    }
    const total = parts.reduce((s, p) => s + p.length, 0)
    const out = new Uint8Array(total); let p = 0; for (const part of parts) { out.set(part, p); p += part.length }
    const parsed = parseBracket(out.buffer)
    expect(parsed).toHaveLength(2)
    expect(parsed[0].meta.kind).toBe('jpeg')
    expect(Array.from(parsed[0].data)).toEqual(Array.from(jpegBytes))
    expect(parsed[1].meta.kind).toBe('raw')
    const rawImg = parseRaw(parsed[1].data.buffer as ArrayBuffer, parsed[1].data.byteOffset, parsed[1].data.byteLength)
    expect(rawImg.width).toBe(4); expect(Array.from(rawImg.data.subarray(0, 4))).toEqual([200, 200, 200, 200])
  })
})

describe('splitBayer / averageRaws', () => {
  function makeRaw(w: number, h: number, fill: (x: number, y: number) => number): { width: number; height: number; bitDepth: number; blackLevel: number; whiteLevel: number; bayer: string; data: Uint16Array; meta: null } {
    const data = new Uint16Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = 64 + fill(x, y)
    return { width: w, height: h, bitDepth: 10, blackLevel: 64, whiteLevel: 1023, bayer: 'BGGR', data, meta: null }
  }

  it('splits the mosaic into four colour planes with black level removed', () => {
    const raw = makeRaw(4, 4, () => 100)
    const p = splitBayer(raw)
    expect(p.width).toBe(2); expect(p.height).toBe(2)
    expect(Array.from(p.r)).toEqual([100, 100, 100, 100])
    expect(Array.from(p.b)).toEqual([100, 100, 100, 100])
  })

  it('averages several identical raw frames, keeping a frame count in the meta', () => {
    const a = makeRaw(8, 8, (x, y) => (x + y) * 4)
    const b = { ...a, data: a.data.slice() }
    const { raw, shifts, used } = averageRaws([a, b])
    expect(used).toBe(2)
    expect(shifts[0]).toEqual({ dx: 0, dy: 0 })
    expect(Array.from(raw.data)).toEqual(Array.from(a.data))
  })

  it('drops a frame shifted further than maxShiftPx', () => {
    const w = 64, h = 64
    // pseudo-random, non-periodic content so coarse phase correlation has a clean single peak
    const noise = (x: number, y: number) => Math.floor(511 * (0.5 + 0.5 * Math.sin(x * 12.9898 + y * 78.233) * Math.sin(x * 4.14 + y * 2.71)))
    const a = makeRaw(w, h, noise)
    // shift b by 20 px in x (measurable within the search window, but beyond a maxShiftPx of 16)
    const shift = 20
    const bData = new Uint16Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const sx = x - shift
      bData[y * w + x] = 64 + (sx >= 0 && sx < w ? noise(sx, y) : 0)
    }
    const b = { ...a, data: bData }
    const { used, shifts } = averageRaws([a, b], 16)
    expect(Math.abs(shifts[1].dx)).toBeGreaterThan(16)
    expect(used).toBe(1)
  })
})
