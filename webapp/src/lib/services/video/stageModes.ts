/** Video modes that move the stage while recording (`drivesStage`), built on
 *  `services/video/stageDither.ts`:
 *
 *  - `edof`: z dither ± `dz` steps around the current focus while `algo/liveStack.ts#LiveStacker`
 *    (in `workers/liveStackWorker.ts`) keeps, block by block, the sharpest content seen — an
 *    extended-depth-of-field video of a thick specimen. Output lags the input by a worker round-trip.
 *  - `sweep`: a slow triangular z sweep over ± `range` in `steps` stops (the video walks through the
 *    specimen's depth; turn on the position burn-in to read z off the frame).
 *  - `superres`: xy dither by half a pixel (via the stage↔camera calibration when present, one raw
 *    step otherwise) while `workers/videoSrWorker.ts` registers and drizzles the last `window` frames
 *    onto a 2× grid. The input is the central half of the frame, so the output has the source frame
 *    size: a 2× digital zoom that is actually resolved. Stabilisation is off (the dither is on purpose
 *    and the worker registers frames itself). Heavy: expect a few output frames per second. */

import { calibration } from '../../store/calibration.svelte'
import { pixelsToStage } from '../../algo/csm'
import type { RgbaFrame } from '../frameChain'
import type { VideoModeRun, ModeFrameInfo, ModeOutput } from './types'
import { StageDither, type DitherStep } from './stageDither'
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

export interface EdofParams { dz: number; dwellMs: number }
export function edofMode(p: EdofParams): VideoModeRun {
  type R = { composite: Uint8ClampedArray; width: number; height: number; stats: { frames: number; replaced: number; coverage: number } }
  let worker: LatestResultWorker<LiveStackMessage, R> | null = null
  let dither: StageDither | null = null
  let size: { w: number; h: number } | null = null
  let last: R | null = null
  let sent = 0
  return {
    id: 'edof',
    drivesStage: true,
    start() {
      dither = new StageDither([{ z: p.dz }, { z: 0 }, { z: -p.dz }, { z: 0 }], p.dwellMs)
      dither.start()
    },
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
    async stop() { await dither?.stop(); worker?.terminate(); worker = null },
    status: () => `z ${dither ? (dither.offset.z >= 0 ? '+' : '') + dither.offset.z : '—'} · ${last?.stats.frames ?? 0} frames stacked · ${Math.round((last?.stats.coverage ?? 0) * 100)} % covered`,
    stats: () => ({ dz: p.dz, framesSent: sent, framesStacked: last?.stats.frames ?? 0, coverage: last?.stats.coverage ?? 0, ditherError: dither?.error ?? undefined }),
  }
}

export interface SweepParams { range: number; steps: number; dwellMs: number }
export function sweepMode(p: SweepParams): VideoModeRun {
  let dither: StageDither | null = null
  const n = Math.max(2, p.steps)
  const up: DitherStep[] = Array.from({ length: n }, (_, i) => ({ z: Math.round(-p.range + (2 * p.range * i) / (n - 1)) }))
  const pattern = [...up, ...up.slice(1, -1).reverse()]
  return {
    id: 'sweep',
    drivesStage: true,
    start() { dither = new StageDither(pattern, p.dwellMs); dither.start() },
    async stop() { await dither?.stop() },
    status: () => `z ${dither ? (dither.offset.z >= 0 ? '+' : '') + dither.offset.z : '—'} of ±${p.range} · ${dither?.steps ?? 0} stops`,
    stats: () => ({ range: p.range, steps: p.steps, stops: dither?.steps ?? 0, ditherError: dither?.error ?? undefined }),
  }
}

export interface SuperresVideoParams { pixfrac: number; window: number }
export function superresVideoMode(p: SuperresVideoParams): VideoModeRun {
  type R = { data: Uint8ClampedArray; width: number; height: number; t: number | null; coverage: number; frames: number; rejected: number; fused: number }
  let worker: LatestResultWorker<VideoSrMessage, R> | null = null
  let dither: StageDither | null = null
  let last: R | null = null
  let crop: Uint8ClampedArray | null = null
  const cropSize = (w: number, h: number) => ({ w: Math.floor(w / 2) & ~1, h: Math.floor(h / 2) & ~1 })
  return {
    id: 'superres',
    drivesStage: true,
    disablesStabiliser: true,
    outputSize(w, h) { const c = cropSize(w, h); return { w: c.w * 2, h: c.h * 2 } },
    start() {
      // half-pixel offsets in image space → stage steps through the calibration, else one raw step
      const csm = calibration.csm
      const px: [number, number][] = [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]]
      const pattern: DitherStep[] = px.map(([x, y]) => {
        if (!csm) return { x: Math.round(x * 2), y: Math.round(y * 2) }
        const s = pixelsToStage(csm.matrix, [x, y])
        return { x: Math.round(s.x), y: Math.round(s.y) }
      })
      dither = new StageDither(pattern, 150)
      dither.start()
      worker = new LatestResultWorker(new Worker(new URL('../../workers/videoSrWorker.ts', import.meta.url), { type: 'module' }))
      worker.post({ type: 'init', scale: 2, pixfrac: p.pixfrac, window: p.window })
    },
    process(f: RgbaFrame, info: ModeFrameInfo): ModeOutput | null {
      if (!worker) return null
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
    reset() { worker?.post({ type: 'reset' }) },
    async stop() { await dither?.stop(); worker?.terminate(); worker = null },
    status: () => `${last?.fused ?? 0} fused · window ${last?.frames ?? 0}/${p.window} · coverage ${Math.round((last?.coverage ?? 0) * 100)} %${last?.rejected ? ` · ${last.rejected} restarts` : ''}${calibration.csm ? '' : ' · no calibration: 1-step dither'}`,
    stats: () => ({ fused: last?.fused ?? 0, rejected: last?.rejected ?? 0, window: p.window, pixfrac: p.pixfrac, calibrated: !!calibration.csm, ditherError: dither?.error ?? undefined }),
  }
}
