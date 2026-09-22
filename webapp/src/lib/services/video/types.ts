/** Video modes (`services/video/*`): what a recording does to the stream beyond encoding it, the
 *  way `services/photo/*` are the still-capture modes. `videoModes.ts` holds the catalogue (name,
 *  blurb, parameters, cost) and the dispatcher; each mode implementation lives in its own file and
 *  returns a `VideoModeRun` the recorder drives once per decoded frame.
 *
 *  Where a run sits in the recorder's per-frame path (`services/recorder.svelte.ts#pushFrame`):
 *
 *    MJPEG part → stabilise (draw into the working canvas) → frame chain orders < 900 (deflicker,
 *    live denoise) → `run.process()` → frame chain orders ≥ 900 (colour LUT) → burn-in overlays →
 *    encoder
 *
 *  A run may change the output size (binning, super-resolution), skip frames (quality gating, an
 *  interval, a worker that has not answered yet), return a *different* frame than the one it was
 *  given (a worker result for an earlier frame, with that frame's own timestamp), re-time frames
 *  (time compression) and drive the stage/illumination while recording (`start`/`stop`). Everything
 *  is optional: a plain recording is a run with no hooks.
 *
 *  Rules: `process()` is synchronous and must never block on I/O — a heavy mode posts to a worker
 *  and returns `null` until a result is back. Temporal state must survive a skipped frame and reset
 *  on `reset()` (stream reconnect) — the recorder also calls it when `device.moving` flips, unless
 *  the mode declares `drivesStage` (it moves the stage itself, so motion is expected). */

import type { RgbaFrame } from '../frameChain'

export interface ModeFrameInfo {
  /** device frame time (ns, CLOCK_BOOTTIME) or null when the stream carries none */
  t: number | null
  seq: number
  /** stage position when the frame arrived */
  position: { x: number; y: number; z: number }
}

export interface ModeOutput {
  frame: RgbaFrame
  /** the device time (ns) the output frame represents when it is not the input frame's (a worker
   *  result for an earlier frame); defaults to the input frame's `t` */
  t?: number | null
}

export interface VideoModeRun {
  /** Stable id from the catalogue (`VideoModeId`). */
  readonly id: string
  /** The mode moves the stage or drives the LEDs itself; the recorder then keeps the stabiliser and
   *  the motion-reset logic quiet instead of fighting the commanded motion. */
  readonly drivesStage?: boolean
  /** The mode needs the raw, un-stabilised frame geometry (it registers frames itself or dithers
   *  the stage in xy on purpose); the recorder then records with stabilisation off. */
  readonly disablesStabiliser?: boolean
  /** Output frame size for a given working-canvas size; default: unchanged. Called once before the
   *  encoder is configured, so it must be a pure function of its inputs. */
  outputSize?(w: number, h: number): { w: number; h: number }
  /** Cheap pre-decode gate (interval, parity, ...): `false` drops the frame before any pixel work. */
  accept?(info: ModeFrameInfo): boolean
  /** Transform the frame (already stabilised / denoised). `null` = nothing to encode for this input. */
  process?(frame: RgbaFrame, info: ModeFrameInfo): ModeOutput | null
  /** Remap presentation time (seconds, monotonic in → monotonic out): time compression / ramps. */
  retime?(tSec: number): number
  /** Begin driving the stage / illumination; awaited before the first frame is encoded. */
  start?(): Promise<void> | void
  /** Stop driving and restore what `start` changed (stage back to its origin, LED level). Always
   *  called once, also when the recording ends by error. */
  stop?(): Promise<void> | void
  /** Drop temporal state (stream reconnect; stage motion unless `drivesStage`). */
  reset?(): void
  /** Progress text for the status line (frames fused, frames kept, ...). */
  status?(): string
  /** What to record on the gallery item about this run. */
  stats?(): Record<string, unknown>
}
