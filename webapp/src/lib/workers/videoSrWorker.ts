/** Sliding-window super-resolution for video: each incoming frame is registered against the previous
 *  one (`algo/register.ts`, sub-pixel), its cumulative shift relative to the window's anchor is
 *  tracked, and the last `window` frames are drizzled onto a `scale`× grid. One result per input
 *  frame; the caller drops frames while a result is pending, so the output rate is whatever this
 *  worker sustains. Cumulative shifts are re-anchored to the newest frame each time so drift never
 *  grows beyond the window.
 *
 *  Robustness (Wronski et al. 2019, `algo/drizzleRobust.ts`; `docs/video-research/creative.md`
 *  addendum): with `robust` on (default), every older frame of the window gets a per-pixel weight
 *  map from its difference to the newest frame (warped by the registered shift) on the ≤ 410 px grey
 *  planes the registration already produced — 1 where the difference is noise, 0 where a specimen
 *  moved — so movers are not smeared and the output there is the newest frame upsampled. The result
 *  reports `robustRejectedFrac`, the mean fraction of down-weighted plane pixels over the window's
 *  older frames (0 for a static scene, rising with specimen motion). Weight-map buffers are kept per
 *  window slot and reused. */
import { defineWorker, post } from './workerUtil'
import { register } from '../algo/register'
import { drizzle, type DrizzleFrame } from '../algo/drizzle'
import { drizzleRobust, robustWeightMap, type RobustDrizzleFrame, type WeightMap } from '../algo/drizzleRobust'
import { grayDown } from '../algo/stack'
import type { Gray } from '../algo/sharpness'

export type VideoSrMessage =
  | { type: 'init'; scale: number; pixfrac: number; window: number; robust?: boolean; robustK?: number }
  | { type: 'frame'; data: Uint8ClampedArray; width: number; height: number; t: number | null }
  | { type: 'reset' }

export interface VideoSrResult {
  data: Uint8ClampedArray; width: number; height: number; t: number | null
  coverage: number; frames: number; rejected: number; fused: number
  /** mean fraction of plane pixels the robustness weight pushed below 0.5, over the window's older frames (0 when `robust` is off or the window holds one frame) */
  robustRejectedFrac: number
}

let scale = 2, pixfrac = 0.6, windowN = 4, robust = true, robustK = 3
const frames: (DrizzleFrame & { gray: Gray; map?: WeightMap })[] = []
let rejected = 0, fused = 0
const mapPool: Float32Array[] = []

defineWorker<VideoSrMessage>((m) => {
  if (m.type === 'init') { scale = m.scale; pixfrac = m.pixfrac; windowN = m.window; robust = m.robust ?? true; robustK = m.robustK ?? 3; frames.length = 0; rejected = 0; fused = 0; return }
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
  const ref = frames[frames.length - 1]
  const ax = ref.dx, ay = ref.dy
  for (const f of frames) { f.dx -= ax; f.dy -= ay }
  const planeScale = gray.width / m.width
  let robustRejectedFrac = 0
  let out
  if (robust && frames.length > 1) {
    const inputs: RobustDrizzleFrame[] = []
    let acc = 0
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i]
      // drizzle geometry: frame content = reference content shifted by (dx, dy); the tracked shift
      // is the other way round, hence the negation (same as the plain path below)
      const sdx = -f.dx, sdy = -f.dy
      if (f === ref) { inputs.push({ data: f.data, width: f.width, height: f.height, dx: 0, dy: 0 }); continue }
      const buf = mapPool[i] && mapPool[i].length === gray.data.length ? mapPool[i] : (mapPool[i] = new Float32Array(gray.data.length))
      const r = robustWeightMap(ref.gray, f.gray, sdx * planeScale, sdy * planeScale, { k: robustK }, buf)
      acc += r.rejectedFrac
      inputs.push({ data: f.data, width: f.width, height: f.height, dx: sdx, dy: sdy, weightMap: r.map })
    }
    robustRejectedFrac = acc / (frames.length - 1)
    out = drizzleRobust(inputs, scale, pixfrac)
  } else {
    out = drizzle(frames.map((f) => ({ data: f.data, width: f.width, height: f.height, dx: -f.dx, dy: -f.dy })), scale, pixfrac)
  }
  fused++
  const result: VideoSrResult = { data: out.data, width: out.width, height: out.height, t: m.t, coverage: out.coverage, frames: frames.length, rejected, fused, robustRejectedFrac }
  post(result, [out.data.buffer])
})
