/** Measurement tool state, shared by the live view (`routes/Live.svelte` + `components/StreamView.svelte`)
 *  and the gallery viewer (`components/Viewer.svelte`). Points are kept as image fractions (0..1, origin
 *  top-left) plus the natural width/height of the image they were clicked on, so a result survives pan
 *  and zoom; the µm conversion (`lib/algo/measure.ts`) happens at commit time using whatever scale
 *  (`lib/store/scaleCal.svelte.ts`) is active for that image. Distance results also keep the raw pixel
 *  length and reference width so they can seed "calibrate from a known length" even with no scale yet. */

import { distance, polygonArea, polygonPerimeter, angleDeg, type Pt } from '../algo/measure'

export type MeasureMode = 'distance' | 'polygon' | 'angle'

export interface MeasureResult {
  id: string
  mode: MeasureMode
  when: string
  pixelLength?: number      // distance mode: raw px length (at referenceWidth) — usable for calibration
  referenceWidth: number
  distanceUm?: number
  areaUm2?: number
  perimeterUm?: number
  angleDeg?: number
}

function toPx(p: Pt, w: number, h: number): Pt { return { x: p.x * w, y: p.y * h } }

class MeasureService {
  active = $state(false)
  mode = $state<MeasureMode>('distance')
  points = $state<Pt[]>([])          // fractions, current in-progress measurement
  results = $state<MeasureResult[]>([])
  private imgW = 0
  private imgH = 0

  toggle(): void { this.active ? this.cancel() : this.start(this.mode) }

  start(mode: MeasureMode): void {
    this.mode = mode
    this.active = true
    this.points = []
  }

  /** Escape, or switching away: leave measurement mode without recording anything in progress. */
  cancel(): void {
    this.active = false
    this.points = []
  }

  /** A click while active. `umPerPx` may be null (not yet calibrated) — distance/pixel results still work. */
  addPoint(p: Pt, w: number, h: number, umPerPx: number | null): void {
    if (!this.active) return
    this.imgW = w; this.imgH = h
    this.points = [...this.points, p]
    if (this.mode === 'distance' && this.points.length === 2) this.commit(umPerPx)
    if (this.mode === 'angle' && this.points.length === 3) this.commit(umPerPx)
  }

  /** Double-click while active in polygon mode: close the shape and record it. */
  closePolygon(umPerPx: number | null): void {
    if (!this.active || this.mode !== 'polygon' || this.points.length < 3) return
    this.commit(umPerPx)
  }

  private commit(umPerPx: number | null): void {
    const w = this.imgW, h = this.imgH
    const px = this.points.map((p) => toPx(p, w, h))
    const scale = umPerPx ?? null
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const when = new Date().toISOString()
    let r: MeasureResult
    if (this.mode === 'distance') {
      const pixelLength = distance(px[0], px[1])
      r = { id, mode: this.mode, when, pixelLength, referenceWidth: w, distanceUm: scale ? pixelLength * scale : undefined }
    } else if (this.mode === 'angle') {
      r = { id, mode: this.mode, when, referenceWidth: w, angleDeg: angleDeg(px[0], px[1], px[2]) }
    } else {
      const umPts = scale ? px.map((p) => ({ x: p.x * scale, y: p.y * scale })) : px
      r = {
        id, mode: this.mode, when, referenceWidth: w,
        areaUm2: scale ? Math.abs(polygonArea(umPts)) : undefined,
        perimeterUm: scale ? polygonPerimeter(umPts) : undefined,
      }
    }
    this.results = [r, ...this.results]
    this.points = []   // stay active for the next measurement; Escape/toggle leaves the mode
  }

  removeResult(id: string): void { this.results = this.results.filter((r) => r.id !== id) }
  clearResults(): void { this.results = [] }
}

export const measure = new MeasureService()

export function resultToCsvRow(r: MeasureResult): string {
  const fields = [
    r.when, r.mode,
    r.distanceUm !== undefined ? r.distanceUm.toFixed(3) : '',
    r.areaUm2 !== undefined ? r.areaUm2.toFixed(3) : '',
    r.perimeterUm !== undefined ? r.perimeterUm.toFixed(3) : '',
    r.angleDeg !== undefined ? r.angleDeg.toFixed(2) : '',
    r.pixelLength !== undefined ? r.pixelLength.toFixed(2) : '',
  ]
  return fields.map((f) => `"${String(f).replace(/"/g, '""')}"`).join(',')
}

export function resultsToCsv(results: MeasureResult[]): string {
  const header = 'when,mode,distance_um,area_um2,perimeter_um,angle_deg,pixel_length'
  return [header, ...results.map(resultToCsvRow)].join('\n')
}
