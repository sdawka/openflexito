/** Wires `algo/deflicker.ts` into the frame chain (order 50, before stabilise/enhance/LUT) for two
 *  independent consumers: the recorder (`recordEnabled`, set for the duration of a recording by
 *  `recorder.svelte.ts`) and the live view (`settings.deflickerLive`, default off — most users never
 *  see a flicker worth the extra per-frame work). Reset whenever `device.moving` changes, so a real
 *  stage move never gets read as a brightness step. */
import { frameChain, toImageData, type FrameProcessor, type FrameTarget } from './frameChain'
import { Deflicker, defaultDeflickerOptions, frameLuma, backgroundLuma, gainLut, applyLutRgba } from '../algo/deflicker'
import { settings } from '../store/settings.svelte'
import { device } from '../store/device.svelte'

class DeflickerProcessor {
  /** Set by the recorder for the lifetime of a recording; not a Svelte rune (read only by the frame
   *  chain, on the same thread, once per frame). */
  recordEnabled = false

  private deflicker = new Deflicker(defaultDeflickerOptions)
  private wasMoving = false
  private lastLightCc = -1
  private lut = new Uint8ClampedArray(256)
  private lutGain = NaN
  lastGain = 1

  private proc: FrameProcessor = {
    id: 'deflicker',
    order: 50,
    enabled: (target: FrameTarget) => (target === 'record' ? this.recordEnabled : target === 'view' ? settings.deflickerLive : false),
    process: (frame, _target, _t) => {
      const rgba = toImageData(frame)
      const moving = device.moving
      if (moving !== this.wasMoving) { this.deflicker.reset(); this.wasMoving = moving }
      // a deliberate LED change is not flicker: re-anchor instead of fighting it for ~20 frames
      const cc = device.light.cc
      if (cc !== this.lastLightCc) { if (this.lastLightCc >= 0) this.deflicker.reset(); this.lastLightCc = cc }
      const luma = defaultDeflickerOptions.background ? backgroundLuma(rgba.data) : frameLuma(rgba.data, defaultDeflickerOptions.usePercentile)
      const gain = this.deflicker.nextGain(luma)
      this.lastGain = gain
      if (gain !== 1) {
        if (gain !== this.lutGain) { gainLut(gain, this.lut); this.lutGain = gain }
        applyLutRgba(rgba.data, this.lut)
      }
      return rgba
    },
    reset: () => { this.deflicker.reset() },
  }

  register(): void { frameChain.register(this.proc) }
}

export const deflickerProcessor = new DeflickerProcessor()
deflickerProcessor.register()
