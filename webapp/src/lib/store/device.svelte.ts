/** Reactive view of the device: connection, status, stage position, latest frame metadata. */

import { RpcClient } from '../api/rpc'
import type {
  CameraControls, DeviceStatus, FrameMeta, MoveResult, PositionEvent, PowerStatus, StageStatus, Vec3,
} from '../api/types'
import { settings } from './settings.svelte'

const FRAME_HISTORY = 600   // ~20 s at 30 fps, enough for an autofocus sweep

export type Compensation = boolean | 'all' | 'xy' | 'z'

class DeviceStore {
  client = new RpcClient(settings.deviceUrl)
  connected = $state(false)
  status = $state<DeviceStatus | null>(null)
  position = $state<Vec3>({ x: 0, y: 0, z: 0 })
  moving = $state(false)
  lastMove = $state<PositionEvent | null>(null)
  frame = $state<FrameMeta | null>(null)
  fps = $state(0)
  /** Measured live-stream bitrate in kB/s, from `event.frame`'s own `size`/`t` (no second stream
   *  opened just to measure it — CLAUDE.md: `api/snapshot.ts` is the only place besides the MJPEG
   *  reader that fetches frame bytes, and this reuses metadata already flowing through the store). */
  streamKBs = $state(0)
  light = $state<{ cc: number; pwm: number[]; channels?: { cc: number; pwm: number } }>({ cc: 0, pwm: [] })
  controls = $state<CameraControls | null>(null)
  error = $state<string | null>(null)

  /** Standby state. Missing `status.power` (older device) reads as on. */
  get powerOn(): boolean { return this.status?.power?.on ?? true }

  /** Seconds until auto standby, or -1 when disabled/off/unknown. Kept fresh by any power.* reply,
   *  including services/activity.svelte.ts's heartbeat — that's the most frequent source. */
  get idleIn(): number { return this.status?.power?.idle_in ?? -1 }
  /** Auto-standby timeout in minutes; the device's own default (until status arrives) is 10. */
  get idleMinutes(): number { return this.status?.power?.idle_minutes ?? 10 }

  /** Ring buffers used by browser-side algorithms (autofocus). Not reactive on purpose. */
  frames: FrameMeta[] = []
  positions: PositionEvent[] = []

  private fpsWindow: number[] = []
  private bitrateWindow: { t: number; size: number }[] = []

  constructor() {
    this.bind(this.client)
  }

  /** Attach this store's handlers to a client (also used when the device URL changes). */
  private bind(c: RpcClient): void {
    c.on('$open', () => { this.connected = true; this.error = null })
    c.on('$close', () => { this.connected = false })
    c.on('event.hello', (s: DeviceStatus) => this.applyStatus(s))
    c.on('event.status', (s: Partial<DeviceStatus>) => {
      if (this.status) this.status = { ...this.status, ...s } as DeviceStatus
    })
    c.on('event.position', (p: PositionEvent) => {
      this.position = p.position
      this.moving = p.moving
      this.lastMove = p
      this.positions.push(p)
      if (this.positions.length > 200) this.positions.shift()
    })
    c.on('event.frame', (f: FrameMeta) => {
      this.frame = f
      this.frames.push(f)
      if (this.frames.length > FRAME_HISTORY) this.frames.shift()
      const now = performance.now()
      this.fpsWindow.push(now)
      while (this.fpsWindow.length && now - this.fpsWindow[0] > 2000) this.fpsWindow.shift()
      this.fps = this.fpsWindow.length / 2
      if (f.stream === 'main' && typeof f.size === 'number') {
        this.bitrateWindow.push({ t: now, size: f.size })
        while (this.bitrateWindow.length && now - this.bitrateWindow[0].t > 3000) this.bitrateWindow.shift()
        if (this.bitrateWindow.length > 1) {
          const spanMs = now - this.bitrateWindow[0].t
          const bytes = this.bitrateWindow.reduce((s, w) => s + w.size, 0)
          this.streamKBs = spanMs > 0 ? bytes / 1024 / (spanMs / 1000) : 0
        }
      }
    })
    c.on('event.light', (l: { cc: number; pwm: number[]; channels?: { cc: number; pwm: number } }) => { this.light = l })
  }

  connect(): void {
    this.client.baseUrl = settings.deviceUrl
    this.client.connect()
  }

  reconnect(): void {
    this.client.close()
    this.connected = false
    this.client = new RpcClient(settings.deviceUrl)
    this.bind(this.client)   // (previously the handlers were bound to a throwaway store, so the UI never updated after a URL change)
    this.connect()
  }

  private applyStatus(s: DeviceStatus): void {
    this.status = s
    if (s.stage) {
      this.position = s.stage.position
      this.moving = s.stage.moving
    }
    if (s.camera) this.controls = s.camera.controls
    this.client.call('light.get').then((l) => { this.light = l }).catch(() => {})
  }

  url(path: string): string {
    return this.client.httpUrl(path)
  }

  // ---- actions -------------------------------------------------------------------------------

  async refreshStatus(): Promise<void> {
    this.applyStatus(await this.client.call<DeviceStatus>('system.status'))
  }

  /** compensate: true = backlash-correct the moving axes (v3 MOVEMENT_AXES); 'all' | 'xy' | 'z' =
   *  correct those axes regardless (v3 ALL_AXES / XY_ONLY / Z_ONLY); false = raw move. */
  moveRel(d: Partial<Vec3>, compensate: Compensation = true): Promise<MoveResult> {
    return this.guard(this.client.call<MoveResult>('stage.move_rel', { ...d, compensate }))
  }

  moveTo(p: Partial<Vec3>, compensate: Compensation = true): Promise<MoveResult> {
    return this.guard(this.client.call<MoveResult>('stage.move_to', { ...p, compensate }))
  }

  jog(d: Partial<Vec3>): Promise<MoveResult> {
    return this.guard(this.client.call<MoveResult>('stage.jog', d))
  }

  stop(): Promise<unknown> {
    return this.guard(this.client.call('stage.stop'))
  }

  release(): Promise<unknown> { return this.guard(this.client.call('stage.release')) }
  zero(): Promise<unknown> { return this.guard(this.client.call('stage.zero')) }
  restorePosition(): Promise<unknown> { return this.guard(this.client.call('stage.restore_position')) }

  private lightSeq = 0
  private controlsSeq = 0

  // Replies carry the full device state; an older request resolving after a newer one must not
  // overwrite the store with the older state.
  async setLight(cc?: number, pwm?: number[]): Promise<void> {
    const seq = ++this.lightSeq
    const l = await this.guard(this.client.call('light.set', { cc, pwm }))
    if (seq === this.lightSeq) this.light = l
  }

  async setControls(c: Partial<CameraControls>): Promise<void> {
    const seq = ++this.controlsSeq
    const r = await this.guard(this.client.call<CameraControls>('camera.set_controls', c))
    if (seq === this.controlsSeq) this.controls = r
  }

  async stageStatus(): Promise<StageStatus> {
    return this.client.call<StageStatus>('stage.status')
  }

  /** Merges a power.* reply into status.power. Used for both the on/off actions below and by
   *  services/activity.svelte.ts's heartbeat, which is the most frequent source of a fresh `idle_in`
   *  — a spread merge so it never clobbers fields (e.g. `idle_minutes`) that reply doesn't carry. */
  applyPower(p: PowerStatus): void {
    if (this.status) this.status = { ...this.status, power: { ...this.status.power, ...p } }
  }

  private powerSeq = 0

  /** Applies optimistically so the standby screen (App.svelte) flips immediately, then reconciles
   *  with the device's own reply; a failure (or a newer call finishing first) rolls the optimistic
   *  value back. */
  async setPower(on: boolean): Promise<void> {
    const seq = ++this.powerSeq
    const prev = this.status?.power
    if (this.status) this.status = { ...this.status, power: { ...prev, on, since: prev?.since ?? Date.now(), reason: 'request' } }
    try {
      const r = await this.client.call<PowerStatus>('power.set', { on })
      if (seq === this.powerSeq) this.applyPower(r)
    } catch (e) {
      if (seq === this.powerSeq && this.status) this.status = { ...this.status, power: prev }
      this.error = (e as Error).message
      throw e
    }
  }

  async togglePower(): Promise<void> {
    return this.setPower(!this.powerOn)
  }

  private idleSeq = 0

  async setIdleMinutes(minutes: number): Promise<void> {
    const seq = ++this.idleSeq
    try {
      const r = await this.client.call<PowerStatus>('power.set_idle', { minutes })
      if (seq === this.idleSeq) this.applyPower(r)
    } catch (e) {
      this.error = (e as Error).message
      throw e
    }
  }

  private guard<T>(p: Promise<T>): Promise<T> {
    return p.catch((e: Error) => { this.error = e.message; throw e })
  }
}

export const device = new DeviceStore()
