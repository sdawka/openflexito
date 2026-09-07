/** Full-resolution photos to the gallery: single still, focus stack (z slices merged by local
 *  sharpness) or LED exposure stack (same scene at several LED levels, fused). The stage does not
 *  move for a photo except the z sweep of a focus stack, which ends where it started using the
 *  device's z backlash compensation (v3 Z_ONLY) so the final image matches the live view. */

import { waitForFrames } from '../api/sampler'
import { exposureFuse, focusStack, type Rgba } from '../algo/stack'
import { saveSnapshot, type GalleryItem } from '../store/gallery'
import { device } from '../store/device.svelte'

export type PhotoMode = 'single' | 'focus' | 'exposure'
export interface PhotoOptions {
  mode: PhotoMode
  slices?: number        // focus: number of z slices (odd, centred on the current z)
  stepZ?: number         // focus: steps between slices
  levels?: number[]      // exposure: LED brightness factors relative to the current level
  onProgress?: (msg: string) => void
}

async function captureFull(): Promise<Blob> {
  const res = await fetch(device.url('/snapshot.jpg') + '?full=1&t=' + Date.now(), { cache: 'no-store' })
  if (!res.ok) throw new Error(`capture failed: ${res.status}`)
  return res.blob()
}

let canvas: OffscreenCanvas | null = null
function ctx2d(w: number, h: number): OffscreenCanvasRenderingContext2D {
  if (!canvas) canvas = new OffscreenCanvas(w, h)
  canvas.width = w; canvas.height = h
  return canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D
}
async function decode(blob: Blob): Promise<Rgba> {
  const bmp = await createImageBitmap(blob)
  const c = ctx2d(bmp.width, bmp.height)
  c.drawImage(bmp, 0, 0); bmp.close()
  const d = c.getImageData(0, 0, canvas!.width, canvas!.height)
  return { data: d.data, width: d.width, height: d.height }
}
async function encode(img: Rgba): Promise<Blob> {
  const c = ctx2d(img.width, img.height)
  c.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0)
  return canvas!.convertToBlob({ type: 'image/jpeg', quality: 0.95 })
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function takePhoto(o: PhotoOptions): Promise<GalleryItem> {
  const say = o.onProgress ?? (() => {})
  const meta = { position: { ...device.position }, controls: device.controls ?? undefined }
  if (o.mode === 'single') {
    say('capturing full resolution…')
    return saveSnapshot(await captureFull(), { ...meta, name: `Photo ${new Date().toLocaleString()}` })
  }
  if (o.mode === 'focus') {
    const slices = Math.max(2, Math.round(o.slices ?? 5)), step = Math.max(1, Math.round(o.stepZ ?? 50))
    const startZ = device.position.z
    const frames: Rgba[] = []
    try {
      say(`focus stack: moving to the first of ${slices} slices`)
      await device.moveRel({ z: -Math.floor((slices - 1) / 2) * step }, 'z')
      for (let i = 0; i < slices; i++) {
        if (i) await device.moveRel({ z: step }, false)
        await settle(150); await waitForFrames(2, 1500)
        say(`focus stack: capturing slice ${i + 1}/${slices} at z=${device.position.z}`)
        frames.push(await decode(await captureFull()))
      }
    } finally {
      say('focus stack: returning to the starting focus')
      await device.moveTo({ z: startZ }, 'z').catch(() => {})
    }
    say('focus stack: merging…')
    const merged = focusStack(frames)
    return saveSnapshot(await encode(merged), { ...meta, name: `Focus stack ${slices}×${step} ${new Date().toLocaleString()}` })
  }
  // exposure stack through the LED
  const base = device.light.cc
  if (base <= 0.02) throw new Error('exposure stack: turn the LED on first')
  const levels = [...new Set((o.levels ?? [0.4, 0.7, 1, 1.5]).map((f) => Math.min(1, Math.max(0.02, +(base * f).toFixed(3)))))]
  if (levels.length < 2) throw new Error('exposure stack: the LED is already at maximum and cannot be varied enough')
  const frames: Rgba[] = []
  try {
    for (let i = 0; i < levels.length; i++) {
      say(`LED stack: level ${i + 1}/${levels.length} (${Math.round(levels[i] * 100)} %)`)
      await device.setLight(levels[i])
      await settle(250); await waitForFrames(3, 2000)
      frames.push(await decode(await captureFull()))
    }
  } finally {
    await device.setLight(base).catch(() => {})
  }
  say('LED stack: fusing…')
  return saveSnapshot(await encode(exposureFuse(frames)), { ...meta, name: `LED exposure stack ×${levels.length} ${new Date().toLocaleString()}` })
}
