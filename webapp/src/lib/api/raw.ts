/** Fetches for the device's raw and bracket endpoints (`device.md` handoff): `/raw.bin`, `/flat.bin`
 *  (both OFRW v2 records) and `/bracket.bin` (an OFBK container). Kept separate from `api/snapshot.ts`
 *  because these return `ArrayBuffer`, not a `Blob`, and the caller almost always parses them with
 *  `algo/raw.ts` (`parseRaw`/`parseBracket`) straight away. */

import { device } from '../store/device.svelte'

export interface RawFetchOptions {
  /** average this many frames in one mode switch (device caps at 8); omit/1 = the plain v1 shape */
  frames?: number
  /** SBGGR10_CSI2P packed transfer (10.1 MB instead of 16.2 MB); 400 on the device if frames > 1 */
  packed?: boolean
}

/** `GET /raw.bin` (or `/flat.bin` with `flat: true`), returning the raw ArrayBuffer for `parseRaw`. */
export async function fetchRawBuffer(o: RawFetchOptions & { flat?: boolean } = {}): Promise<ArrayBuffer> {
  const qs = new URLSearchParams()
  if (o.frames && o.frames > 1) qs.set('frames', String(o.frames))
  if (o.packed) qs.set('packed', '1')
  qs.set('t', String(Date.now()))
  const res = await fetch(device.url(o.flat ? '/flat.bin' : '/raw.bin') + '?' + qs.toString(), { cache: 'no-store' })
  if (!res.ok) throw new Error(`${o.flat ? 'flat-field' : 'raw'} capture failed: ${res.status}`)
  return res.arrayBuffer()
}

/** `GET /raw.bin` with progress callbacks as bytes arrive (the transfer is the slow part, 10-16 MB). */
export async function fetchRawBufferWithProgress(say: (msg: string) => void, o: RawFetchOptions & { flat?: boolean; label?: string } = {}): Promise<ArrayBuffer> {
  const label = o.label ?? (o.flat ? 'flat field' : 'RAW')
  const qs = new URLSearchParams()
  if (o.frames && o.frames > 1) qs.set('frames', String(o.frames))
  if (o.packed) qs.set('packed', '1')
  qs.set('t', String(Date.now()))
  say(`${label}: capturing the sensor data${o.frames && o.frames > 1 ? ` (${o.frames} frames averaged)` : ' (10-bit, 16 MB)'}, ~${o.packed ? 10 : 15}s over WiFi…`)
  const res = await fetch(device.url(o.flat ? '/flat.bin' : '/raw.bin') + '?' + qs.toString(), { cache: 'no-store' })
  if (!res.ok) throw new Error(`${label} capture failed: ${res.status}`)
  const total = +(res.headers.get('content-length') ?? 0)
  const reader = res.body!.getReader(); const parts: Uint8Array[] = []; let got = 0
  for (;;) {
    const { done, value } = await reader.read(); if (done) break
    parts.push(value); got += value.length
    if (total) say(`${label}: downloading ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`)
  }
  const buf = new Uint8Array(got); let o2 = 0; for (const p of parts) { buf.set(p, o2); o2 += p.length }
  return buf.buffer
}

export interface BracketFetchOptions {
  /** exposure-time multipliers relative to the current metered exposure, 1..8 values, each 0.01..100 */
  factors: number[]
  /** OFRW records instead of JPEGs (for true HDR from linear RAW; see `algo/hdr.ts`) */
  raw?: boolean
}

/** `GET /bracket.bin?factors=..[&raw=1]`: one container with a still (JPEG or OFRW) per factor. The
 *  `X-Frame` summary (`{count, factors, base_exposure, exposures, gain, colour_gains, raw, frames}`)
 *  is parsed from the response header so a caller does not need the bytes just to show progress. */
export async function fetchBracketBuffer(o: BracketFetchOptions): Promise<{ buffer: ArrayBuffer; summary: Record<string, unknown> | null }> {
  const qs = new URLSearchParams({ factors: o.factors.join(',') })
  if (o.raw) qs.set('raw', '1')
  qs.set('t', String(Date.now()))
  const res = await fetch(device.url('/bracket.bin') + '?' + qs.toString(), { cache: 'no-store' })
  if (!res.ok) throw new Error(`exposure bracket failed: ${res.status}`)
  const buffer = await res.arrayBuffer()
  let summary: Record<string, unknown> | null = null
  const h = res.headers.get('X-Frame')
  if (h) { try { summary = JSON.parse(h) } catch { /* ignore malformed header */ } }
  return { buffer, summary }
}
