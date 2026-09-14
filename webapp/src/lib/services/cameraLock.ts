/** Freeze the camera's auto algorithms for the duration of a multi-shot capture (focus stack, LED
 *  stack, super-resolution, scan, time-lapse) so every frame shares one exposure, gain and white
 *  balance, then hand control back. The device freezes AE/AWB per still from the latest stream frame
 *  (camera.py `_still_controls`), which lets consecutive stills drift; locking here makes the whole run
 *  consistent. Values come from the latest `event.frame` metadata; if none is available the auto
 *  algorithm is left alone and `locked` reports what was actually frozen. */

import { device } from '../store/device.svelte'
import type { CameraControls } from '../api/types'

export interface CameraLock {
  /** Which auto algorithms were switched off by this lock. */
  locked: { ae: boolean; awb: boolean }
  /** Controls as they were before locking (only the fields this lock changed). */
  previous: Partial<CameraControls>
  /** Re-enable whatever was locked. Safe to call twice. Errors are reported via `onError`, never thrown. */
  release(onError?: (msg: string) => void): Promise<void>
}

export interface CameraLockOptions {
  ae?: boolean   // lock exposure/gain (default true)
  awb?: boolean  // lock colour gains (default true)
}

/** Lock AE and/or AWB from the live frame metadata. Returns a lock whose `release()` restores the
 *  auto flags that were on before. Nothing is changed for an algorithm that is already manual. */
export async function lockCamera(opts: CameraLockOptions = {}): Promise<CameraLock> {
  const wantAe = opts.ae ?? true, wantAwb = opts.awb ?? true
  const c = device.controls, f = device.frame
  const set: Partial<CameraControls> = {}
  const previous: Partial<CameraControls> = {}
  let ae = false, awb = false
  if (wantAe && c?.AeEnable && f?.exposure && f?.gain) {
    set.AeEnable = false
    set.ExposureTime = Math.round(f.exposure)
    set.AnalogueGain = f.gain
    previous.AeEnable = true
    ae = true
  }
  if (wantAwb && c?.AwbEnable && f?.colour_gains && f.colour_gains.length === 2 && f.colour_gains.every((g) => g > 0)) {
    set.AwbEnable = false
    set.ColourGains = [f.colour_gains[0], f.colour_gains[1]]
    previous.AwbEnable = true
    awb = true
  }
  if (ae || awb) await device.setControls(set)
  let released = false
  return {
    locked: { ae, awb },
    previous,
    async release(onError) {
      if (released) return
      released = true
      const restore: Partial<CameraControls> = {}
      if (ae) restore.AeEnable = true
      if (awb) restore.AwbEnable = true
      if (!ae && !awb) return
      try { await device.setControls(restore) } catch (e) { onError?.(`could not re-enable auto ${[ae && 'exposure', awb && 'white balance'].filter(Boolean).join(' and ')}: ${(e as Error).message}`) }
    },
  }
}

/** Run `fn` with the camera locked, releasing afterwards even on error. */
export async function withCameraLock<T>(fn: (lock: CameraLock) => Promise<T>, opts: CameraLockOptions & { onError?: (msg: string) => void } = {}): Promise<T> {
  const lock = await lockCamera(opts)
  try { return await fn(lock) } finally { await lock.release(opts.onError) }
}
