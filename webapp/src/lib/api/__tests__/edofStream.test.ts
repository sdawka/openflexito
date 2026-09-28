import { describe, it, expect, vi, afterEach } from 'vitest'
import { parseEdofRecords, EdofStream, EDOF_HEADER_SIZE, type EdofRecord } from '../edofStream'

function record(type: number, payload: Uint8Array | object, ts = -1, seq = 0): Uint8Array {
  const body = payload instanceof Uint8Array ? payload : new TextEncoder().encode(JSON.stringify(payload))
  const out = new Uint8Array(EDOF_HEADER_SIZE + body.length)
  const v = new DataView(out.buffer)
  out.set([0x4f, 0x46, 0x45, 0x53], 0)
  out[4] = type
  v.setUint32(8, body.length, true)
  v.setBigInt64(12, BigInt(ts), true)
  v.setUint32(20, seq, true)
  out.set(body, EDOF_HEADER_SIZE)
  return out
}

const concat = (...a: Uint8Array[]) => {
  const out = new Uint8Array(a.reduce((s, x) => s + x.length, 0))
  let o = 0
  for (const x of a) { out.set(x, o); o += x.length }
  return out
}

const leg = { type: 'leg', leg: 3, t_cmd: 100, t_ack: 120, steps: 400, step_us: 250, z0: 10, dropped: 0 }
const legEnd = { type: 'leg_end', leg: 3, t_end: 900, z1: 410, cancelled: false, dropped: 1 }
const stream = () => concat(
  record(2, leg),
  record(1, new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9]), 150, 7),
  record(3, legEnd),
  record(1, new Uint8Array([9]), -1, 8),
  record(4, { error: 'stage fault' }),
)

describe('parseEdofRecords', () => {
  it('parses all four record types', () => {
    const buf = stream()
    const got: EdofRecord[] = []
    expect(parseEdofRecords(buf, buf.length, (r) => got.push(r))).toBe(buf.length)
    expect(got.map((r) => r.kind)).toEqual(['leg', 'frame', 'leg_end', 'frame', 'status'])
    expect(got[0]).toEqual({ kind: 'leg', leg })
    expect(got[1]).toMatchObject({ kind: 'frame', ts: 150, seq: 7 })
    expect([...(got[1] as { jpeg: Uint8Array }).jpeg]).toEqual([0xff, 0xd8, 1, 2, 0xff, 0xd9])
    expect(got[2]).toEqual({ kind: 'leg_end', end: legEnd })
    expect(got[3]).toMatchObject({ kind: 'frame', ts: null, seq: 8 })
    expect(got[4]).toEqual({ kind: 'status', status: { error: 'stage fault' } })
  })

  it('frame payloads are copies with their own buffer', () => {
    const buf = stream()
    const got: EdofRecord[] = []
    parseEdofRecords(buf, buf.length, (r) => got.push(r))
    const jpeg = (got[1] as { jpeg: Uint8Array }).jpeg
    expect(jpeg.buffer).not.toBe(buf.buffer)
    expect(jpeg.byteOffset).toBe(0)
    expect(jpeg.buffer.byteLength).toBe(jpeg.length)
    buf.fill(0)
    expect(jpeg[0]).toBe(0xff)
  })

  it('leaves partial records for the next chunk, at every split point', () => {
    const all = stream()
    const want: EdofRecord[] = []
    parseEdofRecords(all, all.length, (r) => want.push(r))
    for (let cut = 0; cut <= all.length; cut++) {
      const got: EdofRecord[] = []
      const buf = new Uint8Array(all.length)
      buf.set(all.subarray(0, cut))
      let len = cut
      const used = parseEdofRecords(buf, len, (r) => got.push(r))
      buf.copyWithin(0, used, len); len -= used
      buf.set(all.subarray(cut), len); len += all.length - cut
      expect(parseEdofRecords(buf, len, (r) => got.push(r))).toBe(len)
      expect(got).toEqual(want)
    }
  })

  it('refuses a stream that lost sync', () => {
    const bad = record(1, new Uint8Array([1])); bad[1] = 0
    expect(() => parseEdofRecords(bad, bad.length, () => {})).toThrow(/sync/)
  })
})

describe('EdofStream', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('reads the header and delivers records across arbitrary chunks', async () => {
    const all = stream()
    const chunks = [all.subarray(0, 5), all.subarray(5, 30), all.subarray(30, 31), all.subarray(31)]
    const body = new ReadableStream<Uint8Array>({ start(c) { for (const ch of chunks) c.enqueue(ch.slice()); c.close() } })
    const info = { codec: 'jpeg', mode: '640x480', width: 640, height: 480, fps: 200, bitrate: 0, sensor_size: [640, 480], started: 1, steps: 400, step_us: 250, backlash_z: 200 }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { headers: { 'X-Edof': JSON.stringify(info) } })))
    const got: EdofRecord[] = []
    const errors: Error[] = []
    const s = new EdofStream()
    const r = await s.start('/edof.bin', (x) => got.push(x), (e) => errors.push(e))
    expect(r.info).toEqual(info)
    await r.done
    expect(errors).toEqual([])
    expect(got.map((x) => x.kind)).toEqual(['leg', 'frame', 'leg_end', 'frame', 'status'])
  })

  it('reports a refused request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('camera busy', { status: 409 })))
    await expect(new EdofStream().start('/edof.bin', () => {}, () => {})).rejects.toThrow(/camera busy/)
  })
})
