/** Frame attribution by timestamp (`docs/video-research/creative.md` §0).
 *
 *  Interleaved modes (HDR by LED alternation, interleaved illumination, stage dithers) need to know
 *  which illumination / stage state each frame was *exposed* under. Classifying by luma fails for
 *  dark-field or oblique pairs, and a fixed "N frames of pipeline latency" queue is off by one as
 *  soon as the exposure time or a dropped MJPEG part changes the pipeline depth. Every frame already
 *  carries its exposure start `t` (libcamera `SensorTimestamp`, ns on CLOCK_BOOTTIME) and its
 *  `exposure`, so the robust rule is: keep a log of `(t, state)` switches and attribute a frame to
 *  the state that held over its whole exposure window `[t, t + exposure (+ readout)]`; a frame whose
 *  window straddles a switch is *ambiguous* and gets dropped. No pipeline model, immune to dropped
 *  frames.
 *
 *  `StateLog` is that log; `ClockMap` maps the browser's `performance.now()` onto the device clock so
 *  a switch the *browser* commanded can be logged in device time until the device timestamps light
 *  events itself (the `light` event carries no `t` yet). Both are pure and allocation-free after
 *  construction (fixed rings). */

export const AMBIGUOUS = 'ambiguous'
export type Ambiguous = typeof AMBIGUOUS

interface Entry<T> {
  /** the old state may still hold at `tFrom` (the command was sent) ... */
  tFrom: number
  /** ... and the new one certainly holds from `tSettled` on (the device confirmed the change) */
  tSettled: number
  state: T
}

/** Ring of timed state switches. `push(t, state)` records that `state` holds from `t` on (the
 *  previous state held until then); `push(tFrom, state, tSettled)` records a switch whose exact
 *  moment is only known to lie inside `[tFrom, tSettled]` (a browser-timed RPC: sent at `tFrom`,
 *  acknowledged at `tSettled`), which makes any window touching that interval ambiguous.
 *
 *  `stateOver(t0, t1)` is the state that held over the whole closed window `[t0, t1]`:
 *  `'ambiguous'` when a switch (or a switch's uncertainty interval) falls inside it, when the window
 *  begins before the oldest logged switch, or when the log is empty. Times are any monotonic
 *  number, ns on the device clock in practice; pushes must be in non-decreasing time order (an
 *  out-of-order push is clamped to the previous one). Capacity defaults to 64 switches: at one
 *  switch per frame and 18 fps that is 3.5 s of history, far more than the pipeline delay. */
export class StateLog<T> {
  private readonly ring: Entry<T>[]
  private head = 0   // index of the next slot to write
  private count = 0

  constructor(readonly capacity = 64) {
    if (capacity < 2) throw new Error('StateLog: capacity must be ≥ 2')
    this.ring = new Array(capacity)
  }

  get length(): number { return this.count }

  clear(): void { this.head = 0; this.count = 0 }

  /** The most recently pushed state (what holds "now"), or `undefined` on an empty log. */
  latest(): T | undefined { return this.count ? this.ring[(this.head - 1 + this.capacity) % this.capacity].state : undefined }

  push(tFrom: number, state: T, tSettled: number = tFrom): void {
    if (tSettled < tFrom) tSettled = tFrom
    const last = this.count ? this.ring[(this.head - 1 + this.capacity) % this.capacity] : null
    if (last && tFrom < last.tSettled) { tFrom = last.tSettled; if (tSettled < tFrom) tSettled = tFrom }
    const slot = this.ring[this.head]
    if (slot) { slot.tFrom = tFrom; slot.tSettled = tSettled; slot.state = state } else this.ring[this.head] = { tFrom, tSettled, state }
    this.head = (this.head + 1) % this.capacity
    if (this.count < this.capacity) this.count++
  }

  private at(i: number): Entry<T> { return this.ring[(this.head - this.count + i + this.capacity * 2) % this.capacity] }

  stateOver(t0: number, t1: number): T | Ambiguous {
    if (t1 < t0) { const s = t0; t0 = t1; t1 = s }
    if (!this.count) return AMBIGUOUS
    // the last switch that began at or before t0 (binary search over the chronological view)
    let lo = 0, hi = this.count - 1, found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (this.at(mid).tFrom <= t0) { found = mid; lo = mid + 1 } else hi = mid - 1
    }
    if (found < 0) return AMBIGUOUS                    // the window begins before the oldest known switch
    const e = this.at(found)
    if (t0 < e.tSettled) return AMBIGUOUS              // the window begins inside a switch's uncertainty
    if (found + 1 < this.count && this.at(found + 1).tFrom <= t1) return AMBIGUOUS   // the next switch begins inside the window
    return e.state
  }
}

/** Maps browser time (`performance.now()`, ms) onto the device clock (ns, CLOCK_BOOTTIME).
 *
 *  Fed with pairs `(device time of a frame, browser time the frame was seen)`. A frame is seen
 *  *after* its device time by the encode + network + decode latency, so each observation gives an
 *  offset `tDevice − tBrowser` that is too small by that frame's latency; the **maximum** over the
 *  last `n` observations is the estimate with the least latency baked in, and is what `toDevice()`
 *  uses. Approximation: the residual (the minimum latency ever observed, a few tens of ms on a LAN)
 *  makes every mapped browser event look *earlier* than it was by that amount. Modes that can
 *  measure the real lag (the HDR settling check watches when the picture actually changes) pass the
 *  correction to `StateLog` pushes themselves; the map does not try to guess it. Clock drift between
 *  CLOCK_BOOTTIME and `performance.now()` over a recording is negligible against a frame interval. */
export class ClockMap {
  private readonly offsets: Float64Array
  private n = 0
  private head = 0

  constructor(readonly window = 32) { this.offsets = new Float64Array(window) }

  get ready(): boolean { return this.n > 0 }

  observe(deviceNs: number, browserMs: number): void {
    this.offsets[this.head] = deviceNs - browserMs * 1e6
    this.head = (this.head + 1) % this.window
    if (this.n < this.window) this.n++
  }

  /** Current offset estimate (ns), `NaN` before the first observation. */
  offsetNs(): number {
    if (!this.n) return NaN
    let m = -Infinity
    for (let i = 0; i < this.n; i++) if (this.offsets[i] > m) m = this.offsets[i]
    return m
  }

  toDevice(browserMs: number): number { return browserMs * 1e6 + this.offsetNs() }

  reset(): void { this.n = 0; this.head = 0 }
}
