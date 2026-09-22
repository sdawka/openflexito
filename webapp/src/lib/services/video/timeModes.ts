/** Time-compression video mode: keep one frame every `intervalS` seconds and lay the kept frames
 *  out at `fps` in the file, so an hour of slow growth plays in a minute. Nothing is buffered
 *  (unlike the Time-lapse panel, which stores every frame for later export): this is a live
 *  recording that simply skips frames and re-times the rest. */

import type { VideoModeRun, ModeFrameInfo } from './types'

export interface TimelapseParams { intervalS: number; fps: number }
export function timelapseMode(p: TimelapseParams): VideoModeRun {
  let lastT: number | null = null
  let kept = 0, seen = 0
  let t0: number | null = null
  return {
    id: 'timelapse',
    accept(info: ModeFrameInfo): boolean {
      seen++
      const t = info.t != null ? info.t / 1e9 : performance.now() / 1000
      if (lastT != null && t - lastT < p.intervalS) return false
      lastT = lastT == null ? t : lastT + p.intervalS * Math.floor((t - lastT) / p.intervalS)
      return true
    },
    retime(tSec: number): number {
      if (t0 == null) t0 = tSec
      return t0 + (kept++) / p.fps
    },
    status: () => `${kept} frames kept of ${seen} · ${(kept / p.fps).toFixed(1)} s of video from ${(kept * p.intervalS).toFixed(0)} s`,
    stats: () => ({ kept, seen, intervalS: p.intervalS, fps: p.fps, speedup: p.intervalS * p.fps }),
  }
}
