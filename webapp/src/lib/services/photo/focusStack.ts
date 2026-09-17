/** Focus stacks: the quick block-fusion stack ('focus', user-fixed z range) and the fine pyramid
 *  stack ('focusfine'/'focusfineraw', z range located and sized automatically). Extracted from
 *  `photoService.ts` so the shared photo modes stay in one small dispatcher.
 *
 *  Both stacks now: lock AE/AWB for the whole run (`cameraLock`, D8 in CAPTURE_AUDIT.md — previously
 *  only the LED stack did this, so a focus stack could drift exposure/colour slice to slice); verify
 *  each z move actually arrived (`moveZVerified` — the hardware read-back vs the intended target, and
 *  `cancelled`, retried once then aborted, rather than silently recording a short move's wrong z into
 *  the depth map); and align to the *middle* slice with Lanczos-3 resampling (`algo/align`'s
 *  `chooseReference`/`alignStack`), not slice 0 with bilinear (D7 — slice 0 is the most defocused
 *  slice, and bilinear at a half-pixel shift softens exactly the sharp slices a stack should keep). */

import { waitForFrames, grabGray } from '../../api/sampler'
import { focusStack as blockFuse, type Rgba } from '../../algo/stack'
import { laplacianVariance } from '../../algo/sharpness'
import { encodePng16 } from '../../algo/png16'
import { alignStack, chooseReference, luminance, translateRgbaSubpixel } from '../../algo/align'
import { toRgba8, developParamsFromTuning } from '../../algo/rawdev'
import type { StackMessage, FuseMethod } from '../../workers/stackWorker'
import type { RawDevelopRequest, RawRgb16Result } from '../../workers/rawWorker'
import { runAutofocus } from '../autofocusService'
import { saveSnapshot, type GalleryItem } from '../../store/gallery'
import { device } from '../../store/device.svelte'
import { settings } from '../../store/settings.svelte'
import { smoothDepthIndex, depthZMap, colorizeDepth, reliefShade, stepsToUm, depthLegend } from '../../algo/depthMap'
import { withCameraLock } from '../cameraLock'
import type { MoveResult } from '../../algo/types'
import type { StillFrameMeta } from '../../api/snapshot'
import { captureFullWithMeta, captureField, decode, encode, encodeRgba8, encodeRgba8Png, settle, type Say, type PhotoMeta } from './common'

export interface FocusStackOptions {
  slices?: number         // focus: number of z slices (odd, centred on the current z); focusfine: the maximum
  stepZ?: number          // focus: steps between slices
  range?: number          // focusfine: total z range of the autofocus sweep that locates the focus plane
  method?: FuseMethod     // focusfine: 'pyramid' (default) or 'hybrid' (Zerene DMap-style)
  onProgress?: (msg: string) => void
}

/** Relative z move with arrival verification: compares the device's read-back position after the
 *  move (`position.z`, program frame: the hardware counter re-read from the board with axis sign and
 *  offset applied; `end_hw` is the raw hardware frame and is not comparable) against the intended
 *  cumulative target and checks `cancelled`; retried once (the residual distance) and aborted if it
 *  still misses, instead of recording whatever z the stage happened to stop at. */
export async function moveZVerified(dz: number, compensate: false | 'z', say: Say, label: string, tolerance = 1): Promise<number> {
  const target = device.position.z + dz
  let remaining = dz
  for (let attempt = 0; attempt < 2; attempt++) {
    const move: MoveResult = await device.moveRel({ z: remaining }, compensate)
    const got = move.position.z, miss = Math.abs(got - target)
    if (!move.cancelled && miss <= tolerance) return got
    if (attempt === 0) {
      say(`${label}: z move short of target (wanted ${target}, reached ${got}${move.cancelled ? ', cancelled' : ''}) — retrying`)
      remaining = target - got
    } else {
      throw new Error(`${label}: stage did not reach z=${target} after a retry (reached ${got}${move.cancelled ? ', cancelled' : ''})`)
    }
  }
  /* unreachable */ throw new Error(`${label}: stage move failed`)
}

/** z distance-per-step, if Settings has one calibrated (`stageStepUm.z`; 0.05 µm/step by default on
 *  this rig) — used only to give the depth map a µm legend instead of raw z steps. */
function zUmPerStep(): number | undefined {
  const z = settings.stageStepUm?.z
  return z && z > 0 ? z : undefined
}

/** Quick focus stack: user-fixed z range (`slices` × `stepZ`, symmetric about the current z), aligned
 *  to the middle slice and merged by local (8×8-cell) sharpness — no pyramid, no depth map. */
export async function takeFocusStack(o: FocusStackOptions, say: Say, meta: PhotoMeta): Promise<GalleryItem> {
  const slices = Math.max(2, Math.round(o.slices ?? 5)), step = Math.max(1, Math.round(o.stepZ ?? 50))
  const startZ = device.position.z
  const frames: Rgba[] = [], sliceBlobs: Blob[] = [], zs: number[] = [], metas: (StillFrameMeta | null)[] = []
  await withCameraLock(async () => {
    try {
      say(`focus stack: moving to the first of ${slices} slices`)
      await moveZVerified(-Math.floor((slices - 1) / 2) * step, 'z', say, 'focus stack')
      for (let i = 0; i < slices; i++) {
        const z = i ? await moveZVerified(step, false, say, 'focus stack') : device.position.z
        await settle(150); await waitForFrames(2, 1500)
        say(`focus stack: capturing slice ${i + 1}/${slices} at z=${z}`)
        const { blob, meta: frameMeta } = await captureFullWithMeta()
        sliceBlobs.push(blob); zs.push(z); metas.push(frameMeta)
        frames.push(await decode(blob))
      }
    } finally {
      say('focus stack: returning to the starting focus')
      await device.moveTo({ z: startZ }, 'z').catch((e) => say(`focus stack: could not return to z=${startZ}: ${(e as Error).message}`))
    }
  }, { onError: (m) => say(`focus stack: ${m}`) })
  say('focus stack: aligning and merging…')
  // align every slice to the middle one (chained outward both ways, Lanczos-3): a z move on a flexure
  // stage shifts the image a little, and the middle slice is usually the sharpest, not slice 0
  const reference = chooseReference(frames.length)
  const shifts = alignStack(frames.map((f) => luminance(f.data, f.width, f.height)), reference)
  for (let i = 0; i < frames.length; i++) {
    const d = shifts[i]
    if (Math.hypot(d.dx, d.dy) >= 0.05) frames[i] = { ...frames[i], data: translateRgbaSubpixel(frames[i].data, frames[i].width, frames[i].height, -d.dx, -d.dy, 'lanczos3') }
  }
  const { image, contributions } = blockFuse(frames)
  const shares = contributions.map((c) => Math.round(c * 100))
  say(`focus stack: merged, taken from each slice: ${shares.map((s) => s + '%').join(' ')}`)
  const extraBlobs: Record<string, Blob> = {}
  sliceBlobs.forEach((b, i) => { extraBlobs[`slice/${i}`] = b })
  return saveSnapshot(await encode(image), {
    ...meta, name: `Focus stack ${slices}×${step}`,
    extra: {
      stack: { slices, stepZ: step, zs, contributions, method: 'blocks' },
      // metadata of the reference slice (same one the alignment/fusion is anchored to), not any
      // particular slice's own exposure — a stack has no single "the" still, this is the closest fit
      capture: captureField(metas[reference]),
    },
    extraBlobs,
  })
}

/** Measure a Laplacian-variance focus curve on stream snapshots at `count` points spanning `range`
 *  around the current z (locating sweep for the adaptive step below) — a much narrower, more
 *  DOF-accurate proxy than the fast sweep's JPEG-size curve (CAPTURE_AUDIT.md D6/#6: JPEG size is a
 *  whole-frame, low-frequency-heavy figure whose curve is far broader than the optical depth of
 *  field). Returns to the starting z. */
async function laplacianWidth(range: number, count: number, say: Say): Promise<{ fwhm: number }> {
  const startZ = device.position.z, step = Math.max(1, Math.round(range / (count - 1)))
  const samples: { z: number; s: number }[] = []
  try {
    await device.moveRel({ z: -Math.round(range / 2) }, 'z')
    for (let i = 0; i < count; i++) {
      if (i) await device.moveRel({ z: step }, false)
      await settle(80)
      samples.push({ z: device.position.z, s: laplacianVariance(await grabGray(410, 60)) })
    }
  } finally {
    await device.moveTo({ z: startZ }, 'z').catch((e) => say(`fine stack: could not return from the width sweep: ${(e as Error).message}`))
  }
  const ss = samples.map((s) => s.s), lo = Math.min(...ss), hi = Math.max(...ss)
  const above = samples.filter((s) => s.s > lo + 0.5 * (hi - lo)).map((s) => s.z)
  return { fwhm: above.length > 1 ? Math.max(...above) - Math.min(...above) : range / 10 }
}

/** Fine focus stack: locate the focus plane with a fast autofocus sweep, measure the depth of field
 *  with a short Laplacian sweep around it, space slices at ≈0.7× the measured half-width (+1 slice
 *  beyond each end of that span), capped at the user's slice count (a ceiling, not a target — a
 *  narrow DOF needs far fewer slices than a wide one), align and fuse them in a Laplacian pyramid
 *  (worker), end back on the focus plane. */
export async function takeFineFocusStack(o: FocusStackOptions, say: Say, meta: PhotoMeta, source: 'jpeg' | 'raw'): Promise<GalleryItem> {
  const maxSlices = Math.max(3, Math.round(o.slices ?? 9)), range = Math.max(100, Math.round(o.range ?? 1000))
  say(`fine stack: locating the focus plane (sweep ±${range / 2})`)
  const af = await runAutofocus({ mode: 'fast', dz: range, metric: 'jpeg', onProgress: (m) => say(`fine stack: ${m}`) })
  const centreZ = af.peakZ
  say('fine stack: measuring the depth of field…')
  const { fwhm } = await laplacianWidth(Math.max(60, Math.round(range / 6)), 7, say)
  const halfWidth = Math.max(2, fwhm / 2)
  const step = Math.max(2, Math.round(halfWidth * 0.7))
  // enough slices to cover the half-width on each side of the peak, plus one extra slice beyond each end
  const neededSlices = 2 * Math.ceil(halfWidth / step) + 1 + 2
  const slices = Math.max(3, Math.min(maxSlices, neededSlices))
  let span = step * (slices - 1)
  say(`fine stack: focus plane z=${centreZ}, half-width ${Math.round(halfWidth)} steps → ${slices} slices ${step} apart (${span} total, capped at ${maxSlices})`)
  const frames: { blob: Blob; z: number }[] = []
  const metas: (StillFrameMeta | null)[] = []
  let width = 0, height = 0
  const gains = liveGains(), params = source === 'raw' ? await tuningParams() : {}
  const worker = new Worker(new URL('../../workers/stackWorker.ts', import.meta.url), { type: 'module' })
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
  await withCameraLock(async () => {
    try {
      // to the bottom of the stack with z backlash compensation, then up in verified raw steps
      await moveZVerified(-Math.floor((slices - 1) / 2) * step, 'z', say, 'fine stack')
      for (let i = 0; i < slices; i++) {
        const z = i ? await moveZVerified(step, false, say, 'fine stack') : device.position.z
        await settle(200); await waitForFrames(2, 1500)
        const label = `fine stack: slice ${i + 1}/${slices} at z=${z}`
        say(`${label}: capturing`)
        if (source === 'raw') {
          // 16-bit path: the developed RAW slice goes straight into the pyramid, nothing is quantised to 8 bits
          const buf = await fetchRaw((m) => say(`${label}: ${m}`), 'RAW')
          const dev = await runRawWorker<RawRgb16Result>({ buffer: buf.buffer as ArrayBuffer, gains, params, want: 'rgb16' }, (m) => say(`${label}: ${m}`), 'develop')
          frames.push({ blob: await encodeRgba8(toRgba8({ data: dev.rgb16, width: dev.width, height: dev.height }, 2), 0.85), z })
          if (!i) { width = dev.width; height = dev.height; post({ type: 'init', width, height, depth: 16, count: slices, reference: 'middle', method: o.method }) }
          progressHook = (m) => say(`fine stack: ${m}`)
          post({ type: 'add', index: i, data: dev.rgb16 }, [dev.rgb16.buffer])
        } else {
          const { blob, meta: frameMeta } = await captureFullWithMeta()
          frames.push({ blob, z }); metas.push(frameMeta)
          const img = await decode(blob)
          if (!i) { width = img.width; height = img.height; post({ type: 'init', width, height, depth: 8, count: slices, reference: 'middle', method: o.method }) }
          progressHook = (m) => say(`fine stack: ${m}`)
          post({ type: 'add', index: i, data: img.data }, [img.data.buffer])
        }
      }
    } finally {
      say('fine stack: returning to the focus plane')
      await device.moveTo({ z: centreZ }, 'z').catch((e) => say(`fine stack: could not return to z=${centreZ}: ${(e as Error).message}`))
    }
  }, { onError: (m) => say(`fine stack: ${m}`) })
  say('fine stack: fusing…')
  post({ type: 'finish' })
  const r = await finished
  worker.terminate()
  const shares = r.contributions.map((c) => Math.round(c * 100))
  say(`fine stack: done, taken from each slice: ${shares.map((s) => s + '%').join(' ')}`)
  const extraBlobs: Record<string, Blob> = {}
  frames.forEach((f, i) => { extraBlobs[`slice/${i}`] = f.blob })
  const zs = frames.map((f) => f.z)
  // depth-from-focus: which slice won each pixel, smoothed, turned into a z map (steps — the saved
  // gallery schema and its viewer assume that unit) and a colour/relief preview. Where the stage's z
  // distance-per-step is calibrated (Settings' `stageStepUm.z`) we also log a µm reading for the
  // operator (`stepsToUm`/`depthLegend`) and persist it into `stack.depth.umPerStep` so the item keeps
  // its capture-time µm scale even if the stage is recalibrated later (gallery.ts, Viewer.svelte).
  say('fine stack: extracting depth map…')
  const depthIndex = smoothDepthIndex(r.depthIndex, r.width, r.height)
  const zMap = depthZMap(depthIndex, zs)
  const depthColor = colorizeDepth(zMap, r.width, r.height)
  const baseRgba = r.data instanceof Uint16Array ? toRgba8({ data: r.data, width: r.width, height: r.height }, 4).data : r.data
  const relief = reliefShade(baseRgba, zMap, r.width, r.height)
  extraBlobs['depth'] = await encodeRgba8Png({ data: depthColor.data, width: r.width, height: r.height })
  extraBlobs['relief'] = await encodeRgba8({ data: relief, width: r.width, height: r.height }, 0.9)
  extraBlobs['depth.bin'] = new Blob([new Uint8Array(depthIndex)], { type: 'application/octet-stream' })
  const umPerStep = zUmPerStep()
  const legend = depthLegend(depthColor.stats, umPerStep)
  say(`fine stack: depth range ${depthColor.stats.min}–${depthColor.stats.max} steps` + (umPerStep ? ` (${stepsToUm([legend.min, legend.max], umPerStep).map((v) => v.toFixed(2)).join('–')} µm)` : ''))
  // the gallery schema's `method` is 'blocks' | 'pyramid': hybrid fusion is a refinement of the
  // pyramid result, not a separate capture method, so it's recorded as 'pyramid' there and only in the
  // progress log (o.method) that hybrid blending actually ran
  const stack = {
    slices, stepZ: step, zs, contributions: r.contributions, method: 'pyramid' as const, centreZ, span, shifts: r.shifts, source,
    depth: { minZ: depthColor.stats.min, maxZ: depthColor.stats.max, colorMap: 'ramp' as const, ...(umPerStep ? { umPerStep } : {}) },
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
  // metadata of the reference slice ('middle', same as the worker's alignment/fusion reference) — a
  // stack has no single "the" still, this is the closest fit
  const reference = chooseReference(metas.length)
  return saveSnapshot(image, {
    ...meta, position: { ...meta.position, z: centreZ }, name: `Fine focus stack ${slices}×${step}`,
    extra: { stack, capture: captureField(metas[reference]) }, extraBlobs,
  })
}

// ---- small helpers shared with photoService's RAW path (duplicated rather than imported, to avoid
// a photoService <-> focusStack runtime import cycle; both are tiny) ---------------------------------

function liveGains(): [number, number] {
  const f = device.frame, c = device.controls
  return f?.colour_gains?.length === 2 ? [f.colour_gains[0], f.colour_gains[1]] : c ? [c.ColourGains[0], c.ColourGains[1]] : [1, 1]
}
async function tuningParams(): Promise<RawDevelopRequest['params']> {
  try { return developParamsFromTuning(await device.client.call('camera.get_tuning')) } catch { return {} }
}
async function fetchRaw(say: Say, label = 'RAW'): Promise<Uint8Array> {
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
function runRawWorker<T>(req: RawDevelopRequest, say: Say, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const w = new Worker(new URL('../../workers/rawWorker.ts', import.meta.url), { type: 'module' })
    w.onmessage = (ev) => {
      if (ev.data.progress) say(`${label}: ${ev.data.progress}`)
      else if (ev.data.error) { reject(new Error(ev.data.error)); w.terminate() }
      else if (ev.data.result) { resolve(ev.data.result); w.terminate() }
    }
    w.onerror = (e) => { reject(new Error(e.message)); w.terminate() }
    w.postMessage(req, [req.buffer])
  })
}
