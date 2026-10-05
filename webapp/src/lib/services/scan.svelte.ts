/** Tile scan: the run lives here, not in the route, so leaving the Scan tab mid-scan neither loses
 *  the progress view nor the cancel button, and the region an operator marks from the Live tab
 *  (corner positions) is still there when they come back.
 *
 *  A scan is: plan a grid (`algo/scanPlan.ts`: N×M fields around the current position or the grid
 *  covering two marked corners, optional polygon clip, raster/snake/spiral order), lock AE/AWB for
 *  the whole run, visit every tile with an adaptive settle (∝ move length, min the configured value)
 *  and a stage-still check, focus it (none / autofocus every tile / coarse autofocus sub-grid +
 *  height map with an optional short local sweep around the predicted z), capture a stream frame
 *  or a full-res still, then stitch in a worker (robust position solve, shading removal — a measured
 *  flat field or one estimated from the tiles themselves — per-channel gain equalisation and an
 *  optional multi-band blend). Per-tile focus status is recorded in the gallery item;
 *  autofocus failures are counted and shown, never swallowed. Cancelling keeps what was captured
 *  and lets the operator stitch or discard it. The stage returns to where it started (x, y and z). */

import { fetchSnapshot } from '../api/snapshot'
import { waitForFrames, grabGray } from '../api/sampler'
import { device } from '../store/device.svelte'
import { calibration, measuredIllumination, saveAutoShading } from '../store/calibration.svelte'
import { settings } from '../store/settings.svelte'
import { buildScanPlan, fovRectNorm, scaleMatrix, settleForMove, type NormRect, type Point, type ScanOrder, type ScanPlan, type ScanRegion, type TilePlan } from '../algo/scanPlan'
import type { Mat2 } from '../algo/csm'
import { runAutofocus, measureSharpness } from './autofocusService'
import { stepAutofocus, curveQuality, type CurveQuality } from '../algo/autofocus'
import { depthOfFieldUm } from '../algo/stackPlan'
import { lockCamera, type CameraLock } from './cameraLock'
import { stitchInWorker } from './stitchService'
import { predictHeightMap, rejectOutliers, isSubGridCell, PlaneTracker, type HeightSample } from '../algo/heightMap'
import { deleteItem, makeThumb, newId, putBlob, putItem, type GalleryItem } from '../store/gallery'
import { activity } from './activity.svelte'

export type FocusMode = 'none' | 'every' | 'interpolate'
type TileFocus = NonNullable<NonNullable<GalleryItem['scan']>['tiles'][number]['focus']>

export interface ScanConfig extends ScanRegion {
  focusMode: FocusMode
  afStep: number           // interpolate: autofocus every Nth tile (plus the grid corners)
  afRange: number          // autofocus sweep, total steps
  localRefine: boolean     // interpolate: short Laplacian sweep around the predicted z
  localRange: number       // ± steps for that sweep
  settleMs: number         // minimum settle after each move
  fullRes: boolean         // full-resolution stills instead of stream frames
  refine: boolean          // stitch: refine positions by correlation
  gainEq: boolean          // stitch: equalise tile brightness
  multiband: boolean       // stitch: 3-level Laplacian blend
  shading: ShadingMode     // stitch: 'auto' (measured map if any, else estimated from the tiles), 'measured' only, 'off'
}
export type ShadingMode = 'auto' | 'measured' | 'off'

export const DEFAULT_CONFIG: ScanConfig = {
  extent: 'centre', cols: 3, rows: 3, cornerA: null, cornerB: null, overlap: 0.3, polygon: [], order: 'snake',
  focusMode: 'none', afStep: 3, afRange: 600, localRefine: true, localRange: 40,
  settleMs: 150, fullRes: true, refine: true, gainEq: true, multiband: false, shading: 'auto',
}
const STORAGE_KEY = 'openflexito.scan.config'

export type TileStatus = 'pending' | 'moving' | 'focusing' | 'capturing' | 'done' | 'failed'
export interface TileState {
  status: TileStatus
  z?: number
  focus?: TileFocus['status']
  /** why the focus quality gate refused the sweep (flat / multimodal / edge / few / suspect) */
  reason?: TileFocus['reason']
  error?: string
  /** object URL of a small thumbnail of the captured tile, for the map */
  thumb?: string
}

export type ScanPhase = 'idle' | 'capturing' | 'stitching' | 'returning' | 'done' | 'cancelled' | 'error'

/** What a finished scan leaves behind: the item, a preview URL, and the footprint it covered so the
 *  map can use the mosaic as an underlay for the next plan of the *same* footprint. */
export interface ScanResult {
  item: GalleryItem
  url: string
  footprint: { origin: Point; cols: number; rows: number; overlap: number; fovW: number }
  summary: string
}

const AF_TIME_S = 6, LOCAL_AF_TIME_S = 2.5
/** smallest sweep the plane tracker may shrink an autofocus to, in steps (also at least 6 DOF) */
const MIN_AF_RANGE = 60
const REASON_LABEL: Record<string, string> = { flat: 'flat curve', multimodal: 'several peaks', edge: 'peak at sweep edge', few: 'too few samples', suspect: 'off the plane', coarse: 'coarse sweep only' }

function loadConfig(): ScanConfig {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Partial<ScanConfig> & { useFlat?: boolean }
      // migrate the old `useFlat` checkbox: on → measured map only, off → self-calibrating
      if (saved.shading == null && typeof saved.useFlat === 'boolean') saved.shading = saved.useFlat ? 'measured' : 'auto'
      delete saved.useFlat
      return { ...DEFAULT_CONFIG, ...saved }
    }
  } catch { /* private mode, corrupt json */ }
  return { ...DEFAULT_CONFIG }
}

const round2 = (x: number) => Math.round(x * 100) / 100
export const fmtTime = (s: number) => (s < 90 ? `${Math.round(s)} s` : `${(s / 60).toFixed(1)} min`)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class ScanService {
  cfg = $state<ScanConfig>(loadConfig())

  running = $state(false)
  phase = $state<ScanPhase>('idle')
  message = $state('')
  done = $state(0)
  total = $state(0)
  tiles = $state<TileState[]>([])
  result = $state<ScanResult | null>(null)
  /** a cancelled run with tiles in hand, waiting for "stitch" or "discard" */
  captured = $state(0)
  /** the plan frozen at start(); the live plan follows the stage while idle */
  private activePlan = $state<ScanPlan | null>(null)
  private startedAt = $state(0)
  private now = $state(0)
  private tickTimer: ReturnType<typeof setInterval> | undefined

  private cancelFlag = false
  private blobs: { blob: Blob; x: number; y: number; width: number; height: number }[] = []
  private item: GalleryItem | null = null
  private runFov: { w: number; h: number } = { w: 0, h: 0 }
  private thumbUrls: string[] = []

  // ---- geometry ---------------------------------------------------------------------------

  readonly streamSize = $derived<[number, number]>((device.status?.camera?.stream_size as [number, number] | undefined) ?? [1640, 1232])
  readonly fov = $derived<[number, number]>(this.cfg.fullRes ? [3280, 2464] : this.streamSize)
  /** calibration matrix expressed for the tile pixel size (it was measured on a downsampled frame) */
  readonly matrix = $derived<Mat2 | null>(calibration.csm ? scaleMatrix(calibration.csm.matrix, calibration.csm.imageWidth, this.fov[0]) : null)
  readonly ready = $derived(!!this.matrix)

  /** The plan the next Start would run, anchored on the stage's current position in centre mode. */
  readonly livePlan = $derived.by((): ScanPlan | null => {
    if (!this.matrix) return null
    return buildScanPlan(this.cfg, this.fov[0], this.fov[1], this.matrix, { x: device.position.x, y: device.position.y })
  })
  /** what the page shows: the frozen plan while running (or awaiting a stitch decision), else the live one */
  readonly plan = $derived<ScanPlan | null>(this.activePlan ?? this.livePlan)
  /** the current field of view inside the plan's box (moves with the stage, also during a run) */
  readonly here = $derived<NormRect | null>(this.plan && this.matrix ? fovRectNorm(this.plan, this.matrix, device.position) : null)
  /** per-run focus outcome for the status line: "focus: 7 measured, 2 predicted (flat curve)" */
  readonly focusSummary = $derived.by((): string => {
    if (this.cfg.focusMode === 'none') return ''
    const by: Record<string, { n: number; reasons: Set<string> }> = {}
    for (const t of this.tiles) {
      if (!t.focus || t.focus === 'none') continue
      const e = (by[t.focus] ??= { n: 0, reasons: new Set() })
      e.n++
      if (t.reason) e.reasons.add(REASON_LABEL[t.reason] ?? t.reason)
    }
    const parts = (['measured', 'refined', 'predicted', 'failed'] as const).filter((k) => by[k]).map((k) => `${by[k].n} ${k}${by[k].reasons.size ? ` (${[...by[k].reasons].join(', ')})` : ''}`)
    return parts.length ? `focus: ${parts.join(', ')}` : ''
  })
  readonly cornersReady = $derived(!!(this.cfg.cornerA && this.cfg.cornerB))

  readonly subgridStep = $derived(Math.max(1, Math.round(this.cfg.afStep)))
  readonly subgridCount = $derived(this.cfg.focusMode === 'interpolate' && this.plan
    ? this.plan.tiles.filter((t) => isSubGridCell(t.col, t.row, this.plan!.cols, this.plan!.rows, this.subgridStep)).length : 0)

  /** Rough pre-run estimate: settle + capture per tile, one autofocus sweep for each tile that gets
   *  one, plus the short local sweep for the interpolated tiles when enabled. */
  readonly estimateS = $derived.by(() => {
    const n = this.plan?.tiles.length ?? 0
    if (!n) return 0
    const captureS = this.cfg.fullRes ? 1.4 : 0.4
    const perTile = this.cfg.settleMs / 1000 + captureS + 0.3
    const afCount = this.cfg.focusMode === 'every' ? n : this.cfg.focusMode === 'interpolate' ? this.subgridCount : 0
    const localCount = this.cfg.focusMode === 'interpolate' && this.cfg.localRefine ? n - this.subgridCount : 0
    return n * perTile + afCount * AF_TIME_S + localCount * LOCAL_AF_TIME_S
  })
  readonly elapsedS = $derived(this.startedAt ? Math.max(0, (this.now - this.startedAt) / 1000) : 0)
  /** remaining time: measured per-tile pace once a tile is in, the estimate before that */
  readonly remainingS = $derived.by(() => {
    if (!this.running || this.phase !== 'capturing') return 0
    if (this.done > 0) return (this.elapsedS / this.done) * (this.total - this.done)
    return this.estimateS
  })

  /** The last mosaic covers exactly the plan on screen: same grid centre (the stage went back to it),
   *  grid, overlap and tile size. Then it can sit under the map and a polygon drawn on it means
   *  what it looks like it means. Overview-then-region is the intended workflow. */
  readonly underlay = $derived.by((): string | null => {
    const r = this.result, p = this.plan
    if (!r || !p || r.item.scan?.partial) return null   // a partial mosaic covers only part of the box
    const f = r.footprint
    if (f.cols !== p.cols || f.rows !== p.rows || f.overlap !== this.cfg.overlap || f.fovW !== p.fov.w) return null
    if (Math.abs(f.origin.x - p.origin.x) > 2 || Math.abs(f.origin.y - p.origin.y) > 2) return null
    return r.url
  })

  /** per-tile states for the map: only while they belong to the plan on screen (a run in progress
   *  or awaiting a stitch decision, or a finished scan whose mosaic still underlays the same plan) */
  readonly tileStates = $derived<TileState[]>(this.activePlan || this.underlay ? this.tiles : [])

  // ---- config helpers ------------------------------------------------------------------------

  persist(): void {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.cfg)) } catch { /* private mode etc. */ }
  }
  markCorner(which: 'A' | 'B'): void {
    const p = { x: device.position.x, y: device.position.y }
    if (which === 'A') this.cfg.cornerA = p; else this.cfg.cornerB = p
  }
  clearCorners(): void { this.cfg.cornerA = null; this.cfg.cornerB = null }
  /** drive to a marked corner (raw move: it is navigation, like a jog) */
  async goToCorner(which: 'A' | 'B'): Promise<void> {
    const p = which === 'A' ? this.cfg.cornerA : this.cfg.cornerB
    if (!p || this.running) return
    await device.moveTo({ x: p.x, y: p.y }, false)
  }
  setPolygon(points: Point[]): void { this.cfg.polygon = points }
  setOrder(order: ScanOrder): void { this.cfg.order = order }

  // ---- the run ------------------------------------------------------------------------------

  private tileIndexOf = new Map<number, number>()   // TilePlan.index -> position in this.tiles
  private setTile(t: TilePlan, patch: Partial<TileState>): void {
    const i = this.tileIndexOf.get(t.index)
    if (i === undefined) return
    this.tiles[i] = { ...this.tiles[i], ...patch }
  }

  /** Wait until the stage reports it is not moving (position events), with a timeout. */
  private async waitStageStill(timeoutMs = 5000): Promise<void> {
    const t0 = performance.now()
    while (device.moving && performance.now() - t0 < timeoutMs) await sleep(40)
    if (device.moving) {
      // the event stream may have missed the final position event: ask the device directly
      try { const s = await device.stageStatus(); if (!s.moving) return } catch { /* fall through */ }
      throw new Error('stage still moving after the settle time')
    }
  }

  private resetRunState(): void {
    for (const u of this.thumbUrls) URL.revokeObjectURL(u)
    this.thumbUrls = []
    this.blobs = []; this.item = null; this.captured = 0
    this.tiles = []; this.done = 0; this.total = 0
    this.tileIndexOf.clear()
  }

  /** Start a scan of the current plan. `overview` runs a quick version (stream frames, no focus,
   *  feather blend) whose mosaic then underlays the map so a polygon can be drawn on it. */
  async start(opts: { overview?: boolean } = {}): Promise<void> {
    if (this.running || !this.matrix || !this.livePlan?.tiles.length) return
    const cfg: ScanConfig = opts.overview
      ? { ...$state.snapshot(this.cfg), fullRes: false, focusMode: 'none', multiband: false }
      : $state.snapshot(this.cfg)
    const fovW = cfg.fullRes ? 3280 : this.streamSize[0], fovH = cfg.fullRes ? 2464 : this.streamSize[1]
    const matrix = calibration.csm ? scaleMatrix(calibration.csm.matrix, calibration.csm.imageWidth, fovW) : null
    if (!matrix) return
    const plan = buildScanPlan(cfg, fovW, fovH, matrix, { x: device.position.x, y: device.position.y })
    if (!plan.tiles.length) return

    this.running = true; this.cancelFlag = false; this.phase = 'capturing'
    this.resetRunState()
    if (this.result) { URL.revokeObjectURL(this.result.url); this.result = null }
    this.activePlan = plan
    this.runFov = { w: fovW, h: fovH }
    this.total = plan.tiles.length
    this.tiles = plan.tiles.map(() => ({ status: 'pending' as TileStatus }))
    plan.tiles.forEach((t, i) => this.tileIndexOf.set(t.index, i))
    this.startedAt = Date.now(); this.now = this.startedAt
    this.tickTimer = setInterval(() => { this.now = Date.now() }, 1000)
    const releaseActivity = activity.hold('scan')

    const start = { ...device.position }   // where the operator was; the stage goes back here
    const id = newId()
    const mode = cfg.focusMode
    const step = this.subgridStep
    const polygonal = cfg.polygon.length >= 3
    const item: GalleryItem = {
      id, kind: 'scan',
      name: `${opts.overview ? 'Overview' : 'Scan'} ${plan.cols}×${plan.rows} ${new Date().toLocaleString()}`,
      when: new Date().toISOString(),
      position: { ...start, x: plan.origin.x, y: plan.origin.y }, controls: device.controls ?? undefined, blobs: [],
      scan: {
        cols: plan.cols, rows: plan.rows, overlap: cfg.overlap, tiles: [],
        focus: { mode, step: mode === 'interpolate' ? step : undefined, method: mode === 'interpolate' ? 'bilinear' : undefined },
        region: { mode: polygonal ? 'polygon' : 'rect', order: cfg.order, extent: cfg.extent, origin: plan.origin },
        focusFailures: 0,
        // z µm/step at scan time, if calibrated — persisted so HeightMapOverlay's legend keeps its
        // scale even if the stage is recalibrated later (see gallery.ts#GalleryItem.scan.zUmPerStep)
        zUmPerStep: settings.stageStepUm?.z,
      },
    }
    this.item = item
    const heightSamples: HeightSample[] = []
    let lock: CameraLock | null = null
    const say = (m: string) => { this.message = m }

    /** Move to the tile, settle (∝ move length), make sure the stage is still, optionally run
     *  something (autofocus, or a move to a predicted z plus a local sweep) that returns the z to
     *  record and how it was found, then capture and store. */
    const captureTile = async (t: TilePlan, afterSettle?: () => Promise<{ z?: number; zMeasured?: boolean; focus: TileFocus }>) => {
      const tag = `tile ${this.done + 1}/${this.total}`
      this.setTile(t, { status: 'moving' })
      say(`${tag}: moving`)
      const target = { x: plan.origin.x + t.stage.x, y: plan.origin.y + t.stage.y }
      const dist = Math.hypot(target.x - device.position.x, target.y - device.position.y)
      await device.moveTo(target, 'xy')   // v3 scans use XY_ONLY backlash compensation
      const settle = settleForMove(dist, cfg.settleMs)
      say(`${tag}: settling ${settle} ms`)
      await sleep(settle)
      await this.waitStageStill()
      let z: number | undefined, zMeasured: boolean | undefined, focus: TileFocus = { status: 'none' }
      if (afterSettle) {
        this.setTile(t, { status: 'focusing' })
        say(`${tag}: focusing`)
        const r = await afterSettle()
        z = r.z; zMeasured = r.zMeasured; focus = r.focus
        if (focus.status === 'failed') {
          item.scan!.focusFailures = (item.scan!.focusFailures ?? 0) + 1
          say(`${tag}: autofocus failed (${focus.error}), capturing anyway`)
        } else if (focus.reason) {
          say(`${tag}: focus curve refused (${REASON_LABEL[focus.reason] ?? focus.reason}), ${focus.status === 'predicted' ? 'using the plane prediction' : 'kept z'}`)
        }
        await this.waitStageStill()
      }
      this.setTile(t, { status: 'capturing' })
      say(`${tag}: waiting for a fresh frame`)
      await waitForFrames(2)
      say(`${tag}: capturing`)
      const blob = await fetchSnapshot({ full: cfg.fullRes })
      say(`${tag}: storing`)
      const key = `tile/${t.index}`
      await putBlob(id, key, blob)
      item.blobs.push(key)
      const zRec = z ?? device.position.z
      item.scan!.tiles.push({ ...t, x: t.pixel.x, y: t.pixel.y, width: fovW, height: fovH, blob: key, z: zRec, zMeasured, focus, settleMs: settle })
      this.blobs.push({ blob, x: t.pixel.x, y: t.pixel.y, width: fovW, height: fovH })
      this.done++; this.captured = this.blobs.length
      let thumb: string | undefined
      try { thumb = URL.createObjectURL(await makeThumb(blob, 192)); this.thumbUrls.push(thumb) } catch { /* the map just shows a tint */ }
      this.setTile(t, { status: focus.status === 'failed' ? 'failed' : 'done', z: zRec, focus: focus.status, reason: focus.reason, error: focus.error, thumb })
    }
    // ---- focus plane model, kept across the run for both focus modes ----------------------------
    const tracker = new PlaneTracker()
    const dofSteps = (() => {
      const um = settings.stageStepUm?.z
      return um && um > 0 ? Math.max(4, Math.round(depthOfFieldUm(settings.objectiveNA ?? 0.65) / um)) : 0
    })()
    /** Sweep size for the next autofocus: the tracker's suggested range once it has a plane (never
     *  below max(MIN_AF_RANGE, 6 DOF), never above the configured range), else the configured one. */
    const sweepRange = (): number => {
      if (!dofSteps || tracker.n < 3) return cfg.afRange
      const r = Math.round(2 * tracker.suggestRange(dofSteps))   // suggestRange is ± steps; the sweep size is the total
      if (!Number.isFinite(r)) return cfg.afRange
      return Math.min(cfg.afRange, Math.max(MIN_AF_RANGE, 6 * dofSteps, r))
    }
    const reasonOf = (q: CurveQuality): TileFocus['reason'] => q.reason
    /** A refused or failed measurement: fall back to the plane prediction when the tracker is
     *  confident there, else keep the z the sweep started from (reported as 'failed'). */
    const fallback = async (t: TilePlan, keepZ: number, why: string, reason: TileFocus['reason'], extra: Partial<TileFocus> = {}) => {
      const p = tracker.n >= 3 ? tracker.predict(t.col, t.row) : null
      try {
        if (p?.confident) {
          const zp = Math.round(p.z)
          await device.moveRel({ z: zp - device.position.z }, 'z')
          return { z: zp, zMeasured: false, focus: { status: 'predicted', reason, error: why, ...extra } as TileFocus }
        }
        await device.moveRel({ z: keepZ - device.position.z }, 'z')
      } catch { /* the capture proceeds wherever the stage is */ }
      return { z: device.position.z, zMeasured: false, focus: { status: 'failed', reason, error: why, ...extra } as TileFocus }
    }
    /** Feed an accepted measurement to the tracker. False when its innovation gate held it back. */
    const learn = (t: TilePlan, z: number): boolean => tracker.update(t.col, t.row, z).accepted

    const autofocusHere = async (t: TilePlan): Promise<{ z?: number; zMeasured?: boolean; focus: TileFocus }> => {
      const range = sweepRange()
      try {
        const p = tracker.n >= 3 ? tracker.predict(t.col, t.row) : null
        if (p?.confident) {
          await device.moveRel({ z: Math.round(p.z) - device.position.z }, 'z')
          await this.waitStageStill()
        }
        const centre = device.position.z
        try {
          // two-pass: coarse continuous sweep (FocusFoM, JPEG size only if the device sends none), then a
          // stepped fine pass on the configured at-rest metric at the stream's native width. The fine span
          // is half the sweep (the Laplacian peak is ~200 steps wide at half maximum on the IMX219 stream,
          // a quarter-range window sat on its slope and was refused as 'edge'/'flat').
          const fineRange = Math.min(range, Math.max(120, Math.round(range / 2)))
          const r = await runAutofocus({ mode: 'twopass', dz: range, fineRange, fineSteps: 9 })
          const metricName = `${r.metric}+${settings.focusMetric ?? 'laplacian'}`
          let q = r.quality, peakZ = r.peakZ, retried = false
          if (!q.ok && (q.reason === 'edge' || q.reason === 'flat')) {
            // one retry with a stepped pass only: recentred where the fine pass ended ('edge', the peak is
            // just outside the window) or twice as wide ('flat', the window missed the peak entirely)
            await this.waitStageStill()
            const span = q.reason === 'flat' ? Math.min(range, 2 * fineRange) : fineRange
            const s2 = await stepAutofocus({
              moveZ: (dz) => device.moveRel({ z: dz }, false),
              currentZ: () => device.position.z,
              measure: measureSharpness,
            }, span, 9)
            const q2 = curveQuality(s2.samples)
            if (q2.ok) { q = q2; peakZ = s2.peakZ; retried = true }
          }
          if (!q.ok) {
            const c = r.coarse
            if (c?.quality.ok) {
              // the fine pass found nothing it trusts but the coarse sweep did: its peak stands (reason 'coarse')
              await device.moveRel({ z: c.peakZ - device.position.z }, 'z')
              const ok = learn(t, c.peakZ)
              return { z: c.peakZ, zMeasured: true, focus: { status: 'measured', contrast: round2(c.quality.contrast), metric: r.metric, range, reason: ok ? 'coarse' : 'suspect' } }
            }
            return await fallback(t, centre, `focus curve refused (${REASON_LABEL[q.reason ?? ''] ?? q.reason}, contrast ${q.contrast.toFixed(2)})`, reasonOf(q), { contrast: round2(q.contrast), metric: metricName, range })
          }
          const ok = learn(t, peakZ)
          return { z: peakZ, zMeasured: true, focus: { status: 'measured', contrast: round2(q.contrast), metric: retried ? `${metricName} (retry)` : metricName, range, ...(ok ? {} : { reason: 'suspect' as const }) } }
        } catch (e) {
          // fastAutofocus throws on a featureless sweep (and has already returned to `centre`)
          const msg = (e as Error).message
          return await fallback(t, centre, msg, /featureless|no focus signal/.test(msg) ? 'flat' : undefined, { range })
        }
      } catch (e) {
        return { focus: { status: 'failed', error: (e as Error).message } }
      }
    }
    /** Height-map focus: move to the predicted z (Z_ONLY backlash correction, as v3's final approach),
     *  then optionally a 5-point sweep (the configured fine metric, full-width grab) over ±localRange
     *  steps to catch what the plane/bilinear model missed (tilt within the cell, a thick specimen).
     *  The refined z must pass the same curve gate, else the prediction stands. */
    const predictedFocus = (t: TilePlan, zTarget: number) => async (): Promise<{ z?: number; zMeasured?: boolean; focus: TileFocus }> => {
      await device.moveRel({ z: zTarget - device.position.z }, 'z')
      if (!cfg.localRefine || cfg.localRange <= 0) return { z: zTarget, zMeasured: false, focus: { status: 'predicted' } }
      try {
        await this.waitStageStill()
        const r = await stepAutofocus({
          moveZ: (dz) => device.moveRel({ z: dz }, false),
          currentZ: () => device.position.z,
          measure: measureSharpness,
        }, 2 * cfg.localRange, 5)
        const q = curveQuality(r.samples)
        if (!q.ok) {
          // stepAutofocus has already moved to its own peak; go back to the prediction
          await device.moveRel({ z: zTarget - device.position.z }, 'z')
          return { z: zTarget, zMeasured: false, focus: { status: 'predicted', reason: reasonOf(q), contrast: round2(q.contrast), range: 2 * cfg.localRange } }
        }
        const ok = learn(t, r.peakZ)
        return { z: r.peakZ, zMeasured: true, focus: { status: 'refined', contrast: round2(q.contrast), range: 2 * cfg.localRange, ...(ok ? {} : { reason: 'suspect' as const }) } }
      } catch (e) {
        return { z: zTarget, zMeasured: false, focus: { status: 'failed', error: `local refine: ${(e as Error).message}` } }
      }
    }

    try {
      say('locking exposure and white balance')
      try { lock = await lockCamera(); item.scan!.locked = lock.locked } catch (e) { say(`could not lock the camera: ${(e as Error).message}`) }
      const tiles = plan.tiles
      if (mode === 'interpolate') {
        const subgrid = tiles.filter((t) => isSubGridCell(t.col, t.row, plan.cols, plan.rows, step))
        const rest = tiles.filter((t) => !isSubGridCell(t.col, t.row, plan.cols, plan.rows, step))
        for (const t of subgrid) {
          if (this.cancelFlag) break
          await captureTile(t, async () => {
            const r = await autofocusHere(t)
            // only a measurement that passed the curve gate (and the plane tracker's) feeds the height map
            if (r.z !== undefined && r.zMeasured && r.focus.reason !== 'suspect') heightSamples.push({ col: t.col, row: t.row, z: r.z })
            return r
          })
        }
        const grid = !this.cancelFlag && heightSamples.length >= 3 ? predictHeightMap(plan.cols, plan.rows, rejectOutliers(heightSamples), 'bilinear', step) : null
        for (const t of rest) {
          if (this.cancelFlag) break
          if (grid) await captureTile(t, predictedFocus(t, Math.round(grid[t.row][t.col])))
          else await captureTile(t, async () => ({ focus: { status: 'failed', error: 'height map needs at least 3 focused tiles' } }))
        }
      } else {
        for (const t of tiles) {
          if (this.cancelFlag) break
          await captureTile(t, mode === 'every' ? () => autofocusHere(t) : undefined)
        }
      }
      this.recordFocusMeta(item, tracker, dofSteps)
      if (this.cancelFlag) {
        if (this.blobs.length >= 2) {
          this.phase = 'cancelled'
          say(`stopped after ${this.blobs.length} of ${this.total} tiles`)
        } else {
          await this.discardCaptured()
          this.phase = 'idle'; say('cancelled')
        }
        return
      }
      await this.stitch()
    } catch (e) {
      this.phase = 'error'
      say(`error: ${(e as Error).message}`)
    } finally {
      // also on error: the stage must not stay wherever the scan died, and z goes back too (autofocus
      // and the height map leave it elsewhere); the camera lock is released whatever happened
      const msg = this.message
      const phase = this.phase
      this.phase = 'returning'; say('returning to start')
      try { await device.moveTo(start, 'all'); this.message = msg } catch (e) { this.message = `${msg} · could not return to the start: ${(e as Error).message}` }
      await lock?.release((m) => (this.message = `${this.message} · ${m}`))
      this.phase = phase
      clearInterval(this.tickTimer); this.tickTimer = undefined; this.now = Date.now()
      releaseActivity()
      this.running = false
      if (this.phase !== 'cancelled') this.activePlan = null
    }
  }

  /** Persist what the focus model learned (additive `item.scan.focus` fields). */
  private recordFocusMeta(item: GalleryItem, tracker: PlaneTracker, dofSteps: number): void {
    const f = item.scan?.focus
    if (!f || f.mode === 'none') return
    const outcome = { measured: 0, predicted: 0, refined: 0, failed: 0, reasons: {} as Record<string, number> }
    for (const t of item.scan!.tiles) {
      const st = t.focus?.status
      if (st === 'measured' || st === 'predicted' || st === 'refined' || st === 'failed') outcome[st]++
      if (t.focus?.reason) outcome.reasons[t.focus.reason] = (outcome.reasons[t.focus.reason] ?? 0) + 1
    }
    const c = tracker.coefficients
    f.tracker = { n: tracker.n, coefficients: [c.a, c.b, c.c], residualRms: Number.isFinite(tracker.residualRms) ? Math.round(tracker.residualRms * 100) / 100 : 0 }
    f.dofSteps = dofSteps || undefined
    f.outcome = outcome
  }

  cancel(): void {
    if (!this.running) return
    this.cancelFlag = true
    void device.stop()
  }

  /** Stitch the tiles in hand (a completed run, or what a cancelled one captured) and save. */
  private async stitch(): Promise<void> {
    const item = this.item, plan = this.activePlan
    if (!item || !plan || !this.blobs.length) return
    const cfg = $state.snapshot(this.cfg)
    const partial = this.blobs.length < this.total
    this.phase = 'stitching'
    this.message = 'stitching…'
    const analysisWidth = this.runFov.w > 2000 ? 512 : 256
    const measured = cfg.shading === 'off' ? null : measuredIllumination()
    const res = await stitchInWorker({
      tiles: this.blobs, maxDim: 8192, analysisWidth, refine: cfg.refine, robust: true, gainEqualise: cfg.gainEq, multiband: cfg.multiband ? 3 : 0,
      shading: cfg.shading, overlap: cfg.overlap,
      flatField: measured ? { width: measured.width, height: measured.height, channels: measured.channels, data: measured.data } : null,
    }, (m) => (this.message = m))
    // remember a self-calibrated shading map (when the worker returns one: `shadingMap`) for later scans
    if (res.shading === 'auto' && res.shadingMap && res.shadingMap.channels === 3) saveAutoShading({ ...res.shadingMap, channels: 3 }, new Date().toISOString())
    const r3 = (g: number) => Math.round(g * 1000) / 1000
    item.scan!.positions = res.positions
    item.scan!.stitch = {
      pairs: res.pairs, dropped: res.dropped, gains: res.gains.map(r3), gainsRgb: res.gainsRgb.map((g) => [r3(g[0]), r3(g[1]), r3(g[2])] as [number, number, number]),
      blend: res.blend, flatField: res.flatField, shading: res.shading, shadingFit: res.shadingFit, analysisWidth,
    }
    if (partial) { item.scan!.partial = { captured: this.blobs.length, planned: this.total }; item.name = `${item.name} (partial ${this.blobs.length}/${this.total})` }
    item.width = res.width; item.height = res.height
    await putBlob(item.id, 'image', res.mosaic); item.blobs.push('image')
    await putBlob(item.id, 'thumb', await makeThumb(res.mosaic)); item.blobs.push('thumb')
    await putItem(item)
    const fails = item.scan!.focusFailures ?? 0
    const summary = `${res.width}×${res.height} px · ${res.pairs} overlaps refined${res.dropped ? `, ${res.dropped} rejected` : ''} · ${res.blend} blend · shading ${res.shading}${res.shadingFit ? ` (rms ${res.shadingFit.rms.toFixed(3)})` : ''} · scale ${res.scale.toFixed(2)}${fails ? ` · ${fails} tile(s) with failed autofocus` : ''}`
    this.result = {
      item, url: URL.createObjectURL(res.mosaic), summary,
      footprint: { origin: plan.origin, cols: plan.cols, rows: plan.rows, overlap: cfg.overlap, fovW: plan.fov.w },
    }
    this.phase = 'done'
    this.message = `saved to the gallery as "${item.name}"`
  }

  /** After a cancel: stitch the captured tiles into a partial mosaic. */
  async stitchCaptured(): Promise<void> {
    if (this.running || this.phase !== 'cancelled' || this.blobs.length < 2) return
    this.running = true
    const release = activity.hold('scan stitch')
    try { await this.stitch() } catch (e) { this.phase = 'error'; this.message = `error: ${(e as Error).message}` } finally {
      release(); this.running = false; this.activePlan = null; this.captured = 0; this.blobs = []
    }
  }

  /** After a cancel: drop the captured tiles (they were already written to the gallery store). */
  async discardCaptured(): Promise<void> {
    const item = this.item
    this.blobs = []; this.captured = 0; this.item = null
    if (item) { try { await deleteItem(item) } catch { /* nothing to see */ } }
    if (!this.running) { this.activePlan = null; this.phase = 'idle'; this.message = '' }
  }
}

export const scan = new ScanService()
