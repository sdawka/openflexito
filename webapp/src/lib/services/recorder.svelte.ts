/** Video recording of what the live view shows (the stream or the live focus stack) with
 *  MediaRecorder: frames are drawn into a canvas at a steady rate and its captured stream is encoded
 *  to WebM in the browser. Saved to the gallery as a video item. */
import { device } from '../store/device.svelte'
import { saveVideo, type GalleryItem } from '../store/gallery'

export type FrameSource = () => { image: CanvasImageSource; width: number; height: number } | null

class Recorder {
  recording = $state(false)
  seconds = $state(0)
  status = $state('')
  private rec: MediaRecorder | null = null
  private chunks: Blob[] = []
  private canvas: HTMLCanvasElement | null = null
  private timer: ReturnType<typeof setInterval> | undefined
  private clock: ReturnType<typeof setInterval> | undefined
  private startedAt = 0
  private label = ''
  private thumb: Blob | null = null

  static mime(): string {
    for (const m of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']) if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) return m
    return ''
  }

  start(source: FrameSource, label: string, fps = 15): void {
    if (this.recording) return
    const mime = Recorder.mime()
    if (!mime) { this.status = 'video recording is not supported by this browser'; return }
    const first = source()
    if (!first) { this.status = 'no frame to record yet'; return }
    this.label = label
    const canvas = document.createElement('canvas')
    canvas.width = first.width; canvas.height = first.height
    this.canvas = canvas
    const ctx = canvas.getContext('2d')!
    const draw = () => { const f = source(); if (f) { if (canvas.width !== f.width || canvas.height !== f.height) { canvas.width = f.width; canvas.height = f.height } ctx.drawImage(f.image, 0, 0, f.width, f.height) } }
    draw()
    const stream = canvas.captureStream(fps)
    this.rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12_000_000 })
    this.chunks = []
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data) }
    this.rec.start(1000)
    this.timer = setInterval(draw, 1000 / fps)
    this.startedAt = performance.now(); this.seconds = 0
    this.clock = setInterval(() => (this.seconds = Math.round((performance.now() - this.startedAt) / 1000)), 500)
    this.recording = true; this.status = ''
    // thumbnail from the first second
    setTimeout(() => canvas.toBlob((b) => (this.thumb = b), 'image/jpeg', 0.8), 800)
  }

  /** Stop and save to the gallery. */
  async stop(): Promise<GalleryItem | null> {
    if (!this.rec || !this.recording) return null
    clearInterval(this.timer); clearInterval(this.clock)
    const rec = this.rec
    const done = new Promise<void>((r) => (rec.onstop = () => r()))
    rec.stop(); await done
    this.recording = false
    const durationS = (performance.now() - this.startedAt) / 1000
    const blob = new Blob(this.chunks, { type: rec.mimeType || 'video/webm' })
    const thumb = this.thumb ?? (await new Promise<Blob | null>((r) => this.canvas!.toBlob(r, 'image/jpeg', 0.8)))
    this.rec = null; this.thumb = null; this.chunks = []
    this.status = 'saving…'
    const item = await saveVideo(blob, thumb, { durationS, fps: 15, source: this.label, width: this.canvas!.width, height: this.canvas!.height, position: { ...device.position } })
    this.status = `saved "${item.name}" (${durationS.toFixed(0)} s, ${(blob.size / 1048576).toFixed(1)} MB)`
    setTimeout(() => (this.status = ''), 5000)
    return item
  }
}

export const recorder = new Recorder()
