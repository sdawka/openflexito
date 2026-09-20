/** Time-lapse → MP4/WebM export off the main thread: decoded frames arrive one at a time (backpressure
 *  is the caller's job, via the `ack` reply below), are drawn onto an `OffscreenCanvas` (with the
 *  frame's drift-correction shift, same convention as `TimelapseViewer`/`exportTimelapseWebm`) and fed
 *  to a WebCodecs `VideoEncoder` through mediabunny at an exact `1/fps` timestamp spacing. See
 *  `services/timelapseExport.ts` for the main-thread side of the protocol and
 *  `services/videoEncoder.ts` for the codec-resolution/bitrate maths this duplicates (a worker cannot
 *  import DOM-dependent code from the main-thread module, but the maths itself is plain and small). */
import {
  Output, Mp4OutputFormat, WebMOutputFormat, BufferTarget, VideoSampleSource, VideoSample,
  canEncodeVideo, type VideoCodec as MbVideoCodec,
} from 'mediabunny'
import { defineWorker, post } from './workerUtil'

type Container = 'mp4' | 'webm'
type CodecPref = 'h264' | 'vp9' | 'av1' | 'auto'
type Quality = 'high' | 'medium' | 'low' | { bitrateMbps: number }

interface StartMsg { type: 'start'; width: number; height: number; fps: number; container: Container; codec: CodecPref; quality: Quality; keyframeS: number }
interface FrameMsg { type: 'frame'; bitmap: ImageBitmap; index: number; shift?: { dx: number; dy: number } }
interface FinishMsg { type: 'finish' }
type InMsg = StartMsg | FrameMsg | FinishMsg

const CODEC_PREF: Record<Exclude<CodecPref, 'auto'>, MbVideoCodec> = { h264: 'avc', vp9: 'vp9', av1: 'av1' }
const CODEC_ORDER: MbVideoCodec[] = ['avc', 'vp9', 'av1']
const REF_PIXEL_RATE = 1640 * 1232 * 30
const BASE_MBPS: Record<'high' | 'medium' | 'low', number> = { high: 12, medium: 6, low: 3 }

function bitrateFor(quality: Quality, width: number, height: number, fps: number): number {
  if (typeof quality === 'object') return Math.max(1, Math.round(quality.bitrateMbps * 1e6))
  const scale = (width * height * Math.max(1, fps)) / REF_PIXEL_RATE
  return Math.round(BASE_MBPS[quality] * 1e6 * Math.max(0.15, scale))
}
function formatFor(container: Container): Mp4OutputFormat | WebMOutputFormat {
  return container === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat()
}
async function resolveCodec(container: Container, pref: CodecPref, w: number, h: number): Promise<MbVideoCodec | null> {
  const supported = new Set(formatFor(container).getSupportedCodecs())
  const order = pref === 'auto' ? CODEC_ORDER : [CODEC_PREF[pref], ...CODEC_ORDER.filter((c) => c !== CODEC_PREF[pref])]
  for (const c of order) {
    if (!supported.has(c)) continue
    try { if (await canEncodeVideo(c, { width: w, height: h })) return c } catch { /* try the next */ }
  }
  return null
}

let canvas: OffscreenCanvas | null = null
let ctx: OffscreenCanvasRenderingContext2D | null = null
let output: Output | null = null
let source: VideoSampleSource | null = null
let target: BufferTarget | null = null
let width = 0, height = 0, fps = 30, container: Container = 'mp4', frameCount = 0

defineWorker<InMsg>(async (m) => {
  if (m.type === 'start') {
    width = m.width; height = m.height; fps = m.fps; container = m.container
    canvas = new OffscreenCanvas(width, height)
    ctx = canvas.getContext('2d', { willReadFrequently: true })
    const codec = await resolveCodec(container, m.codec, width, height)
    if (!codec) throw new Error('no encodable video codec for this browser/container')
    target = new BufferTarget()
    output = new Output({ format: formatFor(container), target })
    source = new VideoSampleSource({
      codec, bitrate: bitrateFor(m.quality, width, height, fps), bitrateMode: 'variable', latencyMode: 'quality',
      keyFrameInterval: Math.max(0.1, m.keyframeS),
    })
    output.addVideoTrack(source, { frameRate: fps })
    await output.start()
    frameCount = 0
    post({ type: 'ready' })
  } else if (m.type === 'frame') {
    if (!ctx || !canvas || !source) throw new Error('encodeWorker: frame received before start')
    ctx.clearRect(0, 0, width, height)
    ctx.drawImage(m.bitmap, -(m.shift?.dx ?? 0), -(m.shift?.dy ?? 0))
    m.bitmap.close()
    const sample = new VideoSample(canvas, { timestamp: m.index / fps })
    await source.add(sample)
    sample.close()
    frameCount++
    post({ type: 'ack', index: m.index })
  } else if (m.type === 'finish') {
    if (!output || !target) throw new Error('encodeWorker: finish received before start')
    await output.finalize()
    const buffer = target.buffer ?? new ArrayBuffer(0)
    const mime = await output.getMimeType().catch(() => (container === 'mp4' ? 'video/mp4' : 'video/webm'))
    post({ type: 'done', buffer, mime, frames: frameCount }, [buffer])
  }
})
