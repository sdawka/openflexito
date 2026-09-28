/** Focus calibration run: four raw z sweeps through focus around the current (focused) z, read
 *  from the live stream's frame metadata (JPEG size as the focus metric, like fast autofocus), then
 *  `algo/zCalibration.ts` solves them for the z backlash and the frame lag. Sequence: engage
 *  upwards below the sweep (−span/2 − 400, then +400), up / down / up at the slow speed, re-engage
 *  below, up at the fast speed. The stage speed is always restored and the stage returns to the
 *  start z with z compensation, on success, failure or cancel. */

import { samplesFromSweep } from '../algo/autofocus'
import { sweepStepTimeUs } from '../algo/sweepStack'
import { solveZCalibration, sweepPeak, type SweepPeak, type ZCalibrationSolution } from '../algo/zCalibration'
import type { FrameMeta, MoveResult } from '../algo/types'
import { withCameraLock } from './cameraLock'
import { device } from '../store/device.svelte'

export interface ZCalOptions {
  /** z span of each sweep, steps; default max(1000, 2·(backlash + 300)) */
  span?: number
  /** slow sweeps: z steps between consecutive frames; default 5 */
  stepsPerFrame?: number
  /** fast sweep step time, µs; default 1000 (the board's full speed) */
  fastUs?: number
  cancelled?: () => boolean
}

export type ZCalPeak = SweepPeak & { speed: number }

export interface ZCalRun extends ZCalibrationSolution {
  peaks: { up1: ZCalPeak; down: ZCalPeak; up2: ZCalPeak; fast: ZCalPeak }
  slowUs: number
  fastUs: number
  fps: number
  span: number
  startZ: number
}

const ENGAGE = 400

/** Main-stream frames when the device reports any (lores metadata has other JPEG sizes). */
function streamFrames(): FrameMeta[] {
  const main = device.frames.filter((f) => f.stream === 'main')
  return main.length ? main : [...device.frames]
}

function measuredFps(): number {
  const ts = streamFrames().map((f) => f.ts ?? f.t).filter((t): t is number => typeof t === 'number').slice(-60)
  if (ts.length < 5) return device.fps || 30
  const span = (ts[ts.length - 1] - ts[0]) / 1e9
  return span > 0 ? (ts.length - 1) / span : device.fps || 30
}

export async function runZCalibration(o: ZCalOptions, say: (m: string) => void): Promise<ZCalRun> {
  const startZ = device.position.z
  const minUs = device.status?.stage?.step_time_us ?? 1000
  const backlash = device.status?.stage?.backlash?.z ?? 200
  const span = Math.max(200, Math.round(o.span ?? Math.max(1000, 2 * (backlash + 300))))
  const half = Math.round(span / 2)
  const fps = measuredFps()
  const fastUs = Math.max(minUs, Math.round(o.fastUs ?? 1000))
  // the lag is read from the difference of two speeds: keep the slow one at least 3× slower
  const slowUs = Math.max(3 * fastUs, sweepStepTimeUs(fps, Math.max(1, o.stepsPerFrame ?? 5), minUs))
  let z = startZ
  const check = () => { if (o.cancelled?.()) throw new Error('focus calibration cancelled') }
  const raw = async (dz: number): Promise<MoveResult> => {
    const m = await device.moveRel({ z: dz }, false)
    z = m.position.z
    if (m.cancelled) throw new Error('focus calibration: a move was cancelled')
    return m
  }
  const sweep = async (dz: number, label: string): Promise<ZCalPeak> => {
    check()
    const z0 = z
    say(`focus calibration: ${label}, ${dz > 0 ? 'up' : 'down'} ${Math.abs(dz)} steps`)
    const m = await raw(dz)
    await new Promise((r) => setTimeout(r, 250)) // the last frames of the sweep are still on their way
    const samples = samplesFromSweep(streamFrames(), m.t0, m.t1, z0, m.position.z, 'jpeg')
    const peak = sweepPeak(samples, {}, `focus calibration (${label})`)
    const speed = Math.abs(m.position.z - z0) / (m.t1 - m.t0)
    say(`focus calibration: ${label} peak at z=${peak.z.toFixed(1)} (${peak.samples} frames, contrast ${peak.contrast.toFixed(2)})`)
    return { ...peak, speed }
  }
  try {
    say(`focus calibration: ${span}-step sweeps at ${slowUs} and ${fastUs} µs/step (${fps.toFixed(1)} fps), starting from z=${startZ}`)
    await raw(-half - ENGAGE)
    await raw(ENGAGE)
    let up1!: ZCalPeak, down!: ZCalPeak, up2!: ZCalPeak, fast!: ZCalPeak
    // AE/AWB frozen for all four sweeps: an exposure change mid-sweep moves the JPEG-size curve
    await withCameraLock(async () => { try {
      await device.client.call('stage.set_step_time', { us: slowUs })
      up1 = await sweep(span, 'slow up 1')
      down = await sweep(-span, 'slow down')
      up2 = await sweep(span, 'slow up 2')
      await device.client.call('stage.set_step_time', { us: fastUs })
      check()
      await raw(-span - ENGAGE)
      await raw(ENGAGE)
      fast = await sweep(span, 'fast up')
    } finally {
      await device.client.call('stage.set_step_time', { us: minUs }).catch((e) => say(`focus calibration: could not restore the stage speed: ${(e as Error).message}`))
    } }, { onError: (m) => say(`focus calibration: ${m}`) })
    const sw = (p: ZCalPeak) => ({ peak: p.z, speed: p.speed })
    const sol = solveZCalibration(sw(up1), sw(down), sw(up2), sw(fast))
    if (![sol.backlash, sol.lagNs, sol.repeatability].every(Number.isFinite)) throw new Error('focus calibration: the sweeps gave no finite solution')
    say(`focus calibration: backlash ${sol.backlash.toFixed(1)} steps (uncorrected ${sol.naiveBacklash.toFixed(1)}), frame lag ${(sol.lagNs / 1e6).toFixed(2)} ms, repeatability ${sol.repeatability.toFixed(1)} steps`)
    return { ...sol, peaks: { up1, down, up2, fast }, slowUs, fastUs, fps, span, startZ }
  } finally {
    say(`focus calibration: returning to z=${startZ}`)
    await device.moveTo({ z: startZ }, 'z').catch((e) => say(`focus calibration: could not return to z=${startZ}: ${(e as Error).message}`))
  }
}
