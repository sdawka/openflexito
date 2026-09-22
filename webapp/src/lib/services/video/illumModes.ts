/** Interleaved-illumination video: the LEDs alternate between two illumination presets (A, B, from
 *  the Illumination panel's presets, e.g. two oblique directions, or brightfield and dark-field), each
 *  held for `hold` frames with AE/AWB locked, and every output frame combines the newest attributed
 *  frame of each state:
 *
 *  - `dpc`: pseudo differential phase contrast `0.5 + gain·(A − B)/(A + B + ε)` on the luma (Tian &
 *    Waller 2015, qualitative: the quantitative inversion needs the LED geometry's transfer function),
 *    after normalising each channel by its running mean so LED brightness mismatch is not a DC offset.
 *  - `rheinberg`: `tintA·A + tintB·B` — the coloured-stop technique done numerically.
 *  - `split`: A left, B right, for teaching.
 *
 *  Frame attribution (`docs/video-research/creative.md` §0) is by **timestamp** when the stream
 *  carries one (`LightAttributor`, below, on `algo/frameAttrib.ts`): a frame belongs to the state
 *  that held over its whole exposure window, frames exposed across a switch are dropped, and the
 *  camera pipeline's delay never enters. Without timestamps the mode falls back to the state
 *  commanded `latency` frames earlier, uses only the last frame of each hold (`hold` ≥ 3, the first
 *  ones may straddle the switch) and checks the two states' luma. Either way the mode reports
 *  "channels look identical" when a preset changes nothing in the picture. `hdrVideo.ts` is the
 *  bright/dim special case of this scheme and shares the attributor. */

import { device } from '../../store/device.svelte'
import { settings } from '../../store/settings.svelte'
import { lockCamera, type CameraLock } from '../cameraLock'
import type { RgbaFrame } from '../frameChain'
import type { VideoModeRun, ModeOutput, ModeFrameInfo } from './types'
import { OutBuffer } from './common'
import { StateLog, ClockMap, AMBIGUOUS } from '../../algo/frameAttrib'

export interface IllumParams { presetA: string; presetB: string; hold: number; output: 'dpc' | 'rheinberg' | 'split'; gain: number; tintA: string; tintB: string }

/** IMX219 rolling-shutter readout at the 1640×1232 stream mode (~1/30 s): the last row finishes
 *  exposing this long after the first row started, so a frame's exposure window is
 *  `[t, t + exposure + READOUT]`. Over-estimating only costs the odd extra dropped frame. */
const READOUT_NS = 33e6
/** Exposure assumed when the frame history has none (µs → 20 ms). */
const DEFAULT_EXPOSURE_US = 20_000

/** Exposure (ns) of the frame with `seq` from the device store's recent metadata, else the latest
 *  frame's, else a default. The stream part and `event.frame` share the same `seq`. */
export function frameExposureNs(seq: number): number {
  const fr = device.frames
  for (let i = fr.length - 1, k = 0; i >= 0 && k < 64; i--, k++) {
    const f = fr[i]
    if (f.seq === seq) return (f.exposure ?? DEFAULT_EXPOSURE_US) * 1e3
  }
  return (device.frame?.exposure ?? DEFAULT_EXPOSURE_US) * 1e3
}

/** Attributes frames to the illumination state they were exposed under.
 *
 *  Primary path (frames carry `t`): every switch the mode commands is logged in device time as an
 *  uncertainty interval `[sent, acknowledged]` (browser `performance.now()` mapped through a
 *  `ClockMap` fed with each processed frame's `t`), plus `lagNs`, a correction a mode may measure
 *  (the HDR settling check watches when the picture actually changes and sets it). A frame is then
 *  `StateLog.stateOver(t, t + exposure + readout)`; `null` when that is ambiguous (the frame is
 *  dropped). Approximation until the device timestamps its own `light` events: the clock map is
 *  biased early by the smallest frame latency it has seen (tens of ms), which is why the interval,
 *  the rolling-shutter readout margin and the measured lag all err toward dropping a frame rather
 *  than mis-attributing it.
 *
 *  Fallback (no `t`): the state commanded `latency` processed frames earlier (the camera pipeline's
 *  depth, default 2, measurable by the settling check). Callers validate that with luma. */
export class LightAttributor<T> {
  readonly log = new StateLog<T>()
  readonly clock = new ClockMap()
  private readonly queue: T[] = []
  private current: T
  private pending: Promise<void> | null = null
  /** fallback pipeline latency in processed frames */
  latency = 2
  /** correction (ns) added to every browser-timed switch, see the class comment */
  lagNs = 0
  /** device-time estimate of the last commanded switch: `[sent, acknowledged]` midpoint (NaN before the first) */
  lastSwitchNs = NaN
  /** whether the last attributed frame carried a timestamp (status text) */
  timestamped = false
  switches = 0

  constructor(initial: T, private readonly apply: (s: T) => Promise<void>) {
    this.current = initial
    this.seedClock()
  }

  get state(): T { return this.current }
  get switching(): boolean { return this.pending !== null }
  get done(): Promise<void> { return this.pending ?? Promise.resolve() }

  /** A stale metadata event gives an offset that is too small and loses to the max: seeding is safe. */
  private seedClock(): void {
    const f = device.frame
    if (!this.clock.ready && f && typeof f.t === 'number') this.clock.observe(f.ts ?? f.t, performance.now())
  }

  /** Command a switch (the promise resolves when the device acknowledged it; errors are swallowed,
   *  the device store reports them). Ignored while a previous switch is still pending. */
  command(s: T): Promise<void> {
    if (this.pending) return this.pending
    this.current = s
    const tSend = performance.now()
    this.seedClock()
    const p = this.apply(s).catch(() => {}).then(() => {
      const tAck = performance.now()
      if (this.clock.ready) {
        const a = this.clock.toDevice(tSend) + this.lagNs, b = this.clock.toDevice(tAck) + this.lagNs
        this.log.push(a, s, b)
        this.lastSwitchNs = (a + b) / 2
      }
      this.switches++
      this.pending = null
    })
    this.pending = p
    return p
  }

  /** Call once per processed frame, before `attribute()`. */
  observe(info: ModeFrameInfo): void {
    this.queue.push(this.current)
    while (this.queue.length > this.latency + 1) this.queue.shift()
    if (info.t != null) this.clock.observe(info.t, performance.now())
  }

  /** The state the frame was exposed under, or `null` for a frame that straddles a switch. */
  attribute(info: ModeFrameInfo): T | null {
    const commanded = this.queue[0] ?? this.current
    if (info.t == null || !this.log.length) { this.timestamped = false; return commanded }
    this.timestamped = true
    const r = this.log.stateOver(info.t, info.t + frameExposureNs(info.seq) + READOUT_NS)
    return r === AMBIGUOUS ? null : r
  }

  reset(): void { this.log.clear(); this.queue.length = 0 }
}

/** Mean luma of an RGBA frame sampled every 16th pixel. */
export function meanLuma(d: Uint8ClampedArray): number {
  let s = 0, k = 0
  for (let i = 0; i < d.length; i += 64) { s += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114; k++ }
  return k ? s / k : 0
}

function hex(c: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c)
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [1, 1, 1]
}

export function illumMode(p: IllumParams): VideoModeRun {
  let lock: CameraLock | null = null
  let saved: { cc: number; pwm: number[] } | null = null
  let attrib: LightAttributor<'A' | 'B'> | null = null
  let holdCount = 0
  let A: Uint8ClampedArray | null = null, B: Uint8ClampedArray | null = null
  let nA = -1, nB = -1   // frame index of each partner, to cap staleness
  let meanA = 0, meanB = 0
  let n = 0, fused = 0, dropped = 0, stale = 0
  const out = new OutBuffer()
  const tA = hex(p.tintA), tB = hex(p.tintB)
  const hold = Math.max(1, p.hold)

  const apply = (s: 'A' | 'B') => {
    const name = s === 'A' ? p.presetA : p.presetB
    const pr = settings.lightPresets[name]
    if (!pr) return Promise.reject(new Error(`unknown illumination preset "${name}"`))
    return device.setLight(pr.cc, pr.pwm)
  }

  return {
    id: 'illum',
    drivesStage: true,
    async start() {
      if (!settings.lightPresets[p.presetA] || !settings.lightPresets[p.presetB]) throw new Error('choose two illumination presets (Illumination panel → presets)')
      saved = { cc: device.light.cc, pwm: [...device.light.pwm] }
      lock = await lockCamera({ ae: true, awb: true })
      attrib = new LightAttributor<'A' | 'B'>('A', apply)
      await attrib.command('A')
      holdCount = 0
    },
    process(f: RgbaFrame, info: ModeFrameInfo): ModeOutput | null {
      if (!attrib) return null
      n++
      attrib.observe(info)
      holdCount++
      const lastOfHold = holdCount >= hold
      if (lastOfHold && !attrib.switching) { void attrib.command(attrib.state === 'A' ? 'B' : 'A'); holdCount = 0 }
      const attributed = attrib.attribute(info)
      if (attributed === null) { dropped++; return null }
      // fallback only: use just the last frame of a hold (the first ones may straddle the switch)
      if (!attrib.timestamped && hold >= 3 && !lastOfHold) return null
      const mean = meanLuma(f.data)
      if (attributed === 'A') { A = A?.length === f.data.length ? A : new Uint8ClampedArray(f.data.length); A.set(f.data); meanA = meanA ? 0.8 * meanA + 0.2 * mean : mean; nA = n }
      else { B = B?.length === f.data.length ? B : new Uint8ClampedArray(f.data.length); B.set(f.data); meanB = meanB ? 0.8 * meanB + 0.2 * mean : mean; nB = n }
      if (!A || !B) return null
      // a partner older than two holds + the pipeline would double a moving organism
      if (Math.abs(nA - nB) > 2 * hold + 3) { stale++; return null }
      const o = out.get(f.width, f.height)
      const gA = meanA > 1 ? 128 / meanA : 1, gB = meanB > 1 ? 128 / meanB : 1
      if (p.output === 'dpc') {
        for (let i = 0; i < o.length; i += 4) {
          const la = (A[i] * 0.299 + A[i + 1] * 0.587 + A[i + 2] * 0.114) * gA, lb = (B[i] * 0.299 + B[i + 1] * 0.587 + B[i + 2] * 0.114) * gB
          const v = 128 + p.gain * 128 * ((la - lb) / (la + lb + 4))
          o[i] = v; o[i + 1] = v; o[i + 2] = v; o[i + 3] = 255
        }
      } else if (p.output === 'rheinberg') {
        for (let i = 0; i < o.length; i += 4) {
          o[i] = A[i] * tA[0] + B[i] * tB[0]; o[i + 1] = A[i + 1] * tA[1] + B[i + 1] * tB[1]; o[i + 2] = A[i + 2] * tA[2] + B[i + 2] * tB[2]; o[i + 3] = 255
        }
      } else {
        const half = f.width >> 1
        for (let y = 0; y < f.height; y++) {
          const row = y * f.width * 4
          o.set(A.subarray(row, row + half * 4), row)
          o.set(B.subarray(row + half * 4, row + f.width * 4), row + half * 4)
        }
      }
      fused++
      return { frame: { data: o, width: f.width, height: f.height } }
    },
    reset() { A = null; B = null; nA = nB = -1; attrib?.reset() },
    async stop() {
      await attrib?.done
      if (saved) { try { await device.setLight(saved.cc, saved.pwm) } catch { /* reported by the device store */ } }
      await lock?.release(); lock = null
    },
    status: () => `LED ${attrib?.state ?? '—'} · ${fused} fused · ${attrib?.timestamped ? 'timestamped' : 'commanded'} attribution${dropped ? ` · ${dropped} straddled a switch` : ''}${stale ? ` · ${stale} stale` : ''} · levels A ${meanA.toFixed(0)} / B ${meanB.toFixed(0)}${meanA && meanB && Math.abs(meanA - meanB) < 2 && p.output !== 'split' ? ' · channels look identical (check the presets)' : ''}`,
    stats: () => ({ frames: n, fused, dropped, stale, attribution: attrib?.timestamped ? 'timestamp' : 'commanded', presetA: p.presetA, presetB: p.presetB, hold: p.hold, output: p.output, meanA: Math.round(meanA), meanB: Math.round(meanB), lockedAe: lock?.locked.ae ?? false }),
  }
}
