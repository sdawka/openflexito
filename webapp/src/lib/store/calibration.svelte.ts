/** Browser-side calibration results (camera-stage mapping), persisted per device in localStorage. */

import type { Calibration1D, Mat2 } from '../algo/csm'
import { settings } from './settings.svelte'
import { flatFieldToIllumination, type FlatFieldJson } from '../algo/flatField'

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

export function saveZCal(c: ZCalibration | null): void {
  calibration.z = c
  try { c ? localStorage.setItem(zKey(), JSON.stringify(c)) : localStorage.removeItem(zKey()) } catch { /* ignore */ }
}

/** The stored frame lag for this device, ns (0 until the focus calibration has been applied). */
export function frameLagNs(): number {
  const l = calibration.z?.lagNs
  return typeof l === 'number' && Number.isFinite(l) ? l : 0
}

export function saveCsm(c: CsmCalibration | null): void {
  calibration.csm = c
  try { c ? localStorage.setItem(key(), JSON.stringify(c)) : localStorage.removeItem(key()) } catch { /* ignore */ }
}

export function saveFlat(f: FlatFieldMap | null): void {
  calibration.flat = f
  try { f ? localStorage.setItem(flatKey(), JSON.stringify(f)) : localStorage.removeItem(flatKey()) } catch { /* ignore */ }
}

/** The measured per-channel flat field from `algo/flatField.ts` (a blank-field RAW capture): replaces
 *  the tuning file's ALSC tables in `rawdev.develop`, feeds DNG GainMap opcodes, and downscales for
 *  stitching. Stored as plain JSON (`flatFieldToJson`/`flatFieldFromJson`), never the Svelte `$state`
 *  proxy or a live `Float32Array` — see the module comment on `FlatField` in `algo/flatField.ts`. */
export function saveRawFlatField(f: FlatFieldJson | null): void {
  calibration.rawFlatField = f
  try { f ? localStorage.setItem(rawFlatKey(), JSON.stringify(f)) : localStorage.removeItem(rawFlatKey()) } catch { /* ignore */ }
}

/** The measured illumination map stitching divides its tiles by, in `algo/stitch.ts` `GainMap` shape
 *  (relative illumination, mean 1): the blank-field JPEG capture (`calibration.flat`) when there is
 *  one, else derived from the RAW per-channel flat field (1 / gain per channel), else `null`. Plain
 *  arrays, never `$state` proxies, so the result can be posted to the stitch worker as is. */
export function measuredIllumination(): { width: number; height: number; channels: 1 | 3; data: number[]; when?: string; source: 'flat' | 'raw' } | null {
  const f = calibration.flat
  if (f) return { width: f.width, height: f.height, channels: f.channels, data: Array.from(f.data), when: f.when, source: 'flat' }
  const r = calibration.rawFlatField
  if (r) {
    const ill = flatFieldToIllumination($state.snapshot(r))
    return { width: ill.width, height: ill.height, channels: 3, data: Array.from(ill.data), when: r.when, source: 'raw' }
  }
  return null
}

/** Store the illumination estimated from a scan's tiles (plain JSON; typed arrays are copied). */
export function saveAutoShading(map: { width: number; height: number; channels: 3; data: ArrayLike<number> } | null, when = new Date().toISOString()): void {
  const v: AutoShading | null = map ? { width: map.width, height: map.height, channels: 3, data: Array.from(map.data, (x) => Math.round(x * 1e4) / 1e4), when } : null
  calibration.autoShading = v
  try { v ? localStorage.setItem(autoKey(), JSON.stringify(v)) : localStorage.removeItem(autoKey()) } catch { /* ignore */ }
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
