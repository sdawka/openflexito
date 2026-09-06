/** Parse the device's /raw.bin (header + little-endian uint16 Bayer mosaic) and basic stats. */

export interface RawImage {
  width: number
  height: number
  bitDepth: number
  blackLevel: number
  bayer: string           // e.g. 'BGGR' (order of the 2x2 cell, row-major)
  data: Uint16Array
}

export const RAW_MAGIC = 'OFRW'
const HEADER_SIZE = 4 + 4 + 4 + 2 + 2 + 8

export function parseRaw(buf: ArrayBuffer): RawImage {
  const dv = new DataView(buf)
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3))
  if (magic !== RAW_MAGIC) throw new Error('not an openflexito raw capture')
  const width = dv.getUint32(4, true), height = dv.getUint32(8, true)
  const bitDepth = dv.getUint16(12, true), blackLevel = dv.getUint16(14, true)
  let bayer = ''
  for (let i = 0; i < 8; i++) { const c = dv.getUint8(16 + i); if (c) bayer += String.fromCharCode(c) }
  const expected = width * height * 2
  if (buf.byteLength < HEADER_SIZE + expected) throw new Error('raw capture truncated')
  // copy so the array is aligned regardless of header size
  const data = new Uint16Array(buf.slice(HEADER_SIZE, HEADER_SIZE + expected))
  return { width, height, bitDepth, blackLevel, bayer: bayer || 'BGGR', data }
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
