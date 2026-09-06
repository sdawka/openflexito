/** Object following: track a user-chosen region frame to frame with FFT correlation and move the
 *  stage (via the camera-stage matrix) to keep it centred. Runs entirely in the browser. */

import { displacement } from '../algo/fftTrack'
import { pixelsToStage } from '../algo/csm'
import type { Gray } from '../algo/sharpness'
import { grabGray } from '../api/sampler'
import { calibration } from '../store/calibration.svelte'
import { device } from '../store/device.svelte'
import { settings } from '../store/settings.svelte'

export interface Region { x: number; y: number; w: number; h: number }   // fractions of the frame

function crop(g: Gray, r: Region): Gray {
  const x0 = Math.max(0, Math.round(r.x * g.width)), y0 = Math.max(0, Math.round(r.y * g.height))
  const w = Math.min(g.width - x0, Math.round(r.w * g.width)), h = Math.min(g.height - y0, Math.round(r.h * g.height))
  const data = new Float32Array(w * h)
  for (let y = 0; y < h; y++) data.set(g.data.subarray((y0 + y) * g.width + x0, (y0 + y) * g.width + x0 + w), y * w)
  return { data, width: w, height: h }
}

class FollowController {
  active = $state(false)
  region = $state<Region | null>(null)
  status = $state('')
  private template: Gray | null = null
  private lost = 0
  private timer: ReturnType<typeof setTimeout> | undefined

  async start(region: Region): Promise<void> {
    if (!calibration.csm) { this.status = 'calibrate camera/stage mapping first'; return }
    this.stop()
    this.active = true
    this.region = region
    this.lost = 0
    const frame = await grabGray(410, 0)
    this.template = crop(frame, region)
    this.status = 'following'
    this.schedule()
  }

  stop(): void {
    clearTimeout(this.timer)
    this.active = false
    this.template = null
    this.status = ''
  }

  private schedule(): void {
    this.timer = setTimeout(() => this.step().catch((e) => { this.status = (e as Error).message }), settings.followIntervalMs)
  }

  private async step(): Promise<void> {
    if (!this.active || !this.template || !this.region || !calibration.csm) return
    const frame = await grabGray(410, 0)
    // search window: the last region grown by 1.5x on each side (clamped)
    const r = this.region
    const win: Region = {
      x: Math.max(0, r.x - r.w * 0.75), y: Math.max(0, r.y - r.h * 0.75),
      w: Math.min(1, r.w * 2.5), h: Math.min(1, r.h * 2.5),
    }
    win.w = Math.min(win.w, 1 - win.x); win.h = Math.min(win.h, 1 - win.y)
    const d = displacement(this.template, crop(frame, win))
    if (!Number.isFinite(d.quality) || d.quality < 1.15) {
      if (++this.lost > 6) { this.status = 'object lost'; this.active = false; return }
      this.status = `searching (${this.lost})`
      this.schedule(); return
    }
    this.lost = 0
    // the template's top-left within the window sits at (dx,dy) from the window's top-left + the
    // offset the template originally had inside the window
    const tx = win.x * frame.width + (r.x - win.x) * frame.width + d.dx
    const ty = win.y * frame.height + (r.y - win.y) * frame.height + d.dy
    this.region = { x: tx / frame.width, y: ty / frame.height, w: r.w, h: r.h }
    // centre offset in pixels of the analysis frame -> stage move
    const cx = tx + this.template.width / 2 - frame.width / 2, cy = ty + this.template.height / 2 - frame.height / 2
    if (Math.hypot(cx, cy) > settings.followDeadbandPx && !device.moving) {
      const k = calibration.csm.imageWidth / frame.width
      const move = pixelsToStage(calibration.csm.matrix, [-cx * k, -cy * k])
      this.status = `centring (${cx.toFixed(0)}, ${cy.toFixed(0)} px)`
      await device.moveRel(move, false)
      // after the move the object should be near the centre; predict the region there
      this.region = { x: 0.5 - r.w / 2, y: 0.5 - r.h / 2, w: r.w, h: r.h }
    } else {
      this.status = 'following'
    }
    if (this.active) this.schedule()
  }
}

export const follow = new FollowController()
