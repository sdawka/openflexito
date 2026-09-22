/** Signal-quality video modes: temporal denoise (soft Wiener merge), long exposure (sliding mean /
 *  exponential), temporal median, software binning and lucky imaging. Pure per-frame transforms
 *  over `algo/burstMerge.ts`, `algo/videoStack.ts` and `algo/binning.ts`; none moves the stage.
 *  The averaging modes lock the camera's AE/AWB for the recording (`lockExposure`, default on):
 *  a mean of N frames is only a longer exposure when every frame shares one gain, and the merge's
 *  noise curve assumes the noise floor does not jump (`docs/video-research/quality.md`, #5). */

import type { RgbaFrame } from '../frameChain'
import type { VideoModeRun, ModeFrameInfo, ModeOutput } from './types'
import { SlidingMean, ExpIntegrator, TemporalMedian, QualityGate, frameSharpness } from '../../algo/videoStack'
import { BurstMerge } from '../../algo/burstMerge'
import { binRgba, binnedSize, upscaleRgba, type BinKernel } from '../../algo/binning'
import { lockCamera, type CameraLock } from '../cameraLock'
import { StageShiftTracker, OutBuffer } from './common'

/** start/stop hooks that hold an AE/AWB lock for the recording when `on` */
function exposureLock(on: boolean): Pick<VideoModeRun, 'start' | 'stop'> & { locked(): boolean } {
  let lock: CameraLock | null = null
  return {
    async start() { if (on) lock = await lockCamera({ ae: true, awb: true }) },
    async stop() { await lock?.release(); lock = null },
    locked: () => !!lock?.locked.ae,
  }
}

export interface DenoiseParams { frames: number; c: number; lockExposure: boolean }
export function denoiseMode(p: DenoiseParams): VideoModeRun {
  const merge = new BurstMerge({ maxFrames: Math.max(2, p.frames), c: p.c, maxShiftPx: 60 })
  const shift = new StageShiftTracker()
  const lk = exposureLock(p.lockExposure)
  let n = 0
  return {
    id: 'denoise',
    compensatesStage: true,
    start: lk.start, stop: lk.stop,
    process(f: RgbaFrame): ModeOutput {
      n++
      const out = merge.push(f.data, f.width, f.height, shift.next())
      return { frame: { data: out, width: f.width, height: f.height } }
    },
    reset() { merge.reset(); shift.reset() },
    status: () => `${n} frames · averaging ${merge.meanCount.toFixed(1)}/${p.frames} · σ ${Math.sqrt(merge.sigma2[8]).toFixed(1)}${lk.locked() ? ' · AE locked' : ''}`,
    stats: () => ({ frames: n, maxFrames: p.frames, c: p.c, meanCount: +merge.meanCount.toFixed(2), sigmaMid: +Math.sqrt(merge.sigma2[8]).toFixed(2), lockedAe: lk.locked() }),
  }
}

export interface IntegrateParams { frames: number; kind: 'mean' | 'exp'; lockExposure: boolean }
export function integrateMode(p: IntegrateParams): VideoModeRun {
  let mean: SlidingMean | null = null
  let exp: ExpIntegrator | null = null
  const lk = exposureLock(p.lockExposure)
  let n = 0
  return {
    id: 'integrate',
    start: lk.start, stop: lk.stop,
    process(f: RgbaFrame): ModeOutput {
      n++
      if (p.kind === 'exp') {
        if (!exp || exp.width !== f.width || exp.height !== f.height) exp = new ExpIntegrator(f.width, f.height, 1 / Math.max(1, p.frames))
        return { frame: { data: exp.push(f.data), width: f.width, height: f.height } }
      }
      if (!mean || mean.width !== f.width || mean.height !== f.height || mean.n !== p.frames) mean = new SlidingMean(f.width, f.height, Math.max(1, p.frames))
      return { frame: { data: mean.push(f.data), width: f.width, height: f.height } }
    },
    reset() { mean?.reset(); exp?.reset() },
    status: () => `${p.kind === 'exp' ? `persistence 1/${p.frames}` : `mean of ${Math.min(n, p.frames)}/${p.frames}`} · noise ÷${Math.sqrt(Math.min(n, p.frames) || 1).toFixed(1)}${lk.locked() ? ' · AE locked' : ''}`,
    stats: () => ({ frames: n, window: p.frames, kind: p.kind, lockedAe: lk.locked() }),
  }
}

export interface MedianParams { frames: 3 | 5; lockExposure: boolean }
export function medianMode(p: MedianParams): VideoModeRun {
  let med: TemporalMedian | null = null
  const lk = exposureLock(p.lockExposure)
  let n = 0
  return {
    id: 'median',
    start: lk.start, stop: lk.stop,
    process(f: RgbaFrame): ModeOutput {
      n++
      if (!med || med.width !== f.width || med.height !== f.height) med = new TemporalMedian(f.width, f.height, p.frames)
      return { frame: { data: med.push(f.data), width: f.width, height: f.height } }
    },
    reset() { med?.reset() },
    status: () => `median of ${p.frames} · ${n} frames`,
    stats: () => ({ frames: n, window: p.frames, lockedAe: lk.locked() }),
  }
}

export interface BinParams { factor: 2 | 3 | 4; kernel: BinKernel; keepSize: boolean }
export function binMode(p: BinParams): VideoModeRun {
  const small = new OutBuffer(), big = new OutBuffer()
  let n = 0
  return {
    id: 'bin',
    outputSize: (w, h) => (p.keepSize ? { w, h } : binnedSize(w, h, p.factor)),
    process(f: RgbaFrame): ModeOutput {
      n++
      const { w, h } = binnedSize(f.width, f.height, p.factor)
      const r = binRgba(f.data, f.width, f.height, p.factor, p.kernel, small.get(w, h))
      if (!p.keepSize) return { frame: { data: r.data, width: r.width, height: r.height } }
      const u = upscaleRgba(r.data, r.width, r.height, f.width, f.height, big.get(f.width, f.height))
      return { frame: { data: u.data, width: u.width, height: u.height } }
    },
    status: () => `${p.factor}×${p.factor} ${p.kernel}${p.keepSize ? ' · upscaled to source size' : ''} · ${n} frames`,
    stats: () => ({ frames: n, factor: p.factor, kernel: p.kernel, keepSize: p.keepSize }),
  }
}

export interface LuckyParams { keep: number; fill: boolean; lockExposure: boolean }
/** Keeps the sharpest fraction of frames. `fill` repeats the last kept frame for a dropped one so
 *  the file plays at a constant rate (true frame times are kept when off). Exempt from the "never
 *  return the input buffer" rule: the frame is handed straight to the encoder unchanged. */
export function luckyMode(p: LuckyParams): VideoModeRun {
  const gate = new QualityGate(p.keep, 200, 8)
  const lk = exposureLock(p.lockExposure)
  const held = new OutBuffer()
  let hasHeld = false
  let last = 0
  return {
    id: 'lucky',
    start: lk.start, stop: lk.stop,
    process(f: RgbaFrame, _info: ModeFrameInfo): ModeOutput | null {
      last = frameSharpness(f.data, f.width, f.height, 2)
      if (gate.accept(last)) {
        if (p.fill) { held.get(f.width, f.height).set(f.data); hasHeld = true }
        return { frame: f }
      }
      if (p.fill && hasHeld) return { frame: held.frame(f.width, f.height) }
      return null
    },
    reset() { gate.reset() },
    status: () => `kept ${gate.kept}/${gate.seen} · sharpness ${last.toFixed(3)}${gate.threshold() != null ? ` ≥ ${gate.threshold()!.toFixed(3)}` : ' (learning)'}${p.fill ? ' · gaps filled' : ''}`,
    stats: () => ({ kept: gate.kept, seen: gate.seen, keep: p.keep, fill: p.fill, lockedAe: lk.locked() }),
  }
}
