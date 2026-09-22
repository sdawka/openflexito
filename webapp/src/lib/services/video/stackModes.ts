/** Signal-quality video modes: temporal denoise, long exposure (sliding mean), temporal median,
 *  software binning and lucky imaging. All are pure per-frame transforms over `algo/videoStack.ts`,
 *  `algo/binning.ts` and `algo/temporalDenoise.ts`; none moves the stage. */

import type { RgbaFrame } from '../frameChain'
import type { VideoModeRun, ModeFrameInfo, ModeOutput } from './types'
import { SlidingMean, ExpIntegrator, TemporalMedian, QualityGate, frameSharpness } from '../../algo/videoStack'
import { binRgba, binnedSize, type BinKernel } from '../../algo/binning'
import { TemporalDenoiser } from '../../algo/temporalDenoise'
import { StageShiftTracker, OutBuffer } from './common'

export interface DenoiseParams { alpha: number }
export function denoiseMode(p: DenoiseParams): VideoModeRun {
  let den: TemporalDenoiser | null = null
  const shift = new StageShiftTracker()
  let frames = 0
  return {
    id: 'denoise',
    process(f: RgbaFrame): ModeOutput {
      if (!den) den = new TemporalDenoiser({ alpha: p.alpha, maxShiftPx: 60 })
      frames++
      const out = den.push(f.data, f.width, f.height, shift.next())
      return { frame: { data: out, width: f.width, height: f.height } }
    },
    reset() { den?.reset(); shift.reset() },
    status: () => `${frames} frames · α ${p.alpha}`,
    stats: () => ({ frames, alpha: p.alpha }),
  }
}

export interface IntegrateParams { frames: number; kind: 'mean' | 'exp' }
export function integrateMode(p: IntegrateParams): VideoModeRun {
  let mean: SlidingMean | null = null
  let exp: ExpIntegrator | null = null
  let n = 0
  return {
    id: 'integrate',
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
    status: () => `${p.kind === 'exp' ? 'exponential' : 'sliding'} · ${Math.min(n, p.frames)}/${p.frames} frames · noise ÷${Math.sqrt(Math.min(n, p.frames) || 1).toFixed(1)}`,
    stats: () => ({ frames: n, window: p.frames, kind: p.kind }),
  }
}

export interface MedianParams { frames: 3 | 5 }
export function medianMode(p: MedianParams): VideoModeRun {
  let med: TemporalMedian | null = null
  let n = 0
  return {
    id: 'median',
    process(f: RgbaFrame): ModeOutput {
      n++
      if (!med || med.width !== f.width || med.height !== f.height) med = new TemporalMedian(f.width, f.height, p.frames)
      return { frame: { data: med.push(f.data), width: f.width, height: f.height } }
    },
    reset() { med?.reset() },
    status: () => `median of ${p.frames} · ${n} frames`,
    stats: () => ({ frames: n, window: p.frames }),
  }
}

export interface BinParams { factor: 2 | 3 | 4; kernel: BinKernel }
export function binMode(p: BinParams): VideoModeRun {
  const out = new OutBuffer()
  let n = 0
  return {
    id: 'bin',
    outputSize: (w, h) => binnedSize(w, h, p.factor),
    process(f: RgbaFrame): ModeOutput {
      n++
      const { w, h } = binnedSize(f.width, f.height, p.factor)
      const r = binRgba(f.data, f.width, f.height, p.factor, p.kernel, out.get(w, h))
      return { frame: { data: r.data, width: r.width, height: r.height } }
    },
    status: () => `${p.factor}×${p.factor} ${p.kernel} · ${n} frames`,
    stats: () => ({ frames: n, factor: p.factor, kernel: p.kernel }),
  }
}

export interface LuckyParams { keep: number }
export function luckyMode(p: LuckyParams): VideoModeRun {
  const gate = new QualityGate(p.keep, 60, 8)
  let last = 0
  return {
    id: 'lucky',
    process(f: RgbaFrame, _info: ModeFrameInfo): ModeOutput | null {
      last = frameSharpness(f.data, f.width, f.height, 2)
      return gate.accept(last) ? { frame: f } : null
    },
    reset() { gate.reset() },
    status: () => `kept ${gate.kept}/${gate.seen} · sharpness ${last.toFixed(1)}${gate.threshold() != null ? ` ≥ ${gate.threshold()!.toFixed(1)}` : ' (learning)'}`,
    stats: () => ({ kept: gate.kept, seen: gate.seen, keep: p.keep }),
  }
}
