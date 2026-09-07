/** The sample currently on the stage: name, specimen, preparation and operator, kept per-browser in
 *  localStorage. Copied onto each gallery item at capture time (`saveSnapshot`/`saveVideo` in
 *  `store/gallery.ts`) so photos and videos remember what they were taken of. Edited from
 *  `components/SamplePanel.svelte`. */

const KEY = 'openflexito.sample'

export interface SampleRecord {
  name: string           // short label shown in the gallery, e.g. "Pond water A3"
  specimen: string       // organism / subject, e.g. "Paramecium"
  stain: string          // stain or preparation, e.g. "unstained, wet mount"
  slideId: string        // slide id / barcode text
  magnification: string  // objective / magnification label, e.g. "40x"
  operator: string
  notes: string
}

const defaults: SampleRecord = { name: '', specimen: '', stain: '', slideId: '', magnification: '', operator: '', notes: '' }

function load(): SampleRecord {
  try {
    const raw = localStorage.getItem(KEY)
    return raw ? { ...defaults, ...JSON.parse(raw) } : { ...defaults }
  } catch {
    return { ...defaults }
  }
}

export const sample = $state<SampleRecord>(load())

export function saveSample(): void {
  try { localStorage.setItem(KEY, JSON.stringify(sample)) } catch { /* private mode etc. */ }
}

/** True once any field has been filled in (an empty record is not worth attaching to items). */
export function hasSample(): boolean {
  return Object.values(sample).some((v) => v.trim() !== '')
}

/** A plain snapshot of the current sample for storage on a gallery item, or undefined if empty. */
export function currentSample(): SampleRecord | undefined {
  return hasSample() ? { ...sample } : undefined
}

export function clearSample(): void {
  Object.assign(sample, defaults)
  saveSample()
}
