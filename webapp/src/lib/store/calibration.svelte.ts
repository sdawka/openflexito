/** Browser-side calibration results (camera-stage mapping), persisted per device in localStorage. */

import type { Calibration1D, Mat2 } from '../algo/csm'
import { settings } from './settings.svelte'

export interface CsmCalibration {
  matrix: Mat2                    // image px -> stage steps
  imageWidth: number              // reference frame size the matrix was measured at
  imageHeight: number
  calX: Calibration1D
  calY: Calibration1D
  when: string
}

const key = () => 'openflexito.csm.' + (settings.deviceUrl || 'local')

function load(): CsmCalibration | null {
  try { const raw = localStorage.getItem(key()); return raw ? JSON.parse(raw) : null } catch { return null }
}

export const calibration = $state<{ csm: CsmCalibration | null }>({ csm: load() })

export function saveCsm(c: CsmCalibration | null): void {
  calibration.csm = c
  try { c ? localStorage.setItem(key(), JSON.stringify(c)) : localStorage.removeItem(key()) } catch { /* ignore */ }
}
