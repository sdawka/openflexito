/** Live extended depth of field: while `/edof.bin` is open the device runs a fast sensor mode and
 *  sweeps z back and forth in legs of `range + backlash` steps; `workers/edofWorker.ts` fuses each
 *  leg's frames into one composite (per-block sharpest frame, so moving organisms do not ghost) and
 *  hands it back when the leg completes (~3/s). This service owns the run: it parks z at the bottom of
 *  the band first (so the first leg starts engaged, moving up), pipes the stream's records into the
 *  worker, keeps the latest composite for `StreamView.svelte`, and can record the composites as a
 *  video through `recorder.startFeed()` with each composite's mid-leg time as its frame time.
 *  Closing the stream is what stops the sweeps and returns z to where they started; `stop()` then
 *  moves back to the centre of the band. */
import { device } from '../store/device.svelte'
import { EdofStream, type EdofInfo, type EdofRecord } from '../api/edofStream'
import type { StageStatus } from '../api/types'
import { activity } from './activity.svelte'
import { recorder } from './recorder.svelte'
import { scan } from './scan.svelte'
import { liveStack } from './liveStack.svelte'
import { focusCtl } from '../store/focusCtl.svelte'
import type { EdofWorkerIn, EdofWorkerOut } from '../workers/edofWorker'

export type EdofMode = 'crop' | 'full'

export interface EdofOptions {
  mode: EdofMode
  fps: number
  /** z steps of useful depth each leg covers */
  range: number
  /** dead band after each reversal, in z steps; null = the device's own `stage.backlash.z` */
  backlash: number | null
}

export interface EdofStats {
  /** composites received since start */
  sweeps: number
  sweepsPerS: number
  framesPerSweep: number
  usefulFraction: number
  windowMs: number
  deviceDropped: number
  workerDropped: number
  decodeMs: number
  fuseMs: number
  /** dead band the worker estimates from the focus peaks of recent legs (static scene), or null */
  backlashEstimate: number | null
}

/** IMX219's 640×480 mode reads the central 1280×960 photosites 2×2-binned: 1280 of 3280 across */
const CROP_FIELD_SHARE = 1280 / 3280
const STORE_KEY = 'openflexito.edof'
export const EDOF_MAX_FPS: Record<EdofMode, number> = { crop: 200, full: 40 }
/** device limit on `steps` per leg (`/edof.bin` answers 400 above it) */
export const MAX_LEG_STEPS = 10000
/** fusion window for a camera-only stream (steps = 0); not used while sweeping */
const DEFAULT_WINDOW_MS = 100
const DEFAULTS: EdofOptions = { mode: 'crop', fps: 120, range: 100, backlash: null }

function load(): EdofOptions {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null')
    return s && typeof s === 'object' ? { ...DEFAULTS, ...s } : { ...DEFAULTS }
  } catch { return { ...DEFAULTS } }
}

class LiveEdof {
  active = $state(false)
  starting = $state(false)
  /** true from Stop until z is back at the centre of the band */
  stopping = $state(false)
  stats = $state<EdofStats | null>(null)
  composite = $state<ImageBitmap | null>(null)
  error = $state<string | null>(null)
  info = $state<EdofInfo | null>(null)
  opts = $state<EdofOptions>(load())
  private stream: EdofStream | null = null
  private done: Promise<void> | null = null
  private worker: Worker | null = null
  private zc = 0
  private releaseActivity: (() => void) | null = null
  private stopPromise: Promise<void> | null = null
  private arrivals: number[] = []
  private deviceDropped = 0
  /** backlash the running legs were padded with and the worker models */
  runBacklash = $state(0)
  /** the device ended the sweeps (stage.stop, standby) while the stream stays open */
  sweepsStopped = $state(false)

  /** Starting, sweeping or returning: the stage belongs to this run, other moves are refused. */
  get holdsStage(): boolean { return this.active || this.starting || this.stopping }

  /** Backlash the next run pads each leg with. */
  get backlash(): number { return Math.max(0, Math.round(this.opts.backlash ?? device.status?.stage?.backlash?.z ?? 0)) }

  /** Take the worker's dead-band estimate as the backlash override (used from the next start). */
  adoptBacklashEstimate(): void {
    const e = this.stats?.backlashEstimate
    if (e == null) return
    this.opts.backlash = Math.max(0, Math.round(e))
    this.save()
  }
  /** Linear share of the field width the current stream shows (crop ≈ 39 %), or null for the full field. */
  get fieldShare(): number | null { return this.info?.mode === 'crop' ? CROP_FIELD_SHARE : null }

  save(): void {
    try { localStorage.setItem(STORE_KEY, JSON.stringify($state.snapshot(this.opts))) } catch { /* private window */ }
  }

  /** Why a run cannot start right now, or null. */
  blocker(): string | null {
    if (!device.connected) return 'not connected'
    if (recorder.recording) return 'a video recording is running'
    if (scan.running) return 'a scan is running'
    if (focusCtl.focusing) return 'autofocus is running'
    return null
  }

  async start(): Promise<void> {
    if (this.active || this.starting || this.stopPromise) return
    const why = this.blocker()
    if (why) { this.error = `cannot start extended focus: ${why}`; return }
    this.starting = true; this.error = null; this.stats = null
    this.arrivals = []; this.deviceDropped = 0; this.sweepsStopped = false
    liveStack.stop()
    const o = $state.snapshot(this.opts)
    const range = Math.max(2, Math.round(o.range))
    this.releaseActivity = activity.hold('live extended focus')
    let parked = false
    try {
      this.zc = device.position.z
      // park at the bottom of the band, approached upwards, so the first leg has no dead band
      await device.moveTo({ z: this.zc - Math.round(range / 2) }, 'z')
      parked = true
      const bl = this.backlash
      const q = new URLSearchParams({ mode: o.mode, fps: String(Math.round(o.fps)), steps: String(Math.min(MAX_LEG_STEPS, range + bl)) })
      const worker = new Worker(new URL('../workers/edofWorker.ts', import.meta.url), { type: 'module' })
      worker.onmessage = (ev) => this.onWorker(ev.data)
      this.worker = worker
      const stream = new EdofStream()
      this.stream = stream
      const { info, done } = await stream.start(device.url(`/edof.bin?${q}`), (r) => this.onRecord(r), (e) => this.fail(e.message))
      this.info = info
      this.done = done
      // the dead band the leg was padded with: the override when set, else what the device reports
      const backlash = o.backlash != null ? bl : info.backlash_z
      this.runBacklash = backlash
      worker.postMessage({
        type: 'init', width: info.width, height: info.height, backlash,
        ...(info.steps === 0 ? { windowMs: DEFAULT_WINDOW_MS } : {}),
      } satisfies EdofWorkerIn)
      this.active = true
      void done.then(() => { if (this.active && !this.stopPromise) void this.stop() })
    } catch (e) {
      this.error = (e as Error).message
      // a refused stream (409, bad params) leaves z at the bottom of the band: put it back
      await this.teardown(parked)
    } finally {
      this.starting = false
    }
  }

  /** Close the stream (the device stops sweeping and returns z to the sweep start), then go back to
   *  the centre of the band. Safe to call repeatedly. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    if (!this.active && !this.stream) return Promise.resolve()
    this.stopping = true
    this.stopPromise = this.teardown(true).finally(() => { this.stopPromise = null; this.stopping = false })
    return this.stopPromise
  }

  private async teardown(recentre: boolean): Promise<void> {
    try {
      await this.stopRecording().catch(() => {})
      this.active = false
      const stream = this.stream, done = this.done
      this.stream = null; this.done = null
      stream?.stop()
      try { await done } catch { /* the error was already reported */ }
      this.worker?.terminate(); this.worker = null
      this.composite?.close(); this.composite = null
      if (recentre) {
        await this.sweepStopped()
        await device.moveTo({ z: this.zc }, 'z').catch((e) => { this.error ??= `could not return to z=${this.zc}: ${(e as Error).message}` })
      }
    } finally {
      this.releaseActivity?.(); this.releaseActivity = null
    }
  }

  /** The reader ends as soon as the fetch is aborted; the device notices the closed connection,
   *  finishes the leg and returns z a moment later, and refuses moves until then. */
  private async sweepStopped(timeoutMs = 10000): Promise<void> {
    const until = performance.now() + timeoutMs
    while (performance.now() < until) {
      const st = await device.stageStatus().catch(() => null) as (StageStatus & { oscillating?: unknown }) | null
      if (st && !st.oscillating && !st.moving) return
      await new Promise((r) => setTimeout(r, 150))
    }
  }

  private fail(msg: string): void {
    this.error = msg
    void this.stop()
  }

  private onRecord(r: EdofRecord): void {
    const w = this.worker
    if (!w) return
    switch (r.kind) {
      case 'frame': {
        const j = r.jpeg
        const buf = j.byteOffset === 0 && j.byteLength === j.buffer.byteLength ? j.buffer as ArrayBuffer : j.slice().buffer as ArrayBuffer
        w.postMessage({ type: 'frame', jpeg: buf, ts: r.ts, seq: r.seq } satisfies EdofWorkerIn, [buf])
        break
      }
      case 'leg':
        this.deviceDropped = Math.max(this.deviceDropped, r.leg.dropped ?? 0)
        w.postMessage({ type: 'leg', leg: r.leg } satisfies EdofWorkerIn)
        break
      case 'leg_end':
        this.deviceDropped = Math.max(this.deviceDropped, r.end.dropped ?? 0)
        w.postMessage({ type: 'leg_end', end: r.end } satisfies EdofWorkerIn)
        break
      case 'status': {
        // `sweeps_stopped` (stage.stop or standby ended the sweeps, frames keep coming) is news, not a failure
        const st = r.status
        if (st.error) this.fail(st.error)
        else if (st.sweeps_stopped) this.sweepsStopped = true
        break
      }
    }
  }

  private workerDropped = 0

  private onWorker(m: EdofWorkerOut): void {
    if ('error' in m) { this.fail(`extended focus: ${m.error}`); return }
    if (m.type === 'stats') { this.workerDropped = m.droppedInWorker; return }
    const bmp = m.bitmap
    if (!this.active) { bmp.close(); return }
    const now = performance.now()
    this.arrivals.push(now)
    while (this.arrivals.length > 2 && now - this.arrivals[0] > 3000) this.arrivals.shift()
    const span = (this.arrivals[this.arrivals.length - 1] - this.arrivals[0]) / 1000
    this.stats = {
      sweeps: (this.stats?.sweeps ?? 0) + 1,
      sweepsPerS: span > 0 ? (this.arrivals.length - 1) / span : 0,
      framesPerSweep: m.frames,
      usefulFraction: m.useful,
      windowMs: (m.t1 - m.t0) / 1e6,
      deviceDropped: this.deviceDropped,
      workerDropped: this.workerDropped,
      decodeMs: m.decodeMs,
      fuseMs: m.fuseMs,
      backlashEstimate: m.backlashEstimate,
    }
    if (this.recording) recorder.feed(bmp, bmp.width, bmp.height, m.tMid)
    this.composite?.close(); this.composite = bmp
  }

  // ---- recording -------------------------------------------------------------------------------

  recording = $state(false)

  /** Record the composites as a video (VFR, one frame per sweep at its mid-leg device time). */
  record(): void {
    if (!this.active || this.recording || recorder.recording) return
    this.recording = true
    const o = $state.snapshot(this.opts), info = this.info, s0 = this.stats?.sweeps ?? 0
    recorder.startFeed('extended focus', {}, () => ({
      mode: info?.mode ?? o.mode, fps: info?.fps ?? o.fps, steps: info?.steps ?? o.range + this.backlash, range: o.range,
      backlash: this.runBacklash, sweeps: (this.stats?.sweeps ?? 0) - s0, framesPerSweep: this.stats?.framesPerSweep ?? 0,
      usefulFraction: this.stats?.usefulFraction ?? 0, windowMs: this.stats?.windowMs ?? 0, width: info?.width ?? 0, height: info?.height ?? 0,
    }))
  }

  async stopRecording(): Promise<void> {
    if (!this.recording) return
    this.recording = false
    await recorder.stop()
  }
}

export const liveEdof = new LiveEdof()
