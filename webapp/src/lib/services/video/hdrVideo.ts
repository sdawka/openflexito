/** HDR video by LED alternation: with the camera's AE/AWB locked (`services/cameraLock.ts`), the
 *  illumination is switched between a bright and a dim level every `period` frames, each incoming
 *  frame is classified bright/dim by its mean luma, and every output frame fuses the newest bright
 *  frame with the newest dim one by well-exposedness (a Gaussian around mid-grey, Mertens' weight
 *  without the pyramid: the weights are computed on a coarse grid and bilinearly upsampled, which is
 *  cheap and smooth enough for 8-bit video). Highlights come from the dim frame, shadows from the
 *  bright one. The output frame rate is the input rate; frames of the same class in a row simply
 *  re-fuse against the last frame of the other class. LED level and the AE lock are restored on stop.
 *
 *  Limits: the LED must actually change the exposure — with AE running the camera would compensate,
 *  which is why the lock is mandatory; a moving organism appears doubled where the two frames
 *  disagree (period 1 keeps that to one frame interval). */

import { device } from '../../store/device.svelte'
import { lockCamera, type CameraLock } from '../cameraLock'
import type { RgbaFrame } from '../frameChain'
import type { VideoModeRun, ModeOutput } from './types'
import { OutBuffer } from './common'

export interface HdrVideoParams { ratio: number /* bright/dim LED ratio */; period: number /* frames per level */ }

const COARSE = 8

export function hdrVideoMode(p: HdrVideoParams): VideoModeRun {
  let lock: CameraLock | null = null
  let cc0 = 0
  let n = 0
  let level: 'bright' | 'dim' = 'bright'
  let switching: Promise<void> | null = null
  let bright: Uint8ClampedArray | null = null, dim: Uint8ClampedArray | null = null
  let brightN = -1, dimN = -1   // frame index of each partner, to cap staleness
  let stale = 0
  let meanHi = -1, meanLo = -1
  /** commanded level per processed frame, so a frame can be attributed to the level set ~LATENCY
   *  frames earlier while the bright/dim means have not separated yet (start-up, or an LED that does
   *  not change the picture much) */
  const levelLog: ('bright' | 'dim')[] = []
  const LATENCY = 2
  const out = new OutBuffer()
  let wgt: Float32Array | null = null
  let fused = 0

  const setLevel = (l: 'bright' | 'dim') => {
    level = l
    const cc = l === 'bright' ? cc0 : cc0 / p.ratio
    switching = device.setLight(cc).catch(() => {}).then(() => { switching = null })
  }

  function fuse(b: Uint8ClampedArray, d: Uint8ClampedArray, w: number, h: number, o: Uint8ClampedArray): void {
    const cw = Math.ceil(w / COARSE), ch = Math.ceil(h / COARSE)
    if (!wgt || wgt.length !== cw * ch) wgt = new Float32Array(cw * ch)
    // coarse weight: share of the bright frame, from well-exposedness of both
    for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
      let lb = 0, ld = 0, k = 0
      for (let y = cy * COARSE; y < Math.min(h, (cy + 1) * COARSE); y += 2) for (let x = cx * COARSE; x < Math.min(w, (cx + 1) * COARSE); x += 2) {
        const i = (y * w + x) * 4
        lb += b[i] * 0.299 + b[i + 1] * 0.587 + b[i + 2] * 0.114
        ld += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114
        k++
      }
      const clippedB = lb / k >= 250   // the bright frame has nothing to offer where it clipped
      lb = lb / k / 255 - 0.5; ld = ld / k / 255 - 0.5
      const wb = (clippedB ? 0 : Math.exp(-(lb * lb) / (2 * 0.2 * 0.2))) + 1e-3, wd = Math.exp(-(ld * ld) / (2 * 0.2 * 0.2)) + 1e-3
      wgt[cy * cw + cx] = wb / (wb + wd)
    }
    for (let y = 0; y < h; y++) {
      const fy = Math.min(ch - 1, Math.max(0, (y + 0.5) / COARSE - 0.5)), y0 = fy | 0, y1 = Math.min(ch - 1, y0 + 1), ty = fy - y0
      for (let x = 0; x < w; x++) {
        const fx = Math.min(cw - 1, Math.max(0, (x + 0.5) / COARSE - 0.5)), x0 = fx | 0, x1 = Math.min(cw - 1, x0 + 1), tx = fx - x0
        const wb = (wgt[y0 * cw + x0] * (1 - tx) + wgt[y0 * cw + x1] * tx) * (1 - ty) + (wgt[y1 * cw + x0] * (1 - tx) + wgt[y1 * cw + x1] * tx) * ty
        const i = (y * w + x) * 4
        o[i] = b[i] * wb + d[i] * (1 - wb); o[i + 1] = b[i + 1] * wb + d[i + 1] * (1 - wb); o[i + 2] = b[i + 2] * wb + d[i + 2] * (1 - wb); o[i + 3] = 255
      }
    }
  }

  return {
    id: 'hdr',
    drivesStage: true,   // the LEDs, not the stage: but the same "expected change, don't reset" semantics
    async start() {
      cc0 = device.light.cc
      if (!(cc0 > 0)) throw new Error('HDR video needs the main LED on')
      lock = await lockCamera({ ae: true, awb: true })
      setLevel('bright')
    },
    process(f: RgbaFrame): ModeOutput | null {
      n++
      if (n % Math.max(1, p.period) === 0 && !switching) setLevel(level === 'bright' ? 'dim' : 'bright')
      // classify by mean luma against the running bright/dim means
      let s = 0, k = 0
      for (let i = 0; i < f.data.length; i += 64) { s += f.data[i] * 0.299 + f.data[i + 1] * 0.587 + f.data[i + 2] * 0.114; k++ }
      const mean = s / k
      levelLog.push(level)
      if (levelLog.length > LATENCY + 1) levelLog.shift()
      const commanded = levelLog[0]
      if (meanHi < 0) { meanHi = mean; meanLo = mean }
      // classify by luma once the two levels are clearly apart, else by the commanded level
      const separated = meanHi - meanLo > 0.05 * Math.max(1, meanHi)
      const isBright = separated ? mean >= (meanHi + meanLo) / 2 : commanded === 'bright'
      if (isBright) { meanHi = 0.8 * meanHi + 0.2 * mean; bright = bright?.length === f.data.length ? bright : new Uint8ClampedArray(f.data.length); bright.set(f.data); brightN = n }
      else { meanLo = 0.8 * meanLo + 0.2 * mean; dim = dim?.length === f.data.length ? dim : new Uint8ClampedArray(f.data.length); dim.set(f.data); dimN = n }
      if (meanLo > meanHi) { const t = meanLo; meanLo = meanHi; meanHi = t }
      if (!bright || !dim) return { frame: f }
      // a partner older than period + 3 frames would double a moving organism: pass the frame through
      if (Math.abs(brightN - dimN) > p.period + 3) { stale++; return { frame: f } }
      const o = out.get(f.width, f.height)
      fuse(bright, dim, f.width, f.height, o)
      fused++
      return { frame: { data: o, width: f.width, height: f.height } }
    },
    async stop() {
      await switching
      try { await device.setLight(cc0) } catch { /* reported by the device store */ }
      await lock?.release()
      lock = null
    },
    status: () => `LED ${level} · ${fused} fused · levels ${meanLo.toFixed(0)}/${meanHi.toFixed(0)}${stale ? ` · ${stale} passed through (stale partner)` : ''}${meanHi - meanLo < 5 && n > 20 ? ' · levels look identical (does the LED change the picture?)' : ''}`,
    stats: () => ({ fused, frames: n, stale, ratio: p.ratio, period: p.period, lockedAe: lock?.locked.ae ?? false }),
  }
}
