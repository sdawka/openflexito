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

/** Analysis width the time-lapse service downsampled frames to before this field was recorded. */
export const LEGACY_MEASURE_WIDTH = 410

/** Convert a shift measured on a downsampled analysis frame of width `measureWidth` to full-frame
 *  pixels of a frame `frameWidth` wide. Saved time-lapse items store `shift` in full-frame px and
 *  record the `measureWidth` they were measured at; items saved before that field existed (legacy)
 *  hold the raw measurement at `min(LEGACY_MEASURE_WIDTH, frameWidth)` px wide and are rescaled here
 *  so their drift-free playback is correct too. */
export function shiftToFrame(shift: { dx: number; dy: number }, measureWidth: number, frameWidth: number): { dx: number; dy: number } {
  const k = measureWidth > 0 ? frameWidth / measureWidth : 1
  return { dx: shift.dx * k, dy: shift.dy * k }
}

/** Playback shift (full-frame px) of a stored frame: new items already carry full-frame px (they
 *  have `measureWidth`); legacy items are rescaled from the analysis width. */
export function playbackShift(meta: { shift: { dx: number; dy: number }; measureWidth?: number }, frameWidth: number): { dx: number; dy: number } {
  if (meta.measureWidth !== undefined) return meta.shift
  return shiftToFrame(meta.shift, Math.min(LEGACY_MEASURE_WIDTH, frameWidth), frameWidth)
}

/** Cheap sharpness proxy for refocus decisions: mean absolute 4-neighbour Laplacian of a greyscale
 *  frame (the drift-measurement downsample is fine). Monotonic near focus, no allocation. */
export function meanAbsLaplacian(g: { data: Float32Array; width: number; height: number }): number {
  const { data, width: w, height: h } = g
  let s = 0, n = 0
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x
    s += Math.abs(4 * data[i] - data[i - 1] - data[i + 1] - data[i - w] - data[i + w]); n++
  }
  return n ? s / n : 0
}

/** Absolute-clock scheduling: the slot index due now, given the start time, the interval and the last
 *  slot captured. Returns the next slot strictly after `lastSlot`; when the previous capture ran long,
 *  the missed slots are skipped rather than queued (so the cadence stays on the wall clock). */
export function nextSlot(nowMs: number, startMs: number, intervalMs: number, lastSlot: number): { slot: number; dueAt: number; skipped: number } {
  const elapsed = Math.floor((nowMs - startMs) / intervalMs)
  const slot = Math.max(lastSlot + 1, elapsed + (nowMs > startMs + elapsed * intervalMs ? 1 : 0))
  const dueAt = startMs + slot * intervalMs
  return { slot, dueAt, skipped: Math.max(0, slot - lastSlot - 1) }
}

/** Refocus trigger: sharpness fell by more than `dropPct` % of the running best. */
export function sharpnessDropped(current: number, best: number, dropPct: number): boolean {
  return dropPct > 0 && best > 0 && current < best * (1 - dropPct / 100)
}
