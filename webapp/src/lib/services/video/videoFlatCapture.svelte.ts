/** Capture and persistence of the video reference flat (`algo/videoFlat.ts#VideoFlat`) used by the
 *  Enhance video mode's `'reference'` flatten: 32 stream frames of a blank field (AE/AWB locked) build
 *  the gain map; an optional dark capture (LED off, restored afterwards) adds the dark map and the
 *  hot-pixel list. The result is persisted to localStorage (~100 kB at a 1/8 grid) and restored at
 *  load through `toneModes.ts#setVideoFlat`. */

import { fetchSnapshot } from '../../api/snapshot'
import { device } from '../../store/device.svelte'
import { lockCamera } from '../cameraLock'
import { VideoFlat } from '../../algo/videoFlat'
import { setVideoFlat, getVideoFlat } from './toneModes'
import { decode } from '../photo/common'

const KEY = 'openflexito.videoFlat'
const FRAMES = 32

export class VideoFlatCapture {
  busy = $state(false)
  status = $state('')
  hasReference = $state(false)
  hasDark = $state(false)
  meanLuma = $state<number | null>(null)
  private flat: VideoFlat | null = null

  constructor() {
    try {
      const raw = localStorage.getItem(KEY)
      if (raw) { const f = VideoFlat.fromJson(JSON.parse(raw)); this.flat = f; setVideoFlat(f); this.hasReference = true; this.hasDark = f.darkFrames > 0; this.meanLuma = f.meanLuma }
    } catch { /* ignore a corrupt store */ }
  }

  private async frames(into: (rgba: Uint8ClampedArray, w: number, h: number) => void, what: string): Promise<void> {
    for (let i = 0; i < FRAMES; i++) {
      const img = await decode(await fetchSnapshot())
      into(img.data as Uint8ClampedArray, img.width, img.height)
      this.status = `${what}: ${i + 1}/${FRAMES}`
    }
  }

  /** Capture the blank field currently in view (move the sample away first). */
  async captureReference(): Promise<void> {
    if (this.busy) return
    this.busy = true
    const lock = await lockCamera({ ae: true, awb: true })
    try {
      const f = new VideoFlat()   // a new reference invalidates any dark captured for the old one
      await this.frames((d, w, h) => f.addReference(d, w, h), 'blank field')
      if (!f.finalize()) throw new Error('no reference frames')
      this.flat = f; setVideoFlat(f); this.hasReference = true; this.hasDark = false; this.meanLuma = f.meanLuma
      this.persist(); this.status = 'reference captured'
    } catch (e) { this.status = (e as Error).message } finally { await lock.release(); this.busy = false }
  }

  /** Capture a dark frame with the LED off (restored afterwards); needs a reference first. */
  async captureDark(): Promise<void> {
    if (this.busy || !this.flat) return
    this.busy = true
    const cc = device.light.cc, pwm = [...device.light.pwm]
    const lock = await lockCamera({ ae: true, awb: true })
    try {
      await device.setLight(0, pwm.map(() => 0))
      await new Promise((r) => setTimeout(r, 400))
      const f = this.flat
      await this.frames((d, w, h) => f.addDark(d, w, h), 'dark')
      if (!f.finalize()) throw new Error('capture the blank field first (the reference is not in memory after a reload)')
      setVideoFlat(f); this.hasDark = true
      this.persist(); this.status = 'dark captured'
    } catch (e) { this.status = (e as Error).message } finally {
      try { await device.setLight(cc, pwm) } catch { /* reported by the device store */ }
      await lock.release(); this.busy = false
    }
  }

  clear(): void {
    this.flat = null; setVideoFlat(null); this.hasReference = false; this.hasDark = false; this.meanLuma = null
    try { localStorage.removeItem(KEY) } catch { /* ignore */ }
    this.status = ''
  }

  /** True when the live frame's mean luma differs from the reference's by more than 10 %. */
  stale(liveMeanLuma: number | null): boolean {
    return this.meanLuma != null && liveMeanLuma != null && Math.abs(liveMeanLuma - this.meanLuma) > 0.1 * Math.max(1, this.meanLuma)
  }

  private persist(): void {
    const f = getVideoFlat()
    if (!f) return
    try { localStorage.setItem(KEY, JSON.stringify(f.toJson())) } catch (e) { this.status = `could not persist the flat: ${(e as Error).message}` }
  }
}

export const videoFlatCapture = new VideoFlatCapture()
