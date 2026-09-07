/** Pure drift-tracking accounting for time-lapse sequences. Each frame is registered to a template
 *  by phase correlation (`fftTrack.displacement`); this module only does the bookkeeping — deciding
 *  when the accumulated drift is large enough to warrant a stage correction, and remembering how much
 *  of a frame's shift is still "owed" once a correction has been issued and a fresh template grabbed.
 *  It also records, for every frame, its offset from the very first frame so a drift-free sequence can
 *  be played back by translating each frame by `-offset`. */

export interface DriftReading { dx: number; dy: number; quality?: number }

export interface DriftDecision {
  /** offset (px) of this frame relative to the first frame, before any correction for it has been
   *  applied; store this as the frame's residual shift for drift-free playback */
  offset: { x: number; y: number }
  /** true once |offset| exceeds the threshold: time to move the stage back and re-template */
  shouldCorrect: boolean
}

export class DriftTracker {
  /** drift (px) already baked into the current template by earlier corrections */
  private origin = { x: 0, y: 0 }

  constructor(public thresholdPx: number) {}

  /** Feed a new raw measurement of this frame against the current template. */
  record(d: DriftReading): DriftDecision {
    const offset = { x: this.origin.x + d.dx, y: this.origin.y + d.dy }
    return { offset, shouldCorrect: Math.hypot(offset.x, offset.y) > this.thresholdPx }
  }

  /** Call once a fresh template has been grabbed after issuing a stage correction. `offsetBefore` is
   *  the offset `record` just returned; `correctedPx` is how far the correction actually moved the
   *  scene back, in the same pixel units (pass the full offset when the move is assumed to close the
   *  gap exactly). Any shortfall carries over as the new template's origin. */
  rebase(offsetBefore: { x: number; y: number }, correctedPx: { x: number; y: number }): void {
    this.origin = { x: offsetBefore.x - correctedPx.x, y: offsetBefore.y - correctedPx.y }
  }

  reset(): void { this.origin = { x: 0, y: 0 } }
}

/** Largest absolute x/y offset across a set of per-frame shifts: how much a drift-free crop would
 *  need to trim from each edge to show only content present in every frame. */
export function driftBounds(shifts: { dx: number; dy: number }[]): { x: number; y: number } {
  let x = 0, y = 0
  for (const s of shifts) { x = Math.max(x, Math.abs(s.dx)); y = Math.max(y, Math.abs(s.dy)) }
  return { x, y }
}
