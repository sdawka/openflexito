/** Minimal 16-bit RGB PNG encoder (browsers cannot write 16-bit images through canvas).
 *  Filter type 0 on every row, zlib via CompressionStream('deflate'). */

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

/** rgb16: interleaved RGB, 16 bits per sample, row-major. */
export async function encodePng16(rgb16: Uint16Array, width: number, height: number): Promise<Blob> {
  const rowBytes = width * 6
  const raw = new Uint8Array((rowBytes + 1) * height)
  for (let y = 0; y < height; y++) {
    const r = y * (rowBytes + 1); raw[r] = 0
    let o = r + 1, s = y * width * 3
    for (let x = 0; x < width * 3; x++, s++) { const v = rgb16[s]; raw[o++] = v >> 8; raw[o++] = v & 0xff }
  }
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer)
  dv.setUint32(0, width); dv.setUint32(4, height); ihdr[8] = 16; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const idat = await deflate(raw)
  const sig = new Uint8Array(new ArrayBuffer(8)); sig.set([137, 80, 78, 71, 13, 10, 26, 10])
  return new Blob([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))], { type: 'image/png' })
}
