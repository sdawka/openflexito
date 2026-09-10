/** Full-resolution photos to the gallery: single still, focus stack (z slices merged by local
 *  sharpness) or LED exposure stack (same scene at several LED levels, fused). The stage does not
 *  move for a photo except the z sweep of a focus stack, which ends where it started using the
 *  device's z backlash compensation (v3 Z_ONLY) so the final image matches the live view. */

import { fetchSnapshot } from '../api/snapshot'
import { waitForFrames } from '../api/sampler'
import { exposureFuse, focusStack, type Rgba } from '../algo/stack'
import type { RawDevelopRequest, RawDevelopResult, RawRgb16Result } from '../workers/rawWorker'
import { encodePng16 } from '../png16'
import { SliceAligner, luminance, translateRgbaSubpixel } from '../algo/align'
import { toRgba8 } from '../algo/rawdev'
import type { StackMessage } from '../workers/stackWorker'
import type { SuperresMessage } from '../workers/superresWorker'
import { developParamsFromTuning } from '../algo/rawdev'
import { runAutofocus } from './autofocusService'
import { saveSnapshot, type GalleryItem } from '../store/gallery'
import { device } from '../store/device.svelte'
import { calibration } from '../store/calibration.svelte'
import { smoothDepthIndex, depthZMap, colorizeDepth, reliefShade } from '../algo/depthMap'

export type PhotoMode = 'single' | 'raw' | 'focus' | 'focusfine' | 'focusfineraw' | 'exposure' | 'superres'
export interface PhotoOptions {
  mode: PhotoMode
  slices?: number        // focus: number of z slices (odd, centred on the current z)
  stepZ?: number         // focus: steps between slices
  range?: number         // focusfine: total z range of the autofocus sweep that locates the focus plane
  levels?: number[]      // exposure: LED brightness factors relative to the current level
  frames?: number        // superres: number of pixel-shifted stills (a square number, default 9 = 3x3)
  onProgress?: (msg: string) => void
}

const captureFull = () => fetchSnapshot({ full: true })

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
async function encodeRgba8Png(img: { data: Uint8ClampedArray; width: number; height: number }): Promise<Blob> {
  const c = ctx2d(img.width, img.height)
  c.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0)
  return canvas!.convertToBlob({ type: 'image/png' })
}

/** Centre-crop an RGBA image so neither side exceeds `maxLong`; returns the crop rectangle used
 *  (null if the image was already small enough). A 2x drizzle of the full ~6560x4928 sensor frame
 *  can exceed canvas/texture size limits in some browsers, so super-resolution works on a bounded
 *  central crop instead. */
function centerCropRgba(img: Rgba, maxLong: number): { img: Rgba; crop: { width: number; height: number; x0: number; y0: number } | null } {
  if (Math.max(img.width, img.height) <= maxLong) return { img, crop: null }
  const w = Math.min(img.width, maxLong), h = Math.min(img.height, maxLong)
  const x0 = Math.floor((img.width - w) / 2), y0 = Math.floor((img.height - h) / 2)
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) data.set(img.data.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4), y * w * 4)
  return { img: { data, width: w, height: h }, crop: { width: w, height: h, x0, y0 } }
}

/** Download the sensor's raw Bayer frame (10-bit, ~16 MB) with progress. */
async function fetchRaw(say: (m: string) => void, label = 'RAW'): Promise<Uint8Array> {
  say(`${label}: capturing the sensor data (10-bit, 16 MB, ~15 s over WiFi)…`)
  const res = await fetch(device.url('/raw.bin') + '?t=' + Date.now(), { cache: 'no-store' })
  if (!res.ok) throw new Error(`raw capture failed: ${res.status}`)
  const total = +(res.headers.get('content-length') ?? 0)
  const reader = res.body!.getReader(); const parts: Uint8Array[] = []; let got = 0
  for (;;) {
    const { done, value } = await reader.read(); if (done) break
    parts.push(value); got += value.length
    if (total) say(`${label}: downloading ${(got / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB`)
  }
  const buf = new Uint8Array(got); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length }
  return buf
}
function liveGains(): [number, number] {
  const f = device.frame, c = device.controls
  return f?.colour_gains?.length === 2 ? [f.colour_gains[0], f.colour_gains[1]] : c ? [c.ColourGains[0], c.ColourGains[1]] : [1, 1]
}
async function tuningParams(): Promise<RawDevelopRequest['params']> {
  try { return developParamsFromTuning(await device.client.call('camera.get_tuning')) } catch { return {} }
}
function runRawWorker<T>(req: RawDevelopRequest, say: (m: string) => void, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const w = new Worker(new URL('../workers/rawWorker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (ev) => {
      if (ev.data.progress) say(`${label}: ${ev.data.progress}`)
      else if (ev.data.error) { reject(new Error(ev.data.error)); w.terminate() }
      else if (ev.data.result) { resolve(ev.data.result); w.terminate() }
    }
    w.onerror = (e) => { reject(new Error(e.message)); w.terminate() }
    w.postMessage(req, [req.buffer])
  })
}

/** Download the sensor's raw Bayer frame and develop it in a worker to 16-bit RGB files (PNG + DNG). */
async function developRaw(say: (m: string) => void): Promise<{ result: RawDevelopResult; gains: [number, number] }> {
  const buf = await fetchRaw(say)
  const gains = liveGains(), params = await tuningParams()
  const model = `OpenFlexure openflexito ${device.status?.camera?.sensor?.model ?? 'camera'}`
  const result = await runRawWorker<RawDevelopResult>({ buffer: buf.buffer as ArrayBuffer, gains, params, model, want: 'files' }, say, 'RAW')
  return { result, gains }
}


export async function takePhoto(o: PhotoOptions): Promise<GalleryItem> {
  const say = o.onProgress ?? (() => {})
  const meta = { position: { ...device.position }, controls: device.controls ?? undefined }
  if (o.mode === 'single') {
    say('capturing full resolution…')
    return saveSnapshot(await captureFull(), { ...meta, name: 'Photo' })
  }
  if (o.mode === 'raw') {
    const { result, gains } = await developRaw(say)
    say('RAW: saving…')
    const preview = await encodeRgba8(result.preview)
    return saveSnapshot(result.png, {
      ...meta, name: `RAW ${result.bitDepth}-bit`, thumbFrom: preview, size: { width: result.width, height: result.height },
      extra: { raw: { bitDepth: result.bitDepth, bayer: result.bayer, blackLevel: result.blackLevel, gains, applied: result.applied } },
      extraBlobs: { dng: result.dng, preview },
    })
  }
  if (o.mode === 'focusfine' || o.mode === 'focusfineraw') return fineStack(o, say, meta, o.mode === 'focusfineraw' ? 'raw' : 'jpeg')
  if (o.mode === 'superres') return superresPhoto(o, say, meta)
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
      await device.moveTo({ z: startZ }, 'z').catch((e) => say(`focus stack: could not return to z=${startZ}: ${(e as Error).message}`))
    }
    say('focus stack: aligning and merging…')
    // align every slice to the first (a z move on a flexure stage shifts the image a little):
    // neighbour-chained, sub-pixel (algo/align)
    const aligner = new SliceAligner()
    for (let i = 0; i < frames.length; i++) {
      const d = aligner.next(luminance(frames[i].data, frames[i].width, frames[i].height))
      if (i && Math.hypot(d.dx, d.dy) >= 0.05) frames[i] = { ...frames[i], data: translateRgbaSubpixel(frames[i].data, frames[i].width, frames[i].height, -d.dx, -d.dy) }
    }
    const { image, contributions } = focusStack(frames)
    const shares = contributions.map((c) => Math.round(c * 100))
    say(`focus stack: merged, taken from each slice: ${shares.map((s) => s + '%').join(' ')}`)
    const extraBlobs: Record<string, Blob> = {}
    sliceBlobs.forEach((b, i) => { extraBlobs[`slice/${i}`] = b })
    return saveSnapshot(await encode(image), {
      ...meta, name: `Focus stack ${slices}×${step}`,
      extra: { stack: { slices, stepZ: step, zs, contributions, method: 'blocks' } }, extraBlobs,
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
    await device.setLight(base).catch((e) => say(`LED stack: could not restore the LED to ${Math.round(base * 100)} %: ${(e as Error).message}`))
    if (lockAe) await device.setControls({ AeEnable: true }).catch((e) => say(`LED stack: could not re-enable auto exposure: ${(e as Error).message}`))
  }
  say('LED stack: fusing…')
  return saveSnapshot(await encode(exposureFuse(frames)), { ...meta, name: `LED exposure stack ×${levels.length}` })
}

/** Fine focus stack: find the focus plane with an autofocus sweep, size the stack from the width of
 *  the sharpness curve, capture the slices symmetrically about the plane, align and fuse them in a
 *  Laplacian pyramid (worker), end back on the focus plane. */
async function fineStack(o: PhotoOptions, say: (m: string) => void, meta: { position: { x: number; y: number; z: number }; controls?: object }, source: 'jpeg' | 'raw'): Promise<GalleryItem> {
  const slices = Math.max(3, Math.round(o.slices ?? 9)), range = Math.max(100, Math.round(o.range ?? 1000))
  say(`fine stack: locating the focus plane (sweep ±${range / 2})`)
  const af = await runAutofocus({ mode: 'fast', dz: range, metric: 'jpeg', onProgress: (m) => say(`fine stack: ${m}`) })
  const centreZ = af.peakZ
  // width of the sharpness peak: z-extent where sharpness exceeds half way between min and max
  const ss = af.samples.map((s) => s.s), lo = Math.min(...ss), hi = Math.max(...ss)
  const above = af.samples.filter((s) => s.s > lo + 0.5 * (hi - lo)).map((s) => s.z)
  const fwhm = above.length > 1 ? Math.max(...above) - Math.min(...above) : range / 10
  let span = Math.min(range, Math.max(slices * 4, Math.round(fwhm * 1.5)))
  const step = Math.max(2, Math.round(span / (slices - 1)))
  span = step * (slices - 1)
  say(`fine stack: focus plane z=${centreZ}, peak width ${Math.round(fwhm)} steps → ${slices} slices ${step} apart (${span} total)`)
  const frames: { blob: Blob; z: number }[] = []
  let width = 0, height = 0
  const gains = liveGains(), params = source === 'raw' ? await tuningParams() : {}
  const worker = new Worker(new URL('../workers/stackWorker.ts', import.meta.url), { type: 'module' })
  const post = (m: StackMessage, transfer?: Transferable[]) => worker.postMessage(m, transfer ?? [])
  let progressHook: ((m: string) => void) | null = null
  const finished = new Promise<{ data: Uint8ClampedArray | Uint16Array; width: number; height: number; contributions: number[]; shifts: { dx: number; dy: number }[]; depthIndex: Uint8Array }>((resolve, reject) => {
    worker.onmessage = (ev) => {
      if (ev.data.progress) progressHook?.(ev.data.progress)
      else if (ev.data.error) reject(new Error(ev.data.error))
      else if (ev.data.result) resolve(ev.data.result)
    }
    worker.onerror = (e) => reject(new Error(e.message))
  })
  try {
    // to the bottom of the stack with z backlash compensation, then up in raw steps
    await device.moveRel({ z: -Math.floor((slices - 1) / 2) * step }, 'z')
    for (let i = 0; i < slices; i++) {
      if (i) await device.moveRel({ z: step }, false)
      await settle(200); await waitForFrames(2, 1500)
      const label = `fine stack: slice ${i + 1}/${slices} at z=${device.position.z}`
      say(`${label}: capturing`)
      if (source === 'raw') {
        // 16-bit path: the developed RAW slice goes straight into the pyramid, nothing is quantised to 8 bits
        const buf = await fetchRaw((m) => say(`${label}: ${m}`), 'RAW')
        const dev = await runRawWorker<RawRgb16Result>({ buffer: buf.buffer as ArrayBuffer, gains, params, want: 'rgb16' }, (m) => say(`${label}: ${m}`), 'develop')
        frames.push({ blob: await encodeRgba8(toRgba8({ data: dev.rgb16, width: dev.width, height: dev.height }, 2), 0.85), z: device.position.z })
        if (!i) { width = dev.width; height = dev.height; post({ type: 'init', width, height, depth: 16 }) }
        progressHook = (m) => say(`fine stack: ${m}`)
        post({ type: 'add', index: i, data: dev.rgb16 }, [dev.rgb16.buffer])
      } else {
        const blob = await captureFull()
        frames.push({ blob, z: device.position.z })
        const img = await decode(blob)
        if (!i) { width = img.width; height = img.height; post({ type: 'init', width, height, depth: 8 }) }
        progressHook = (m) => say(`fine stack: ${m}`)
        post({ type: 'add', index: i, data: img.data }, [img.data.buffer])
      }
    }
  } finally {
    say('fine stack: returning to the focus plane')
    await device.moveTo({ z: centreZ }, 'z').catch((e) => say(`fine stack: could not return to z=${centreZ}: ${(e as Error).message}`))
  }
  say('fine stack: fusing…')
  post({ type: 'finish' })
  const r = await finished
  worker.terminate()
  const shares = r.contributions.map((c) => Math.round(c * 100))
  say(`fine stack: done, taken from each slice: ${shares.map((s) => s + '%').join(' ')}`)
  const extraBlobs: Record<string, Blob> = {}
  frames.forEach((f, i) => { extraBlobs[`slice/${i}`] = f.blob })
  const zs = frames.map((f) => f.z)
  // depth-from-focus: which slice won each pixel, smoothed, turned into a z map and a colour/relief preview
  say('fine stack: extracting depth map…')
  const depthIndex = smoothDepthIndex(r.depthIndex, r.width, r.height)
  const zMap = depthZMap(depthIndex, zs)
  const depthColor = colorizeDepth(zMap, r.width, r.height)
  const baseRgba = r.data instanceof Uint16Array ? toRgba8({ data: r.data, width: r.width, height: r.height }, 4).data : r.data
  const relief = reliefShade(baseRgba, zMap, r.width, r.height)
  extraBlobs['depth'] = await encodeRgba8Png({ data: depthColor.data, width: r.width, height: r.height })
  extraBlobs['relief'] = await encodeRgba8({ data: relief, width: r.width, height: r.height }, 0.9)
  extraBlobs['depth.bin'] = new Blob([new Uint8Array(depthIndex)], { type: 'application/octet-stream' })
  const stack = {
    slices, stepZ: step, zs, contributions: r.contributions, method: 'pyramid' as const, centreZ, span, shifts: r.shifts, source,
    depth: { minZ: depthColor.stats.min, maxZ: depthColor.stats.max, colorMap: 'ramp' as const },
  }
  if (r.data instanceof Uint16Array) {
    say('fine stack: encoding 16-bit PNG…')
    const png = await encodePng16(r.data, r.width, r.height)
    const preview = await encodeRgba8(toRgba8({ data: r.data, width: r.width, height: r.height }, 4))
    return saveSnapshot(png, {
      ...meta, position: { ...meta.position, z: centreZ }, name: `Fine focus stack RAW ${slices}×${step}`, thumbFrom: preview, size: { width: r.width, height: r.height },
      extra: { stack, raw: { bitDepth: 10, bayer: 'BGGR', blackLevel: 64, gains, applied: { lsc: !!params?.lsc, ccm: !!params?.ccm, gammaCurve: !!params?.gammaCurve, demosaic: 'malvar' } } }, extraBlobs: { ...extraBlobs, preview },
    })
  }
  const image = await encodeRgba8({ data: r.data, width: r.width, height: r.height }, 0.95)
  return saveSnapshot(image, {
    ...meta, position: { ...meta.position, z: centreZ }, name: `Fine focus stack ${slices}×${step}`,
    extra: { stack }, extraBlobs,
  })
}

const SUPERRES_SCALE = 2

/** Pixel-shift super-resolution: capture N full-resolution stills in a square raster pattern with
 *  sub-pixel stage offsets (from the CSM calibration's pixels/step), register every frame to the
 *  first by phase correlation (the measured shift, not the commanded one — backlash and residual
 *  stage error would otherwise misalign the fusion) and drizzle them onto a finer grid in a worker.
 *  Moves are raw, like the other sweeps, and the stage returns to the starting position at the end. */
async function superresPhoto(o: PhotoOptions, say: (m: string) => void, meta: { position: { x: number; y: number; z: number }; controls?: object }): Promise<GalleryItem> {
  const csm = calibration.csm
  if (!csm) throw new Error('super-resolution: run the stage↔camera calibration first (Calibrate tab) — choosing sub-pixel offsets needs pixels/step')
  const side = Math.max(2, Math.round(Math.sqrt(Math.max(4, Math.round(o.frames ?? 9)))))
  const total = side * side

  say(`super-resolution: capturing frame 1/${total} (reference)…`)
  const firstImg = await decode(await captureFull())
  const { img: firstCropped, crop } = centerCropRgba(firstImg, 4096)
  const scaleFactor = firstImg.width / csm.imageWidth
  const pxPerStepX = Math.hypot(csm.calX.pixelsPerStep[0], csm.calX.pixelsPerStep[1]) * scaleFactor
  const pxPerStepY = Math.hypot(csm.calY.pixelsPerStep[0], csm.calY.pixelsPerStep[1]) * scaleFactor
  if (!(pxPerStepX > 0) || !(pxPerStepY > 0)) throw new Error('super-resolution: calibration reports zero pixels/step; recalibrate the stage↔camera mapping')
  const stepX = Math.max(1, Math.round(0.5 / pxPerStepX)), stepY = Math.max(1, Math.round(0.5 / pxPerStepY))
  say(`super-resolution: ${side}×${side} pattern, ${stepX} step(s) in x and ${stepY} in y (~0.5 px at full resolution)`)

  const worker = new Worker(new URL('../workers/superresWorker.ts', import.meta.url), { type: 'module' })
  const postMsg = (m: SuperresMessage, transfer?: Transferable[]) => worker.postMessage(m, transfer ?? [])
  let progressHook: ((m: string) => void) | null = (m) => say(`super-resolution: ${m}`)
  const finished = new Promise<{ data: Uint8ClampedArray; width: number; height: number; coverage: number; shifts: { dx: number; dy: number; quality: number }[] }>((resolve, reject) => {
    worker.onmessage = (ev) => {
      if (ev.data.progress) progressHook?.(ev.data.progress)
      else if (ev.data.error) reject(new Error(ev.data.error))
      else if (ev.data.result) resolve(ev.data.result)
    }
    worker.onerror = (e) => reject(new Error(e.message))
  })
  postMsg({ type: 'init', width: firstCropped.width, height: firstCropped.height, scale: SUPERRES_SCALE })
  postMsg({ type: 'add', index: 0, data: firstCropped.data }, [firstCropped.data.buffer])

  let curCol = 0, curRow = 0
  try {
    for (let i = 1; i < total; i++) {
      const row = Math.floor(i / side), col = i % side
      await device.moveRel({ x: (col - curCol) * stepX, y: (row - curRow) * stepY }, false)
      curCol = col; curRow = row
      await settle(150); await waitForFrames(2, 1500)
      say(`super-resolution: capturing frame ${i + 1}/${total}`)
      const { img: cropped } = centerCropRgba(await decode(await captureFull()), 4096)
      postMsg({ type: 'add', index: i, data: cropped.data }, [cropped.data.buffer])
    }
  } finally {
    say('super-resolution: returning to the starting position')
    await device.moveRel({ x: -curCol * stepX, y: -curRow * stepY }, false).catch((e) => say(`super-resolution: could not return to the start: ${(e as Error).message}`))
  }
  say('super-resolution: fusing…')
  postMsg({ type: 'finish' })
  const r = await finished
  worker.terminate()
  say(`super-resolution: done, ${Math.round(r.coverage * 100)}% of the ${SUPERRES_SCALE}× grid covered by drizzled frames`)
  const image = await encodeRgba8Png({ data: r.data, width: r.width, height: r.height })
  return saveSnapshot(image, {
    ...meta, size: { width: r.width, height: r.height },
    name: `Super-resolution ${total} frames ×${SUPERRES_SCALE}`,
    extra: { superres: { frames: total, scale: SUPERRES_SCALE, shifts: r.shifts, crop } },
  })
}
