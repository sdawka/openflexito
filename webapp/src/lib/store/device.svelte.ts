/** Reactive view of the device: connection, status, stage position, latest frame metadata. */

import { RpcClient } from '../api/rpc'
import type {
  CameraControls, DeviceStatus, FrameMeta, MoveResult, PositionEvent, StageStatus, Vec3,
} from '../api/types'
import { settings } from './settings.svelte'

const FRAME_HISTORY = 600   // ~20 s at 30 fps, enough for an autofocus sweep

class DeviceStore {
  client = new RpcClient(settings.deviceUrl)
  connected = $state(false)
  status = $state<DeviceStatus | null>(null)
  position = $state<Vec3>({ x: 0, y: 0, z: 0 })
  moving = $state(false)
  lastMove = $state<PositionEvent | null>(null)
  frame = $state<FrameMeta | null>(null)
  fps = $state(0)
  light = $state<{ cc: number; pwm: number[] }>({ cc: 0, pwm: [] })
  controls = $state<CameraControls | null>(null)
  error = $state<string | null>(null)

  /** Ring buffers used by browser-side algorithms (autofocus). Not reactive on purpose. */
  frames: FrameMeta[] = []
  positions: PositionEvent[] = []

  private fpsWindow: number[] = []

  constructor() {
    const c = this.client
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
    })
    c.on('event.light', (l: { cc: number; pwm: number[] }) => { this.light = l })
  }

  connect(): void {
    this.client.baseUrl = settings.deviceUrl
    this.client.connect()
  }

  reconnect(): void {
    this.client.close()
    this.client = new RpcClient(settings.deviceUrl)
    // re-bind handlers by re-running the constructor logic
    const fresh = new DeviceStore()
    this.client = fresh.client
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

  moveRel(d: Partial<Vec3>, compensate = true): Promise<MoveResult> {
    return this.guard(this.client.call<MoveResult>('stage.move_rel', { ...d, compensate }))
  }

  moveTo(p: Partial<Vec3>, compensate = true): Promise<MoveResult> {
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

  async setLight(cc?: number, pwm?: number[]): Promise<void> {
    this.light = await this.guard(this.client.call('light.set', { cc, pwm }))
  }

  async setControls(c: Partial<CameraControls>): Promise<void> {
    this.controls = await this.guard(this.client.call<CameraControls>('camera.set_controls', c))
  }

  async stageStatus(): Promise<StageStatus> {
    return this.client.call<StageStatus>('stage.status')
  }

  private guard<T>(p: Promise<T>): Promise<T> {
    return p.catch((e: Error) => { this.error = e.message; throw e })
  }
}

export const device = new DeviceStore()
