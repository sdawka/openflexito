/** Live temporal focus stack: grabs frames from the stream <img>, feeds them to the stacker worker
 *  and exposes the composite as an ImageBitmap for the view. Resets itself when the stage moves. */
import { device } from '../store/device.svelte'
import { saveSnapshot, type GalleryItem } from '../store/gallery'
import type { LiveStackMessage } from '../workers/liveStackWorker'
import type { LiveStackStats } from '../algo/liveStack'
import type { PositionEvent } from '../api/types'
import { activity } from './activity.svelte'

class LiveStack {
  active = $state(false)
  mode = $state<'stack' | 'average'>('stack')
  stats = $state<LiveStackStats | null>(null)
  composite = $state<ImageBitmap | null>(null)
  fps = 8
  /** the live <img>, registered by StreamView */
  source: HTMLImageElement | null = null
  private worker: Worker | null = null
  private timer: ReturnType<typeof setInterval> | undefined
  private canvas: OffscreenCanvas | null = null
  private size: { w: number; h: number } | null = null
  private inflight = false
  private dropNext = false   // a frame sent before a reset is answered after it: discard that stale composite
  /** ms to wait after the last position event before trusting frames again (MJPEG latency + settling) */
  settleMs = 400
  private lastMoveEvent: PositionEvent | null = null
  private settleUntil = 0
  private settleTs = 0
  private lastComposite: { data: Uint8ClampedArray; width: number; height: number } | null = null
  private releaseActivity: (() => void) | null = null

  start(mode: 'stack' | 'average' = 'stack'): void {
    if (this.active && this.mode === mode) return
    if (this.active) this.stop()
    this.mode = mode
    this.active = true
    this.releaseActivity = activity.hold('live focus stack')
    this.lastMoveEvent = device.lastMove; this.settleUntil = 0; this.settleTs = 0
    this.worker = new Worker(new URL('../workers/liveStackWorker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = async (ev) => {
      this.inflight = false
      if (this.dropNext) { this.dropNext = false; return }
      if (ev.data.error) { console.error('live stack:', ev.data.error); return }
      const { composite, width, height, stats } = ev.data
      this.lastComposite = { data: composite, width, height }
      this.stats = stats
      const bmp = await createImageBitmap(new ImageData(composite as Uint8ClampedArray<ArrayBuffer>, width, height))
      this.composite?.close(); this.composite = bmp
    }
    this.timer = setInterval(() => this.tick(), 1000 / this.fps)
  }

  stop(): void {
    this.active = false
    clearInterval(this.timer)
    this.worker?.terminate(); this.worker = null
    this.composite?.close(); this.composite = null
    this.stats = null; this.size = null; this.inflight = false; this.dropNext = false; this.lastComposite = null
    this.releaseActivity?.(); this.releaseActivity = null
  }

  reset(): void {
    this.worker?.postMessage({ type: 'reset' } as LiveStackMessage)
    this.dropNext = this.inflight
    this.stats = null; this.lastComposite = null
    this.composite?.close(); this.composite = null
  }

  private tick(): void {
    const img = this.source
    if (!img || !img.naturalWidth || !this.worker || this.inflight) return
    // Any position event (start or end of a move, zero, jog back to the same spot) invalidates the
    // composite. Frames are then ignored while the stage moves and until both the wall clock and the
    // frame timestamps say the stream shows the settled stage: the <img> lags the events by a few frames.
    const mv = device.lastMove
    if (mv !== this.lastMoveEvent) {
      this.lastMoveEvent = mv
      this.settleUntil = performance.now() + this.settleMs
      this.settleTs = mv ? mv.t + this.settleMs * 1e6 : 0
      this.reset()
    }
    if (device.moving || performance.now() < this.settleUntil) return
    const fts = device.frame ? (device.frame.ts ?? device.frame.t) : null
    if (fts != null && fts < this.settleTs) return
    const w = img.naturalWidth, h = img.naturalHeight
    if (!this.size || this.size.w !== w || this.size.h !== h) {
      this.size = { w, h }
      this.canvas = new OffscreenCanvas(w, h)
      this.worker.postMessage({ type: 'init', width: w, height: h, mode: this.mode } as LiveStackMessage)
    }
    const ctx = this.canvas!.getContext('2d', { willReadFrequently: true })!
    try { ctx.drawImage(img, 0, 0) } catch { return }
    const data = ctx.getImageData(0, 0, w, h).data
    this.inflight = true
    this.worker.postMessage({ type: 'frame', data } as LiveStackMessage, [data.buffer])
  }

  /** Save the current composite to the gallery. */
  async save(): Promise<GalleryItem> {
    const c = this.lastComposite
    if (!c) throw new Error('no composite yet')
    const canvas = new OffscreenCanvas(c.width, c.height)
    canvas.getContext('2d')!.putImageData(new ImageData(c.data as Uint8ClampedArray<ArrayBuffer>, c.width, c.height), 0, 0)
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 })
    return saveSnapshot(blob, { position: { ...device.position }, controls: device.controls ?? undefined, name: this.mode === 'average' ? `Smoothed frame (${this.stats?.frames ?? 0} frames)` : `Live stack (${this.stats?.frames ?? 0} frames)` })
  }
}

export const liveStack = new LiveStack()
