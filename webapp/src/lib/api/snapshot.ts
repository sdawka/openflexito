/** The one place that fetches `/snapshot.jpg`: the latest stream frame (fast, stream resolution) or a
 *  full-resolution still (`full`, ~1.3 s on the Pi: the camera switches configuration and freezes the
 *  live auto-exposure/white-balance values for the capture). A still now carries its *own* request
 *  metadata in the `X-Frame` header (device `device.md` §1: `switch_mode` + `capture_request`, not the
 *  last stream frame's), so `fetchSnapshotWithMeta` parses and returns it alongside the blob. */
import { device } from '../store/device.svelte'
import type { FrameMeta } from '../algo/types'

/** Shape of a still's `X-Frame` header: `FrameMeta` plus the extras a still (or a raw/bracket item)
 *  carries. `matched: false` means the encoder timestamp was not found in the metadata ring and
 *  `ts`/`exposure` belong to the newest frame instead (device.md §4) — treat such frames as untimed. */
export interface StillFrameMeta extends Omit<FrameMeta, 'size'> {
  still?: boolean
  matched?: boolean
  width?: number
  height?: number
  size?: number
  colour_temperature?: number | null
  frame_duration?: number | null
}

function buildUrl(path: string, full?: boolean): string {
  return device.url(path) + (full ? '?full=1&' : '?') + 't=' + Date.now()
}

function parseXFrame(res: Response): StillFrameMeta | null {
  const h = res.headers.get('X-Frame')
  if (!h) return null
  try { return JSON.parse(h) as StillFrameMeta } catch { return null }
}

export async function fetchSnapshot(o: { full?: boolean } = {}): Promise<Blob> {
  const res = await fetch(buildUrl('/snapshot.jpg', o.full), { cache: 'no-store' })
  if (!res.ok) throw new Error(`snapshot failed: ${res.status}`)
  return res.blob()
}

/** Like `fetchSnapshot`, but also returns the parsed `X-Frame` metadata (null if absent/malformed). */
export async function fetchSnapshotWithMeta(o: { full?: boolean } = {}): Promise<{ blob: Blob; meta: StillFrameMeta | null }> {
  const res = await fetch(buildUrl('/snapshot.jpg', o.full), { cache: 'no-store' })
  if (!res.ok) throw new Error(`snapshot failed: ${res.status}`)
  const meta = parseXFrame(res)
  return { blob: await res.blob(), meta }
}

export async function fetchSnapshotBitmap(o: { full?: boolean } = {}): Promise<ImageBitmap> {
  return createImageBitmap(await fetchSnapshot(o))
}
