/** Interleaved-illumination video: the LEDs alternate between two illumination presets (A, B, from
 *  the Illumination panel's presets, e.g. two oblique directions, or brightfield and dark-field), each
 *  held for `hold` frames with AE/AWB locked, and every output frame combines the newest settled
 *  frame of each state:
 *
 *  - `dpc`: pseudo differential phase contrast `0.5 + gain·(A − B)/(A + B + ε)` on the luma (Tian &
 *    Waller 2015, qualitative: the quantitative inversion needs the LED geometry's transfer function),
 *    after normalising each channel by its running mean so LED brightness mismatch is not a DC offset.
 *  - `rheinberg`: `tintA·A + tintB·B` — the coloured-stop technique done numerically.
 *  - `split`: A left, B right, for teaching.
 *
 *  Frame attribution: the camera pipeline shows a light change 2–3 frames late, so a frame is
 *  attributed to the state commanded `latency` frames earlier and, with `hold` ≥ 3, only the last
 *  frame of each hold is used (the first ones may straddle the switch). Timestamped light events from
 *  the device would make this exact (`docs/video-research/creative.md` §0); until then the luma of
 *  the two states is checked and the mode reports "channels look identical" when a preset changes
 *  nothing in the picture. `hdrVideo.ts` is the bright/dim special case of this scheme. */

import { device } from '../../store/device.svelte'
import { settings } from '../../store/settings.svelte'
import { lockCamera, type CameraLock } from '../cameraLock'
import type { RgbaFrame } from '../frameChain'
import type { VideoModeRun, ModeOutput } from './types'
import { OutBuffer } from './common'

export interface IllumParams { presetA: string; presetB: string; hold: number; output: 'dpc' | 'rheinberg' | 'split'; gain: number; tintA: string; tintB: string }

const LATENCY = 2

function hex(c: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c)
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [1, 1, 1]
}

export function illumMode(p: IllumParams): VideoModeRun {
  let lock: CameraLock | null = null
  let saved: { cc: number; pwm: number[] } | null = null
  let state: 'A' | 'B' = 'A'
  let switching: Promise<void> | null = null
  const log: ('A' | 'B')[] = []
  let holdCount = 0
  let A: Uint8ClampedArray | null = null, B: Uint8ClampedArray | null = null
  let meanA = 0, meanB = 0
  let n = 0, fused = 0
  const out = new OutBuffer()
  const tA = hex(p.tintA), tB = hex(p.tintB)

  const apply = (name: string) => {
    const pr = settings.lightPresets[name]
    if (!pr) return Promise.reject(new Error(`unknown illumination preset "${name}"`))
    return device.setLight(pr.cc, pr.pwm)
  }
  const setState = (s: 'A' | 'B') => { state = s; switching = apply(s === 'A' ? p.presetA : p.presetB).catch(() => {}).then(() => { switching = null }) }

  return {
    id: 'illum',
    drivesStage: true,
    async start() {
      if (!settings.lightPresets[p.presetA] || !settings.lightPresets[p.presetB]) throw new Error('choose two illumination presets (Illumination panel → presets)')
      saved = { cc: device.light.cc, pwm: [...device.light.pwm] }
      lock = await lockCamera({ ae: true, awb: true })
      setState('A'); holdCount = 0
    },
    process(f: RgbaFrame): ModeOutput | null {
      n++
      log.push(state); if (log.length > LATENCY + 1) log.shift()
      const attributed = log[0]
      holdCount++
      const lastOfHold = holdCount >= Math.max(1, p.hold)
      if (lastOfHold && !switching) { setState(state === 'A' ? 'B' : 'A'); holdCount = 0 }
      // use only the last frame of a hold (the first ones may straddle the switch)
      if (p.hold >= 3 && !lastOfHold) return A && B ? null : null
      let s = 0, k = 0
      for (let i = 0; i < f.data.length; i += 64) { s += f.data[i] * 0.299 + f.data[i + 1] * 0.587 + f.data[i + 2] * 0.114; k++ }
      const mean = s / k
      if (attributed === 'A') { A = A?.length === f.data.length ? A : new Uint8ClampedArray(f.data.length); A.set(f.data); meanA = meanA ? 0.8 * meanA + 0.2 * mean : mean }
      else { B = B?.length === f.data.length ? B : new Uint8ClampedArray(f.data.length); B.set(f.data); meanB = meanB ? 0.8 * meanB + 0.2 * mean : mean }
      if (!A || !B) return null
      const o = out.get(f.width, f.height)
      const nA = meanA > 1 ? 128 / meanA : 1, nB = meanB > 1 ? 128 / meanB : 1
      if (p.output === 'dpc') {
        for (let i = 0; i < o.length; i += 4) {
          const la = (A[i] * 0.299 + A[i + 1] * 0.587 + A[i + 2] * 0.114) * nA, lb = (B[i] * 0.299 + B[i + 1] * 0.587 + B[i + 2] * 0.114) * nB
          const v = 128 + p.gain * 128 * ((la - lb) / (la + lb + 4))
          o[i] = v; o[i + 1] = v; o[i + 2] = v; o[i + 3] = 255
        }
      } else if (p.output === 'rheinberg') {
        for (let i = 0; i < o.length; i += 4) {
          o[i] = A[i] * tA[0] + B[i] * tB[0]; o[i + 1] = A[i + 1] * tA[1] + B[i + 1] * tB[1]; o[i + 2] = A[i + 2] * tA[2] + B[i + 2] * tB[2]; o[i + 3] = 255
        }
      } else {
        const half = f.width >> 1
        for (let y = 0; y < f.height; y++) {
          const row = y * f.width * 4
          o.set(A.subarray(row, row + half * 4), row)
          o.set(B.subarray(row + half * 4, row + f.width * 4), row + half * 4)
        }
      }
      fused++
      return { frame: { data: o, width: f.width, height: f.height } }
    },
    async stop() {
      await switching
      if (saved) { try { await device.setLight(saved.cc, saved.pwm) } catch { /* reported by the device store */ } }
      await lock?.release(); lock = null
    },
    status: () => `LED ${state} · ${fused} fused · levels A ${meanA.toFixed(0)} / B ${meanB.toFixed(0)}${meanA && meanB && Math.abs(meanA - meanB) < 2 && p.output !== 'split' ? ' · channels look identical (check the presets)' : ''}`,
    stats: () => ({ frames: n, fused, presetA: p.presetA, presetB: p.presetB, hold: p.hold, output: p.output, meanA: Math.round(meanA), meanB: Math.round(meanB), lockedAe: lock?.locked.ae ?? false }),
  }
}
