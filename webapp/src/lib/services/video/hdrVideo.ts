/** HDR video by LED alternation: with the camera's AE/AWB locked (`services/cameraLock.ts`), the
 *  illumination is switched between a bright and a dim level every `period` frames, each incoming
 *  frame is attributed to the level it was exposed under, and every output frame fuses the newest
 *  bright frame with the newest dim one. Highlights come from the dim frame, shadows from the bright
 *  one. The output frame rate is the input rate; frames of the same class in a row simply re-fuse
 *  against the last frame of the other class. LED level and the AE lock are restored on stop.
 *
 *  Attribution (`docs/video-research/creative.md` §0, `LightAttributor` in `illumModes.ts`): by
 *  timestamp when the stream carries one — the frame belongs to the level that held over its whole
 *  exposure window, a frame exposed across a switch is dropped — else by the level commanded
 *  `latency` frames earlier, validated against the running bright/dim luma means once they have
 *  separated.
 *
 *  Settling check (creative.md addendum): the first frames of the run measure how the picture
 *  follows the LED. A baseline luma is taken at the bright level, the LED is switched to dim once,
 *  and the following frames are watched: the first one whose mean luma moves by more than 5 %
 *  gives the pipeline latency in frames (used by the fallback queue) and, from its timestamp, the
 *  correction between the browser-estimated switch time and when the picture really changed
 *  (`LightAttributor.lagNs`, which also absorbs the clock map's latency bias). If nothing moves
 *  within 8 frames the run continues but `status()` carries a warning: the LED does not change the
 *  picture at this exposure (LED already at its floor, an exposure so short the change is below
 *  noise, or AE not actually locked). Settling frames are passed through unfused.
 *
 *  Fusion is done in **linear light**: both frames are sRGB-decoded through a LUT, the dim frame is
 *  scaled by the measured bright/dim gain (the LED's real ratio, estimated from unclipped coarse
 *  cells, seeded with the commanded `ratio`) so both are radiance estimates on the bright frame's
 *  scale, and they are mixed by a well-exposedness weight (Mertens' Gaussian around mid-grey, on
 *  the display-referred luma, computed on an 8-px coarse grid and bilinearly upsampled; a clipped
 *  bright cell gets weight 0). The mixed radiance is then multiplied by the same weight's *local
 *  exposure* (1 for the bright frame's scale, 1/gain for the dim frame's) and re-encoded — where a
 *  region is taken wholly from one frame the output is exactly that frame, in between it is a
 *  physically meaningful exposure blend instead of a gamma-domain average that darkens midtones.
 *  Allocation-free per frame after the first (LUTs, coarse weight grid and output buffer are reused).
 *
 *  Limits: the LED must actually change the exposure — with AE running the camera would compensate,
 *  which is why the lock is mandatory; a moving organism appears doubled where the two frames
 *  disagree (period 1 keeps that to one frame interval; a partner older than `period + 3` frames is
 *  not fused, the frame passes through). */

import { device } from '../../store/device.svelte'
import { lockCamera, type CameraLock } from '../cameraLock'
import type { RgbaFrame } from '../frameChain'
import type { VideoModeRun, ModeOutput, ModeFrameInfo } from './types'
import { OutBuffer } from './common'
import { LightAttributor, frameExposureNs, meanLuma } from './illumModes'

export interface HdrVideoParams { ratio: number /* bright/dim LED ratio */; period: number /* frames per level */ }

const COARSE = 8
const SETTLE_BASELINE_FRAMES = 3
const SETTLE_MAX_FRAMES = 8
const SETTLE_MIN_CHANGE = 0.05
const ENC_N = 4096

let DEC: Float32Array | null = null
let ENC: Uint8Array | null = null
function luts(): { dec: Float32Array; enc: Uint8Array } {
  if (!DEC || !ENC) {
    DEC = new Float32Array(256)
    for (let i = 0; i < 256; i++) { const x = i / 255; DEC[i] = x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4) }
    ENC = new Uint8Array(ENC_N + 1)
    for (let i = 0; i <= ENC_N; i++) { const v = i / ENC_N; ENC[i] = Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)) }
  }
  return { dec: DEC, enc: ENC }
}

type Level = 'bright' | 'dim'

export function hdrVideoMode(p: HdrVideoParams): VideoModeRun {
  let lock: CameraLock | null = null
  let cc0 = 0
  let n = 0
  let attrib: LightAttributor<Level> | null = null
  let bright: Uint8ClampedArray | null = null, dim: Uint8ClampedArray | null = null
  let brightN = -1, dimN = -1   // frame index of each partner, to cap staleness
  let stale = 0, dropped = 0, mismatched = 0
  let meanHi = -1, meanLo = -1
  let gain = Math.max(1.01, p.ratio)   // measured bright/dim radiance ratio, seeded with the commanded one
  let warning: string | null = null
  // settling check
  let phase: 'baseline' | 'watch' | 'run' = 'baseline'
  let baseSum = 0, baseN = 0, base = 0
  let settleCmdN = 0, settleLatency = -1
  const out = new OutBuffer()
  let wgt: Float32Array | null = null
  let fused = 0

  const levelCc = (l: Level) => (l === 'bright' ? cc0 : cc0 / p.ratio)

  /** Coarse well-exposedness weight (share of the bright frame) and the measured gain. */
  function weights(b: Uint8ClampedArray, d: Uint8ClampedArray, w: number, h: number, dec: Float32Array): void {
    const cw = Math.ceil(w / COARSE), ch = Math.ceil(h / COARSE)
    if (!wgt || wgt.length !== cw * ch) wgt = new Float32Array(cw * ch)
    let linB = 0, linD = 0
    for (let cy = 0; cy < ch; cy++) for (let cx = 0; cx < cw; cx++) {
      let lb = 0, ld = 0, k = 0, lbLin = 0, ldLin = 0
      const y1 = Math.min(h, (cy + 1) * COARSE), x1 = Math.min(w, (cx + 1) * COARSE)
      for (let y = cy * COARSE; y < y1; y += 2) for (let x = cx * COARSE; x < x1; x += 2) {
        const i = (y * w + x) * 4
        lb += b[i] * 0.299 + b[i + 1] * 0.587 + b[i + 2] * 0.114
        ld += d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114
        lbLin += dec[b[i]] * 0.299 + dec[b[i + 1]] * 0.587 + dec[b[i + 2]] * 0.114
        ldLin += dec[d[i]] * 0.299 + dec[d[i + 1]] * 0.587 + dec[d[i + 2]] * 0.114
        k++
      }
      const clippedB = lb / k >= 250   // the bright frame has nothing to offer where it clipped
      if (!clippedB && ld / k > 8) { linB += lbLin; linD += ldLin }   // both frames informative: usable for the gain
      lb = lb / k / 255 - 0.5; ld = ld / k / 255 - 0.5
      const wb = (clippedB ? 0 : Math.exp(-(lb * lb) / (2 * 0.2 * 0.2))) + 1e-3, wd = Math.exp(-(ld * ld) / (2 * 0.2 * 0.2)) + 1e-3
      wgt[cy * cw + cx] = wb / (wb + wd)
    }
    if (linD > 0 && linB > 0) {
      const g = linB / linD
      if (g > 1.01 && g < 64) gain = 0.9 * gain + 0.1 * g
    }
  }

  function fuse(b: Uint8ClampedArray, d: Uint8ClampedArray, w: number, h: number, o: Uint8ClampedArray): void {
    const { dec, enc } = luts()
    weights(b, d, w, h, dec)
    const cw = Math.ceil(w / COARSE), ch = Math.ceil(h / COARSE), g = gain, invG = 1 / gain
    const W = wgt!
    for (let y = 0; y < h; y++) {
      const fy = Math.min(ch - 1, Math.max(0, (y + 0.5) / COARSE - 0.5)), y0 = fy | 0, y1 = Math.min(ch - 1, y0 + 1), ty = fy - y0
      for (let x = 0; x < w; x++) {
        const fx = Math.min(cw - 1, Math.max(0, (x + 0.5) / COARSE - 0.5)), x0 = fx | 0, x1 = Math.min(cw - 1, x0 + 1), tx = fx - x0
        const wb = (W[y0 * cw + x0] * (1 - tx) + W[y0 * cw + x1] * tx) * (1 - ty) + (W[y1 * cw + x0] * (1 - tx) + W[y1 * cw + x1] * tx) * ty
        const wd = 1 - wb
        // radiance on the bright frame's scale, then the local exposure that maps it back to display
        const e = wb + wd * invG
        const i = (y * w + x) * 4
        for (let c = 0; c < 3; c++) {
          const r = (wb * dec[b[i + c]] + wd * g * dec[d[i + c]]) * e
          o[i + c] = enc[r >= 1 ? ENC_N : r <= 0 ? 0 : (r * ENC_N) | 0]
        }
        o[i + 3] = 255
      }
    }
  }

  /** The settling check's per-frame step; returns true while the frame should pass through. */
  function settle(mean: number, info: ModeFrameInfo): boolean {
    if (!attrib) return true
    if (phase === 'baseline') {
      baseSum += mean; baseN++
      if (baseN >= SETTLE_BASELINE_FRAMES && !attrib.switching) {
        base = baseSum / baseN
        settleCmdN = n
        void attrib.command('dim')
        phase = 'watch'
      }
      return true
    }
    if (phase === 'watch') {
      const since = n - settleCmdN
      const change = base > 0 ? (base - mean) / base : 0
      if (change > SETTLE_MIN_CHANGE) {
        settleLatency = since
        attrib.latency = Math.max(1, Math.min(6, since))
        if (info.t != null && Number.isFinite(attrib.lastSwitchNs)) {
          // the switch fell inside this frame's window at the point where the exposed-dim fraction
          // matches the observed change (a full change → at the window start)
          const expected = 1 - 1 / p.ratio
          const frac = Math.min(1, Math.max(0, change / Math.max(1e-3, expected)))
          const win = frameExposureNs(info.seq) + 33e6
          const switchAt = info.t + (1 - frac) * win
          attrib.lagNs += switchAt - attrib.lastSwitchNs
        }
        phase = 'run'
        warning = null
        return true
      }
      if (since >= SETTLE_MAX_FRAMES) {
        warning = 'the LED does not change the picture at this exposure (AE not locked, LED at its floor, or the change is below noise)'
        phase = 'run'
        return true
      }
      return true
    }
    return false
  }

  return {
    id: 'hdr',
    drivesStage: true,   // the LEDs, not the stage: but the same "expected change, don't reset" semantics
    async start() {
      cc0 = device.light.cc
      if (!(cc0 > 0)) throw new Error('HDR video needs the main LED on')
      lock = await lockCamera({ ae: true, awb: true })
      attrib = new LightAttributor<Level>('bright', (l) => device.setLight(levelCc(l)))
      await attrib.command('bright')
      phase = 'baseline'; baseSum = 0; baseN = 0
    },
    process(f: RgbaFrame, info: ModeFrameInfo): ModeOutput | null {
      if (!attrib) return { frame: f }
      n++
      attrib.observe(info)
      const mean = meanLuma(f.data)
      if (phase !== 'run') { settle(mean, info); return { frame: f } }
      if (n % Math.max(1, p.period) === 0 && !attrib.switching) void attrib.command(attrib.state === 'bright' ? 'dim' : 'bright')
      let level = attrib.attribute(info)
      if (level === null) { dropped++; return null }
      if (meanHi < 0) { meanHi = mean; meanLo = mean }
      const separated = meanHi - meanLo > 0.05 * Math.max(1, meanHi)
      if (separated) {
        const byLuma: Level = mean >= (meanHi + meanLo) / 2 ? 'bright' : 'dim'
        if (byLuma !== level) {
          // fallback path: luma is the validator and wins; timestamped path: count the disagreement
          if (!attrib.timestamped) level = byLuma
          else mismatched++
        }
      }
      if (level === 'bright') { meanHi = 0.8 * meanHi + 0.2 * mean; bright = bright?.length === f.data.length ? bright : new Uint8ClampedArray(f.data.length); bright.set(f.data); brightN = n }
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
    reset() { bright = null; dim = null; brightN = dimN = -1; attrib?.reset() },
    async stop() {
      await attrib?.done
      try { await device.setLight(cc0) } catch { /* reported by the device store */ }
      await lock?.release()
      lock = null
    },
    status: () => {
      if (phase !== 'run') return `settling check · ${phase === 'baseline' ? 'baseline' : `waiting for the LED (${n - settleCmdN} frames)`}`
      return `LED ${attrib?.state ?? '—'} · ${fused} fused · ${attrib?.timestamped ? 'timestamped' : 'commanded'} attribution${settleLatency > 0 ? ` · settles in ${settleLatency} frame${settleLatency === 1 ? '' : 's'}` : ''} · gain ${gain.toFixed(2)}× · levels ${meanLo.toFixed(0)}/${meanHi.toFixed(0)}${dropped ? ` · ${dropped} straddled a switch` : ''}${stale ? ` · ${stale} passed through (stale partner)` : ''}${mismatched ? ` · ${mismatched} luma mismatches` : ''}${warning ? ` · warning: ${warning}` : meanHi - meanLo < 5 && n > 20 ? ' · levels look identical (does the LED change the picture?)' : ''}`
    },
    stats: () => ({ fused, frames: n, stale, dropped, mismatched, ratio: p.ratio, gainMeasured: Math.round(gain * 100) / 100, period: p.period, settleLatencyFrames: settleLatency, attribution: attrib?.timestamped ? 'timestamp' : 'commanded', lagMs: attrib ? Math.round(attrib.lagNs / 1e6) : 0, warning: warning ?? undefined, lockedAe: lock?.locked.ae ?? false }),
  }
}
