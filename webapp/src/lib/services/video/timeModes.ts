/** Time-compression video mode: keep one frame every `intervalS` seconds and lay the kept frames
 *  out at `fps` in the file, so an hour of slow growth plays in a minute. Nothing is buffered
 *  (unlike the Time-lapse panel, which stores every frame for later export): this is a live
 *  recording that simply skips frames and re-times the rest. */

import type { RgbaFrame } from '../frameChain'
import type { VideoModeRun, ModeFrameInfo, ModeOutput } from './types'
import { SlidingMean } from '../../algo/videoStack'

export interface TimelapseParams { intervalS: number; fps: number; average: boolean }
/** `average` = true averages every frame of an interval into the kept one (free √N denoising for
 *  slow scenes) instead of picking the first; movers smear, so it is off by default. */
export function timelapseMode(p: TimelapseParams): VideoModeRun {
  let lastT: number | null = null
  let kept = 0, seen = 0
  let t0: number | null = null
  let mean: SlidingMean | null = null
  let due = false
  const tick = (info: ModeFrameInfo): boolean => {
    const t = info.t != null ? info.t / 1e9 : performance.now() / 1000
    if (lastT != null && t - lastT < p.intervalS) return false
    lastT = lastT == null ? t : lastT + p.intervalS * Math.floor((t - lastT) / p.intervalS)
    return true
  }
  return {
    id: 'timelapse',
    accept(info: ModeFrameInfo): boolean {
      seen++
      if (p.average) { due = tick(info); return true }   // every frame feeds the mean; `process` decides
      return tick(info)
    },
    process: p.average ? (f: RgbaFrame): ModeOutput | null => {
      const n = Math.max(1, Math.round(p.intervalS * 18))
      if (!mean || mean.width !== f.width || mean.height !== f.height || mean.n !== n) mean = new SlidingMean(f.width, f.height, n)
      const m = mean.push(f.data)
      if (!due) return null
      due = false
      return { frame: { data: m, width: f.width, height: f.height } }
    } : undefined,
    reset() { mean?.reset() },
    retime(tSec: number): number {
      if (t0 == null) t0 = tSec
      return t0 + (kept++) / p.fps
    },
    status: () => `${kept} frames kept of ${seen} · ${(kept / p.fps).toFixed(1)} s of video from ${(kept * p.intervalS).toFixed(0)} s${p.average ? ` · each = mean of ~${Math.round(p.intervalS * 18)} frames` : ''}`,
    stats: () => ({ kept, seen, intervalS: p.intervalS, fps: p.fps, speedup: p.intervalS * p.fps, average: p.average }),
  }
}
