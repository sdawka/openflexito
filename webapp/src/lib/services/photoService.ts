/** Full-resolution photos to the gallery: single still, focus stack (z slices merged by local
 *  sharpness) or LED exposure stack (same scene at several LED levels, fused). The stage does not
 *  move for a photo except the z sweep of a focus stack, which ends where it started using the
 *  device's z backlash compensation (v3 Z_ONLY) so the final image matches the live view. */

import { waitForFrames } from '../api/sampler'
import { exposureFuse, focusStack, type Rgba } from '../algo/stack'
import type { RawDevelopRequest, RawDevelopResult } from '../workers/rawWorker'
import { saveSnapshot, type GalleryItem } from '../store/gallery'
import { device } from '../store/device.svelte'

export type PhotoMode = 'single' | 'raw' | 'focus' | 'exposure'
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

async function encodeRgba8(img: { data: Uint8ClampedArray; width: number; height: number }, quality = 0.9): Promise<Blob> {
  const c = ctx2d(img.width, img.height)
  c.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0)
  return canvas!.convertToBlob({ type: 'image/jpeg', quality })
}

/** Download the sensor's raw Bayer frame (10-bit, ~16 MB) and develop it in a worker to 16-bit RGB. */
async function developRaw(say: (m: string) => void): Promise<{ result: RawDevelopResult; raw: Blob; gains: [number, number] }> {
  say('RAW: capturing the sensor data (10-bit, 16 MB, ~15 s over WiFi)…')
  const res = await fetch(device.url('/raw.bin') + '?t=' + Date.now(), { cache: 'no-store' })
  if (!res.ok) throw new Error(`raw capture failed: ${res.status}`)
  const total = +(res.headers.get('content-length') ?? 0)
  const reader = res.body!.getReader(); const parts: Uint8Array[] = []; let got = 0
  for (;;) {
    const { done, value } = await reader.read(); if (done) break
    parts.push(value); got += value.length
    if (total) say(`RAW: downloading ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`)
  }
  const buf = new Uint8Array(got); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length }
  const raw = new Blob([buf], { type: 'application/octet-stream' })
  // white balance: what the camera is using right now (auto or fixed)
  const f = device.frame, c = device.controls
  const gains: [number, number] = f?.colour_gains?.length === 2 ? [f.colour_gains[0], f.colour_gains[1]] : c ? [c.ColourGains[0], c.ColourGains[1]] : [1, 1]
  const result = await new Promise<RawDevelopResult>((resolve, reject) => {
    const w = new Worker(new URL('../workers/rawWorker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (ev) => {
      if (ev.data.progress) say(`RAW: ${ev.data.progress}`)
      else if (ev.data.error) { reject(new Error(ev.data.error)); w.terminate() }
      else if (ev.data.result) { resolve(ev.data.result); w.terminate() }
    }
    w.onerror = (e) => { reject(new Error(e.message)); w.terminate() }
    const req: RawDevelopRequest = { buffer: buf.buffer, gains }
    w.postMessage(req, [buf.buffer])
  })
  return { result, raw, gains }
}

export async function takePhoto(o: PhotoOptions): Promise<GalleryItem> {
  const say = o.onProgress ?? (() => {})
  const meta = { position: { ...device.position }, controls: device.controls ?? undefined }
  if (o.mode === 'single') {
    say('capturing full resolution…')
    return saveSnapshot(await captureFull(), { ...meta, name: `Photo ${new Date().toLocaleString()}` })
  }
  if (o.mode === 'raw') {
    const { result, raw, gains } = await developRaw(say)
    say('RAW: saving…')
    const preview = await encodeRgba8(result.preview)
    return saveSnapshot(result.png, {
      ...meta, name: `RAW ${result.bitDepth}-bit ${new Date().toLocaleString()}`, thumbFrom: preview, size: { width: result.width, height: result.height },
      extra: { raw: { bitDepth: result.bitDepth, bayer: result.bayer, blackLevel: result.blackLevel, gains } },
      extraBlobs: { raw, preview },
    })
  }
  if (o.mode === 'focus') {
    const slices = Math.max(2, Math.round(o.slices ?? 5)), step = Math.max(1, Math.round(o.stepZ ?? 50))
    const startZ = device.position.z
    const frames: Rgba[] = [], sliceBlobs: Blob[] = [], zs: number[] = []
    try {
      say(`focus stack: moving to the first of ${slices} slices`)
      await device.moveRel({ z: -Math.floor((slices - 1) / 2) * step }, 'z')
      for (let i = 0; i < slices; i++) {
        if (i) await device.moveRel({ z: step }, false)
        await settle(150); await waitForFrames(2, 1500)
        say(`focus stack: capturing slice ${i + 1}/${slices} at z=${device.position.z}`)
        const blob = await captureFull()
        sliceBlobs.push(blob); zs.push(device.position.z)
        frames.push(await decode(blob))
      }
    } finally {
      say('focus stack: returning to the starting focus')
      await device.moveTo({ z: startZ }, 'z').catch(() => {})
    }
    say('focus stack: merging…')
    const { image, contributions } = focusStack(frames)
    const shares = contributions.map((c) => Math.round(c * 100))
    say(`focus stack: merged, taken from each slice: ${shares.map((s) => s + '%').join(' ')}`)
    const extraBlobs: Record<string, Blob> = {}
    sliceBlobs.forEach((b, i) => { extraBlobs[`slice/${i}`] = b })
    return saveSnapshot(await encode(image), {
      ...meta, name: `Focus stack ${slices}×${step} ${new Date().toLocaleString()}`,
      extra: { stack: { slices, stepZ: step, zs, contributions } }, extraBlobs,
    })
  }
  // exposure stack through the LED
  const base = device.light.cc
  if (base <= 0.02) throw new Error('exposure stack: turn the LED on first')
  const levels = [...new Set((o.levels ?? [0.4, 0.7, 1, 1.5]).map((f) => Math.min(1, Math.max(0.02, +(base * f).toFixed(3)))))]
  if (levels.length < 2) throw new Error('exposure stack: the LED is already at maximum and cannot be varied enough')
  const frames: Rgba[] = []
  // Under auto exposure the camera would cancel each LED change before the still froze it, so lock
  // the current exposure/gain for the stack and hand control back afterwards.
  const c = device.controls, f = device.frame
  const lockAe = !!c?.AeEnable && !!f?.exposure && !!f?.gain
  if (lockAe) await device.setControls({ AeEnable: false, ExposureTime: Math.round(f!.exposure!), AnalogueGain: f!.gain! })
  try {
    for (let i = 0; i < levels.length; i++) {
      say(`LED stack: level ${i + 1}/${levels.length} (${Math.round(levels[i] * 100)} %)`)
      await device.setLight(levels[i])
      await settle(250); await waitForFrames(3, 2000)
      frames.push(await decode(await captureFull()))
    }
  } finally {
    await device.setLight(base).catch(() => {})
    if (lockAe) await device.setControls({ AeEnable: true }).catch(() => {})
  }
  say('LED stack: fusing…')
  return saveSnapshot(await encode(exposureFuse(frames)), { ...meta, name: `LED exposure stack ×${levels.length} ${new Date().toLocaleString()}` })
}
