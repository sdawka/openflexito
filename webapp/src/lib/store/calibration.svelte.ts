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

const key = () => 'openflexito.csm.' + (settings.deviceUrl || 'local')
const flatKey = () => 'openflexito.flat.' + (settings.deviceUrl || 'local')
const rawFlatKey = () => 'openflexito.rawflat.' + (settings.deviceUrl || 'local')

function load(): CsmCalibration | null {
  try { const raw = localStorage.getItem(key()); return raw ? JSON.parse(raw) : null } catch { return null }
}
function loadFlat(): FlatFieldMap | null {
  try { const raw = localStorage.getItem(flatKey()); return raw ? JSON.parse(raw) : null } catch { return null }
}
function loadRawFlat(): FlatFieldJson | null {
  try { const raw = localStorage.getItem(rawFlatKey()); return raw ? JSON.parse(raw) : null } catch { return null }
}

export const calibration = $state<{ csm: CsmCalibration | null; flat: FlatFieldMap | null; rawFlatField: FlatFieldJson | null }>({ csm: load(), flat: loadFlat(), rawFlatField: loadRawFlat() })

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
