/** Live temporal focus stack: grabs frames from the stream <img>, feeds them to the stacker worker
 *  and exposes the composite as an ImageBitmap for the view. Resets itself when the stage moves. */
import { device } from '../store/device.svelte'
import { saveSnapshot, type GalleryItem } from '../store/gallery'
import type { LiveStackMessage } from '../workers/liveStackWorker'
import type { LiveStackStats } from '../algo/liveStack'

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
  private lastPos = ''
  private lastComposite: { data: Uint8ClampedArray; width: number; height: number } | null = null

  start(mode: 'stack' | 'average' = 'stack'): void {
    if (this.active && this.mode === mode) return
    if (this.active) this.stop()
    this.mode = mode
    this.active = true
    this.worker = new Worker(new URL('../workers/liveStackWorker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = async (ev) => {
      this.inflight = false
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
    this.stats = null; this.size = null; this.inflight = false; this.lastComposite = null
  }

  reset(): void {
    this.worker?.postMessage({ type: 'reset' } as LiveStackMessage)
    this.stats = null
  }

  private tick(): void {
    const img = this.source
    if (!img || !img.naturalWidth || !this.worker || this.inflight) return
    // any stage motion invalidates the composite
    const pos = `${device.position.x},${device.position.y},${device.position.z}`
    if (device.moving) { this.lastPos = ''; return }
    if (pos !== this.lastPos) { if (this.lastPos) this.reset(); this.lastPos = pos }
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
