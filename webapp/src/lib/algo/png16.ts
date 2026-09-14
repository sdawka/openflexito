/** Minimal 16-bit RGB PNG encoder (browsers cannot write 16-bit images through canvas), with the
 *  standard per-row adaptive filter choice (None/Sub/Up/Average/Paeth by minimum sum of absolute
 *  residuals, as libpng does) so smooth image data deflates roughly twice as small as unfiltered rows.
 *  zlib via CompressionStream('deflate'). `decodePng16` reads the files back (tests, gallery viewers
 *  that need the 16-bit samples). */

let crcTable: Uint32Array | null = null
function crc32(bytes: Uint8Array, seed = 0xffffffff): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0 }
  }
  let c = seed
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return c >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(12 + data.length)), dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  dv.setUint32(8 + data.length, (crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0)  // CRC over type + data
  return out
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate')
  const writer = cs.writable.getWriter()
  void writer.write(data as Uint8Array<ArrayBuffer>); void writer.close()
  return new Uint8Array(await new Response(cs.readable).arrayBuffer())
}
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate')
  const writer = ds.writable.getWriter()
  void writer.write(data as Uint8Array<ArrayBuffer>); void writer.close()
  return new Uint8Array(await new Response(ds.readable).arrayBuffer())
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

export type PngFilter = 'none' | 'adaptive' | 'up' | 'paeth'

/** Filter one row (bytes) against the previous row; bpp = bytes per pixel. Returns the filtered bytes
 *  (without the filter-type byte) for the given filter type 0..4. */
function filterRow(cur: Uint8Array, prev: Uint8Array | null, bpp: number, type: number, out: Uint8Array): void {
  const n = cur.length
  for (let i = 0; i < n; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0, b = prev ? prev[i] : 0, c = prev && i >= bpp ? prev[i - bpp] : 0
    let pred = 0
    if (type === 1) pred = a
    else if (type === 2) pred = b
    else if (type === 3) pred = (a + b) >> 1
    else if (type === 4) pred = paeth(a, b, c)
    out[i] = (cur[i] - pred) & 0xff
  }
}
function residualCost(f: Uint8Array): number {
  let s = 0
  for (let i = 0; i < f.length; i++) { const v = f[i]; s += v < 128 ? v : 256 - v }
  return s
}

/** rgb16: interleaved RGB, 16 bits per sample, row-major. */
export async function encodePng16(rgb16: Uint16Array, width: number, height: number, filter: PngFilter = 'adaptive'): Promise<Blob> {
  const rowBytes = width * 6, bpp = 6
  const raw = new Uint8Array((rowBytes + 1) * height)
  const rows = [new Uint8Array(rowBytes), new Uint8Array(rowBytes)]
  const scratch = new Uint8Array(rowBytes), best = new Uint8Array(rowBytes)
  const candidates = filter === 'none' ? [0] : filter === 'up' ? [2] : filter === 'paeth' ? [4] : [0, 1, 2, 3, 4]
  for (let y = 0; y < height; y++) {
    const cur = rows[y & 1], prev = y ? rows[(y & 1) ^ 1] : null
    for (let x = 0, s = y * width * 3, o = 0; x < width * 3; x++, s++) { const v = rgb16[s]; cur[o++] = v >> 8; cur[o++] = v & 0xff }
    let bestType = candidates[0], bestCost = Infinity
    for (const t of candidates) {
      if (candidates.length === 1) { filterRow(cur, prev, bpp, t, best); break }
      filterRow(cur, prev, bpp, t, scratch)
      const cost = residualCost(scratch)
      if (cost < bestCost) { bestCost = cost; bestType = t; best.set(scratch) }
    }
    const r = y * (rowBytes + 1)
    raw[r] = bestType
    raw.set(best, r + 1)
  }
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer)
  dv.setUint32(0, width); dv.setUint32(4, height); ihdr[8] = 16; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const idat = await deflate(raw)
  const sig = new Uint8Array(new ArrayBuffer(8)); sig.set([137, 80, 78, 71, 13, 10, 26, 10])
  return new Blob([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))], { type: 'image/png' })
}

/** Decode a 16-bit RGB PNG (as written above, or any non-interlaced 16-bit RGB PNG). */
export async function decodePng16(bytes: Uint8Array): Promise<{ data: Uint16Array; width: number; height: number }> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes[0] !== 137 || bytes[1] !== 80) throw new Error('not a PNG')
  let p = 8, width = 0, height = 0
  const idats: Uint8Array[] = []
  while (p < bytes.length) {
    const len = dv.getUint32(p), type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7])
    const data = bytes.subarray(p + 8, p + 8 + len)
    if (type === 'IHDR') {
      width = dv.getUint32(p + 8); height = dv.getUint32(p + 12)
      if (bytes[p + 16] !== 16 || bytes[p + 17] !== 2 || bytes[p + 20] !== 0) throw new Error('only 16-bit RGB non-interlaced PNGs are supported')
    } else if (type === 'IDAT') idats.push(data)
    else if (type === 'IEND') break
    p += 12 + len
  }
  const z = new Uint8Array(idats.reduce((s, d) => s + d.length, 0)); let o = 0; for (const d of idats) { z.set(d, o); o += d.length }
  const raw = await inflate(z)
  const rowBytes = width * 6, bpp = 6
  const out = new Uint16Array(width * height * 3)
  let prev: Uint8Array | null = null
  for (let y = 0; y < height; y++) {
    const r = y * (rowBytes + 1), type = raw[r]
    const cur = raw.subarray(r + 1, r + 1 + rowBytes)
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev ? prev[i] : 0, c = prev && i >= bpp ? prev[i - bpp] : 0
      let pred = 0
      if (type === 1) pred = a; else if (type === 2) pred = b; else if (type === 3) pred = (a + b) >> 1; else if (type === 4) pred = paeth(a, b, c)
      cur[i] = (cur[i] + pred) & 0xff
    }
    for (let x = 0, s = y * width * 3; x < width * 3; x++, s++) out[s] = (cur[2 * x] << 8) | cur[2 * x + 1]
    prev = cur
  }
  return { data: out, width, height }
}
