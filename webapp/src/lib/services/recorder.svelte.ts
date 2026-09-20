/** Video recording of the live stream, or the live focus stack, through WebCodecs + mediabunny
 *  (falling back to MediaRecorder where `VideoEncoder` is unavailable) — see `services/videoEncoder.ts`
 *  for the sink split and why explicit per-frame timestamps replace a capture timer.
 *
 *  The live stream is read directly with `api/mjpegStream.ts` (fetch + ReadableStream, one fully
 *  decoded `createImageBitmap` per JPEG part) instead of redrawing the DOM `<img>` on a timer: a
 *  15 fps timer duplicates/drops frames relative to the ~18 fps the device actually sends, and can
 *  sample the `<img>` mid-decode (tearing) since the browser's own multipart handling gives no signal
 *  for exactly when a new part finishes decoding — this was the recorder's "shaky, glitchy" root
 *  cause (CAPTURE_AUDIT.md D8, priority 1). Each decoded frame is drawn into a canvas exactly once and
 *  handed to the sink with its own device timestamp, so played-back speed matches real time regardless
 *  of encoder drops. The live-stack composite (already temporally smoothed, and not an `<img>`) keeps
 *  using the existing `FrameSource` callback, throttled to `event.frame`.
 *
 *  Optional stabilisation (`algo/stabilize.ts`) removes hand/vibration jitter from the stream path: a
 *  small crop margin absorbs the correction, so the recorded frame is slightly smaller than the
 *  source. It is suspended (and the reference dropped) while `device.moving` is true, so a real stage
 *  move is never fought as if it were jitter. After stabilisation, the frame chain (`frameChain.run`,
 *  order 50 = deflicker; other packages may register more stages) runs over the canvas before it is
 *  handed to the sink — skipped entirely when nothing is registered/enabled, so a plain recording pays
 *  no extra readback cost.
 *
 *  Container/codec/quality/keyframe interval are options; a per-frame `{t, seq, position}` log is
 *  saved next to the video (gallery blob 'frames'), along with the sink's measured fps and its
 *  dropped/duplicated frame counts. */
import { device } from '../store/device.svelte'
import { saveVideo, type GalleryItem, type VideoFrameLog } from '../store/gallery'
import type { FrameMeta } from '../api/types'
import { MjpegStream, type MjpegFrame } from '../api/mjpegStream'
import { Stabilizer, defaultStabilizeOptions } from '../algo/stabilize'
import { toGray } from '../algo/sharpness'
import { activity } from './activity.svelte'
import { frameChain, toImageData } from './frameChain'
import { deflickerProcessor } from './deflickerProcessor'
import { createVideoSink, type VideoSink, type Container, type VideoCodecPref, type VideoQuality } from './videoEncoder'

export type FrameSource = () => { image: CanvasImageSource; width: number; height: number } | null

export type VideoContainer = Container
export type VideoCodec = VideoCodecPref
export type { VideoQuality } from './videoEncoder'

export interface RecorderOptions {
  container: VideoContainer
  codec: VideoCodec
  quality: VideoQuality
  /** seconds between forced key frames */
  keyframeS: number
  /** at most this many canvas frames per second when the browser cannot honour manual per-frame
   *  pushes (MediaRecorder fallback without `requestFrame`); ignored otherwise (0 = every frame) */
  maxFps: number
  /** remove hand/vibration jitter from the live-stream source (ignored for the live-stack source) */
  stabilize: boolean
  /** bake `services/deflickerProcessor.ts` into this recording (order 50 in the frame chain) */
  deflicker: boolean
}

const GRAY_WIDTH = 480   // downscale width for the stabiliser's tracking frame (register.ts refines from here)

export class Recorder {
  recording = $state(false)
  seconds = $state(0)
  frames = $state(0)
  status = $state('')
  options = $state<RecorderOptions>({ container: 'mp4', codec: 'auto', quality: 'high', keyframeS: 2, maxFps: 30, stabilize: true, deflicker: false })
  private sink: VideoSink | null = null
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
  private stabiliseUsed = false
  private deflickerUsed = false
  private optsUsed: RecorderOptions = this.options
  private releaseActivity: (() => void) | null = null

  /** Best-effort browser support probe; `VideoEncoder` (WebCodecs) or `MediaRecorder`. */
  static supported(): boolean { return typeof VideoEncoder !== 'undefined' || typeof MediaRecorder !== 'undefined' }

  /** Best MediaRecorder MIME type available, kept for `services/timelapse.svelte.ts`'s existing
   *  `exportTimelapseWebm` (its own canvas.captureStream + MediaRecorder path; WP5 owns the newer
   *  `services/timelapseExport.ts` WebCodecs/mediabunny path instead, wired up as "Export MP4"). */
  static mime(): string {
    if (typeof MediaRecorder === 'undefined') return ''
    for (const m of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']) if (MediaRecorder.isTypeSupported(m)) return m
    return ''
  }

  /** Which codecs this browser can at least attempt (container-independent hint for the UI; the
   *  actual choice is re-resolved per recording against the chosen container in `videoEncoder.ts`). */
  static codecSupport(): Record<Exclude<VideoCodec, 'auto'>, boolean> {
    const wc = typeof VideoEncoder !== 'undefined'
    const mr = typeof MediaRecorder !== 'undefined'
    return {
      h264: wc || (mr && (MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.4d0034') || MediaRecorder.isTypeSupported('video/mp4;codecs=h264'))),
      vp9: wc || (mr && MediaRecorder.isTypeSupported('video/webm;codecs=vp9')),
      av1: wc || (mr && MediaRecorder.isTypeSupported('video/webm;codecs=av01.0.08M.08')),
    }
  }

  /** Record the live focus-stack composite (or another non-stream source) via a polled `FrameSource`,
   *  throttled to the device's own frame events. Use `startStream()` for the plain live view — it
   *  reads the MJPEG stream directly instead of a DOM `<img>`, which is what fixes the tearing. */
  start(source: FrameSource, label: string, opts: Partial<RecorderOptions> = {}): void {
    if (this.recording) return
    const o = { ...this.options, ...opts }
    const first = source()
    if (!first) { this.status = 'no frame to record yet'; return }
    this.beginCanvas(first.width, first.height, o)
    this.label = label
    const draw = () => {
      const f = source(); if (!f) return false
      this.resizeIfNeeded(f.width, f.height)
      this.ctx!.drawImage(f.image, 0, 0, f.width, f.height)
      return true
    }
    draw()
    void createVideoSink(this.canvas!, this.sinkOptions(o, 15))
      .then((sink) => { this.sink = sink; this.finishStart() })
      .catch((e) => { this.status = `could not start the recorder: ${(e as Error).message}` })
    const minGap = o.maxFps > 0 ? 1000 / o.maxFps : 0
    let lastSeq = -1, lastDraw = -Infinity
    this.off = device.client.on('event.frame', (f: FrameMeta) => {
      if (!this.recording || f.seq === lastSeq) return
      const now = performance.now()
      if (minGap && now - lastDraw < minGap * 0.9) return
      if (!draw()) return
      lastSeq = f.seq; lastDraw = now
      this.pushFrame(f.ts ?? f.t, f.seq)
      setTimeout(() => this.recording && this.captureThumbnail(), 800)
    })
  }

  /** Record the live stream directly (`/stream.mjpg`), one decoded frame per JPEG part, optionally
   *  stabilised. This is the path that avoids the DOM `<img>`'s tearing/duplicate-frame problems. */
  startStream(label = 'live view', opts: Partial<RecorderOptions> = {}): void {
    if (this.recording) return
    const o = { ...this.options, ...opts }
    this.label = label
    this.stabilizer = o.stabilize ? new Stabilizer(defaultStabilizeOptions) : null
    this.margin = o.stabilize ? Math.ceil(defaultStabilizeOptions.maxShiftPx) + 2 : 0
    this.wasMoving = device.moving
    let started = false
    this.mjpeg = new MjpegStream()
    const run = this.mjpeg.start(device.url('/stream.mjpg'), (frame: MjpegFrame) => {
      if (!started) {
        started = true
        this.beginCanvas(frame.bitmap.width, frame.bitmap.height, o)
        void createVideoSink(this.canvas!, this.sinkOptions(o, 20))
          .then((sink) => { this.sink = sink; this.finishStart() })
          .catch((e) => { this.status = `could not start the recorder: ${(e as Error).message}`; this.mjpeg?.stop() })
      }
      this.drawStreamFrame(frame)
      this.pushFrame(frame.ts, frame.seq)
      frame.bitmap.close()
    }, (e) => { if (this.recording || this.sink) this.status = `stream error: ${e.message}` })
    void run.then(() => { if (this.recording) { this.status = 'stream ended'; void this.stop() } })
  }

  private sinkOptions(o: RecorderOptions, fpsHint: number) {
    return { width: this.canvas!.width, height: this.canvas!.height, container: o.container, codec: o.codec, quality: o.quality, keyframeS: o.keyframeS, fpsHint }
  }

  private beginCanvas(w: number, h: number, o: RecorderOptions): void {
    this.srcW = w; this.srcH = h
    const cw = Math.max(1, w - 2 * this.margin), ch = Math.max(1, h - 2 * this.margin)
    const canvas = document.createElement('canvas')
    canvas.width = cw; canvas.height = ch
    this.canvas = canvas
    this.ctx = canvas.getContext('2d', { willReadFrequently: true })
    this.log = []; this.frames = 0; this.thumb = null
    this.optsUsed = o
    deflickerProcessor.recordEnabled = o.deflicker
    frameChain.reset()
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

  /** Run the registered frame-chain processors (deflicker order 50; other packages may add more) over
   *  the canvas's current pixels and write the result back. A no-op (no readback) when nothing for
   *  `'record'` is enabled, so a plain recording never pays the extra `getImageData`/`putImageData`. */
  private runChain(t: number): void {
    if (!frameChain.active('record')) return
    const ctx = this.ctx!, w = this.canvas!.width, h = this.canvas!.height
    const img = ctx.getImageData(0, 0, w, h)
    const out = frameChain.run('record', { data: img.data, width: img.width, height: img.height }, t)
    const rgba = toImageData(out)
    ctx.putImageData(rgba.data === img.data ? img : new ImageData(new Uint8ClampedArray(rgba.data), rgba.width, rgba.height), 0, 0)
  }

  /** Run the frame chain, then hand the canvas to the sink with the frame's own device time (falls
   *  back to wall-clock when the stream carries none). Dropped-by-backlog frames are still logged as
   *  "not encoded" by simply not appending to `log`/`frames`. */
  private pushFrame(tNs: number | null, seq: number): void {
    if (!this.sink || !this.recording) return
    const chainT = tNs ?? performance.now() * 1e6
    this.runChain(chainT)
    const tSec = tNs != null ? tNs / 1e9 : performance.now() / 1000
    if (this.sink.addFrame(this.canvas!, tSec)) {
      this.frames++
      this.log.push({ t: tNs ?? 0, seq, position: { ...device.position } })
      if (this.frames === 20) this.captureThumbnail()
    }
  }

  private captureThumbnail(): void {
    this.canvas?.toBlob((b) => (this.thumb = b), 'image/jpeg', 0.8)
  }

  private finishStart(): void {
    this.stabiliseUsed = !!this.stabilizer
    this.deflickerUsed = this.optsUsed.deflicker
    this.startedAt = performance.now(); this.seconds = 0
    this.clock = setInterval(() => (this.seconds = Math.round((performance.now() - this.startedAt) / 1000)), 500)
    this.recording = true; this.status = ''
    this.releaseActivity?.()
    this.releaseActivity = activity.hold('video recording')
  }

  /** Stop and save to the gallery. Releases the activity hold taken in `finishStart` no matter how
   *  recording ends (normal stop, stream error, unmount) so a hold can never pin the device awake. */
  async stop(): Promise<GalleryItem | null> {
    if (!this.sink || !this.recording) {
      this.recording = false
      this.sink = null
      this.releaseActivity?.(); this.releaseActivity = null
      return null
    }
    this.recording = false
    this.off?.(); this.off = null
    this.mjpeg?.stop(); this.mjpeg = null
    clearInterval(this.clock)
    deflickerProcessor.recordEnabled = false
    try {
      const sink = this.sink; this.sink = null
      const result = await sink.close()
      const thumb = this.thumb ?? (await new Promise<Blob | null>((r) => this.canvas!.toBlob(r, 'image/jpeg', 0.8)))
      const log = this.log
      this.thumb = null; this.log = []; this.stabilizer = null
      this.status = 'saving…'
      const fps = result.durationS > 0 ? Math.round((log.length / result.durationS) * 10) / 10 : 0
      const item = await saveVideo(result.blob, thumb, {
        durationS: result.durationS, fps, source: this.label, width: this.canvas!.width, height: this.canvas!.height, position: { ...device.position },
        codec: result.codec, frames: log,
        encoder: result.kind, container: result.container, quality: typeof this.optsUsed.quality === 'string' ? this.optsUsed.quality : `${this.optsUsed.quality.bitrateMbps} Mbit/s`,
        keyframeS: this.optsUsed.keyframeS, stabilised: this.stabiliseUsed, deflickered: this.deflickerUsed,
        framesDropped: result.dropped, framesDuplicated: result.duplicated,
      })
      this.status = `saved "${item.name}" (${result.durationS.toFixed(0)} s, ${log.length} frames${result.dropped ? `, ${result.dropped} dropped` : ''}, ${(result.blob.size / 1048576).toFixed(1)} MB)`
      setTimeout(() => (this.status = ''), 5000)
      return item
    } finally {
      this.releaseActivity?.(); this.releaseActivity = null
    }
  }
}

export const recorder = new Recorder()
