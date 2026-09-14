/** Reads `/stream.mjpg` (multipart/x-mixed-replace) directly with `fetch` + a `ReadableStream`,
 *  instead of relying on the browser's own multipart handling inside an `<img>` tag. An `<img src>`
 *  gives no signal for exactly when a new part has finished decoding into visible pixels (it lags
 *  its own `X-Frame` metadata by a few frames, see `services/liveStack.svelte.ts`'s comment on the
 *  same lag) and can be sampled mid-decode by `drawImage`, tearing the picture — the actual cause of
 *  the video recorder's shakiness/glitches (CAPTURE_AUDIT.md D8). This reader instead delivers each
 *  JPEG part exactly once, fully decoded (`createImageBitmap`, which never yields a partial image),
 *  paired with the device's own per-frame metadata parsed from the part's headers (`web.py`'s
 *  `X-Frame` trailer: `{seq, ts, t, exposure, gain, ...}` — see `algo/types.ts` `FrameMeta`).
 *
 *  Framing: the device writes `--{boundary}\r\nContent-Type: image/jpeg\r\nContent-Length: N\r\n
 *  X-Seq: ..\r\nX-Timestamp: ..\r\nX-Frame: {json}\r\n\r\n<N bytes of JPEG>\r\n` per part, forever,
 *  and the boundary token in the `Content-Type` response header is trusted (never hard-coded). The
 *  parser reads by `Content-Length` when present (it always is, from this device) and falls back to
 *  searching for the next boundary otherwise (a different producer without a length). */
import type { FrameMeta } from './types'

export interface MjpegFrame {
  /** Fully decoded frame. Caller must `close()` it once done (it is not reused). */
  bitmap: ImageBitmap
  /** `meta.ts ?? meta.t ?? null`: the best timestamp available for this part. */
  ts: number | null
  seq: number
  meta: FrameMeta | null
  /** JPEG byte size of this part, for diagnostics/bitrate estimates. */
  size: number
}

export type MjpegFrameHandler = (frame: MjpegFrame) => void
export type MjpegErrorHandler = (err: Error) => void

const enc = new TextEncoder()
const dec = new TextDecoder()

function findBytes(hay: Uint8Array, needle: Uint8Array, from: number): number {
  const end = hay.length - needle.length
  outer: for (let i = Math.max(0, from); i <= end; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return i
  }
  return -1
}

function parseHeaders(text: string): { contentLength: number | null; meta: FrameMeta | null } {
  const lenM = /content-length:\s*(\d+)/i.exec(text)
  const frameM = /x-frame:\s*(\{.*\})/i.exec(text)
  let meta: FrameMeta | null = null
  if (frameM) { try { meta = JSON.parse(frameM[1]) as FrameMeta } catch { meta = null } }
  return { contentLength: lenM ? parseInt(lenM[1], 10) : null, meta }
}

/** Reads one MJPEG stream until `stop()` is called or the connection ends/errors (reported via
 *  `onError`, never thrown — reconnecting is the caller's decision). `start()` resolves once the
 *  read loop has ended, so `await`ing it means "the stream is no longer being read". */
export class MjpegStream {
  private closed = false
  private controller: AbortController | null = null

  async start(url: string, onFrame: MjpegFrameHandler, onError?: MjpegErrorHandler): Promise<void> {
    this.closed = false
    this.controller = new AbortController()
    try {
      const res = await fetch(url, { signal: this.controller.signal, cache: 'no-store' })
      if (!res.ok || !res.body) throw new Error(`stream fetch failed: ${res.status}`)
      const ct = res.headers.get('content-type') || ''
      const bm = /boundary=([^;,\s]+)/i.exec(ct)
      if (!bm) throw new Error('no multipart boundary in the stream response Content-Type')
      const boundary = enc.encode(`--${bm[1]}\r\n`)
      const headerSep = enc.encode('\r\n\r\n')
      const reader = res.body.getReader()
      let buf = new Uint8Array(0)
      let pos = 0

      while (!this.closed) {
        for (;;) {
          const bStart = findBytes(buf, boundary, pos)
          if (bStart < 0) break
          const headersStart = bStart + boundary.length
          const hEnd = findBytes(buf, headerSep, headersStart)
          if (hEnd < 0) break
          const headerText = dec.decode(buf.subarray(headersStart, hEnd))
          const { contentLength, meta } = parseHeaders(headerText)
          const bodyStart = hEnd + headerSep.length
          let bodyEnd: number
          if (contentLength != null) {
            bodyEnd = bodyStart + contentLength
            if (buf.length < bodyEnd) break   // wait for more data
          } else {
            const nextB = findBytes(buf, boundary, bodyStart)
            if (nextB < 0) break              // wait for more data
            bodyEnd = nextB - 2                // trailing \r\n before the next boundary
          }
          const body = buf.slice(bodyStart, bodyEnd)
          pos = bodyEnd
          if (body.length) {
            try {
              const bitmap = await createImageBitmap(new Blob([body], { type: 'image/jpeg' }))
              onFrame({ bitmap, ts: meta?.ts ?? meta?.t ?? null, seq: meta?.seq ?? -1, meta, size: body.length })
            } catch { /* a corrupt/truncated part: skip it, keep the connection open */ }
          }
        }
        if (pos > 0) { buf = buf.slice(pos); pos = 0 }
        const { done, value } = await reader.read()
        if (done) break
        if (value && value.length) {
          const next = new Uint8Array(buf.length + value.length)
          next.set(buf); next.set(value, buf.length)
          buf = next
        }
      }
      try { await reader.cancel() } catch { /* already closed */ }
    } catch (e) {
      if (!this.closed) onError?.(e as Error)
    } finally {
      this.controller = null
    }
  }

  /** Abort the fetch and stop delivering frames. Idempotent, safe to call before `start()` resolves
   *  (CLAUDE.md: never leave an MJPEG connection open). */
  stop(): void {
    this.closed = true
    this.controller?.abort()
  }
}
