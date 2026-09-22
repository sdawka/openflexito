/** Video modes that move the stage while recording (`drivesStage`), built on
 *  `services/video/stageDither.ts`:
 *
 *  - `edof`: z dither ± `dz` steps around the current focus while `algo/liveStack.ts#LiveStacker`
 *    (in `workers/liveStackWorker.ts`) keeps, block by block, the sharpest content seen — an
 *    extended-depth-of-field video of a thick specimen. Output lags the input by a worker round-trip.
 *  - `sweep`: a slow triangular z sweep over ± `range` in `steps` stops (the video walks through the
 *    specimen's depth; turn on the position burn-in to read z off the frame).
 *  - `superres`: sub-pixel xy dither while `workers/videoSrWorker.ts` registers and drizzles the
 *    last `window` frames of the central crop onto a `scale`× grid. The dither step vectors are the
 *    smallest integer stage steps whose image-space offsets have fractional parts near ½ (a naive
 *    `round(0.5 px → steps)` degenerates to two states when the calibration is near 1 px/step). With
 *    `dither` off it is *lucky drizzle*: no stage motion, the specimen's own jitter supplies the
 *    phases and a sharpness gate rejects blurred frames (works on a moving specimen).
 *  - `servo`: a focus servo for long recordings — every `periodS`, in a quiet moment, z is nudged
 *    ±δ, the sharpness at the three positions is fitted with a parabola and z moves to the vertex
 *    (clamped to ±δ, backlash-compensated on the final approach); the probe frames are replaced by
 *    the last good frame so the film never shows the search.
 *
 *  All stage-driving modes drop frames exposed during a move (`StageDither.settled()`), return the
 *  stage to its origin on stop, and lock AE/AWB for the run (a brightness change at the field edge
 *  from the dither would otherwise be chased by the camera's AE). */

import { device } from '../../store/device.svelte'
import { calibration } from '../../store/calibration.svelte'
import { invert2, apply2 } from '../../algo/csm'
import { frameSharpness, QualityGate } from '../../algo/videoStack'
import { lockCamera, type CameraLock } from '../cameraLock'
import type { RgbaFrame } from '../frameChain'
import type { VideoModeRun, ModeFrameInfo, ModeOutput } from './types'
import { StageDither, type DitherStep } from './stageDither'
import { OutBuffer, sleep } from './common'
import type { LiveStackMessage } from '../../workers/liveStackWorker'
import type { VideoSrMessage } from '../../workers/videoSrWorker'

/** Post-and-wait worker wrapper: `submit()` returns false while a result is pending, `take()` hands
 *  out the newest result once. */
class LatestResultWorker<M, R> {
  private worker: Worker
  private pending = false
  private result: R | null = null
  error: string | null = null
  /** `worker` must be constructed at the call site with the literal `new Worker(new URL('…', import.meta.url), { type: 'module' })`
   *  form, which is what Vite's static analysis needs to bundle it; a URL passed through a variable is not bundled. */
  constructor(worker: Worker) {
    this.worker = worker
    this.worker.onmessage = (ev: MessageEvent<R & { error?: string }>) => {
      this.pending = false
      if (ev.data.error) { this.error = ev.data.error; return }
      this.result = ev.data
    }
  }
  post(m: M, transfer: Transferable[] = []): void { this.worker.postMessage(m, transfer) }
  submit(m: M, transfer: Transferable[] = []): boolean {
    if (this.pending) return false
    this.pending = true
    this.worker.postMessage(m, transfer)
    return true
  }
  take(): R | null { const r = this.result; this.result = null; return r }
  terminate(): void { this.worker.terminate() }
}

const ditherNote = (d: StageDither | null) => (d?.error ? ` · STAGE ERROR: ${d.error} (pattern stopped)` : '')

export interface EdofParams { dz: number; dwellMs: number }
export function edofMode(p: EdofParams): VideoModeRun {
  type R = { composite: Uint8ClampedArray; width: number; height: number; stats: { frames: number; replaced: number; coverage: number } }
  let worker: LatestResultWorker<LiveStackMessage, R> | null = null
  let dither: StageDither | null = null
  let lock: CameraLock | null = null
  let size: { w: number; h: number } | null = null
  let last: R | null = null
  let sent = 0, dropped = 0
  return {
    id: 'edof',
    drivesStage: true,
    async start() {
      lock = await lockCamera({ ae: true, awb: true })
      dither = new StageDither([{ z: p.dz }, { z: 0 }, { z: -p.dz }, { z: 0 }], p.dwellMs)
      dither.start()
    },
    accept() { if (dither && !dither.settled()) { dropped++; return false } return true },
    process(f: RgbaFrame, info: ModeFrameInfo): ModeOutput | null {
      if (!worker) worker = new LatestResultWorker(new Worker(new URL('../../workers/liveStackWorker.ts', import.meta.url), { type: 'module' }))
      if (!size || size.w !== f.width || size.h !== f.height) { size = { w: f.width, h: f.height }; worker.post({ type: 'init', width: f.width, height: f.height, mode: 'stack' }) }
      const copy = new Uint8ClampedArray(f.data)
      if (worker.submit({ type: 'frame', data: copy }, [copy.buffer])) sent++
      const r = worker.take()
      if (!r) return null
      last = r
      return { frame: { data: r.composite, width: r.width, height: r.height }, t: info.t }
    },
    reset() { worker?.post({ type: 'reset' }) },
    async stop() { await dither?.stop(); worker?.terminate(); worker = null; await lock?.release(); lock = null },
    status: () => `z ${dither ? (dither.offset.z >= 0 ? '+' : '') + dither.offset.z : '—'} · ${last?.stats.frames ?? 0} frames stacked · ${Math.round((last?.stats.coverage ?? 0) * 100)} % covered · ${dropped} unsettled dropped${ditherNote(dither)}`,
    stats: () => ({ dz: p.dz, framesSent: sent, framesStacked: last?.stats.frames ?? 0, coverage: last?.stats.coverage ?? 0, unsettledDropped: dropped, ditherError: dither?.error ?? undefined }),
  }
}

export interface SweepParams { range: number; steps: number; dwellMs: number }
export function sweepMode(p: SweepParams): VideoModeRun {
  let dither: StageDither | null = null
  let lock: CameraLock | null = null
  let dropped = 0
  const n = Math.max(2, p.steps)
  const up: DitherStep[] = Array.from({ length: n }, (_, i) => ({ z: Math.round(-p.range + (2 * p.range * i) / (n - 1)) }))
  const pattern = [...up, ...up.slice(1, -1).reverse()]
  return {
    id: 'sweep',
    drivesStage: true,
    async start() { lock = await lockCamera({ ae: true, awb: true }); dither = new StageDither(pattern, p.dwellMs); dither.start() },
    accept() { if (dither && !dither.settled()) { dropped++; return false } return true },
    async stop() { await dither?.stop(); await lock?.release(); lock = null },
    status: () => `z ${dither ? (dither.offset.z >= 0 ? '+' : '') + dither.offset.z : '—'} of ±${p.range} · ${dither?.steps ?? 0} stops · ${dropped} unsettled dropped${ditherNote(dither)}`,
    stats: () => ({ range: p.range, steps: p.steps, stops: dither?.steps ?? 0, unsettledDropped: dropped, ditherError: dither?.error ?? undefined }),
  }
}

/** Smallest integer step count along one stage axis whose image offset has a fractional part closest
 *  to ½ px (searched 1..8 steps); null without a calibration. */
export function halfPixelSteps(axis: 'x' | 'y'): { steps: number; px: [number, number] } | null {
  const csm = calibration.csm
  if (!csm) return null
  let inv
  try { inv = invert2(csm.matrix) } catch { return null }
  let best: { steps: number; px: [number, number]; score: number } | null = null
  for (let k = 1; k <= 8; k++) {
    const px = apply2(inv, axis === 'x' ? [k, 0] : [0, k])
    const frac = (v: number) => Math.abs(((v % 1) + 1) % 1 - 0.5)   // 0 = exactly half a pixel
    const score = frac(px[0]) + frac(px[1]) + Math.hypot(px[0], px[1]) * 0.02   // prefer small moves
    if (!best || score < best.score) best = { steps: k, px, score }
  }
  return best ? { steps: best.steps, px: best.px } : null
}

export interface SuperresVideoParams { pixfrac: number; window: number; scale: 1.5 | 2; dither: boolean; keep: number; robust: boolean; robustK: number }
export function superresVideoMode(p: SuperresVideoParams): VideoModeRun {
  type R = { data: Uint8ClampedArray; width: number; height: number; t: number | null; coverage: number; frames: number; rejected: number; fused: number; robustRejectedFrac?: number }
  let worker: LatestResultWorker<VideoSrMessage, R> | null = null
  let dither: StageDither | null = null
  let lock: CameraLock | null = null
  let last: R | null = null
  let crop: Uint8ClampedArray | null = null
  let dropped = 0, gated = 0
  const gate = new QualityGate(p.keep, 200, 8)
  const cropSize = (w: number, h: number) => ({ w: Math.floor(w / p.scale) & ~1, h: Math.floor(h / p.scale) & ~1 })
  let pattern: DitherStep[] = []
  return {
    id: 'superres',
    drivesStage: p.dither,
    disablesStabiliser: true,
    outputSize(w, h) { const c = cropSize(w, h); return { w: Math.round(c.w * p.scale), h: Math.round(c.h * p.scale) } },
    async start() {
      lock = await lockCamera({ ae: true, awb: true })
      if (p.dither) {
        const sx = halfPixelSteps('x'), sy = halfPixelSteps('y')
        const ax = sx?.steps ?? 1, ay = sy?.steps ?? 1
        pattern = [{ x: 0, y: 0 }, { x: ax, y: 0 }, { x: ax, y: ay }, { x: 0, y: ay }]
        dither = new StageDither(pattern, 220)
        dither.start()
      }
      worker = new LatestResultWorker(new Worker(new URL('../../workers/videoSrWorker.ts', import.meta.url), { type: 'module' }))
      worker.post({ type: 'init', scale: p.scale, pixfrac: p.pixfrac, window: p.window, robust: p.robust, robustK: p.robustK })
    },
    accept() { if (dither && !dither.settled()) { dropped++; return false } return true },
    process(f: RgbaFrame, info: ModeFrameInfo): ModeOutput | null {
      if (!worker) return null
      if (!p.dither && !gate.accept(frameSharpness(f.data, f.width, f.height, 2))) { gated++; const r0 = worker.take(); return r0 ? { frame: { data: (last = r0).data, width: r0.width, height: r0.height }, t: r0.t } : null }
      const c = cropSize(f.width, f.height)
      const x0 = (f.width - c.w) >> 1, y0 = (f.height - c.h) >> 1
      if (!crop || crop.length !== c.w * c.h * 4) crop = new Uint8ClampedArray(c.w * c.h * 4)
      for (let y = 0; y < c.h; y++) crop.set(f.data.subarray(((y0 + y) * f.width + x0) * 4, ((y0 + y) * f.width + x0 + c.w) * 4), y * c.w * 4)
      const send = new Uint8ClampedArray(crop)
      worker.submit({ type: 'frame', data: send, width: c.w, height: c.h, t: info.t }, [send.buffer])
      const r = worker.take()
      if (!r) return null
      last = r
      return { frame: { data: r.data, width: r.width, height: r.height }, t: r.t }
    },
    reset() { worker?.post({ type: 'reset' }); gate.reset() },
    async stop() { await dither?.stop(); worker?.terminate(); worker = null; await lock?.release(); lock = null },
    status: () => `${last?.fused ?? 0} fused · window ${last?.frames ?? 0}/${p.window} · coverage ${Math.round((last?.coverage ?? 0) * 100)} %${last?.rejected ? ` · ${last.rejected} restarts` : ''}${p.robust && last?.robustRejectedFrac != null ? ` · ${Math.round(last.robustRejectedFrac * 100)} % rejected as motion` : ''}${p.dither ? (calibration.csm ? ` · dither ${pattern[1]?.x ?? 1}/${pattern[3]?.y ?? 1} steps · ${dropped} unsettled dropped` : ' · no calibration: 1-step dither') : ` · lucky gate kept ${gate.kept}/${gate.seen}`}${ditherNote(dither)}`,
    stats: () => ({ fused: last?.fused ?? 0, rejected: last?.rejected ?? 0, window: p.window, pixfrac: p.pixfrac, scale: p.scale, dither: p.dither, robust: p.robust, robustRejectedFrac: last?.robustRejectedFrac, calibrated: !!calibration.csm, unsettledDropped: dropped, gated, ditherError: dither?.error ?? undefined }),
  }
}

export interface ServoParams { periodS: number; delta: number; maxExcursion: number; hideProbe: boolean }
export function servoMode(p: ServoParams): VideoModeRun {
  let running = false
  let probing = false
  let loop: Promise<void> | null = null
  let lastSharp = 0, baseline = 0
  let nudges = 0, corrected = 0, excursion = 0, lost = false
  let lastUserMoveT = 0
  const held = new OutBuffer()
  let hasHeld = false
  let probeSamples: number[] = []
  let wantSample: ((v: number) => void) | null = null
  let logLine = 'waiting'

  const sampleSharpness = async (): Promise<number> => {
    await sleep(160)   // pipeline delay: skip the frames exposed before/while the move settled
    return new Promise<number>((r) => { wantSample = r })
  }
  const moveZ = (dz: number, compensate: 'z' | false = false) => device.moveRel({ z: dz }, compensate)

  async function run(): Promise<void> {
    while (running) {
      await sleep(p.periodS * 1000)
      if (!running) break
      if (device.moving || performance.now() - lastUserMoveT < 2000 || lost) { logLine = lost ? 'lost focus signal: holding z' : 'busy: nudge postponed'; continue }
      if (Math.abs(excursion) >= p.maxExcursion) { logLine = `excursion limit ±${p.maxExcursion} reached: holding z`; continue }
      probing = true
      try {
        const d = p.delta
        await moveZ(+d); const sPlus = await sampleSharpness()
        await moveZ(-2 * d); const sMinus = await sampleSharpness()
        await moveZ(+d); const s0 = await sampleSharpness()
        // parabola through (-d, sMinus), (0, s0), (+d, sPlus): vertex at d·(sMinus − sPlus) / (2·(sMinus − 2s0 + sPlus))
        const denom = sMinus - 2 * s0 + sPlus
        let target = denom < 0 ? (d * (sMinus - sPlus)) / (2 * denom) : (sPlus > s0 && sPlus > sMinus ? d : sMinus > s0 && sMinus > sPlus ? -d : 0)
        target = Math.max(-d, Math.min(d, target))
        const step = Math.round(target)
        nudges++
        if (step !== 0) { await moveZ(step, 'z'); excursion += step; corrected += Math.abs(step) }
        baseline = Math.max(s0, sPlus, sMinus)
        logLine = `nudge ${nudges}: ${step >= 0 ? '+' : ''}${step} steps (metric ${sMinus.toFixed(3)} / ${s0.toFixed(3)} / ${sPlus.toFixed(3)})`
      } catch (e) { logLine = `servo: ${(e as Error).message}` }
      finally { probing = false; wantSample = null }
    }
  }

  return {
    id: 'servo',
    drivesStage: true,
    start() { running = true; loop = run() },
    process(f: RgbaFrame, info: ModeFrameInfo): ModeOutput | null {
      lastSharp = frameSharpness(f.data, f.width, f.height, 2)
      if (wantSample) { const r = wantSample; wantSample = null; r(lastSharp) }
      if (!probing) {
        if (device.moving) lastUserMoveT = performance.now()
        if (baseline === 0 && lastSharp > 0) baseline = lastSharp
        lost = baseline > 0 && lastSharp < 0.3 * baseline
        if (p.hideProbe) { held.get(f.width, f.height).set(f.data); hasHeld = true }
        return { frame: f }
      }
      if (p.hideProbe && hasHeld) return { frame: held.frame(f.width, f.height), t: info.t }
      return { frame: f }
    },
    async stop() { running = false; await loop?.catch(() => {}); if (excursion) { try { await moveZ(-excursion, 'z') } catch { /* reported by the device store */ } excursion = 0 } },
    status: () => `${probing ? 'probing focus' : 'watching'} · sharpness ${lastSharp.toFixed(3)} (baseline ${baseline.toFixed(3)}) · z offset ${excursion >= 0 ? '+' : ''}${excursion} · ${logLine}`,
    stats: () => ({ nudges, correctedSteps: corrected, finalExcursion: excursion, periodS: p.periodS, delta: p.delta, hideProbe: p.hideProbe }),
  }
}
