/** Time-lapse capture with optional drift correction. Frames are grabbed at a fixed interval (a
 *  stream frame or a full-resolution still); each is registered to a template by phase correlation
 *  (`algo/fftTrack.displacement`) and the accumulated drift is tracked by `algo/drift.ts`. Once the
 *  drift exceeds the configured threshold and the camera-stage calibration exists, a raw stage move
 *  (`compensate: false`) brings the sample back into frame and a fresh template is grabbed. Every
 *  frame's residual shift is stored so the gallery viewer can play the sequence back drift-free.
 *  Optionally autofocuses every N frames and turns the LED off between frames to limit heating and
 *  photobleaching, restoring the level it found on start. */

import { DriftTracker, type DriftReading } from '../algo/drift'
import { displacement, centralCrop } from '../algo/fftTrack'
import { toGray, type Gray } from '../algo/sharpness'
import { pixelsToStage } from '../algo/csm'
import { fetchSnapshot } from '../api/snapshot'
import { calibration } from '../store/calibration.svelte'
import { device } from '../store/device.svelte'
import { getBlob, saveTimelapse, saveVideo, type GalleryItem, type TimelapseFrameMeta } from '../store/gallery'
import { runAutofocus } from './autofocusService'
import { Recorder } from './recorder.svelte'

export interface TimelapseConfig {
  intervalMs: number
  frames: number                 // total frame count
  source: 'stream' | 'full'
  autofocusEveryN: number        // 0 = never
  ledOff: boolean
  driftCorrect: boolean
  driftThresholdPx: number
}

const MEASURE_WIDTH = 410
const CENTRAL_FRAC = 0.6
const CORRECTION_SETTLE_MS = 150
const LIGHT_SETTLE_MS = 200

async function measureGray(blob: Blob): Promise<Gray> {
  const bmp = await createImageBitmap(blob)
  const scale = Math.min(1, MEASURE_WIDTH / bmp.width)
  const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale))
  const c = new OffscreenCanvas(w, h)
  const ctx = c.getContext('2d')!
  ctx.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  return toGray(ctx.getImageData(0, 0, w, h))
}

class TimelapseService {
  active = $state(false)
  captured = $state(0)
  total = $state(0)
  status = $state('')
  driftPx = $state(0)
  corrections = $state(0)
  lastItem = $state<GalleryItem | null>(null)

  private cfg: TimelapseConfig | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private cancelled = false
  private template: Gray | null = null
  private drift: DriftTracker | null = null
  private savedLight: { cc: number; pwm: number[] } | null = null
  private frames: { blob: Blob; meta: TimelapseFrameMeta }[] = []

  async start(cfg: TimelapseConfig): Promise<void> {
    if (this.active) return
    this.cfg = cfg
    this.active = true
    this.cancelled = false
    this.captured = 0; this.total = cfg.frames; this.corrections = 0; this.driftPx = 0
    this.frames = []
    this.template = null
    this.lastItem = null
    this.drift = cfg.driftCorrect && calibration.csm ? new DriftTracker(cfg.driftThresholdPx) : null
    if (cfg.ledOff) {
      this.savedLight = { cc: device.light.cc, pwm: [...device.light.pwm] }
      await device.setLight(0, device.light.pwm.map(() => 0)).catch(() => {})
    } else {
      this.savedLight = null
    }
    this.status = 'starting…'
    void this.tick()
  }

  stop(): void {
    if (!this.active) return
    this.cancelled = true
    clearTimeout(this.timer)
    void this.finish()
  }

  private async tick(): Promise<void> {
    if (this.cancelled || !this.cfg) return
    try {
      await this.captureOne()
    } catch (e) {
      this.status = `frame ${this.captured}: ${(e as Error).message}`
    }
    if (this.cancelled || !this.cfg) return
    if (this.captured >= this.cfg.frames) { await this.finish(); return }
    this.timer = setTimeout(() => { void this.tick() }, this.cfg.intervalMs)
  }

  private async captureOne(): Promise<void> {
    const cfg = this.cfg!
    if (cfg.ledOff && this.savedLight) {
      await device.setLight(this.savedLight.cc, this.savedLight.pwm).catch(() => {})
      await new Promise((r) => setTimeout(r, LIGHT_SETTLE_MS))
    }
    if (cfg.autofocusEveryN > 0 && this.captured > 0 && this.captured % cfg.autofocusEveryN === 0) {
      this.status = 'autofocus…'
      await runAutofocus({ mode: 'fast', dz: 1000, metric: 'jpeg' }).catch((e) => { this.status = `autofocus: ${(e as Error).message}` })
    }
    const blob = await fetchSnapshot({ full: cfg.source === 'full' })
    if (cfg.ledOff && this.savedLight) await device.setLight(0, this.savedLight.pwm.map(() => 0)).catch(() => {})

    let shift = { dx: 0, dy: 0 }
    if (this.drift) {
      const gray = await measureGray(blob)
      if (!this.template) {
        this.template = centralCrop(gray, CENTRAL_FRAC)
      } else {
        const d: DriftReading = displacement(this.template, centralCrop(gray, CENTRAL_FRAC))
        const decision = this.drift.record(d)
        shift = { dx: decision.offset.x, dy: decision.offset.y }
        this.driftPx = Math.hypot(shift.dx, shift.dy)
        if (decision.shouldCorrect && calibration.csm) {
          const k = calibration.csm.imageWidth / gray.width
          const move = pixelsToStage(calibration.csm.matrix, [-decision.offset.x * k, -decision.offset.y * k])
          this.status = `correcting drift (${decision.offset.x.toFixed(0)}, ${decision.offset.y.toFixed(0)} px)`
          await device.moveRel(move, false)
          await new Promise((r) => setTimeout(r, CORRECTION_SETTLE_MS))
          const settleBlob = await fetchSnapshot({ full: cfg.source === 'full' })
          this.template = centralCrop(await measureGray(settleBlob), CENTRAL_FRAC)
          this.drift.rebase(decision.offset, decision.offset)   // assume the commanded move closed the gap
          this.corrections++
        }
      }
    }

    this.frames.push({ blob, meta: { t: new Date().toISOString(), z: device.position.z, shift } })
    this.captured++
    this.status = `frame ${this.captured}/${cfg.frames}`
  }

  private async finish(): Promise<GalleryItem | null> {
    if (!this.active) return null
    this.active = false
    clearTimeout(this.timer)
    if (this.cfg?.ledOff && this.savedLight) await device.setLight(this.savedLight.cc, this.savedLight.pwm).catch(() => {})
    if (!this.frames.length) { this.status = ''; return null }
    this.status = 'saving…'
    const item = await saveTimelapse(this.frames.map((f) => f.blob), this.frames.map((f) => f.meta), {
      intervalMs: this.cfg!.intervalMs, source: this.cfg!.source, driftCorrected: !!this.drift,
    })
    this.lastItem = item
    this.status = `saved "${item.name}" (${this.frames.length} frames)`
    this.frames = []
    setTimeout(() => { if (this.status.startsWith('saved')) this.status = '' }, 6000)
    return item
  }
}

export const timelapse = new TimelapseService()

/** Re-encode a saved time-lapse as WebM by drawing its frames to a canvas and recording it with
 *  MediaRecorder, the same approach `recorder.svelte.ts` uses for the live view. */
export async function exportTimelapseWebm(item: GalleryItem, opts: { fps?: number; stabilised?: boolean } = {}): Promise<GalleryItem> {
  const meta = item.timelapse
  if (!meta || !meta.frames.length) throw new Error('not a time-lapse item')
  const fps = opts.fps ?? 8
  const stabilised = opts.stabilised ?? true
  const mime = Recorder.mime()
  if (!mime) throw new Error('video recording is not supported by this browser')
  const w = item.width ?? 640, h = item.height ?? 480
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const ctx = canvas.getContext('2d')!
  const stream = canvas.captureStream(0)
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void }
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 })
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
  const done = new Promise<void>((resolve) => (rec.onstop = () => resolve()))
  rec.start()
  for (let i = 0; i < meta.frames.length; i++) {
    const blob = await getBlob(item.id, `f${String(i).padStart(4, '0')}`)
    if (!blob) continue
    const bmp = await createImageBitmap(blob)
    const shift = stabilised ? meta.frames[i].shift : { dx: 0, dy: 0 }
    ctx.clearRect(0, 0, w, h)
    ctx.drawImage(bmp, -shift.dx, -shift.dy)
    bmp.close()
    track.requestFrame?.()
    await new Promise((r) => setTimeout(r, 1000 / fps))
  }
  rec.stop()
  await done
  const blob = new Blob(chunks, { type: rec.mimeType || 'video/webm' })
  return saveVideo(blob, null, { durationS: meta.frames.length / fps, fps, source: 'time-lapse export', width: w, height: h })
}
