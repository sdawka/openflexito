/** Video recording of the live stream, or the live focus stack, with MediaRecorder.
 *
 *  The live stream is read directly with `api/mjpegStream.ts` (fetch + ReadableStream, one fully
 *  decoded `createImageBitmap` per JPEG part) instead of redrawing the DOM `<img>` on a timer: a
 *  15 fps timer duplicates/drops frames relative to the ~18 fps the device actually sends, and can
 *  sample the `<img>` mid-decode (tearing) since the browser's own multipart handling gives no signal
 *  for exactly when a new part finishes decoding — this was the recorder's "shaky, glitchy" root
 *  cause (CAPTURE_AUDIT.md D8, priority 1). Each decoded frame is drawn into a canvas exactly once and
 *  pushed into a `captureStream(0)` track with `requestFrame()`, so the WebM holds one frame per
 *  source frame with no duplicates or drops. The live-stack composite (already temporally smoothed,
 *  and not an `<img>`) keeps using the existing `FrameSource` callback, throttled to `event.frame`.
 *
 *  Optional stabilisation (`algo/stabilize.ts`) removes hand/vibration jitter from the stream path: a
 *  small crop margin absorbs the correction, so the recorded frame is slightly smaller than the
 *  source. It is suspended (and the reference dropped) while `device.moving` is true, so a real stage
 *  move is never fought as if it were jitter.
 *
 *  Codec (VP9 default, AV1 or VP8 when supported), bitrate and fps cap are options; a per-frame
 *  `{t, seq, position}` log is saved next to the video (gallery blob 'frames'). */
import { device } from '../store/device.svelte'
import { saveVideo, type GalleryItem, type VideoFrameLog } from '../store/gallery'
import type { FrameMeta } from '../api/types'
import { MjpegStream, type MjpegFrame } from '../api/mjpegStream'
import { Stabilizer, defaultStabilizeOptions } from '../algo/stabilize'
import { toGray } from '../algo/sharpness'
import { activity } from './activity.svelte'

export type FrameSource = () => { image: CanvasImageSource; width: number; height: number } | null

export type VideoCodec = 'vp9' | 'av1' | 'vp8' | 'auto'
export interface RecorderOptions {
  codec: VideoCodec
  /** encoder target, Mbit/s (scaled with the frame's pixel count relative to 820x616 if `scaleBitrate`) */
  bitrateMbps: number
  /** at most this many canvas frames per second when the browser cannot honour manual per-frame
   *  pushes (`captureStream(0)`/`requestFrame` unsupported); ignored otherwise (0 = every frame) */
  maxFps: number
  /** remove hand/vibration jitter from the live-stream source (ignored for the live-stack source) */
  stabilize: boolean
}

const CANDIDATES: Record<Exclude<VideoCodec, 'auto'>, string[]> = {
  vp9: ['video/webm;codecs=vp9'],
  av1: ['video/webm;codecs=av01.0.08M.08', 'video/webm;codecs=av1', 'video/mp4;codecs=av01.0.08M.08'],
  vp8: ['video/webm;codecs=vp8'],
}
const FALLBACKS = ['video/webm', 'video/mp4']
const GRAY_WIDTH = 260   // downscale width for the stabiliser's tracking frame

export class Recorder {
  recording = $state(false)
  seconds = $state(0)
  frames = $state(0)
  status = $state('')
  options = $state<RecorderOptions>({ codec: 'vp9', bitrateMbps: 12, maxFps: 30, stabilize: true })
  private rec: MediaRecorder | null = null
  private chunks: Blob[] = []
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private grayCanvas: OffscreenCanvas | null = null
  private off: (() => void) | null = null
  private mjpeg: MjpegStream | null = null
  private stabilizer: Stabilizer | null = null
  private wasMoving = false
  private margin = 0
  private srcW = 0
  private srcH = 0
  private clock: ReturnType<typeof setInterval> | undefined
  private startedAt = 0
  private label = ''
  private thumb: Blob | null = null
  private log: VideoFrameLog[] = []
  private mimeUsed = ''
  private bitrateMbpsUsed = 12
  private releaseActivity: (() => void) | null = null

  static supported(m: string): boolean { return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m) }

  /** Best supported MIME type for the codec preference ('auto' = VP9, then AV1, VP8, anything). */
  static mime(codec: VideoCodec = 'auto'): string {
    const order: Exclude<VideoCodec, 'auto'>[] = codec === 'auto' ? ['vp9', 'av1', 'vp8'] : [codec, ...(['vp9', 'av1', 'vp8'] as const).filter((c) => c !== codec)]
    for (const c of order) for (const m of CANDIDATES[c]) if (Recorder.supported(m)) return m
    for (const m of FALLBACKS) if (Recorder.supported(m)) return m
    return ''
  }

  /** Which codecs this browser can encode. */
  static codecSupport(): Record<Exclude<VideoCodec, 'auto'>, boolean> {
    return { vp9: CANDIDATES.vp9.some(Recorder.supported), av1: CANDIDATES.av1.some(Recorder.supported), vp8: CANDIDATES.vp8.some(Recorder.supported) }
  }

  static codecOf(mime: string): string {
    const m = /codecs=([^;,]+)/.exec(mime)
    return m ? (m[1].startsWith('av01') ? 'av1' : m[1]) : mime.replace('video/', '')
  }

  /** Record the live focus-stack composite (or another non-stream source) via a polled `FrameSource`,
   *  throttled to the device's own frame events. Use `startStream()` for the plain live view — it
   *  reads the MJPEG stream directly instead of a DOM `<img>`, which is what fixes the tearing. */
  start(source: FrameSource, label: string, opts: Partial<RecorderOptions> = {}): void {
    if (this.recording) return
    const o = { ...this.options, ...opts }
    const mime = Recorder.mime(o.codec)
    if (!mime) { this.status = 'video recording is not supported by this browser'; return }
    const first = source()
    if (!first) { this.status = 'no frame to record yet'; return }
    if (!this.beginCanvas(first.width, first.height, mime, o)) return
    this.label = label
    const draw = () => {
      const f = source(); if (!f) return false
      this.resizeIfNeeded(f.width, f.height)
      this.ctx!.drawImage(f.image, 0, 0, f.width, f.height)
      return true
    }
    draw()
    let track: (MediaStreamTrack & { requestFrame?: () => void }) | null
    try { track = this.attachTrack(mime, o) } catch (e) { this.status = `could not start the recorder: ${(e as Error).message}`; return }
    const minGap = o.maxFps > 0 ? 1000 / o.maxFps : 0
    let lastSeq = -1, lastDraw = -Infinity
    this.off = device.client.on('event.frame', (f: FrameMeta) => {
      if (!this.recording || f.seq === lastSeq) return
      const now = performance.now()
      if (minGap && now - lastDraw < minGap * 0.9) return
      if (!draw()) return
      lastSeq = f.seq; lastDraw = now
      track?.requestFrame?.()
      this.frames++
      this.log.push({ t: f.ts ?? f.t, seq: f.seq, position: { ...device.position } })
      setTimeout(() => this.recording && this.captureThumbnail(), 800)
    })
    this.finishStart()
  }

  /** Record the live stream directly (`/stream.mjpg`), one decoded frame per JPEG part, optionally
   *  stabilised. This is the path that avoids the DOM `<img>`'s tearing/duplicate-frame problems. */
  startStream(label = 'live view', opts: Partial<RecorderOptions> = {}): void {
    if (this.recording) return
    const o = { ...this.options, ...opts }
    const mime = Recorder.mime(o.codec)
    if (!mime) { this.status = 'video recording is not supported by this browser'; return }
    this.label = label
    this.stabilizer = o.stabilize ? new Stabilizer(defaultStabilizeOptions) : null
    this.margin = o.stabilize ? Math.ceil(defaultStabilizeOptions.maxShiftPx) + 2 : 0
    this.wasMoving = device.moving
    let started = false
    let track: (MediaStreamTrack & { requestFrame?: () => void }) | null = null
    this.mjpeg = new MjpegStream()
    const run = this.mjpeg.start(device.url('/stream.mjpg'), (frame: MjpegFrame) => {
      if (!started) {
        if (!this.beginCanvas(frame.bitmap.width, frame.bitmap.height, mime, o)) { frame.bitmap.close(); this.mjpeg?.stop(); return }
        try { track = this.attachTrack(mime, o) } catch (e) { this.status = `could not start the recorder: ${(e as Error).message}`; frame.bitmap.close(); this.mjpeg?.stop(); return }
        started = true
        this.finishStart()
      }
      this.drawStreamFrame(frame)
      track?.requestFrame?.()
      this.frames++
      this.log.push({ t: frame.ts ?? 0, seq: frame.seq, position: { ...device.position } })
      if (this.frames === 20) this.captureThumbnail()
      frame.bitmap.close()
    }, (e) => { if (this.recording) this.status = `stream error: ${e.message}` })
    void run.then(() => { if (this.recording) { this.status = 'stream ended'; void this.stop() } })
  }

  private beginCanvas(w: number, h: number, mime: string, o: RecorderOptions): boolean {
    this.srcW = w; this.srcH = h
    const cw = Math.max(1, w - 2 * this.margin), ch = Math.max(1, h - 2 * this.margin)
    const canvas = document.createElement('canvas')
    canvas.width = cw; canvas.height = ch
    this.canvas = canvas
    this.ctx = canvas.getContext('2d')
    if (!this.ctx) { this.status = 'could not create a canvas 2D context'; return false }
    this.mimeUsed = mime
    this.chunks = []; this.log = []; this.frames = 0; this.thumb = null
    return true
  }

  private resizeIfNeeded(w: number, h: number): void {
    const cw = Math.max(1, w - 2 * this.margin), ch = Math.max(1, h - 2 * this.margin)
    if (this.canvas!.width !== cw || this.canvas!.height !== ch) { this.canvas!.width = cw; this.canvas!.height = ch; this.srcW = w; this.srcH = h }
  }

  /** Track the frame's displacement (unless the stage is moving — a real move is not jitter, and the
   *  reference is dropped so the settled frame after the move becomes a fresh anchor) and draw it
   *  translated into the canvas, cropped by `this.margin` on each side. */
  private drawStreamFrame(frame: MjpegFrame): void {
    const { bitmap } = frame
    this.resizeIfNeeded(bitmap.width, bitmap.height)
    let dx = 0, dy = 0
    if (this.stabilizer) {
      const moving = device.moving
      if (moving) { if (!this.wasMoving) this.stabilizer.reset(); this.wasMoving = true }
      else {
        this.wasMoving = false
        const g = this.grayOf(bitmap)
        const r = this.stabilizer.track(g, performance.now() / 1000)
        dx = r.dx; dy = r.dy
      }
    }
    const ctx = this.ctx!
    ctx.drawImage(bitmap, -this.margin - dx, -this.margin - dy, bitmap.width, bitmap.height)
  }

  private grayOf(bitmap: ImageBitmap) {
    const scale = Math.min(1, GRAY_WIDTH / bitmap.width)
    const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale))
    if (!this.grayCanvas || this.grayCanvas.width !== w || this.grayCanvas.height !== h) this.grayCanvas = new OffscreenCanvas(w, h)
    const gctx = this.grayCanvas.getContext('2d', { willReadFrequently: true })!
    gctx.drawImage(bitmap, 0, 0, w, h)
    return toGray(gctx.getImageData(0, 0, w, h))
  }

  /** `captureStream(0)` + `track.requestFrame()` when the browser supports manual pushes (frame-
   *  accurate: exactly one encoded frame per call); otherwise a `captureStream(fps)` fallback that
   *  samples the canvas on its own timer (may still duplicate/drop, but at least draws whole frames). */
  /** Throws if the MediaRecorder cannot be constructed/started; the caller reports that and bails. */
  private attachTrack(mime: string, o: RecorderOptions): (MediaStreamTrack & { requestFrame?: () => void }) | null {
    const stream = this.canvas!.captureStream(0)
    const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void }
    const manual = typeof track.requestFrame === 'function'
    let streamUsed = stream
    if (!manual) { stream.getVideoTracks().forEach((t) => t.stop()); streamUsed = this.canvas!.captureStream(o.maxFps || 30) }
    this.bitrateMbpsUsed = o.bitrateMbps
    this.rec = new MediaRecorder(streamUsed, { mimeType: mime, videoBitsPerSecond: Math.round(o.bitrateMbps * 1e6) })
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data) }
    this.rec.start(1000)
    return manual ? track : null
  }

  private captureThumbnail(): void {
    this.canvas?.toBlob((b) => (this.thumb = b), 'image/jpeg', 0.8)
  }

  private finishStart(): void {
    this.startedAt = performance.now(); this.seconds = 0
    this.clock = setInterval(() => (this.seconds = Math.round((performance.now() - this.startedAt) / 1000)), 500)
    this.recording = true; this.status = ''
    this.releaseActivity?.()
    this.releaseActivity = activity.hold('video recording')
  }

  /** Stop and save to the gallery. Releases the activity hold taken in `finishStart` no matter how
   *  recording ends (normal stop, stream error, unmount) so a hold can never pin the device awake. */
  async stop(): Promise<GalleryItem | null> {
    if (!this.rec || !this.recording) { this.releaseActivity?.(); this.releaseActivity = null; return null }
    this.recording = false
    this.off?.(); this.off = null
    this.mjpeg?.stop(); this.mjpeg = null
    clearInterval(this.clock)
    try {
      const rec = this.rec
      const done = new Promise<void>((r) => (rec.onstop = () => r()))
      rec.stop(); await done
      const durationS = (performance.now() - this.startedAt) / 1000
      const blob = new Blob(this.chunks, { type: rec.mimeType || this.mimeUsed || 'video/webm' })
      const thumb = this.thumb ?? (await new Promise<Blob | null>((r) => this.canvas!.toBlob(r, 'image/jpeg', 0.8)))
      const log = this.log
      this.rec = null; this.thumb = null; this.chunks = []; this.log = []; this.stabilizer = null
      this.status = 'saving…'
      const fps = durationS > 0 ? Math.round((log.length / durationS) * 10) / 10 : 0
      const item = await saveVideo(blob, thumb, {
        durationS, fps, source: this.label, width: this.canvas!.width, height: this.canvas!.height, position: { ...device.position },
        codec: Recorder.codecOf(this.mimeUsed), bitrateBps: Math.round(this.bitrateMbpsUsed * 1e6), frames: log,
      })
      this.status = `saved "${item.name}" (${durationS.toFixed(0)} s, ${log.length} frames, ${(blob.size / 1048576).toFixed(1)} MB)`
      setTimeout(() => (this.status = ''), 5000)
      return item
    } finally {
      this.releaseActivity?.(); this.releaseActivity = null
    }
  }
}

export const recorder = new Recorder()
