/** Click-hold-drag panning of the stage ("grab the slide", like a map).
 *
 *  The pointer reports the total drag displacement in image pixels; this converts it to stage
 *  steps through the camera-stage matrix and keeps at most one move in flight, sending the
 *  difference between what the cursor asks for and what has already been sent. Moves are raw
 *  (no backlash compensation) so successive small moves stay responsive. `pendingPx()` is the part
 *  of the drag the stage has not caught up with yet; the view translates the image by it so the
 *  picture sticks to the cursor while the hardware follows. */

import { apply2, invert2, type Mat2, type Vec2 } from '../algo/csm'

export interface PanIO {
  move(steps: { x: number; y: number }): Promise<unknown>
  /** image px -> stage steps (scene displacement, as pixelsToStage) */
  matrix: Mat2
  onchange?(): void
}

export class PanController {
  private totalPx: Vec2 = [0, 0]
  private sent = { x: 0, y: 0 }
  private settled = { x: 0, y: 0 }
  private inflight = false
  private inverse: Mat2
  active = false
  /** Identity of the matrix this controller was built for (callers rebuild it after a recalibration). */
  matrixRef: unknown = null
  /** Ignore drag remainders smaller than this many steps while the pointer is still down. */
  minSteps = 4

  constructor(private io: PanIO) {
    this.inverse = invert2(io.matrix)
  }

  get busy(): boolean { return this.inflight }

  begin(): void {
    this.active = true
    if (!this.inflight) {
      this.totalPx = [0, 0]; this.sent = { x: 0, y: 0 }; this.settled = { x: 0, y: 0 }
    } else {
      // a previous drag is still settling: continue from where it left off so nothing is lost
      this.totalPx = apply2(this.inverse, [this.sent.x, this.sent.y])
    }
  }

  /** Total displacement of the pointer since `begin`, in image pixels of the calibration frame. */
  update(totalPx: Vec2): void {
    if (!this.active) return
    this.totalPx = totalPx
    void this.pump()
  }

  end(): void {
    this.active = false
    void this.pump()
  }

  /** Pixels the image should be shifted by to appear where the cursor put it (not yet moved by the stage). */
  pendingPx(): Vec2 {
    const done = apply2(this.inverse, [this.settled.x, this.settled.y])
    return [this.totalPx[0] - done[0], this.totalPx[1] - done[1]]
  }

  private async pump(): Promise<void> {
    if (this.inflight) return
    this.inflight = true
    try {
      for (;;) {
        const want = apply2(this.io.matrix, this.totalPx)
        const d = { x: Math.round(want[0]) - this.sent.x, y: Math.round(want[1]) - this.sent.y }
        if (!d.x && !d.y) break
        if (this.active && Math.hypot(d.x, d.y) < this.minSteps) break
        this.sent = { x: this.sent.x + d.x, y: this.sent.y + d.y }
        await this.io.move(d)
        this.settled = { ...this.sent }
        this.io.onchange?.()
      }
    } catch {
      this.settled = { ...this.sent }   // the device refused; stop chasing, the view snaps back
      this.totalPx = apply2(this.inverse, [this.sent.x, this.sent.y])
    } finally {
      this.inflight = false
      this.io.onchange?.()
    }
  }
}
