/** Tone/structure video modes over `algo/videoTone.ts`: a video Enhance that does not pump
 *  (temporally stable auto-levels + clarity) and pseudo-DIC relief shading. */

import type { RgbaFrame } from '../frameChain'
import type { VideoModeRun, ModeOutput } from './types'
import { StableLevels, AnchoredWhiteBalance, BackgroundFlattener, applyLut3, localContrast, relief, highPassView } from '../../algo/videoTone'
import { device } from '../../store/device.svelte'
import { OutBuffer } from './common'

export interface EnhanceVideoParams {
  levels: boolean; lowPct: number; highPct: number
  /** soft highlight roll-off (0 = hard clip) */
  knee: boolean
  /** reference-anchored software white balance (lock the camera's AWB first) */
  wb: boolean
  /** rolling background flattening */
  flatten: boolean
  clarity: number; scale: number
}
export function enhanceVideoMode(p: EnhanceVideoParams): VideoModeRun {
  const lv = new StableLevels(p.lowPct, p.highPct, 0.03, 2, 40, 0.3, p.knee ? 0.85 : 0)
  const wb = new AnchoredWhiteBalance()
  const flat = new BackgroundFlattener()
  const lut = new Uint8ClampedArray(256)
  const luts: [Uint8ClampedArray, Uint8ClampedArray, Uint8ClampedArray] = [new Uint8ClampedArray(256), new Uint8ClampedArray(256), new Uint8ClampedArray(256)]
  const identity = new Uint8ClampedArray(256).map((_, i) => i)
  const a = new OutBuffer(), b = new OutBuffer(), c = new OutBuffer()
  let n = 0
  return {
    id: 'enhance',
    process(f: RgbaFrame): ModeOutput {
      n++
      const frozen = device.moving
      let src = f.data
      if (p.flatten) { const o = c.get(f.width, f.height); flat.update(src, f.width, f.height, o, frozen); src = o }
      if (p.levels || p.wb) {
        const base = p.levels ? lv.update(src, lut, 4, frozen) : identity
        if (p.wb) { wb.update(src, 4, frozen); wb.luts(base, luts) } else { luts[0].set(base); luts[1].set(base); luts[2].set(base) }
        const o = a.get(f.width, f.height); applyLut3(src, luts, o); src = o
      }
      if (p.clarity > 0) { const o = b.get(f.width, f.height); localContrast(src, f.width, f.height, p.scale, p.clarity, o); src = o }
      return { frame: { data: src, width: f.width, height: f.height } }
    },
    reset() { lv.reset(); wb.reset(); flat.reset() },
    status: () => `${n} frames${p.levels ? ` · levels ${Math.round(lv.black)}–${Math.round(lv.white)}` : ''}${p.wb ? (wb.active ? ` · WB ${wb.gains.map((g) => g.toFixed(2)).join('/')}` : ' · WB idle (no bright background)') : ''}${p.clarity ? ` · clarity ${p.clarity}` : ''}`,
    stats: () => ({ frames: n, levels: p.levels, black: Math.round(lv.black), white: Math.round(lv.white), knee: p.knee, wb: p.wb ? wb.gains.map((g) => +g.toFixed(3)) : false, flatten: p.flatten, clarity: p.clarity, scale: p.scale }),
  }
}

export interface ReliefParams { style: 'relief' | 'darkfield' | 'phase'; angle: number; strength: number; mix: number; scale: number }
export function reliefMode(p: ReliefParams): VideoModeRun {
  const out = new OutBuffer()
  let n = 0
  return {
    id: 'relief',
    process(f: RgbaFrame): ModeOutput {
      n++
      const o = out.get(f.width, f.height)
      if (p.style === 'relief') relief(f.data, f.width, f.height, p.angle, p.strength, p.mix, o)
      else highPassView(f.data, f.width, f.height, p.scale, p.strength, p.style, o)
      return { frame: { data: o, width: f.width, height: f.height } }
    },
    status: () => `${n} frames · ${p.style}${p.style === 'relief' ? ` · light from ${p.angle}°` : ` · scale ${p.scale} px`}`,
    stats: () => ({ frames: n, style: p.style, angle: p.angle, strength: p.strength, mix: p.mix, scale: p.scale }),
  }
}
