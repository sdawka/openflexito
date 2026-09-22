/** Sliding-window super-resolution for video: each incoming frame is registered against the previous
 *  one (`algo/register.ts`, sub-pixel), its cumulative shift relative to the window's anchor is
 *  tracked, and the last `window` frames are drizzled (`algo/drizzle.ts`) onto a `scale`× grid. One
 *  result per input frame; the caller drops frames while a result is pending, so the output rate is
 *  whatever this worker sustains. Cumulative shifts are re-anchored to the newest frame each time so
 *  drift never grows beyond the window. */
import { defineWorker, post } from './workerUtil'
import { register } from '../algo/register'
import { drizzle, type DrizzleFrame } from '../algo/drizzle'
import { grayDown } from '../algo/stack'
import type { Gray } from '../algo/sharpness'

export type VideoSrMessage =
  | { type: 'init'; scale: number; pixfrac: number; window: number }
  | { type: 'frame'; data: Uint8ClampedArray; width: number; height: number; t: number | null }
  | { type: 'reset' }

let scale = 2, pixfrac = 0.6, windowN = 4
const frames: (DrizzleFrame & { gray: Gray })[] = []
let rejected = 0, fused = 0

defineWorker<VideoSrMessage>((m) => {
  if (m.type === 'init') { scale = m.scale; pixfrac = m.pixfrac; windowN = m.window; frames.length = 0; rejected = 0; fused = 0; return }
  if (m.type === 'reset') { frames.length = 0; return }
  const gray = grayDown(m.data, m.width, m.height, Math.min(410, m.width))
  const prev = frames[frames.length - 1]
  let dx = 0, dy = 0
  if (prev) {
    const r = register(prev.gray, gray, { coarseW: Math.min(410, m.width), maxShiftFrac: 0.1 })
    const f = m.width / gray.width
    if (!r.confident || Math.hypot(r.dx, r.dy) * f > m.width * 0.1) {
      // unrelated frame (stage jumped, scene changed): restart the window on this frame
      frames.length = 0; rejected++
    } else { dx = prev.dx + r.dx * f; dy = prev.dy + r.dy * f }
  }
  frames.push({ data: m.data, width: m.width, height: m.height, dx, dy, gray })
  while (frames.length > windowN) frames.shift()
  // re-anchor: shifts relative to the newest frame so the output stays put on the current view
  const ax = frames[frames.length - 1].dx, ay = frames[frames.length - 1].dy
  for (const f of frames) { f.dx -= ax; f.dy -= ay }
  const out = drizzle(frames.map((f) => ({ data: f.data, width: f.width, height: f.height, dx: -f.dx, dy: -f.dy })), scale, pixfrac)
  fused++
  post({ data: out.data, width: out.width, height: out.height, t: m.t, coverage: out.coverage, frames: frames.length, rejected, fused }, [out.data.buffer])
})
