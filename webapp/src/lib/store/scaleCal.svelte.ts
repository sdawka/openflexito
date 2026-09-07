/** Pixel scale (µm/px) for the scale bar and measurement tool. Two sources, either of which yields a
 *  single µm/px figure at a reference image width (see `lib/algo/measure.ts`):
 *   - 'stage': derived from the CSM calibration (`lib/store/calibration.svelte.ts`) and the stage step
 *     size in Settings (`settings.stageStepUm`) — automatic once "Calibrate XY" has been run.
 *   - 'manual': the user measured a segment of known real-world length (e.g. on a stage micrometer)
 *     with the measurement tool and typed its length; persisted per device like the CSM calibration. */

import { settings } from './settings.svelte'
import { calibration } from './calibration.svelte'
import { umPerPixelFromStageCalibration, scaleForWidth } from '../algo/measure'

export interface ManualScale {
  umPerPx: number
  referenceWidth: number   // natural width of the image the measurement was made on
  when: string
}

const key = () => 'openflexito.scalecal.' + (settings.deviceUrl || 'local')

function load(): ManualScale | null {
  try { const raw = localStorage.getItem(key()); return raw ? JSON.parse(raw) : null } catch { return null }
}

export const scaleCal = $state<{ manual: ManualScale | null }>({ manual: load() })

export function saveManualScale(m: ManualScale | null): void {
  scaleCal.manual = m
  try { m ? localStorage.setItem(key(), JSON.stringify(m)) : localStorage.removeItem(key()) } catch { /* ignore */ }
}

export function clearManualScale(): void { saveManualScale(null) }

/** Record a manual calibration from a measured pixel length and its known real-world length in µm. */
export function setManualFromLength(pxLength: number, realUm: number, referenceWidth: number): void {
  if (!(pxLength > 0) || !(realUm > 0)) return
  saveManualScale({ umPerPx: realUm / pxLength, referenceWidth, when: new Date().toISOString() })
}

export interface Scale { umPerPx: number; referenceWidth: number; source: 'manual' | 'stage' }

/** The active scale, preferring a manual calibration over the derived stage one; null if neither is
 *  available (no CSM calibration yet and no manual measurement). */
export function currentScale(): Scale | null {
  if (scaleCal.manual) return { ...scaleCal.manual, source: 'manual' }
  const csm = calibration.csm
  if (!csm) return null
  const umPerPx = umPerPixelFromStageCalibration(csm.calX.pixelsPerStep, csm.calY.pixelsPerStep, settings.stageStepUm.x, settings.stageStepUm.y)
  if (!umPerPx) return null
  return { umPerPx, referenceWidth: csm.imageWidth, source: 'stage' }
}

/** µm/px at an arbitrary image width (e.g. the live stream's natural width, or a gallery item's). */
export function umPerPxAt(width: number): number | null {
  const s = currentScale()
  if (!s || !width) return null
  return scaleForWidth(s.umPerPx, s.referenceWidth, width)
}
