/** The one place that fetches `/snapshot.jpg`: the latest stream frame (fast, stream resolution) or a
 *  full-resolution still (`full`, ~1.3 s on the Pi: the camera switches configuration and freezes the
 *  live auto-exposure/white-balance values for the capture). */
import { device } from '../store/device.svelte'

export async function fetchSnapshot(o: { full?: boolean } = {}): Promise<Blob> {
  const res = await fetch(device.url('/snapshot.jpg') + (o.full ? '?full=1&' : '?') + 't=' + Date.now(), { cache: 'no-store' })
  if (!res.ok) throw new Error(`snapshot failed: ${res.status}`)
  return res.blob()
}

export async function fetchSnapshotBitmap(o: { full?: boolean } = {}): Promise<ImageBitmap> {
  return createImageBitmap(await fetchSnapshot(o))
}
