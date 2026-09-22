/** Motion-visualisation video modes over `algo/motionViz.ts`, `algo/eulerian.ts` and
 *  `algo/opticalFlow.ts`: moving-object highlight, motion trails, temporal colour code, z-projection
 *  over time, Eulerian motion magnification and dense optical flow. Pure per-frame transforms; all
 *  reset when the stage moves (the recorder does that) because a pan makes the whole field "move". */

import type { RgbaFrame } from '../frameChain'
import type { VideoModeRun, ModeFrameInfo, ModeOutput } from './types'
import { BackgroundModel, MotionHistory, TemporalColorCode, TimeProjection } from '../../algo/motionViz'
import { EulerianMagnifier, type EulerianOptions } from '../../algo/eulerian'
import { GridFlow, renderFlowHsv } from '../../algo/opticalFlow'
import { OutBuffer, StageShiftTracker } from './common'

export interface MotionParams { sensitivity: number /* k·σ threshold, lower = more sensitive */; learn: number /* background adaptation per frame */; background: 'median' | 'mean' }
export function motionMode(p: MotionParams): VideoModeRun {
  let bg: BackgroundModel | null = null
  const out = new OutBuffer()
  let n = 0
  return {
    id: 'motion',
    process(f: RgbaFrame): ModeOutput {
      n++
      if (!bg || bg.width !== f.width || bg.height !== f.height) bg = new BackgroundModel(f.width, f.height, p.learn, p.background === 'median', Math.max(0.1, p.learn * 16))
      const diff = bg.update(f.data, false)
      const o = out.get(f.width, f.height)
      bg.highlight(f.data, diff, o, p.sensitivity)
      return { frame: { data: o, width: f.width, height: f.height } }
    },
    reset() { bg?.reset() },
    status: () => `${n} frames · ${p.background} background · noise σ ${bg?.sigma.toFixed(1) ?? '—'}`,
    stats: () => ({ frames: n, sensitivity: p.sensitivity, learn: p.learn, background: p.background }),
  }
}

export interface TrailsParams { decay: number; sensitivity: number; source: 'frame' | 'background' }
export function trailsMode(p: TrailsParams): VideoModeRun {
  let mh: MotionHistory | null = null
  let bg: BackgroundModel | null = null
  const out = new OutBuffer()
  let n = 0
  return {
    id: 'trails',
    process(f: RgbaFrame): ModeOutput {
      n++
      if (!mh || mh.width !== f.width || mh.height !== f.height) mh = new MotionHistory(f.width, f.height, p.decay, p.sensitivity)
      if (p.source === 'background') {
        if (!bg || bg.width !== f.width || bg.height !== f.height) bg = new BackgroundModel(f.width, f.height, 0.03, true, 0.5)
        mh.source = bg.update(f.data)
        mh.k = p.sensitivity * 1.2
      } else mh.source = null
      const o = out.get(f.width, f.height)
      mh.update(f.data, o)
      return { frame: { data: o, width: f.width, height: f.height } }
    },
    reset() { mh?.reset(); bg?.reset() },
    status: () => `${n} frames · trail ~${Math.round(1 / (1 - p.decay))} frames · ${p.source} difference`,
    stats: () => ({ frames: n, decay: p.decay, source: p.source }),
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
      if (!tc || tc.width !== f.width || tc.height !== f.height) tc = new TemporalColorCode(f.width, f.height, p.period, p.decay >= 1 ? 1 : p.decay > 0 ? p.decay : undefined, p.map)
      const o = out.get(f.width, f.height)
      tc.update(f.data, o)
      return { frame: { data: o, width: f.width, height: f.height } }
    },
    reset() { tc?.reset() },
    status: () => `${n} frames · hue cycle ${p.period} frames · fade ${tc?.decay.toFixed(3) ?? '—'}`,
    stats: () => ({ frames: n, period: p.period, decay: tc?.decay ?? p.decay, map: p.map }),
  }
}

export interface ProjectParams { kind: 'max' | 'min' | 'range'; decay: number }
export function projectMode(p: ProjectParams): VideoModeRun {
  let pr: TimeProjection | null = null
  const out = new OutBuffer()
  let n = 0
  return {
    id: 'project',
    process(f: RgbaFrame): ModeOutput {
      n++
      if (!pr || pr.width !== f.width || pr.height !== f.height) pr = new TimeProjection(f.width, f.height, p.kind, p.decay)
      const o = out.get(f.width, f.height)
      pr.update(f.data, o)
      return { frame: { data: o, width: f.width, height: f.height } }
    },
    reset() { pr?.reset() },
    status: () => `${p.kind} projection over ${n} frames${p.decay < 1 ? ` · fading ${p.decay}` : ''}`,
    stats: () => ({ frames: n, kind: p.kind, decay: p.decay }),
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
    status: () => `${n} frames · ${p.fLo}–${em?.effectiveFHi().toFixed(1) ?? p.fHi} Hz ×${p.alpha}${em && em.effectiveFHi() < p.fHi - 0.05 ? ` (band clamped: ${em.fps.toFixed(0)} fps stream)` : ''}`,
    stats: () => ({ frames: n, fLo: p.fLo, fHi: em?.effectiveFHi() ?? p.fHi, alpha: p.alpha, fps: em ? +em.fps.toFixed(1) : undefined }),
  }
}

export interface FlowParams { cell: number; alpha: number; vMax: number }
export function flowMode(p: FlowParams): VideoModeRun {
  let gf: GridFlow | null = null
  const shift = new StageShiftTracker()
  const out = new OutBuffer()
  let n = 0, vMaxUsed = 0
  return {
    id: 'flow',
    process(f: RgbaFrame): ModeOutput {
      n++
      if (!gf || gf.width !== f.width || gf.height !== f.height) gf = new GridFlow(f.width, f.height, { analysisWidth: 205, cell: p.cell, alpha: p.alpha, tau: 40 })
      const s = shift.next(), k = gf.field.width / f.width
      const field = gf.update(f.data, { dx: s.dx * k, dy: s.dy * k })
      const o = out.get(f.width, f.height)
      vMaxUsed = renderFlowHsv(f.data, f.width, f.height, field, o, p.vMax)
      return { frame: { data: o, width: f.width, height: f.height } }
    },
    reset() { gf?.reset(); shift.reset() },
    status: () => { const st = gf?.stats(); return st ? `${n} frames · mean ${(st.meanSpeed / (gf!.field.width / gf!.width)).toFixed(1)} px/frame · heading ${st.directionDeg.toFixed(0)}° · ${Math.round(st.validFrac * 100)} % of cells` : `${n} frames` },
    stats: () => { const st = gf?.stats(); return { frames: n, cell: p.cell, meanSpeedPx: st ? +(st.meanSpeed / (gf!.field.width / gf!.width)).toFixed(2) : 0, directionDeg: st ? +st.directionDeg.toFixed(0) : 0, vMax: +vMaxUsed.toFixed(2) } },
  }
}
