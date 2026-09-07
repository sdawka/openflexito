/** Wires organism tracking (`algo/tracking.ts`: blob detection + nearest-neighbour linking) to the
 *  live stream or a stored time-lapse. On the live stream it samples the live `<img>`
 *  (`liveStack.source`) at ~5 fps via an OffscreenCanvas; on a time-lapse it walks the saved frames in
 *  order. Detected trajectories are exposed for `StreamView`'s additive `paths` prop and as a CSV. */

import { BlobTracker, detectBlobs, tracksToCsv, type Track } from '../algo/tracking'
import { toGray } from '../algo/sharpness'
import { getBlob, type GalleryItem } from '../store/gallery'
import { ai } from './aiService.svelte'
import { liveStack } from './liveStack.svelte'

const FPS = 5

class TrackingService {
  active = $state(false)
  tracks = $state<Track[]>([])
  useAi = $state(false)
  maxDisplacementPx = $state(40)
  status = $state('')
  /** size of the frame the current track coordinates are in (px); needed to turn them into fractions
   *  for the StreamView overlay */
  frameWidth = $state(0)
  frameHeight = $state(0)

  private tracker: BlobTracker | null = null
  private timer: ReturnType<typeof setInterval> | undefined
  private startT = 0
  private busy = false

  start(): void {
    if (this.active) return
    this.tracker = new BlobTracker(this.maxDisplacementPx, 3)
    this.tracks = []
    this.active = true
    this.startT = performance.now()
    this.status = 'tracking…'
    this.timer = setInterval(() => { void this.tick() }, 1000 / FPS)
  }

  stop(): void {
    this.active = false
    clearInterval(this.timer)
    this.status = ''
  }

  private async tick(): Promise<void> {
    const img = liveStack.source
    if (!img || !img.naturalWidth || this.busy || !this.tracker) return
    this.busy = true
    try {
      const w = img.naturalWidth, h = img.naturalHeight
      this.frameWidth = w; this.frameHeight = h
      const c = new OffscreenCanvas(w, h)
      const ctx = c.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(img, 0, 0)
      const t = (performance.now() - this.startT) / 1000
      const blobs = this.useAi ? await this.aiBlobs(c, w, h) : detectBlobs(toGray(ctx.getImageData(0, 0, w, h)))
      this.tracks = [...this.tracker.step(t, blobs)]
      this.status = `${this.tracks.filter((tr) => tr.active).length} active track(s)`
    } catch (e) {
      this.status = (e as Error).message
    } finally {
      this.busy = false
    }
  }

  private async aiBlobs(canvas: OffscreenCanvas, w: number, h: number): Promise<{ x: number; y: number; area: number }[]> {
    const bmp = canvas.transferToImageBitmap()
    const detections = await ai.detect(bmp)
    return detections.map((d) => ({
      x: (d.box.xmin + d.box.xmax) / 2 * w, y: (d.box.ymin + d.box.ymax) / 2 * h,
      area: (d.box.xmax - d.box.xmin) * w * (d.box.ymax - d.box.ymin) * h,
    }))
  }

  /** Run detection + linking over every frame of a saved time-lapse, replacing any live tracking. */
  async runOnTimelapse(item: GalleryItem): Promise<Track[]> {
    const meta = item.timelapse
    if (!meta) throw new Error('not a time-lapse item')
    this.stop()
    this.tracker = new BlobTracker(this.maxDisplacementPx, 3)
    this.tracks = []
    for (let i = 0; i < meta.frames.length; i++) {
      const blob = await getBlob(item.id, `f${String(i).padStart(4, '0')}`)
      if (!blob) continue
      const bmp = await createImageBitmap(blob)
      const c = new OffscreenCanvas(bmp.width, bmp.height)
      const ctx = c.getContext('2d')!
      ctx.drawImage(bmp, 0, 0)
      bmp.close()
      this.frameWidth = bmp.width; this.frameHeight = bmp.height
      const blobs = detectBlobs(toGray(ctx.getImageData(0, 0, c.width, c.height)))
      this.tracks = [...this.tracker.step((i * meta.intervalMs) / 1000, blobs)]
    }
    return this.tracks
  }

  /** micrometres per pixel, if known (from the CSM calibration's reference frame), for the µm/s column */
  exportCsv(umPerPx?: number): string {
    return tracksToCsv(this.tracks, umPerPx)
  }
}

export const tracking = new TrackingService()
