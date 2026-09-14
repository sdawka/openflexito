/** Time-lapse capture with optional drift correction. Frames are grabbed on an absolute clock (slot i
 *  is due at start + i × interval; a slot that is already late when the previous capture finishes is
 *  skipped rather than queued, so the cadence stays honest) as a stream frame or a full-resolution
 *  still; each is registered to a template by phase correlation (`algo/fftTrack.displacement`) and
 *  the accumulated drift is tracked by `algo/drift.ts`. Once the drift exceeds the configured
 *  threshold and the camera-stage calibration exists, a raw stage move (`compensate: false`) brings
 *  the sample back into frame and a fresh template is grabbed. Every frame's residual shift is stored
 *  in full-frame pixels (D2: it is measured on a downsample and rescaled by frame width / analysis
 *  width) so the gallery viewer can play the sequence back drift-free.
 *
 *  Also: AE/AWB are locked for the whole run (`services/cameraLock.ts`) with an optional periodic
 *  re-meter (release, wait for the auto algorithms, re-lock) for long runs; autofocus runs every N
 *  frames and/or when the analysis frame's sharpness drops more than X % below the running best; the
 *  LED can be off between frames to limit heating and photobleaching; frames can be re-encoded as PNG;
 *  the storage footprint is estimated live and a byte cap stops the run with a warning. */

import { DriftTracker, type DriftReading, playbackShift, meanAbsLaplacian, nextSlot, sharpnessDropped } from '../algo/drift'
import { displacement, centralCrop } from '../algo/fftTrack'
import { toGray, type Gray } from '../algo/sharpness'
import { pixelsToStage } from '../algo/csm'
import { fetchSnapshot } from '../api/snapshot'
import { waitForFrames } from '../api/sampler'
import { calibration } from '../store/calibration.svelte'
import { device } from '../store/device.svelte'
import { getBlob, saveTimelapse, saveVideo, type GalleryItem, type TimelapseFrameMeta } from '../store/gallery'
import { runAutofocus } from './autofocusService'
import { lockCamera, type CameraLock } from './cameraLock'
import { Recorder } from './recorder.svelte'

export interface TimelapseConfig {
  intervalMs: number
  frames: number                 // total slot count (frames = slots minus any skipped for running late)
  source: 'stream' | 'full'
  autofocusEveryN: number        // 0 = never
  /** autofocus when the analysis frame's sharpness falls this many % below the running best (0 = off) */
  refocusDropPct: number
  ledOff: boolean
  driftCorrect: boolean
  driftThresholdPx: number       // in analysis-frame px (410 wide), as before
  /** freeze AE/AWB for the run (default true) */
  lockCamera: boolean
  /** every N frames release the lock, let the camera re-meter and lock again (0 = never) */
  remeterEveryN: number
  /** frame encoding: the device JPEG as is, or a lossless PNG re-encode of it */
  format: 'jpeg' | 'png'
  /** stop with a warning once the stored frames exceed this many bytes (0 = no cap) */
  maxBytes: number
}

export const MEASURE_WIDTH = 410
const CENTRAL_FRAC = 0.6
const CORRECTION_SETTLE_MS = 150
const LIGHT_SETTLE_MS = 200
/** after releasing the lock: two fresh frames, then this long for AGC/AWB to converge before re-locking */
const REMETER_SETTLE_MS = 600

/** Rough per-frame size for the pre-run estimate (bytes): the 1640-wide stream JPEG vs a full still (PNG ~4×). */
export function estimateFrameBytes(source: 'stream' | 'full', format: 'jpeg' | 'png'): number {
  const jpeg = source === 'full' ? 1.3e6 : 0.3e6
  return format === 'png' ? jpeg * 4 : jpeg
}

async function measureGray(blob: Blob): Promise<{ gray: Gray; frameWidth: number; frameHeight: number }> {
  const bmp = await createImageBitmap(blob)
  const scale = Math.min(1, MEASURE_WIDTH / bmp.width)
  const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale))
  const c = new OffscreenCanvas(w, h)
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bmp, 0, 0, w, h)
  const frameWidth = bmp.width, frameHeight = bmp.height
  bmp.close()
  return { gray: toGray(ctx.getImageData(0, 0, w, h)), frameWidth, frameHeight }
}

async function toPng(blob: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(blob)
  const c = new OffscreenCanvas(bmp.width, bmp.height)
  c.getContext('2d')!.drawImage(bmp, 0, 0)
  bmp.close()
  return c.convertToBlob({ type: 'image/png' })
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class TimelapseService {
  active = $state(false)
  captured = $state(0)
  total = $state(0)
  status = $state('')
  warning = $state('')
  driftPx = $state(0)
  corrections = $state(0)
  skipped = $state(0)
  refocuses = $state(0)
  /** bytes stored so far and the projected total for the whole run */
  bytesStored = $state(0)
  estimateBytes = $state(0)
  /** browser storage headroom (bytes) reported by navigator.storage, if available */
  quotaFree = $state<number | null>(null)
  lastItem = $state<GalleryItem | null>(null)

  private cfg: TimelapseConfig | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  private cancelled = false
  private template: Gray | null = null
  private drift: DriftTracker | null = null
  private savedLight: { cc: number; pwm: number[] } | null = null
  private frames: { blob: Blob; meta: TimelapseFrameMeta }[] = []
  private startedAt = 0
  private startedIso = ''
  private lastSlot = -1
  private bestSharpness = 0
  private lock: CameraLock | null = null
  private inflight: Promise<void> | null = null

  async start(cfg: TimelapseConfig): Promise<void> {
    if (this.active) return
    this.cfg = cfg
    this.active = true
    this.cancelled = false
    this.captured = 0; this.total = cfg.frames; this.corrections = 0; this.driftPx = 0; this.skipped = 0; this.refocuses = 0
    this.bytesStored = 0; this.estimateBytes = estimateFrameBytes(cfg.source, cfg.format) * cfg.frames
    this.warning = ''
    this.frames = []
    this.template = null
    this.lastItem = null
    this.lastSlot = -1
    this.bestSharpness = 0
    this.drift = cfg.driftCorrect && calibration.csm ? new DriftTracker(cfg.driftThresholdPx) : null
    try {
      const est = await navigator.storage?.estimate?.()
      this.quotaFree = est && est.quota !== undefined && est.usage !== undefined ? est.quota - est.usage : null
      if (this.quotaFree !== null && this.estimateBytes > 0.9 * this.quotaFree) this.warning = `estimated ${fmtBytes(this.estimateBytes)} exceeds the browser's free storage (${fmtBytes(this.quotaFree)})`
    } catch { this.quotaFree = null }
    if (cfg.ledOff) {
      this.savedLight = { cc: device.light.cc, pwm: [...device.light.pwm] }
      await device.setLight(0, device.light.pwm.map(() => 0)).catch(() => {})
    } else {
      this.savedLight = null
    }
    this.lock = null
    if (cfg.lockCamera) {
      if (cfg.ledOff && this.savedLight) { await device.setLight(this.savedLight.cc, this.savedLight.pwm).catch(() => {}); await sleep(LIGHT_SETTLE_MS) }
      try { this.lock = await lockCamera() } catch (e) { this.warning = `could not lock the camera: ${(e as Error).message}` }
      if (cfg.ledOff && this.savedLight) await device.setLight(0, this.savedLight.pwm.map(() => 0)).catch(() => {})
    }
    this.status = 'starting…'
    this.startedAt = performance.now()
    this.startedIso = new Date().toISOString()
    void this.tick(0)
  }

  stop(): void {
    if (!this.active) return
    this.cancelled = true
    clearTimeout(this.timer)
    void this.finish()
  }

  private async tick(slot: number): Promise<void> {
    if (this.cancelled || !this.cfg) return
    try {
      this.inflight = this.captureOne(slot)
      await this.inflight
    } catch (e) {
      this.status = `frame ${this.captured}: ${(e as Error).message}`
    }
    this.lastSlot = slot
    if (this.cancelled || !this.cfg) return
    if (this.cfg.maxBytes > 0 && this.bytesStored > this.cfg.maxBytes) {
      this.warning = `storage cap reached (${fmtBytes(this.bytesStored)} of ${fmtBytes(this.cfg.maxBytes)}): stopped after ${this.captured} frames`
      await this.finish(); return
    }
    const next = nextSlot(performance.now(), this.startedAt, this.cfg.intervalMs, slot)
    if (next.skipped) { this.skipped += next.skipped; this.warning = `${this.skipped} slot(s) skipped: capture took longer than the interval` }
    if (next.slot >= this.cfg.frames) { await this.finish(); return }
    this.timer = setTimeout(() => { void this.tick(next.slot) }, Math.max(0, next.dueAt - performance.now()))
  }

  private async lightOn(): Promise<void> {
    if (this.cfg?.ledOff && this.savedLight) { await device.setLight(this.savedLight.cc, this.savedLight.pwm).catch(() => {}); await sleep(LIGHT_SETTLE_MS) }
  }
  private async lightOff(): Promise<void> {
    if (this.cfg?.ledOff && this.savedLight) await device.setLight(0, this.savedLight.pwm.map(() => 0)).catch(() => {})
  }

  private async autofocus(why: string): Promise<boolean> {
    this.status = `autofocus (${why})…`
    try { await runAutofocus({ mode: 'fast', dz: 1000, metric: 'jpeg' }); this.refocuses++; return true }
    catch (e) { this.status = `autofocus: ${(e as Error).message}`; return false }
  }

  private async captureOne(slot: number): Promise<void> {
    const cfg = this.cfg!
    await this.lightOn()
    let remetered = false
    if (this.lock && cfg.remeterEveryN > 0 && this.captured > 0 && this.captured % cfg.remeterEveryN === 0) {
      this.status = 're-metering…'
      await this.lock.release((m) => (this.warning = m))
      await waitForFrames(2)
      await sleep(REMETER_SETTLE_MS)
      try { this.lock = await lockCamera(); remetered = true } catch (e) { this.warning = `could not re-lock the camera: ${(e as Error).message}` }
    }
    let refocused = false
    if (cfg.autofocusEveryN > 0 && this.captured > 0 && this.captured % cfg.autofocusEveryN === 0) refocused = await this.autofocus(`every ${cfg.autofocusEveryN}`)

    const needGray = !!this.drift || cfg.refocusDropPct > 0
    let blob = await fetchSnapshot({ full: cfg.source === 'full' })
    let measured = needGray ? await measureGray(blob) : null
    let sharpness = measured ? meanAbsLaplacian(measured.gray) : undefined
    // sharpness-triggered refocus: the frame just taken is soft compared with the best so far, so
    // autofocus and retake this slot (the soft frame is discarded)
    if (measured && sharpness !== undefined && !refocused && sharpnessDropped(sharpness, this.bestSharpness, cfg.refocusDropPct)) {
      if (await this.autofocus(`sharpness ${Math.round((1 - sharpness / this.bestSharpness) * 100)} % down`)) {
        refocused = true
        blob = await fetchSnapshot({ full: cfg.source === 'full' })
        measured = await measureGray(blob)
        sharpness = meanAbsLaplacian(measured.gray)
      }
    }
    if (sharpness !== undefined) this.bestSharpness = refocused ? sharpness : Math.max(this.bestSharpness, sharpness)
    await this.lightOff()

    let shift = { dx: 0, dy: 0 }
    if (this.drift && measured) {
      const { gray, frameWidth } = measured
      if (!this.template) {
        this.template = centralCrop(gray, CENTRAL_FRAC)
      } else {
        const d: DriftReading = displacement(this.template, centralCrop(gray, CENTRAL_FRAC))
        const decision = this.drift.record(d)
        const kFrame = frameWidth / gray.width   // D2: store the shift in full-frame px
        shift = { dx: decision.offset.x * kFrame, dy: decision.offset.y * kFrame }
        this.driftPx = Math.hypot(decision.offset.x, decision.offset.y)
        if (decision.shouldCorrect && calibration.csm) {
          const k = calibration.csm.imageWidth / gray.width
          const move = pixelsToStage(calibration.csm.matrix, [-decision.offset.x * k, -decision.offset.y * k])
          this.status = `correcting drift (${decision.offset.x.toFixed(0)}, ${decision.offset.y.toFixed(0)} px)`
          await this.lightOn()
          await device.moveRel(move, false)
          await sleep(CORRECTION_SETTLE_MS)
          const settleBlob = await fetchSnapshot({ full: cfg.source === 'full' })
          await this.lightOff()
          this.template = centralCrop((await measureGray(settleBlob)).gray, CENTRAL_FRAC)
          this.drift.rebase(decision.offset, decision.offset)   // assume the commanded move closed the gap
          this.corrections++
        }
      }
    }

    if (cfg.format === 'png') blob = await toPng(blob)
    this.frames.push({ blob, meta: {
      t: new Date().toISOString(), z: device.position.z, shift, measureWidth: measured?.gray.width ?? MEASURE_WIDTH, slot,
      sharpness: sharpness !== undefined ? Math.round(sharpness * 100) / 100 : undefined, refocused: refocused || undefined, remetered: remetered || undefined,
    } })
    this.captured++
    this.bytesStored += blob.size
    this.estimateBytes = (this.bytesStored / this.captured) * cfg.frames
    this.status = `frame ${this.captured}/${cfg.frames} · ${fmtBytes(this.bytesStored)} stored, ≈${fmtBytes(this.estimateBytes)} total`
  }

  private async finish(): Promise<GalleryItem | null> {
    if (!this.active) return null
    this.active = false
    clearTimeout(this.timer)
    // Stop pressed mid-capture: let that frame finish (it switches the LED off at its end and pushes
    // its frame) before restoring the light and saving, otherwise the LED ended up off and the frame lost
    await this.inflight?.catch(() => {})
    if (this.cfg?.ledOff && this.savedLight) await device.setLight(this.savedLight.cc, this.savedLight.pwm).catch((e) => { this.status = `could not restore the light: ${(e as Error).message}` })
    const locked = this.lock?.locked ?? { ae: false, awb: false }
    await this.lock?.release((m) => (this.warning = m))
    this.lock = null
    if (!this.frames.length) { this.status = ''; return null }
    this.status = 'saving…'
    const cfg = this.cfg!
    const item = await saveTimelapse(this.frames.map((f) => f.blob), this.frames.map((f) => f.meta), {
      intervalMs: cfg.intervalMs, source: cfg.source, driftCorrected: !!this.drift,
      format: cfg.format, locked, remeterEveryN: cfg.remeterEveryN, refocusDropPct: cfg.refocusDropPct, skipped: this.skipped, startedAt: this.startedIso,
    })
    this.lastItem = item
    this.status = `saved "${item.name}" (${this.frames.length} frames, ${fmtBytes(this.bytesStored)}${this.skipped ? `, ${this.skipped} skipped` : ''}${this.refocuses ? `, ${this.refocuses} refocus` : ''})`
    this.frames = []
    setTimeout(() => { if (this.status.startsWith('saved')) this.status = '' }, 8000)
    return item
  }
}

export function fmtBytes(b: number): string {
  return b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(0)} MB` : `${(b / 1e3).toFixed(0)} kB`
}

export const timelapse = new TimelapseService()

/** Re-encode a saved time-lapse as WebM by drawing its frames to a canvas and recording it with
 *  MediaRecorder, the same approach `recorder.svelte.ts` uses for the live view. Stabilisation uses
 *  `playbackShift` so legacy items (shift in analysis px) and new ones (full-frame px) both line up. */
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
    const shift = stabilised ? playbackShift(meta.frames[i], bmp.width) : { dx: 0, dy: 0 }
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
