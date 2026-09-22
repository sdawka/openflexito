/** Drives the stage through a small repeating pattern of raw relative moves while a video mode
 *  records (z dither for extended-depth-of-field video, xy sub-pixel dither for super-resolution
 *  video). One move is in flight at a time; every step waits for the move to complete and then
 *  dwells `dwellMs` so at least one settled frame is captured at each position. `stop()` returns
 *  the stage to where the pattern started (the net offset is tracked, so a cancelled pattern still
 *  ends at the origin). Moves are raw (`compensate: false`), like every jog: backlash would make a
 *  dither of a few steps meaningless and the pattern is symmetric anyway. */

import { device } from '../../store/device.svelte'

export interface DitherStep { x?: number; y?: number; z?: number }

export class StageDither {
  private running = false
  private loop: Promise<void> | null = null
  /** net offset from the origin, in steps */
  offset = { x: 0, y: 0, z: 0 }
  /** index of the pattern step the stage currently sits at */
  index = 0
  steps = 0
  error: string | null = null
  /** `performance.now()` when the last move completed; frames that arrive within `settleMs` of it
   *  were (partly) exposed during the move and should be dropped by the mode's `accept` */
  lastMoveEnd = 0
  moving = false

  constructor(private pattern: DitherStep[], public readonly dwellMs: number) {
    if (!pattern.length) throw new Error('empty dither pattern')
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.loop = this.run()
  }

  private async run(): Promise<void> {
    let i = 0
    while (this.running && device.connected) {
      const target = this.pattern[i % this.pattern.length]
      const d = { x: (target.x ?? 0) - this.offset.x, y: (target.y ?? 0) - this.offset.y, z: (target.z ?? 0) - this.offset.z }
      if (d.x || d.y || d.z) {
        this.moving = true
        try { await device.moveRel(d, false) } catch (e) { this.error = (e as Error).message; this.moving = false; break }
        this.moving = false
        this.lastMoveEnd = performance.now()
        this.offset = { x: target.x ?? 0, y: target.y ?? 0, z: target.z ?? 0 }
      }
      this.index = i % this.pattern.length
      this.steps++
      i++
      await new Promise((r) => setTimeout(r, this.dwellMs))
    }
    this.running = false
  }

  /** True when the stage has been still for at least `settleMs`: 130 ms (≈ 2 frames at 18 fps, the
   *  camera pipeline delay) or half the dwell when the dwell is shorter, so a short dwell still
   *  yields its last frames instead of rejecting everything. */
  settled(settleMs = Math.min(130, this.dwellMs * 0.5)): boolean { return !this.moving && performance.now() - this.lastMoveEnd >= settleMs }

  /** Stop the pattern and return to the origin. */
  async stop(): Promise<void> {
    this.running = false
    await this.loop?.catch(() => {})
    this.loop = null
    const back = { x: -this.offset.x, y: -this.offset.y, z: -this.offset.z }
    if (back.x || back.y || back.z) {
      try { await device.moveRel(back, false); this.offset = { x: 0, y: 0, z: 0 } } catch (e) { this.error = (e as Error).message }
    }
  }
}
