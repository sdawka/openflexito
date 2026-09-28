/** Reads `/edof.bin` (device live extended depth of field): while this request is open the camera
 *  runs a fast sensor mode and the stage sweeps z back and forth continuously in "legs". The body is
 *  a sequence of records, each a little-endian 24-byte header
 *  `OFES | u8 type | 3 pad | u32 payload length | i64 time ns (-1 unknown) | u32 frame seq`
 *  followed by the payload: 1 = JPEG frame (time = SensorTimestamp), 2 = leg start JSON,
 *  3 = leg end JSON, 4 = status JSON. `X-Edof` describes the stream. Frames exposed during a leg can
 *  arrive after that leg's end record (the encoder lags), so group them by time, not arrival order
 *  (`algo/sweepFuse.ts#LegGrouper`). Aborting the fetch ends the sweep on the device. */

export interface EdofInfo {
  codec: 'jpeg'
  mode: string
  width: number
  height: number
  fps: number
  bitrate: number
  /** sensor mode the frames were read out in */
  sensor_size: [number, number]
  /** CLOCK_BOOTTIME ns when the stream started */
  started: number
  /** z steps per leg (0: camera only, no sweep) */
  steps: number
  /** step delay, µs */
  step_us: number
  /** steps after each reversal during which the stage does not move */
  backlash_z: number
}

export interface EdofLeg {
  type: 'leg'
  leg: number
  /** ns, when the move was commanded / acknowledged by the board */
  t_cmd: number
  t_ack: number
  /** signed z steps of this leg */
  steps: number
  step_us: number
  z0: number
  /** frames the device dropped so far */
  dropped: number
}

export interface EdofLegEnd {
  type: 'leg_end'
  leg: number
  t_end: number
  z1: number
  cancelled: boolean
  dropped: number
}

/** `sweeps_stopped`: stage.stop or standby ended the sweeps (frames keep coming), with the leg and dropped-frame counts */
export interface EdofStatus { error?: string; sweeps_stopped?: boolean; legs?: number; dropped?: number }

export type EdofRecord =
  | { kind: 'frame'; jpeg: Uint8Array; ts: number | null; seq: number }
  | { kind: 'leg'; leg: EdofLeg }
  | { kind: 'leg_end'; end: EdofLegEnd }
  | { kind: 'status'; status: EdofStatus }

const MAGIC = [0x4f, 0x46, 0x45, 0x53] // "OFES"
export const EDOF_HEADER_SIZE = 24
export const EDOF_FRAME = 1, EDOF_LEG = 2, EDOF_LEG_END = 3, EDOF_STATUS = 4

const utf8 = new TextDecoder()

/** Parse as many complete records as `buf[0..len)` holds; returns the number of bytes consumed.
 *  Frames are copied out (safe to transfer); unknown record types are skipped. Throws on a bad
 *  magic (a desynchronised stream cannot be recovered). */
export function parseEdofRecords(buf: Uint8Array, len: number, onRecord: (r: EdofRecord) => void): number {
  const view = new DataView(buf.buffer, buf.byteOffset, len)
  let off = 0
  while (len - off >= EDOF_HEADER_SIZE) {
    for (let i = 0; i < 4; i++) if (buf[off + i] !== MAGIC[i]) throw new Error('EDOF stream out of sync')
    const type = buf[off + 4]
    const n = view.getUint32(off + 8, true)
    if (len - off < EDOF_HEADER_SIZE + n) break
    const ts = Number(view.getBigInt64(off + 12, true))
    const seq = view.getUint32(off + 20, true)
    const start = off + EDOF_HEADER_SIZE
    off = start + n
    if (type === EDOF_FRAME) { onRecord({ kind: 'frame', jpeg: buf.slice(start, start + n), ts: ts < 0 ? null : ts, seq }); continue }
    if (type < EDOF_LEG || type > EDOF_STATUS) continue
    const json = JSON.parse(utf8.decode(buf.subarray(start, start + n)))
    if (type === EDOF_LEG) onRecord({ kind: 'leg', leg: json as EdofLeg })
    else if (type === EDOF_LEG_END) onRecord({ kind: 'leg_end', end: json as EdofLegEnd })
    else onRecord({ kind: 'status', status: json as EdofStatus })
  }
  return off
}

export class EdofStream {
  private abort: AbortController | null = null

  /** Open the stream; resolves with its description once the device has switched modes.
   *  `onRecord` then fires for every record; `done` settles when the stream ends. */
  async start(url: string, onRecord: (r: EdofRecord) => void, onError: (e: Error) => void): Promise<{ info: EdofInfo; done: Promise<void> }> {
    this.abort = new AbortController()
    const res = await fetch(url, { signal: this.abort.signal, cache: 'no-store' })
    if (!res.ok || !res.body) throw new Error((await res.text().catch(() => '')) || `EDOF refused (${res.status})`)
    const info = JSON.parse(res.headers.get('X-Edof') ?? 'null') as EdofInfo | null
    if (!info) throw new Error('the device did not describe the EDOF stream')
    const reader = res.body.getReader()
    const done = (async () => {
      // amortised growable buffer: only the unparsed tail (at most one partial record) is moved
      // after each read, and the buffer doubles when a chunk does not fit
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
          const used = parseEdofRecords(buf, len, onRecord)
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
