import { describe, it, expect } from 'vitest'
import { parseRecordPackets, avcCodecString, RECORD_HEADER_SIZE, type RecordPacket } from '../recordStream'

function frame(payload: number[], ts: number, key: boolean): Uint8Array {
  const out = new Uint8Array(RECORD_HEADER_SIZE + payload.length)
  const v = new DataView(out.buffer)
  out.set([0x4f, 0x46, 0x56, 0x50])
  v.setUint32(4, payload.length, true)
  v.setBigInt64(8, BigInt(ts), true)
  v.setUint32(16, key ? 1 : 0, true)
  out.set(payload, RECORD_HEADER_SIZE)
  return out
}

describe('parseRecordPackets', () => {
  it('parses whole packets and leaves a partial one for the next chunk', () => {
    const a = frame([0, 0, 0, 1, 0x67, 1, 2], 1000, true)
    const b = frame([0, 0, 0, 1, 0x41, 9], -1, false)
    const buf = new Uint8Array(a.length + b.length)
    buf.set(a); buf.set(b, a.length)
    const got: RecordPacket[] = []
    const used = parseRecordPackets(buf, a.length + b.length - 2, (p) => got.push(p))
    expect(used).toBe(a.length)
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ ts: 1000, key: true })
    expect([...got[0].data]).toEqual([0, 0, 0, 1, 0x67, 1, 2])
    const rest = buf.slice(used)
    expect(parseRecordPackets(rest, rest.length, (p) => got.push(p))).toBe(b.length)
    expect(got[1]).toMatchObject({ ts: null, key: false })
  })

  it('refuses a stream that lost sync', () => {
    const bad = frame([1], 0, true); bad[0] = 0
    expect(() => parseRecordPackets(bad, bad.length, () => {})).toThrow(/sync/)
  })
})

describe('avcCodecString', () => {
  it('reads profile, constraints and level from the SPS', () => {
    // AUD, then SPS (High profile 100, constraints 0, level 4.1 = 0x29)
    const au = new Uint8Array([0, 0, 0, 1, 0x09, 0xf0, 0, 0, 1, 0x67, 0x64, 0x00, 0x29, 0xac])
    expect(avcCodecString(au)).toBe('avc1.640029')
  })
  it('is null without an SPS', () => {
    expect(avcCodecString(new Uint8Array([0, 0, 0, 1, 0x41, 1, 2, 3]))).toBeNull()
  })
})
