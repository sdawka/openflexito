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
 *  What is recorded is what the live view shows: the frame chain's `record` target carries the same
 *  processors as the view (deflicker, live denoise when "also apply while recording" is on, the look
 *  when `settings.lookBakeIntoRecording`). Burn-in overlays (`services/burnIn.ts`) are drawn last, so
 *  they appear in the encoded frames.
 *
 *  Container/codec/quality/keyframe interval are options; a per-frame `{t, seq, position}` log is
 *  saved next to the video (gallery blob 'frames'), along with the sink's measured fps and its
 *  dropped/duplicated frame counts. */
import { device } from '../store/device.svelte'
import { saveVideo, type GalleryItem, type VideoFrameLog } from '../store/gallery'
import type { FrameMeta } from '../api/types'
import { MjpegStream, type MjpegFrame } from '../api/mjpegStream'
import { Stabilizer, defaultStabilizeOptions, stabilizeOptionsFor, rotationMargin, type StabilizeStrength } from '../algo/stabilize'
import { Retimer, type RetimeMode, type SpeedKeyframe } from '../algo/retime'
import { toGray } from '../algo/sharpness'
import { activity } from './activity.svelte'
import { frameChain, toImageData, type FrameInput } from './frameChain'
import { deflickerProcessor } from './deflickerProcessor'
import { createVideoSink, type VideoSink, type Container, type VideoCodecPref, type VideoQuality } from './videoEncoder'
import { drawBurnIn, type BurnInKind } from './burnIn'
import { umPerPxAt } from '../store/scaleCal.svelte'
import { sample } from '../store/sample.svelte'

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
  /** one-euro cutoff preset for the stabiliser ('normal' = 1 Hz) */
  stabilizeStrength?: StabilizeStrength
  /** also correct in-plane rotation (left/right patch registration; +2 ms/frame, wider crop) */
  stabilizeRotation?: boolean
  /** 'crop' cuts a margin so the shifted frame always covers the canvas; 'hold' keeps the full frame
   *  size and lets the uncovered border show the previous frames' pixels */
  stabilizeEdges?: 'crop' | 'hold'
  /** output timing: 'vfr' keeps true device times (default); 'cfr' re-times to `retimeFps`, duplicating
   *  the current frame into skipped slots and dropping early frames; 'ramp' follows speed keyframes */
  retime?: RetimeMode
  retimeFps?: number
  retimeKeyframes?: SpeedKeyframe[]
  /** bake `services/deflickerProcessor.ts` into this recording (order 50 in the frame chain) */
  deflicker: boolean
  /** overlays to draw into the frames */
  burnIn?: BurnInKind[]
}

const GRAY_WIDTH = 480   // downscale width for the stabiliser's tracking frame (register.ts refines from here)
const STAB_MARGIN_PX = 40   // crop margin (full-resolution px) the stabiliser's correction is clamped to
const STAB_THETA_MAX_DEG = 2

export class Recorder {
  recording = $state(false)
  seconds = $state(0)
  frames = $state(0)
  status = $state('')
  options = $state<RecorderOptions>({ container: 'mp4', codec: 'auto', quality: 'high', keyframeS: 2, maxFps: 30, stabilize: true, deflicker: false })
  /** stabiliser rotation / re-timing counters, refreshed with the clock while recording */
  detail = $state('')
  private sink: VideoSink | null = null
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private burnIn: BurnInKind[] = []
  private firstOutT: number | null = null
  private grayCanvas: OffscreenCanvas | null = null
  private off: (() => void) | null = null
  private mjpeg: MjpegStream | null = null
  private stabilizer: Stabilizer | null = null
  private stabilizeWanted = false
  private holdEdges = false
  private retimer: Retimer | null = null
  private retimeDuplicated = 0
  private retimeDropped = 0
  lastTheta = 0
  /** tracking-frame px → full-frame px for the stabiliser's shifts */
  private grayScale = 1
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
    // the Stabilizer itself is created on the first frame (its shift clamp is in tracking-frame px,
    // which depend on the stream size); `stabilizeWanted` remembers the choice
    this.stabilizeWanted = o.stabilize
    this.stabilizer = null
    this.holdEdges = o.stabilize && o.stabilizeEdges === 'hold'
    this.margin = o.stabilize && !this.holdEdges ? STAB_MARGIN_PX + 2 : 0
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
    // rotation needs a wider crop (exact for a rectangle about its centre); decided here, where the
    // frame size is known, so the output canvas and the encoder are configured with the final size
    if (this.stabilizeWanted && !this.holdEdges && o.stabilizeRotation) this.margin = STAB_MARGIN_PX + 2 + rotationMargin(w, h, (STAB_THETA_MAX_DEG * Math.PI) / 180)
    const cw = Math.max(1, w - 2 * this.margin), ch = Math.max(1, h - 2 * this.margin)
    const canvas = document.createElement('canvas')
    canvas.width = cw; canvas.height = ch
    this.canvas = canvas
    this.ctx = canvas.getContext('2d', { willReadFrequently: true })
    this.log = []; this.frames = 0; this.thumb = null; this.firstOutT = null
    this.optsUsed = o
    this.burnIn = o.burnIn ?? []
    this.retimer = o.retime && o.retime !== 'vfr' ? new Retimer({ mode: o.retime, fps: o.retimeFps ?? 18, keyframes: o.retimeKeyframes }) : null
    this.retimeDuplicated = 0; this.retimeDropped = 0
    deflickerProcessor.recordEnabled = o.deflicker
    frameChain.reset()
  }

  private resizeIfNeeded(w: number, h: number): void {
    const cw = Math.max(1, w - 2 * this.margin), ch = Math.max(1, h - 2 * this.margin)
    if (this.canvas!.width !== cw || this.canvas!.height !== ch) { this.canvas!.width = cw; this.canvas!.height = ch; this.srcW = w; this.srcH = h }
  }

  /** Track the frame's displacement (unless the stage is moving — a real move is not jitter; the
   *  reference is re-anchored at both ends of the move while the one-euro filters keep their state,
   *  so the settled frame after the move becomes a fresh anchor without a cold filter) and draw it
   *  translated into the canvas, cropped by `this.margin` on each side. The stabiliser works on a
   *  `GRAY_WIDTH`-px copy; its shift is scaled back to full-frame pixels here and its clamp is set so
   *  the scaled correction never exceeds the crop margin (the previous version applied the tracking-
   *  frame shift unscaled: ~0.3× the needed correction). */
  private drawStreamFrame(frame: MjpegFrame): void {
    const { bitmap } = frame
    let dx = 0, dy = 0, theta = 0
    if (this.stabilizeWanted) {
      if (!this.stabilizer) {
        this.grayScale = bitmap.width / Math.max(1, Math.round(bitmap.width * Math.min(1, GRAY_WIDTH / bitmap.width)))
        const rotation = !!this.optsUsed.stabilizeRotation
        const opts = stabilizeOptionsFor(this.optsUsed.stabilizeStrength ?? 'normal', {
          ...defaultStabilizeOptions, maxShiftPx: STAB_MARGIN_PX / this.grayScale, reanchorPx: 20 / this.grayScale, rotation, maxThetaDeg: STAB_THETA_MAX_DEG,
        })
        this.stabilizer = new Stabilizer(opts)
      }
      this.resizeIfNeeded(bitmap.width, bitmap.height)
      if (device.moving) { if (!this.wasMoving) this.stabilizer.reanchor(); this.wasMoving = true }
      else {
        if (this.wasMoving) this.stabilizer.reanchor()
        this.wasMoving = false
        const g = this.grayOf(bitmap)
        const r = this.stabilizer.track(g, frame.ts != null ? frame.ts / 1e9 : performance.now() / 1000)
        // quantised to 1/8 px so the encoder does not see resampling noise on a still scene
        dx = Math.round(r.dx * this.grayScale * 8) / 8; dy = Math.round(r.dy * this.grayScale * 8) / 8
        theta = r.theta
        this.lastTheta = r.rawTheta
      }
    } else this.resizeIfNeeded(bitmap.width, bitmap.height)
    const ctx = this.ctx!
    // 'hold' edges: the canvas is the full frame and is never cleared, so the border strip a shifted
    // frame leaves uncovered keeps the previous frames' pixels instead of showing a black band
    if (theta !== 0) {
      const cx = bitmap.width / 2 - this.margin, cy = bitmap.height / 2 - this.margin
      ctx.translate(cx, cy); ctx.rotate(theta); ctx.translate(-cx - dx, -cy - dy)
      ctx.drawImage(bitmap, -this.margin, -this.margin, bitmap.width, bitmap.height)
      ctx.setTransform(1, 0, 0, 1, 0, 0)
    } else {
      ctx.drawImage(bitmap, -this.margin - dx, -this.margin - dy, bitmap.width, bitmap.height)
    }
  }

  private grayOf(bitmap: ImageBitmap) {
    const scale = Math.min(1, GRAY_WIDTH / bitmap.width)
    const w = Math.max(1, Math.round(bitmap.width * scale)), h = Math.max(1, Math.round(bitmap.height * scale))
    if (!this.grayCanvas || this.grayCanvas.width !== w || this.grayCanvas.height !== h) this.grayCanvas = new OffscreenCanvas(w, h)
    const gctx = this.grayCanvas.getContext('2d', { willReadFrequently: true })!
    gctx.drawImage(bitmap, 0, 0, w, h)
    return toGray(gctx.getImageData(0, 0, w, h))
  }

  /** Run the frame chain (deflicker, live denoise, look) over the canvas in place. A no-op (no
   *  readback) when nothing is enabled for `record`, so a plain recording never pays the extra
   *  `getImageData`/`putImageData`. */
  private processFrame(tNs: number | null): void {
    if (!frameChain.active('record')) return
    const ctx = this.ctx!, w = this.canvas!.width, h = this.canvas!.height
    const img = ctx.getImageData(0, 0, w, h)
    const rgba = toImageData(frameChain.run('record', { data: img.data, width: w, height: h }, tNs ?? performance.now() * 1e6))
    if (rgba.data !== img.data) img.data.set(rgba.data)
    ctx.putImageData(img, 0, 0)
  }

  /** Process, overlay, then hand the canvas to the sink with the frame's own device time (falls back
   *  to wall-clock when the stream carries none). Dropped-by-backlog frames are still logged as "not
   *  encoded" by simply not appending to `log`/`frames`. */
  private pushFrame(tNs: number | null, seq: number): void {
    if (!this.sink || !this.recording) return
    this.processFrame(tNs)
    let tSec = tNs != null ? tNs / 1e9 : performance.now() / 1000
    let dupTimes: number[] = []
    if (this.retimer) {
      const r = this.retimer.push(tSec)
      if (!r.emit) { this.retimeDropped++; return }   // before the next slot: nothing to encode
      tSec = r.tOut
      dupTimes = r.duplicateTimes
    }
    if (this.firstOutT == null) this.firstOutT = dupTimes[0] ?? tSec
    const c = this.canvas!
    if (this.burnIn.length) {
      drawBurnIn(this.ctx!, c.width, c.height, {
        kinds: this.burnIn, elapsedS: Math.max(0, tSec - this.firstOutT), position: device.position,
        umPerPx: this.burnIn.includes('scalebar') ? umPerPxAt(c.width) : null,
        sampleName: sample.name || undefined,
      })
    }
    // skipped CFR slots get the same canvas (the recorder only has the current frame), then the frame itself
    for (const td of dupTimes) if (this.sink.addFrame(c, td)) this.retimeDuplicated++
    if (this.sink.addFrame(c, tSec)) {
      this.frames++
      this.log.push({ t: tNs ?? 0, seq, position: { ...device.position } })
      if (this.frames === 20) this.captureThumbnail()
    }
  }

  private captureThumbnail(): void {
    this.canvas?.toBlob((b) => (this.thumb = b), 'image/jpeg', 0.8)
  }

  private finishStart(): void {
    this.stabiliseUsed = this.stabilizeWanted
    this.deflickerUsed = this.optsUsed.deflicker
    this.startedAt = performance.now(); this.seconds = 0
    this.clock = setInterval(() => {
      this.seconds = Math.round((performance.now() - this.startedAt) / 1000)
      const rot = this.optsUsed.stabilizeRotation && this.stabilizeWanted ? `rotation ${((this.lastTheta * 180) / Math.PI).toFixed(2)}°` : ''
      const rt = this.retimer ? `${this.optsUsed.retime} +${this.retimeDuplicated} −${this.retimeDropped}` : ''
      this.detail = [rot, rt].filter(Boolean).join(' · ')
    }, 500)
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
      this.mjpeg?.stop(); this.mjpeg = null
      this.off?.(); this.off = null
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
      const retimeMeta = this.retimer ? { mode: this.optsUsed.retime!, fps: this.optsUsed.retimeFps ?? 18, ...this.retimer.stats() } : undefined
      this.thumb = null; this.log = []; this.stabilizer = null; this.stabilizeWanted = false; this.retimer = null
      if (!log.length) { this.status = 'nothing recorded: no frames arrived'; return null }
      this.status = 'saving…'
      const fps = result.durationS > 0 ? Math.round((log.length / result.durationS) * 10) / 10 : 0
      const item = await saveVideo(result.blob, thumb, {
        durationS: result.durationS, fps, source: this.label, width: this.canvas!.width, height: this.canvas!.height, position: { ...device.position },
        burnIn: this.burnIn,
        codec: result.codec, frames: log,
        encoder: result.kind, container: result.container, quality: typeof this.optsUsed.quality === 'string' ? this.optsUsed.quality : `${this.optsUsed.quality.bitrateMbps} Mbit/s`,
        keyframeS: this.optsUsed.keyframeS, stabilised: this.stabiliseUsed, deflickered: this.deflickerUsed,
        framesDropped: result.dropped + this.retimeDropped, framesDuplicated: result.duplicated + this.retimeDuplicated,
        stabiliser: this.stabiliseUsed ? { strength: this.optsUsed.stabilizeStrength ?? 'normal', rotation: !!this.optsUsed.stabilizeRotation, edges: this.optsUsed.stabilizeEdges ?? 'crop' } : undefined,
        retime: retimeMeta,
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
