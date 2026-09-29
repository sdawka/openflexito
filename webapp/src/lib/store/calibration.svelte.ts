/** Browser-side calibration results (camera-stage mapping), persisted per device in localStorage. */

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

export const calibration = $state<{ csm: CsmCalibration | null; flat: FlatFieldMap | null; rawFlatField: FlatFieldJson | null; z: ZCalibration | null }>({ csm: load(), flat: loadFlat(), rawFlatField: loadRawFlat(), z: loadZ() })

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
