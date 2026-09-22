/** Analysis-style video modes: the kymograph (the *video* is a growing space–time image along a
 *  user line) and motion-triggered recording (frames are encoded only while something moves,
 *  with a post-roll, and the gaps are compressed out of the timeline). */

import type { RgbaFrame } from '../frameChain'
import type { VideoModeRun, ModeFrameInfo, ModeOutput } from './types'
import { sampleLine, Kymograph, type LinePx } from '../../algo/kymograph'
import { BackgroundModel } from '../../algo/motionViz'
import { measure } from '../measureService.svelte'
import { device } from '../../store/device.svelte'
import { StageShiftTracker } from './common'

export interface KymographParams { band: number; rows: number; sideBySide: boolean }
/** The line is the measurement tool's current two points (fractions of the frame) when it has them,
 *  else the horizontal centre line. It follows small stage pans through the calibration. */
export function kymographMode(p: KymographParams): VideoModeRun {
  let ky: Kymograph | null = null
  let row: Float32Array | null = null
  let line: LinePx | null = null
  let lineFrac: { x0: number; y0: number; x1: number; y1: number } | null = null
  let length = 0
  const shift = new StageShiftTracker()
  let out: Uint8ClampedArray | null = null
  let n = 0
  const pick = (w: number, h: number) => {
    const pts = measure.points
    lineFrac = pts.length >= 2 ? { x0: pts[0].x, y0: pts[0].y, x1: pts[1].x, y1: pts[1].y } : { x0: 0.1, y0: 0.5, x1: 0.9, y1: 0.5 }
    line = { x0: lineFrac.x0 * w, y0: lineFrac.y0 * h, x1: lineFrac.x1 * w, y1: lineFrac.y1 * h }
    length = Math.max(64, Math.round(Math.hypot(line.x1 - line.x0, line.y1 - line.y0)))
  }
  return {
    id: 'kymograph',
    outputSize(w, h) { pick(w, h); return p.sideBySide ? { w: w + length, h: Math.max(h, p.rows) } : { w: length, h: p.rows } },
    process(f: RgbaFrame): ModeOutput {
      n++
      if (!line) pick(f.width, f.height)
      if (!ky) { ky = new Kymograph(length, p.rows); row = new Float32Array(length * 3) }
      const s = shift.next()
      if (s.dx || s.dy) { line!.x0 += s.dx; line!.x1 += s.dx; line!.y0 += s.dy; line!.y1 += s.dy }
      sampleLine(f.data, f.width, f.height, line!, length, p.band, row!)
      ky.push(row!)
      if (!p.sideBySide) return { frame: { data: ky.image, width: length, height: p.rows } }
      const W = f.width + length, H = Math.max(f.height, p.rows)
      if (!out || out.length !== W * H * 4) { out = new Uint8ClampedArray(W * H * 4); for (let i = 3; i < out.length; i += 4) out[i] = 255 }
      for (let y = 0; y < f.height; y++) out.set(f.data.subarray(y * f.width * 4, (y + 1) * f.width * 4), y * W * 4)
      for (let y = 0; y < p.rows; y++) out.set(ky.image.subarray(y * length * 4, (y + 1) * length * 4), (y * W + f.width) * 4)
      // the sampled line, drawn on the live half
      const steps = length
      for (let k = 0; k < steps; k++) { const t = k / (steps - 1); const x = Math.round(line!.x0 + (line!.x1 - line!.x0) * t), y = Math.round(line!.y0 + (line!.y1 - line!.y0) * t); if (x >= 0 && y >= 0 && x < f.width && y < f.height) { const o = (y * W + x) * 4; out[o] = 255; out[o + 1] = 220; out[o + 2] = 0 } }
      return { frame: { data: out, width: W, height: H } }
    },
    reset() { ky?.reset(); shift.reset() },
    status: () => `${ky?.rows ?? 0}/${p.rows} rows · line ${length} px · band ${p.band} px${measure.points.length >= 2 ? '' : ' (centre line: draw a Distance measurement to choose one)'}`,
    stats: () => ({ frames: n, length, rows: p.rows, band: p.band, line: lineFrac ?? undefined }),
  }
}

export interface TriggerParams { sensitivity: number /* % of the field that must move */; postRollS: number; compressGaps: boolean }
/** Encodes only while motion energy (fraction of pixels above k·σ against a running-median
 *  background, measured on a coarse sample) is above `sensitivity`, plus `postRollS` afterwards.
 *  With `compressGaps` the recording's timeline skips the idle stretches (a burst-to-burst film);
 *  without, true times are kept and the player shows the gaps. Triggering is inhibited while the
 *  stage moves and for a second after, and for a second after a light change. */
export function triggerMode(p: TriggerParams): VideoModeRun {
  let bg: BackgroundModel | null = null
  let lastMotionT: number | null = null
  let lastMoveT = 0, lastLightT = 0, lastCc = -1
  let armedT = 0
  let events = 0, kept = 0, seen = 0, inEvent = false, recordingNow = false
  let energy = 0
  // time compression: output time = input time − accumulated gap
  let gap = 0, lastOutIn: number | null = null
  return {
    id: 'trigger',
    process(f: RgbaFrame, info: ModeFrameInfo): ModeOutput | null {
      seen++
      const t = info.t != null ? info.t / 1e9 : performance.now() / 1000
      const now = performance.now()
      if (device.moving) lastMoveT = now
      if (device.light.cc !== lastCc) { if (lastCc >= 0) lastLightT = now; lastCc = device.light.cc }
      if (!bg || bg.width !== f.width || bg.height !== f.height) { bg = new BackgroundModel(f.width, f.height, 0.05, true, 0.5); armedT = now + 2000 }
      const diff = bg.update(f.data)
      const th = 4 * bg.sigma
      let moving = 0, cnt = 0
      for (let q = 0; q < diff.length; q += 7) { if (diff[q] > th) moving++; cnt++ }
      energy = cnt ? (moving / cnt) * 100 : 0
      const inhibited = now < armedT || now - lastMoveT < 1000 || now - lastLightT < 1000
      if (!inhibited && energy >= p.sensitivity) { if (!inEvent) { inEvent = true; events++ } lastMotionT = t }
      const active = lastMotionT != null && t - lastMotionT <= p.postRollS
      recordingNow = active
      if (!active) { inEvent = false; return null }
      kept++
      if (p.compressGaps) { if (lastOutIn != null && t - lastOutIn > 0.5) gap += t - lastOutIn - 1 / 15; lastOutIn = t }
      return { frame: f }
    },
    retime(tSec: number): number { return p.compressGaps ? tSec - gap : tSec },
    reset() { bg?.reset(); armedT = performance.now() + 2000 },
    status: () => `${recordingNow ? 'recording' : 'armed'} · motion ${energy.toFixed(1)} % (trigger ${p.sensitivity} %) · ${events} events · ${kept}/${seen} frames kept`,
    stats: () => ({ events, kept, seen, sensitivity: p.sensitivity, postRollS: p.postRollS, compressGaps: p.compressGaps }),
  }
}
