/** Divides the live view (and recordings baked from it) by the illumination map in linear light, so
 *  the vignetting and colour shading (yellow centre, magenta rim) disappear everywhere, not only in
 *  mosaics. Order 30: before deflicker (50), so the brightness normaliser sees the flat picture.
 *
 *  `enabled()` reads two cheap reactive flags only (`settings.shadingLive`, `illumination.has`); the
 *  map itself is fetched and expanded to a per-pixel, per-channel multiplier the first time a frame of
 *  a given size arrives after the calibration changed (`illuminationStamp.version`). */
import { frameChain, toImageData, type FrameProcessor, type FrameTarget } from './frameChain'
import { applyMultiplierRgba, buildShadingMultiplier } from '../algo/flatField'
import { illuminationMap, illumination, illuminationStamp } from '../store/calibration.svelte'
import { settings } from '../store/settings.svelte'

let mult: Float32Array | null = null
let multW = 0, multH = 0, multVersion = -1

export const shadingProcessor: FrameProcessor = {
  id: 'shading',
  order: 30,
  enabled: (target: FrameTarget) => (target === 'view' || target === 'record') && settings.shadingLive && illumination.has,
  process: (frame, _target, _t) => {
    const rgba = toImageData(frame)
    if (!mult || multW !== rgba.width || multH !== rgba.height || multVersion !== illuminationStamp.version) {
      const map = illuminationMap()
      mult = map ? buildShadingMultiplier(rgba.width, rgba.height, map) : null
      multW = rgba.width; multH = rgba.height; multVersion = illuminationStamp.version
    }
    if (mult) applyMultiplierRgba(rgba.data, mult)
    return rgba
  },
}

frameChain.register(shadingProcessor)
