/** Exposure / gain search on raw Bayer data (port of OpenFlexure v3 adjust_shutter_and_gain_from_raw).
 *
 *  Target: the 99.9th-percentile raw level (black level removed) reaches `target` (default 400 of
 *  the 1023 range for a 10-bit sensor, ~40 %). First scale exposure time (factor capped at 8x per
 *  step), then analogue gain (capped at 2x per step), until within `tolerance` or the camera stops
 *  honouring the request (sensor limit reached). */

export interface ExposureIO {
  /** Set controls and wait until the camera reports them (returns what it actually applied). */
  setControls(c: { ExposureTime?: number; AnalogueGain?: number; AeEnable?: boolean }): Promise<{ ExposureTime: number; AnalogueGain: number }>
  /** Capture a raw frame and return its brightest-pixel level (black level removed). */
  measureLevel(): Promise<number>
  log?(msg: string): void
}

export interface ExposureOptions {
  target?: number
  tolerance?: number   // fraction of target
  maxIter?: number
  minExposure?: number // µs
  maxExposure?: number // µs
  maxGain?: number
}

export interface ExposureResult { exposure: number; gain: number; level: number; iterations: number; converged: boolean }

export function nextExposure(current: number, level: number, target: number, cap = 8, min = 50, max = 500_000): number {
  if (level <= 0) return Math.min(max, current * cap)
  const factor = Math.min(target / level, cap)
  return Math.round(Math.max(min, Math.min(max, current * factor)))
}

export function nextGain(current: number, level: number, target: number, cap = 2, max = 10.67): number {
  if (level <= 0) return Math.min(max, current * cap)
  return Math.max(1, Math.min(max, current * Math.min(target / level, cap)))
}

export async function autoExpose(io: ExposureIO, opts: ExposureOptions = {}): Promise<ExposureResult> {
  const target = opts.target ?? 400, tol = opts.tolerance ?? 0.05, maxIter = opts.maxIter ?? 20
  const minExp = opts.minExposure ?? 50, maxExp = opts.maxExposure ?? 500_000, maxGain = opts.maxGain ?? 10.67
  let applied = await io.setControls({ AeEnable: false, AnalogueGain: 1, ExposureTime: minExp })
  let exposure = applied.ExposureTime, gain = applied.AnalogueGain
  let level = await io.measureLevel(), iterations = 0
  const ok = () => Math.abs(level - target) < tol * target

  // 1. exposure time
  for (; iterations < maxIter && !ok(); iterations++) {
    const want = nextExposure(exposure, level, target, 8, minExp, maxExp)
    applied = await io.setControls({ ExposureTime: want })
    io.log?.(`exposure ${exposure} -> ${want} µs (applied ${applied.ExposureTime}), level ${level.toFixed(0)}`)
    if (Math.abs(applied.ExposureTime - exposure) < 1) break   // sensor limit reached
    exposure = applied.ExposureTime
    level = await io.measureLevel()
  }
  // 2. analogue gain
  for (; iterations < maxIter && !ok(); iterations++) {
    const want = nextGain(gain, level, target, 2, maxGain)
    applied = await io.setControls({ AnalogueGain: want })
    io.log?.(`gain ${gain.toFixed(2)} -> ${want.toFixed(2)} (applied ${applied.AnalogueGain.toFixed(2)}), level ${level.toFixed(0)}`)
    if (Math.abs(applied.AnalogueGain - gain) < 1e-3) break
    gain = applied.AnalogueGain
    level = await io.measureLevel()
  }
  return { exposure, gain, level, iterations, converged: ok() }
}
