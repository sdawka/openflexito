/** RAW photo modes: a single 10-bit develop, an on-device N-frame average (`√N` shot-noise reduction,
 *  device.md §2 `/raw.bin?frames=N`) and true HDR from a linear RAW exposure bracket (`/bracket.bin
 *  ?raw=1`, `algo/hdr.ts`). Split out of `photoService.ts` (shared with the focus-stack and
 *  super-resolution agents) so this file only touches RAW develop/DNG/HDR. */

import { fetchRawBufferWithProgress, fetchBracketBuffer } from '../../api/raw'
import { parseBracket, parseRaw } from '../../algo/raw'
import { developParamsFromTuning, developLinear, encodeRgb16, toRgba8, type DevelopOptions } from '../../algo/rawdev'
import { encodePng16 } from '../../algo/png16'
import type { RawDevelopRequest, RawDevelopResult } from '../../workers/rawWorker'
import { mergeHdr, toneMapReinhard, dynamicRangeStops, type HdrFrame } from '../../algo/hdr'
import { device } from '../../store/device.svelte'
import { calibration } from '../../store/calibration.svelte'
import { flatFieldFromJson, flatFieldFromRaw, flatFieldToJson, type FlatFieldOptions } from '../../algo/flatField'
import { saveRawFlatField } from '../../store/calibration.svelte'
import { saveSnapshot, type GalleryItem } from '../../store/gallery'
import { encodeRgba8, captureField, type Say, type PhotoMeta } from './common'

export function liveGains(): [number, number] {
  const f = device.frame, c = device.controls
  return f?.colour_gains?.length === 2 ? [f.colour_gains[0], f.colour_gains[1]] : c ? [c.ColourGains[0], c.ColourGains[1]] : [1, 1]
}

export async function tuningParams(): Promise<Pick<DevelopOptions, 'lsc' | 'ccm' | 'gammaCurve'>> {
  try { return developParamsFromTuning(await device.client.call('camera.get_tuning')) } catch { return {} }
}

/** The measured flat field (`calibration.rawFlatField`), or null when none has been captured. */
export function currentFlatField() {
  return calibration.rawFlatField ? flatFieldFromJson(calibration.rawFlatField) : null
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

/** Download `frames` sensor frames (device-averaged when `frames > 1`) and develop them in a worker
 *  to 16-bit RGB files (PNG + DNG). `frames = 1` is the plain single-shot RAW mode. */
async function developRawBuffer(say: Say, frames: number, label: string): Promise<{ result: RawDevelopResult; gains: [number, number] }> {
  const buffer = await fetchRawBufferWithProgress(say, { frames, label })
  const gains = liveGains(), params = await tuningParams()
  const model = `OpenFlexure openflexito ${device.status?.camera?.sensor?.model ?? 'camera'}`
  const result = await runRawWorker<RawDevelopResult>({ buffer, gains, params, model, flatField: currentFlatField(), want: 'files' }, say, label)
  return { result, gains }
}

async function saveRawResult(result: RawDevelopResult, gains: [number, number], meta: PhotoMeta, name: string): Promise<GalleryItem> {
  const preview = await encodeRgba8(result.preview)
  return saveSnapshot(result.png, {
    ...meta, name, thumbFrom: preview, size: { width: result.width, height: result.height },
    extra: {
      raw: { bitDepth: result.bitDepth, bayer: result.bayer, blackLevel: result.blackLevel, gains, applied: result.applied },
      capture: captureField(result.meta),
    },
    extraBlobs: { dng: result.dng, preview },
  })
}

/** Capture-flat-field action (device.md §2 `/flat.bin?frames=N`): take with the sample removed and the
 *  illumination as it will be used, average `frames` raw frames on the device, derive per-channel gain
 *  maps and store them (`calibration.rawFlatField`) so `rawdev.develop` uses them instead of the
 *  tuning's ALSC tables. Returns the field so a caller (a future Settings/Calibrate button) can show a
 *  before/after preview before committing — call `saveRawFlatField` again with `null` to discard it,
 *  it is already saved here as the new baseline. */
export async function captureFlatField(say: Say, frames = 4, opts: FlatFieldOptions = {}): Promise<ReturnType<typeof flatFieldFromRaw>> {
  say(`flat field: capturing ${frames} averaged blank-field frames…`)
  const buffer = await fetchRawBufferWithProgress(say, { frames, flat: true, label: 'flat field' })
  const raw = parseRaw(buffer)
  say('flat field: deriving gain maps…')
  const field = flatFieldFromRaw(raw, opts)
  saveRawFlatField(flatFieldToJson(field))
  say('flat field: saved; RAW develops and new DNGs will use it')
  return field
}

/** `mode: 'raw'` — one 10-bit develop of the sensor's native readout. */
export async function rawPhoto(say: Say, meta: PhotoMeta): Promise<GalleryItem> {
  const { result, gains } = await developRawBuffer(say, 1, 'RAW')
  return saveRawResult(result, gains, meta, `RAW ${result.bitDepth}-bit`)
}

/** `mode: 'rawavg'` — the device sums N raw frames in one mode switch and ships a 16-bit mean
 *  (device.md §2): the only real SNR win available, √N reduction in shot noise, no extra registration
 *  needed if the stage held still (the trailer's `frame_timestamps` let a caller check that later). */
export async function rawAveragePhoto(say: Say, meta: PhotoMeta, frames = 4): Promise<GalleryItem> {
  const n = Math.max(2, Math.min(8, Math.round(frames)))
  const { result, gains } = await developRawBuffer(say, n, `RAW average ×${n}`)
  return saveRawResult(result, gains, meta, `RAW average ×${n}`)
}

/** Resolve one bracket item's *requested* factor without trusting its position in the container: the
 *  device always writes each item's own `index` (its position among the frames it actually captured,
 *  device/openflexito/camera.py `_bracket_sync`'s `enumerate(zip(factors, exposures))`), so a bracket
 *  that arrived reordered — or only partially completed, fewer items than `factors` — still looks its
 *  factor up by that index rather than by array position `i`. Falls back to `i` only when `index` is
 *  missing or out of range. */
function bracketFactor(meta: Record<string, unknown>, i: number, factors: number[]): number | null {
  const rawIndex = meta.index
  const idx = typeof rawIndex === 'number' && Number.isInteger(rawIndex) && rawIndex >= 0 && rawIndex < factors.length ? rawIndex : i
  const f = typeof meta.factor === 'number' ? meta.factor : factors[idx]
  return typeof f === 'number' ? f : null
}

/** Resolve each bracket item's exposure for the HDR merge (`HdrFrame.exposure`, `algo/hdr.ts`).
 *  Correct-by-construction rather than index-trusting: each item's OWN `meta.exposure` is the real
 *  `ExposureTime` libcamera reported *for that captured frame* (device/openflexito/rawfmt.py
 *  `frame_meta` — read straight from the frame's metadata, not from what was requested), so it is
 *  preferred over the *requested* factor for every item where the whole bracket has it. A bracket
 *  reordered or truncated by a future/other device still pairs correctly either way: the real
 *  per-frame value doesn't depend on position at all, and the factor fallback (`bracketFactor`) looks
 *  up the requested factor by the item's own `index`, not its position in the array.
 *
 *  The whole bracket commits to ONE consistent unit rather than mixing them per item — `mergeHdr` only
 *  weighs frames relative to each other, so a µs value on one frame and a bare ratio on another would
 *  silently corrupt the merge:
 *    1. every item has its own real `meta.exposure` (µs) -> use those directly (best case).
 *    2. else the summary carries `base_exposure` (µs, the exposure the reference/factor-1 frame
 *       actually ran at) -> each item's real exposure when it has one, else `base_exposure * factor`
 *       (still µs, just estimated for that one item).
 *    3. else the bare requested factor for every item (a self-consistent ratio on its own, just not
 *       calibrated against a real exposure).
 *  An item with nothing usable under the chosen unit resolves to null so the caller drops it instead
 *  of silently mispairing an exposure with the wrong plane. */
export function resolveHdrExposures(items: { meta: Record<string, unknown> }[], factors: number[], summary: Record<string, unknown> | null): (number | null)[] {
  const real = items.map((it) => { const e = it.meta.exposure; return typeof e === 'number' && e > 0 ? e : null })
  if (real.every((e) => e != null)) return real
  const base = typeof summary?.base_exposure === 'number' && summary.base_exposure > 0 ? summary.base_exposure : null
  if (base != null) {
    return items.map((it, i) => {
      if (real[i] != null) return real[i]
      const f = bracketFactor(it.meta, i, factors)
      return f != null ? base * f : null
    })
  }
  return items.map((it, i) => bracketFactor(it.meta, i, factors))
}

/** `mode: 'hdrraw'` — true HDR from a linear RAW exposure bracket (device.md §3 `/bracket.bin?raw=1`):
 *  Debevec-weighted radiance merge (`algo/hdr.ts`), global Reinhard tone map, 16-bit PNG. Unlike the
 *  LED/exposure Mertens stack (`exposureStack.ts`) this is a real dynamic-range extension: the merged
 *  radiance is linear light in the units of the reference (factor-1) exposure. */
export async function hdrRawPhoto(say: Say, meta: PhotoMeta, factors = [0.25, 1, 4]): Promise<GalleryItem> {
  if (factors.length < 2) throw new Error('HDR RAW: at least two exposure factors are needed')
  say(`HDR RAW: capturing a ${factors.length}-frame linear-RAW exposure bracket…`)
  const { buffer, summary } = await fetchBracketBuffer({ factors, raw: true })
  const items = parseBracket(buffer)
  if (items.length < 2) throw new Error('HDR RAW: the device returned fewer than two exposures')
  const gains = liveGains(), params = await tuningParams()
  const flatField = currentFlatField()
  const exposures = resolveHdrExposures(items, factors, summary)
  say('HDR RAW: developing each exposure to linear RGB…')
  let width = 0, height = 0
  const frames: HdrFrame[] = []
  items.forEach((it, i) => {
    const exposure = exposures[i]
    if (exposure == null) { say(`HDR RAW: item ${i} has no usable exposure metadata, dropping it from the merge`); return }
    const raw = parseRaw(it.data.buffer as ArrayBuffer, it.data.byteOffset, it.data.byteLength)
    // highlights are the whole point of an HDR merge, so no highlight desaturation here: 'clip'
    // marks a channel's true saturation and mergeHdr's hat weight already discounts it.
    const lin = developLinear(raw, { gains: (raw.meta?.colour_gains as [number, number] | undefined) ?? gains, ccm: (raw.meta?.ccm as number[] | undefined) ?? params.ccm, lsc: params.lsc, flatField, highlights: 'clip' })
    if (!frames.length) { width = lin.width; height = lin.height }
    frames.push({ data: lin.data, exposure })
  })
  if (frames.length < 2) throw new Error('HDR RAW: fewer than two frames had usable exposure metadata')
  say('HDR RAW: merging radiance…')
  const radiance = mergeHdr(frames, width, height)
  say(`HDR RAW: merged (${dynamicRangeStops(radiance).toFixed(1)} stops), tone mapping…`)
  const toneMapped = toneMapReinhard(radiance, width, height)
  const encoded = encodeRgb16({ data: toneMapped, width, height }, { gammaCurve: params.gammaCurve })
  say('HDR RAW: encoding 16-bit PNG…')
  const png = await encodePng16(encoded.data, width, height)
  const preview = await encodeRgba8(toRgba8(encoded, 4))
  return saveSnapshot(png, {
    ...meta, name: `HDR RAW ×${factors.length}`, thumbFrom: preview, size: { width, height },
    extra: { capture: captureField(summary) },
    extraBlobs: { preview },
  })
}
