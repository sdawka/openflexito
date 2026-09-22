/** Motion-visualisation video modes over `algo/motionViz.ts` and `algo/eulerian.ts`: moving-object
 *  highlight, motion trails, temporal colour code and Eulerian motion magnification. Pure per-frame
 *  transforms; all reset when the stage moves (the recorder does that) because a pan makes the whole
 *  field "move". */

import type { RgbaFrame } from '../frameChain'
import type { VideoModeRun, ModeFrameInfo, ModeOutput } from './types'
import { BackgroundModel, MotionHistory, TemporalColorCode } from '../../algo/motionViz'
import { EulerianMagnifier, type EulerianOptions } from '../../algo/eulerian'
import { OutBuffer } from './common'

export interface MotionParams { sensitivity: number /* k·σ threshold, lower = more sensitive */; learn: number /* background adaptation per frame */ }
export function motionMode(p: MotionParams): VideoModeRun {
  let bg: BackgroundModel | null = null
  const out = new OutBuffer()
  let n = 0
  return {
    id: 'motion',
    process(f: RgbaFrame): ModeOutput {
      n++
      if (!bg || bg.width !== f.width || bg.height !== f.height) bg = new BackgroundModel(f.width, f.height, p.learn)
      const diff = bg.update(f.data, false)
      const o = out.get(f.width, f.height)
      bg.highlight(f.data, diff, o, p.sensitivity)
      return { frame: { data: o, width: f.width, height: f.height } }
    },
    reset() { bg?.reset() },
    status: () => `${n} frames · noise σ ${bg?.sigma.toFixed(1) ?? '—'}`,
    stats: () => ({ frames: n, sensitivity: p.sensitivity, learn: p.learn }),
  }
}

export interface TrailsParams { decay: number; sensitivity: number }
export function trailsMode(p: TrailsParams): VideoModeRun {
  let mh: MotionHistory | null = null
  const out = new OutBuffer()
  let n = 0
  return {
    id: 'trails',
    process(f: RgbaFrame): ModeOutput {
      n++
      if (!mh || mh.width !== f.width || mh.height !== f.height) mh = new MotionHistory(f.width, f.height, p.decay, p.sensitivity)
      const o = out.get(f.width, f.height)
      mh.update(f.data, o)
      return { frame: { data: o, width: f.width, height: f.height } }
    },
    reset() { mh?.reset() },
    status: () => `${n} frames · trail ~${Math.round(1 / (1 - p.decay))} frames`,
    stats: () => ({ frames: n, decay: p.decay }),
  }
}

export interface TimecodeParams { period: number; decay: number; map: string }
export function timecodeMode(p: TimecodeParams): VideoModeRun {
  let tc: TemporalColorCode | null = null
  const out = new OutBuffer()
  let n = 0
  return {
    id: 'timecode',
    process(f: RgbaFrame): ModeOutput {
      n++
      if (!tc || tc.width !== f.width || tc.height !== f.height) tc = new TemporalColorCode(f.width, f.height, p.period, p.decay, p.map)
      const o = out.get(f.width, f.height)
      tc.update(f.data, o)
      return { frame: { data: o, width: f.width, height: f.height } }
    },
    reset() { tc?.reset() },
    status: () => `${n} frames · hue cycle ${p.period} frames`,
    stats: () => ({ frames: n, period: p.period, decay: p.decay, map: p.map }),
  }
}

export type MagnifyParams = EulerianOptions
export function magnifyMode(p: MagnifyParams): VideoModeRun {
  let em: EulerianMagnifier | null = null
  const out = new OutBuffer()
  let n = 0
  return {
    id: 'magnify',
    process(f: RgbaFrame, info: ModeFrameInfo): ModeOutput {
      n++
      if (!em || em.width !== f.width || em.height !== f.height) em = new EulerianMagnifier(f.width, f.height, p)
      const o = out.get(f.width, f.height)
      em.update(f.data, (info.t ?? performance.now() * 1e6) / 1e9, o)
      return { frame: { data: o, width: f.width, height: f.height } }
    },
    reset() { em?.reset() },
    status: () => `${n} frames · ${p.fLo}–${p.fHi} Hz ×${p.alpha}`,
    stats: () => ({ frames: n, fLo: p.fLo, fHi: p.fHi, alpha: p.alpha }),
  }
}
