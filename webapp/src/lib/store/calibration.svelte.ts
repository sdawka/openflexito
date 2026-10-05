/** Calibration results computed in the browser (camera-stage mapping, focus backlash/lag, flat fields,
 *  scan-derived shading). The microscope is the source of truth: `services/calibrationSync.svelte.ts`
 *  loads every key from the device's `calibration.get` on connect and each `save*` here pushes through
 *  `calibrationSync.push`, so all clients of one device share one calibration. localStorage (per device
 *  URL) is only a cache so the app has values before the socket opens and when the device is away. */

import type { Calibration1D, Mat2 } from '../algo/csm'
import { settings } from './settings.svelte'
import type { FlatFieldJson } from '../algo/flatField'

export interface CsmCalibration {
  matrix: Mat2                    // image px -> stage steps
  imageWidth: number              // reference frame size the matrix was measured at
  imageHeight: number
  calX: Calibration1D
  calY: Calibration1D
  when: string
}

/** Flat-field (blank-field illumination) map: relative illumination per pixel of a downscaled frame,
 *  mean 1, luminance (`channels` 1) or RGB (`channels` 3), row-major `data`. Tiles are divided by it
 *  before stitching (`algo/stitch.ts#applyFlatField`). Produced by a blank-field capture (see the
 *  Calibrate page once that exists); `null`/absent = none. Stored as a plain array for JSON. */
export interface FlatFieldMap { width: number; height: number; channels: 1 | 3; data: number[]; when: string; source?: string }

/** Focus calibration (`services/zCalibration.ts`): z backlash and the camera's frame lag. The
 *  backlash is applied to the device (`stage.set_backlash`); `lagNs` stays here and is passed to
 *  every timestamp → z interpolation (autofocus sweeps, the sweep focus stack). */
export interface ZCalibration {
  backlash: number
  lagNs: number
  repeatability: number
  /** stage step time of the slow sweeps and the fast one, µs */
  slowUs: number
  fastUs: number
  when: string
}

const zKey = () => 'openflexito.zcal.' + (settings.deviceUrl || 'local')
const key = () => 'openflexito.csm.' + (settings.deviceUrl || 'local')
const flatKey = () => 'openflexito.flat.' + (settings.deviceUrl || 'local')
const autoKey = () => 'openflexito.autoshading.' + (settings.deviceUrl || 'local')
const rawFlatKey = () => 'openflexito.rawflat.' + (settings.deviceUrl || 'local')

/** Device keys (`calibration.set {key}`) of each store slot. */
export const CAL_KEYS = { csm: 'csm', z: 'z', flat: 'flat', rawFlatField: 'raw_flat', autoShading: 'auto_shading' } as const
export type CalSlot = keyof typeof CAL_KEYS
/** Set by `services/calibrationSync.svelte.ts`; a save with `fromDevice` false pushes the value there. */
export const calibrationSync: { push: (key: string, value: object | null) => void } = { push: () => {} }
const cache = (k: string, v: unknown) => { try { v ? localStorage.setItem(k, JSON.stringify(v)) : localStorage.removeItem(k) } catch { /* ignore */ } }

function load(): CsmCalibration | null {
  try { const raw = localStorage.getItem(key()); return raw ? JSON.parse(raw) : null } catch { return null }
}
function loadZ(): ZCalibration | null {
  try { const raw = localStorage.getItem(zKey()); return raw ? JSON.parse(raw) : null } catch { return null }
}
function loadFlat(): FlatFieldMap | null {
  try { const raw = localStorage.getItem(flatKey()); return raw ? JSON.parse(raw) : null } catch { return null }
}
function loadRawFlat(): FlatFieldJson | null {
  try { const raw = localStorage.getItem(rawFlatKey()); return raw ? JSON.parse(raw) : null } catch { return null }
}

/** Illumination estimated from scan tiles (`algo/shading.ts`): relative illumination, mean 1, RGB. A
 *  fallback for `illuminationMap()` when no blank field has been measured. */
export interface AutoShading { width: number; height: number; channels: 3; data: number[]; when: string }
function loadAuto(): AutoShading | null {
  try { const raw = localStorage.getItem(autoKey()); return raw ? JSON.parse(raw) : null } catch { return null }
}

export const calibration = $state<{ csm: CsmCalibration | null; flat: FlatFieldMap | null; rawFlatField: FlatFieldJson | null; z: ZCalibration | null; autoShading: AutoShading | null }>({ csm: load(), flat: loadFlat(), rawFlatField: loadRawFlat(), z: loadZ(), autoShading: loadAuto() })

export function saveZCal(c: ZCalibration | null, fromDevice = false): void {
  calibration.z = c
  cache(zKey(), c)
  if (!fromDevice) calibrationSync.push(CAL_KEYS.z, c)
}

/** The stored frame lag for this device, ns (0 until the focus calibration has been applied). */
export function frameLagNs(): number {
  const l = calibration.z?.lagNs
  return typeof l === 'number' && Number.isFinite(l) ? l : 0
}

export function saveCsm(c: CsmCalibration | null, fromDevice = false): void {
  calibration.csm = c
  cache(key(), c)
  if (!fromDevice) calibrationSync.push(CAL_KEYS.csm, c)
}

export function saveFlat(f: FlatFieldMap | null, fromDevice = false): void {
  calibration.flat = f
  cache(flatKey(), f)
  if (!fromDevice) calibrationSync.push(CAL_KEYS.flat, f)
}

/** The measured per-channel flat field from `algo/flatField.ts` (a blank-field RAW capture): replaces
 *  the tuning file's ALSC tables in `rawdev.develop`, feeds DNG GainMap opcodes, and downscales for
 *  stitching. Stored as plain JSON (`flatFieldToJson`/`flatFieldFromJson`), never the Svelte `$state`
 *  proxy or a live `Float32Array` — see the module comment on `FlatField` in `algo/flatField.ts`. */
export function saveRawFlatField(f: FlatFieldJson | null, fromDevice = false): void {
  calibration.rawFlatField = f
  cache(rawFlatKey(), f)
  if (!fromDevice) calibrationSync.push(CAL_KEYS.rawFlatField, f)
}

/** The measured illumination map stitching divides its tiles by, in `algo/stitch.ts` `GainMap` shape
 *  (relative illumination, mean 1): the blank-field JPEG capture (`calibration.flat`) when there is
 *  one, else derived from the RAW per-channel flat field (1 / gain per channel), else `null`. Plain
 *  arrays, never `$state` proxies, so the result can be posted to the stitch worker as is. */
export function measuredIllumination(): { width: number; height: number; channels: 1 | 3; data: number[]; when?: string; source: 'flat' } | null {
  // Only the stream-domain flat applies to scan tiles: they are JPEGs the ISP has already lens-shading
  // corrected (ALSC from the tuning file), so dividing them by the RAW flat field (sensor-domain, before
  // the ISP) corrects the shading twice and paints the corners magenta. The RAW flat serves RAW develop.
  const f = calibration.flat
  if (f) return { width: f.width, height: f.height, channels: f.channels, data: Array.from(f.data), when: f.when, source: 'flat' }
  return null
}

/** Store the illumination estimated from a scan's tiles (plain JSON; typed arrays are copied). */
export function saveAutoShading(map: { width: number; height: number; channels: 3; data: ArrayLike<number> } | null, when = new Date().toISOString(), fromDevice = false): void {
  const v: AutoShading | null = map ? { width: map.width, height: map.height, channels: 3, data: Array.from(map.data, (x) => Math.round(x * 1e4) / 1e4), when } : null
  calibration.autoShading = v
  cache(autoKey(), v)
  if (!fromDevice) calibrationSync.push(CAL_KEYS.autoShading, v)
}

/** Apply a value that arrived from the device (no push back). `null` clears the slot. */
export function applyFromDevice(slot: CalSlot, value: unknown): void {
  const v = (value ?? null) as never
  switch (slot) {
    case 'csm': saveCsm(v, true); break
    case 'z': saveZCal(v, true); break
    case 'flat': saveFlat(v, true); break
    case 'rawFlatField': saveRawFlatField(v, true); break
    case 'autoShading': {
      const a = value as AutoShading | null
      saveAutoShading(a ? { width: a.width, height: a.height, channels: 3, data: a.data } : null, a?.when, true)
      break
    }
  }
}

export type IlluminationSource = 'flat' | 'raw' | 'auto'
export interface IlluminationMapJson { width: number; height: number; channels: 1 | 3; data: number[]; when?: string; source: IlluminationSource }

/** The relative-illumination map to correct images with: the measured one (`measuredIllumination`: a
 *  blank-field JPEG or RAW capture) when there is one, else the scan-derived estimate, else `null`. */
export function illuminationMap(): IlluminationMapJson | null {
  const m = measuredIllumination()
  if (m) return m
  const a = calibration.autoShading
  if (a) return { width: a.width, height: a.height, channels: 3, data: Array.from(a.data), when: a.when, source: 'auto' }
  return null
}

/** Cheap, reactive facts about `illuminationMap()` for code that must not build it per frame (the
 *  shading frame-chain processor's `enabled()`): `has` flips when a map appears or goes; `stamp.version`
 *  (plain, non-reactive) increments on every change so a cache can tell it is stale. */
export const illumination = $state({ has: illuminationMap() !== null })
export const illuminationStamp = { version: 0 }
$effect.root(() => {
  $effect(() => {
    const m = illuminationMap()   // reads calibration.flat / rawFlatField / autoShading
    illuminationStamp.version++
    illumination.has = m !== null
  })
})
