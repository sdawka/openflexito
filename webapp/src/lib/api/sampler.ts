/** Grab settled, downsampled greyscale frames from the device for browser-side image maths. */

import type { Gray } from '../algo/sharpness'
import { toGray } from '../algo/sharpness'
import { device } from '../store/device.svelte'

/** Resolve once `n` new frames have arrived after the call (i.e. the camera has moved on). */
export function waitForFrames(n = 2, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve) => {
    const start = device.frame?.seq ?? 0
    const t = setTimeout(done, timeoutMs)
    const off = device.client.on('event.frame', (f) => { if (f.seq >= start + n) done() })
    function done() { clearTimeout(t); off(); resolve() }
  })
}

let canvas: OffscreenCanvas | HTMLCanvasElement | null = null

function getCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (!canvas) canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : document.createElement('canvas')
  canvas.width = w; canvas.height = h
  return canvas
}

/** Fetch the latest JPEG and return it as greyscale, scaled so the width is at most `maxWidth`. */
export async function grabGray(maxWidth = 410, settleMs = 80): Promise<Gray> {
  if (settleMs) await new Promise((r) => setTimeout(r, settleMs))
  await waitForFrames(1, 1000)
  const res = await fetch(device.url('/snapshot.jpg') + '?t=' + Date.now(), { cache: 'no-store' })
  if (!res.ok) throw new Error(`snapshot failed: ${res.status}`)
  const bmp = await createImageBitmap(await res.blob())
  const scale = Math.min(1, maxWidth / bmp.width)
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale)
  const c = getCanvas(w, h)
  const ctx = c.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D
  ctx.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  return toGray(ctx.getImageData(0, 0, w, h) as ImageData)
}

export async function fetchRaw(): Promise<ArrayBuffer> {
  const res = await fetch(device.url('/raw.bin') + '?t=' + Date.now(), { cache: 'no-store' })
  if (!res.ok) throw new Error(`raw capture failed: ${res.status}`)
  return res.arrayBuffer()
}
