/** Reads `/record.h264` (device `web.py#record`): while this request is open the camera records in
 *  its binned 1640×1232 sensor mode through the Pi's hardware H.264 encoder, and every access unit
 *  arrives framed as `OFVP | u32 length | i64 timestamp ns (-1 unknown) | u32 flags (bit 0 keyframe)`
 *  (little-endian, 20 bytes) followed by the Annex B payload. `X-Record` describes the stream.
 *  Aborting the fetch ends the recording on the device. */

export interface RecordInfo {
  codec: 'h264'
  width: number
  height: number
  fps: number
  bitrate: number
  /** frames between keyframes */
  iperiod: number
  /** sensor mode the frames were read out in (1640×1232 = 2×2 binned full field) */
  sensor_size: [number, number]
}

export interface RecordPacket {
  /** Annex B access unit (start codes included) */
  data: Uint8Array
  /** device frame time, ns on CLOCK_BOOTTIME, or null */
  ts: number | null
  key: boolean
}

const MAGIC = [0x4f, 0x46, 0x56, 0x50] // "OFVP"
export const RECORD_HEADER_SIZE = 20

/** Parse as many complete packets as `buf[0..len)` holds; returns the number of bytes consumed.
 *  Throws on a bad magic (a desynchronised stream cannot be recovered). */
export function parseRecordPackets(buf: Uint8Array, len: number, onPacket: (p: RecordPacket) => void): number {
  const view = new DataView(buf.buffer, buf.byteOffset, len)
  let off = 0
  while (len - off >= RECORD_HEADER_SIZE) {
    for (let i = 0; i < 4; i++) if (buf[off + i] !== MAGIC[i]) throw new Error('recording stream out of sync')
    const n = view.getUint32(off + 4, true)
    if (len - off < RECORD_HEADER_SIZE + n) break
    const ts = Number(view.getBigInt64(off + 8, true))
    const flags = view.getUint32(off + 16, true)
    const start = off + RECORD_HEADER_SIZE
    onPacket({ data: buf.slice(start, start + n), ts: ts < 0 ? null : ts, key: (flags & 1) === 1 })
    off = start + n
  }
  return off
}

/** RFC 6381 codec string (`avc1.PPCCLL`) from the SPS in an Annex B access unit, or null. */
export function avcCodecString(annexB: Uint8Array): string | null {
  for (let i = 0; i + 4 < annexB.length; i++) {
    if (annexB[i] !== 0 || annexB[i + 1] !== 0) continue
    const sc = annexB[i + 2] === 1 ? 3 : annexB[i + 2] === 0 && annexB[i + 3] === 1 ? 4 : 0
    if (!sc) continue
    const nal = i + sc
    if ((annexB[nal] & 0x1f) === 7 && nal + 3 < annexB.length) {
      const hex = (b: number) => b.toString(16).padStart(2, '0')
      return `avc1.${hex(annexB[nal + 1])}${hex(annexB[nal + 2])}${hex(annexB[nal + 3])}`
    }
    i = nal
  }
  return null
}

export class RecordStream {
  private abort: AbortController | null = null

  /** Open the recording; resolves with the stream description once the device has switched modes.
   *  `onPacket` then fires for every access unit; `done` settles when the stream ends. */
  async start(url: string, onPacket: (p: RecordPacket) => void, onError: (e: Error) => void): Promise<{ info: RecordInfo; done: Promise<void> }> {
    this.abort = new AbortController()
    const res = await fetch(url, { signal: this.abort.signal, cache: 'no-store' })
    if (!res.ok || !res.body) throw new Error((await res.text().catch(() => '')) || `recording refused (${res.status})`)
    const info = JSON.parse(res.headers.get('X-Record') ?? 'null') as RecordInfo | null
    if (!info) throw new Error('the device did not describe the recording')
    const reader = res.body.getReader()
    const done = (async () => {
      let buf = new Uint8Array(1 << 20)
      let len = 0
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          if (len + value.length > buf.length) {
            const next = new Uint8Array(Math.max(buf.length * 2, len + value.length))
            next.set(buf.subarray(0, len)); buf = next
          }
          buf.set(value, len); len += value.length
          const used = parseRecordPackets(buf, len, onPacket)
          if (used) { buf.copyWithin(0, used, len); len -= used }
        }
      } catch (e) {
        if ((e as Error).name !== 'AbortError') onError(e as Error)
      }
    })()
    return { info, done }
  }

  stop(): void {
    this.abort?.abort()
    this.abort = null
  }
}
