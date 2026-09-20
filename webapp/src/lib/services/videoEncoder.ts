/** Video encoding sinks: a small `VideoSink` abstraction with a WebCodecs `VideoEncoder` + mediabunny
 *  muxing implementation (`WebCodecsSink`, the "top-notch" path: microsecond-accurate timestamps
 *  derived from the device frame time, explicit bitrate/keyframe/latency control, fast-start MP4 or
 *  WebM) and a `MediaRecorderSink` fallback for browsers without `VideoEncoder` (old Firefox, Safari
 *  <17). Both take frames as a `CanvasImageSource` (the recorder's own canvas, already stabilised and
 *  run through the frame chain) plus the frame's timestamp in seconds.
 *
 *  Mediabunny (npm `mediabunny`, MPL-2.0, verified on npm 2026-09) replaces the old mp4-muxer/
 *  webm-muxer pair: `VideoSampleSource` wraps a WebCodecs `VideoEncoder` internally (codec string,
 *  hardware acceleration and keyframe-interval handling included) and its `add()` Promise *is* the
 *  encoder's backpressure signal — we still keep our own bounded in-flight counter on top so a frame
 *  is dropped (not queued) the instant the encoder falls behind, which is what "never blocks the MJPEG
 *  reader" requires; mediabunny's own backpressure alone would only ever slow the caller down, not shed
 *  frames. `codec` here follows mediabunny's own short names (`'avc'`, `'vp9'`, `'av1'`); the recorder
 *  and settings UI use the more familiar `'h264'` and map it to `'avc'` at this boundary. */
import {
  Output, Mp4OutputFormat, WebMOutputFormat, BufferTarget, VideoSampleSource, VideoSample,
  canEncodeVideo, type VideoCodec as MbVideoCodec,
} from 'mediabunny'

export type Container = 'mp4' | 'webm'
export type VideoCodecPref = 'h264' | 'vp9' | 'av1' | 'auto'
export type VideoQuality = 'high' | 'medium' | 'low' | { bitrateMbps: number }

export interface VideoSinkCreateOptions {
  width: number
  height: number
  container: Container
  codec: VideoCodecPref
  quality: VideoQuality
  /** seconds between forced key frames */
  keyframeS: number
  /** informational only (mediabunny/MediaRecorder do not require an exact fps) */
  fpsHint?: number
  /** frames queued for encoding but not yet accepted by the encoder before a new one is dropped */
  maxQueue?: number
}

export interface VideoSinkResult {
  kind: 'webcodecs' | 'mediarecorder'
  blob: Blob
  mime: string
  codec: string
  container: Container
  frames: number
  dropped: number
  duplicated: number
  durationS: number
}

export interface VideoSink {
  readonly kind: 'webcodecs' | 'mediarecorder'
  readonly codec: string
  readonly container: Container
  readonly mime: string
  /** Encode the current contents of `canvas` at `tSec` (seconds, monotonic). Returns `false` when the
   *  frame was dropped (encoder backlog / queue full) instead of accepted. */
  addFrame(canvas: CanvasImageSource, tSec: number): boolean
  /** Stop encoding and finalise the container. Resolves once the blob is ready. */
  close(): Promise<VideoSinkResult>
}

const CODEC_PREF: Record<Exclude<VideoCodecPref, 'auto'>, MbVideoCodec> = { h264: 'avc', vp9: 'vp9', av1: 'av1' }
const CODEC_ORDER: MbVideoCodec[] = ['avc', 'vp9', 'av1']

/** ~1640×1232@30fps reference bitrates (design.md); scaled linearly with the actual pixel rate and
 *  floored at 15% so a small/slow stream never rounds to ~0 bit/s. */
const REF_PIXEL_RATE = 1640 * 1232 * 30
const BASE_MBPS: Record<'high' | 'medium' | 'low', number> = { high: 12, medium: 6, low: 3 }

function bitrateFor(quality: VideoQuality, width: number, height: number, fps: number): number {
  if (typeof quality === 'object') return Math.max(1, Math.round(quality.bitrateMbps * 1e6))
  const scale = (width * height * Math.max(1, fps)) / REF_PIXEL_RATE
  return Math.round(BASE_MBPS[quality] * 1e6 * Math.max(0.15, scale))
}

function formatFor(container: Container): Mp4OutputFormat | WebMOutputFormat {
  return container === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat()
}

/** Best codec this browser/container combination can actually encode, honouring `pref`. */
async function resolveCodec(container: Container, pref: VideoCodecPref, w: number, h: number): Promise<MbVideoCodec | null> {
  const supported = new Set(formatFor(container).getSupportedCodecs())
  const order = pref === 'auto' ? CODEC_ORDER : [CODEC_PREF[pref], ...CODEC_ORDER.filter((c) => c !== CODEC_PREF[pref])]
  for (const c of order) {
    if (!supported.has(c)) continue
    try { if (await canEncodeVideo(c, { width: w, height: h })) return c } catch { /* try the next */ }
  }
  return null
}

/** WebCodecs `VideoEncoder` (via mediabunny's `VideoSampleSource`) muxed to a fast-start MP4 or WebM
 *  `BufferTarget`. Explicit per-frame timestamps (seconds, relative to the first accepted frame,
 *  monotonic-guarded) so playback speed matches real time regardless of drops. */
export class WebCodecsSink implements VideoSink {
  readonly kind = 'webcodecs' as const
  readonly container: Container
  codec = ''
  mime = ''
  private output: Output
  private target: BufferTarget
  private source!: VideoSampleSource
  private maxInFlight: number
  private inFlight = 0
  /** Every add() promise currently in flight, so `close()` can wait for all of them — not just the
   *  most recently started one, which is all a single `pending` field could ever guarantee once more
   *  than one frame is outstanding (up to `maxInFlight`, so on any recording longer than one frame). */
  private inFlightPromises = new Set<Promise<unknown>>()
  private frames = 0
  private dropped = 0
  private firstTsSec: number | null = null
  private lastTsSec = -Infinity
  private closed = false

  private constructor(container: Container, target: BufferTarget, output: Output, maxInFlight: number) {
    this.container = container; this.target = target; this.output = output; this.maxInFlight = maxInFlight
  }

  static async create(opts: VideoSinkCreateOptions): Promise<WebCodecsSink | null> {
    if (typeof VideoEncoder === 'undefined') return null
    const codec = await resolveCodec(opts.container, opts.codec, opts.width, opts.height)
    if (!codec) return null
    const target = new BufferTarget()
    const output = new Output({ format: formatFor(opts.container), target })
    const sink = new WebCodecsSink(opts.container, target, output, opts.maxQueue ?? 8)
    sink.codec = codec
    const bitrate = bitrateFor(opts.quality, opts.width, opts.height, opts.fpsHint ?? 20)
    try {
      sink.source = new VideoSampleSource({
        codec, bitrate, bitrateMode: 'variable', latencyMode: 'quality',
        keyFrameInterval: Math.max(0.1, opts.keyframeS),
      })
      output.addVideoTrack(sink.source, { frameRate: opts.fpsHint })
      await output.start()
    } catch { return null }
    // `Output.getMimeType()` only resolves once the first sample has been encoded (it needs the
    // codec description); awaiting it here before any frame is added would deadlock the recorder.
    // The container-level type is enough for the Blob; the precise codec string is read in `close()`.
    sink.mime = opts.container === 'mp4' ? 'video/mp4' : 'video/webm'
    return sink
  }

  addFrame(canvas: CanvasImageSource, tSec: number): boolean {
    if (this.closed) return false
    if (this.inFlight >= this.maxInFlight) { this.dropped++; return false }
    const ts = Math.max(this.lastTsSec + 1e-6, tSec)
    this.lastTsSec = ts
    if (this.firstTsSec === null) this.firstTsSec = ts
    const relTs = ts - this.firstTsSec
    let sample: VideoSample
    try { sample = new VideoSample(canvas, { timestamp: relTs }) } catch { this.dropped++; return false }
    this.inFlight++
    const p: Promise<unknown> = this.source.add(sample)
      .catch(() => { /* surfaced via close()'s own state; a single bad frame should not kill the run */ })
      .finally(() => { this.inFlight--; this.inFlightPromises.delete(p); sample.close() })
    this.inFlightPromises.add(p)
    this.frames++
    return true
  }

  async close(): Promise<VideoSinkResult> {
    this.closed = true
    await Promise.all(this.inFlightPromises).catch(() => {})
    await this.output.finalize()
    this.mime = await this.output.getMimeType().catch(() => this.mime)
    const buffer = this.target.buffer ?? new ArrayBuffer(0)
    const blob = new Blob([buffer], { type: this.mime })
    const durationS = this.firstTsSec === null ? 0 : Math.max(0, this.lastTsSec - this.firstTsSec)
    return { kind: this.kind, blob, mime: this.mime, codec: this.codec, container: this.container, frames: this.frames, dropped: this.dropped, duplicated: 0, durationS }
  }
}

const MR_CANDIDATES: Record<Exclude<VideoCodecPref, 'auto'>, string[]> = {
  h264: ['video/mp4;codecs=avc1.4d0034', 'video/mp4;codecs=h264', 'video/webm;codecs=h264'],
  vp9: ['video/webm;codecs=vp9'],
  av1: ['video/webm;codecs=av01.0.08M.08', 'video/webm;codecs=av1'],
}
const MR_FALLBACKS = ['video/webm', 'video/mp4']

function pickMediaRecorderMime(pref: VideoCodecPref): string {
  if (typeof MediaRecorder === 'undefined') return ''
  const order: Exclude<VideoCodecPref, 'auto'>[] = pref === 'auto' ? ['vp9', 'h264', 'av1'] : [pref, ...(['vp9', 'h264', 'av1'] as const).filter((c) => c !== pref)]
  for (const c of order) for (const m of MR_CANDIDATES[c]) if (MediaRecorder.isTypeSupported(m)) return m
  for (const m of MR_FALLBACKS) if (MediaRecorder.isTypeSupported(m)) return m
  return ''
}

/** Patch a MediaRecorder WebM's `Segment > Info > Duration` element (EBML id 0x4489, the 8-byte
 *  float64 Chrome reserves but never fills in) in place. If the placeholder cannot be found (a
 *  producer that reserved none) the blob is returned unpatched — the player then shows no/live
 *  duration, the pre-existing MediaRecorder behaviour this replaces. */
async function fixWebmDuration(blob: Blob, durationMs: number): Promise<Blob> {
  const buf = await blob.arrayBuffer()
  const bytes = new Uint8Array(buf)
  const limit = Math.min(bytes.length - 11, 1 << 16)   // Segment Info sits near the start of the file
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0x44 && bytes[i + 1] === 0x89 && bytes[i + 2] === 0x88) {
      new DataView(buf, i + 3, 8).setFloat64(0, durationMs)
      return new Blob([buf], { type: blob.type })
    }
  }
  return blob
}

/** `captureStream(0)` + `track.requestFrame()` (frame-accurate, no duplicates) when the browser
 *  supports manual pushes; a `captureStream(fps)` timer fallback otherwise (may duplicate/drop, but
 *  still draws whole frames — the existing MediaRecorder behaviour, kept for browsers without
 *  `VideoEncoder`). WebM duration is patched in `close()`. */
export class MediaRecorderSink implements VideoSink {
  readonly kind = 'mediarecorder' as const
  readonly container: Container
  codec: string
  mime: string
  private rec: MediaRecorder
  private chunks: Blob[] = []
  private track: (MediaStreamTrack & { requestFrame?: () => void }) | null
  private frames = 0
  private firstTsSec: number | null = null
  private lastTsSec = 0

  private constructor(rec: MediaRecorder, track: (MediaStreamTrack & { requestFrame?: () => void }) | null, mime: string, codec: string) {
    this.rec = rec; this.track = track; this.mime = mime; this.codec = codec
    this.container = mime.includes('mp4') ? 'mp4' : 'webm'
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data) }
    this.rec.start(1000)
  }

  static create(canvas: HTMLCanvasElement, opts: VideoSinkCreateOptions): MediaRecorderSink | null {
    if (typeof MediaRecorder === 'undefined') return null
    const mime = pickMediaRecorderMime(opts.codec)
    if (!mime) return null
    const stream = canvas.captureStream(0)
    let track = stream.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined
    const manual = typeof track?.requestFrame === 'function'
    let used = stream
    if (!manual) { stream.getVideoTracks().forEach((t) => t.stop()); used = canvas.captureStream(opts.fpsHint || 30); track = undefined }
    const bitrate = bitrateFor(opts.quality, opts.width, opts.height, opts.fpsHint ?? 20)
    let rec: MediaRecorder
    try { rec = new MediaRecorder(used, { mimeType: mime, videoBitsPerSecond: bitrate }) } catch { return null }
    const codec = /codecs=([^;,]+)/.exec(mime)?.[1] ?? mime.replace(/^video\//, '')
    return new MediaRecorderSink(rec, manual ? (track ?? null) : null, mime, codec)
  }

  addFrame(_canvas: CanvasImageSource, tSec: number): boolean {
    if (this.firstTsSec === null) this.firstTsSec = tSec
    this.lastTsSec = tSec
    this.track?.requestFrame?.()
    this.frames++
    return true
  }

  async close(): Promise<VideoSinkResult> {
    const done = new Promise<void>((r) => (this.rec.onstop = () => r()))
    if (this.rec.state !== 'inactive') this.rec.stop()
    await done
    const durationS = this.firstTsSec === null ? 0 : Math.max(0, this.lastTsSec - this.firstTsSec)
    let blob = new Blob(this.chunks, { type: this.rec.mimeType || this.mime })
    if (this.container === 'webm') blob = await fixWebmDuration(blob, durationS * 1000).catch(() => blob)
    return { kind: this.kind, blob, mime: blob.type, codec: this.codec, container: this.container, frames: this.frames, dropped: 0, duplicated: this.track ? 0 : this.frames, durationS }
  }
}

/** WebCodecs first, MediaRecorder fallback. Throws only when neither is usable. */
export async function createVideoSink(canvas: HTMLCanvasElement, opts: VideoSinkCreateOptions): Promise<VideoSink> {
  const wc = await WebCodecsSink.create(opts).catch(() => null)
  if (wc) return wc
  const mr = MediaRecorderSink.create(canvas, opts)
  if (mr) return mr
  throw new Error('video recording is not supported by this browser')
}
