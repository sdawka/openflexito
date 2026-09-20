/** Registers the LUT/"look" frame-chain processor (`services/frameChain.ts`, order 900 - last: colour,
 *  per the frame-chain doc comment) at module init, so importing this file anywhere (StreamView,
 *  TimelapseViewer) is enough to make it available; it self-registers exactly once regardless of how
 *  many components import it (`frameChain.register` is idempotent per `id`).
 *
 *  `enabled()` reads only `look.enabled` and `settings.lookBakeIntoRecording` - both plain, rarely-changing
 *  booleans - rather than `look.current` (which is a memoised `$derived` that gets a new object on every
 *  slider tweak). That matters: `frameChain.active(target)` is called from reactive effects (StreamView's
 *  stream-processing loop, TimelapseViewer's per-frame draw) that must NOT retrigger on every strength/
 *  hue/levels change - only on the coarse on/off toggle. `process()` itself always reads the live
 *  `look.current`, so per-frame output still reflects the latest adjustments even though `enabled()`
 *  doesn't depend on them.
 *
 *  GPU path: `gfx/lutGl.ts#LutRenderer` when the frame is a `CanvasImageSource` (not already decoded to
 *  an RGBA buffer) and WebGL2 is available; CPU `algo/lut.ts#applyLookRgba` on `toImageData(frame)`
 *  otherwise, or whenever the GPU path reports itself lost/unsupported for that draw. */

import { frameChain, isRgbaFrame, toImageData, type FrameInput, type FrameTarget, type RgbaFrame } from './frameChain'
import { look } from '../store/look.svelte'
import { settings } from '../store/settings.svelte'
import { applyLookRgba } from '../algo/lut'
import { LutRenderer } from '../gfx/lutGl'

let renderer: LutRenderer | null | undefined // undefined = not yet probed, null = unsupported
function getRenderer(): LutRenderer | null {
  if (renderer === undefined) renderer = LutRenderer.isSupported() ? new LutRenderer() : null
  return renderer
}

// one CPU scratch buffer per target: the live view and a recording can run their chains
// interleaved, and a shared buffer would let one overwrite the other's pixels
const scratch: Partial<Record<FrameTarget, RgbaFrame>> = {}
function scratchFor(target: FrameTarget, w: number, h: number): RgbaFrame {
  let s = scratch[target]
  if (!s || s.width !== w || s.height !== h) s = scratch[target] = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }
  return s
}

frameChain.register({
  id: 'look',
  order: 900,
  enabled(target: FrameTarget): boolean {
    if (!look.enabled) return false
    if (target === 'record') return settings.lookBakeIntoRecording
    return true
  },
  process(frame: FrameInput, target: FrameTarget): FrameInput {
    const l = look.current
    if (!l || !l.cube) return frame
    if (!isRgbaFrame(frame)) {
      const gl = getRenderer()
      if (gl) {
        gl.uploadLut(l.cube)
        const out = gl.draw(frame as CanvasImageSource, { strength: l.strength })
        if (out) return out
      }
    }
    const rgba = toImageData(frame)
    const dst = scratchFor(target, rgba.width, rgba.height)
    applyLookRgba(rgba.data, dst.data, l)
    return dst
  },
})
