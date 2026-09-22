/** Focus peaking + zebra viewfinder overlays as a frame-chain processor (`frameChain.ts`, order 950:
 *  after the look at 900 so the overlay colour is never re-mapped by a LUT). `view` target only —
 *  these are monitor aids and must never land in a recording or playback (`colour.md` proposal 7).
 *
 *  `enabled()` reads only `settings.peaking || settings.zebra` (cheap booleans), per the frame-chain
 *  rule; the colour and the stage state are read inside `process()`. The peaking threshold is frozen
 *  while `device.moving` (a move changes content, not focus) and reset on chain reset. Registered by
 *  importing this module from `CameraControls.svelte`, where the toggles live. */

import { frameChain, toImageData, type FrameInput, type FrameProcessor, type FrameTarget, type RgbaFrame } from './frameChain'
import { settings } from '../store/settings.svelte'
import { device } from '../store/device.svelte'
import { FocusPeaker, paintZebra, parseColour } from '../algo/peaking'

const peaker = new FocusPeaker({ tauS: 0.5, minP90: 3 })
let scratch: RgbaFrame | null = null

function copyInto(src: RgbaFrame): RgbaFrame {
  if (!scratch || scratch.width !== src.width || scratch.height !== src.height) {
    scratch = { data: new Uint8ClampedArray(src.width * src.height * 4), width: src.width, height: src.height }
  }
  scratch.data.set(src.data)
  return scratch
}

export const peakingProcessor: FrameProcessor = {
  id: 'peaking',
  order: 950,
  enabled(target: FrameTarget): boolean {
    return target === 'view' && (settings.peaking || settings.zebra)
  },
  process(frame: FrameInput, _target: FrameTarget, t: number): FrameInput {
    const rgba = toImageData(frame)
    // paint on our own copy: an earlier processor may hand us its reusable scratch buffer, and
    // toImageData of a canvas source is fresh anyway
    const out = copyInto(rgba)
    if (settings.peaking) {
      peaker.process(out.data, out.width, out.height, t / 1e9, parseColour(settings.peakingColour), device.moving)
    }
    if (settings.zebra) paintZebra(out.data, out.width, out.height)
    return out
  },
  reset(): void { peaker.reset() },
}

frameChain.register(peakingProcessor)
