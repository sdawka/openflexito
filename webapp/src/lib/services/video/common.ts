/** Helpers shared by the video modes (`services/video/*`). */

import { device } from '../../store/device.svelte'
import { calibration } from '../../store/calibration.svelte'
import { invert2, apply2, type Vec2 } from '../../algo/csm'
import type { RgbaFrame } from '../frameChain'

/** Pixel shift of the scene since the previous call, from the stage position delta and the CSM
 *  calibration (`{0, 0}` without a calibration, on the first call, or for a singular matrix).
 *  Same maths as `services/denoiseProcessor.ts#stageShiftPx`, instanced so each mode has its own. */
export class StageShiftTracker {
  private last: { x: number; y: number } | null = null
  reset(): void { this.last = null }
  next(): { dx: number; dy: number } {
    const cur = device.position, prev = this.last, csm = calibration.csm
    this.last = { x: cur.x, y: cur.y }
    if (!prev || !csm) return { dx: 0, dy: 0 }
    const d: Vec2 = [cur.x - prev.x, cur.y - prev.y]
    if (!d[0] && !d[1]) return { dx: 0, dy: 0 }
    try { const [dx, dy] = apply2(invert2(csm.matrix), d); return { dx, dy } } catch { return { dx: 0, dy: 0 } }
  }
}

/** One reusable output buffer of the frame's size (modes must not return the input buffer when the
 *  frame chain may still read it). */
export class OutBuffer {
  private buf: Uint8ClampedArray | null = null
  get(w: number, h: number): Uint8ClampedArray {
    if (!this.buf || this.buf.length !== w * h * 4) this.buf = new Uint8ClampedArray(w * h * 4)
    return this.buf
  }
  frame(w: number, h: number): RgbaFrame { return { data: this.get(w, h), width: w, height: h } }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
