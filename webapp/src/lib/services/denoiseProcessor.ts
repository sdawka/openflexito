/** Live temporal denoise frame-chain processor (`docs/image-pipeline/design.md` WP4, `frameChain.ts`
 *  order 100 - runs before stabilise/enhance/LUT). Wraps `algo/temporalDenoise.ts#TemporalDenoiser`
 *  with the stage displacement since the previous processed frame, converted from steps to pixels via
 *  the CSM calibration (`store/calibration.svelte.ts`, `algo/csm.ts`) when one exists; without a
 *  calibration the shift is always reported as 0 and the denoiser falls back to its own motion/ghost
 *  gate (`CONFIDENCE_K`) to avoid smearing real motion.
 *
 *  `calibration.csm.matrix` maps *image px -> stage steps* (`CsmCalibration`'s own doc comment); the
 *  denoiser wants the inverse (stage steps -> image px, i.e. how far the scene appears to move for a
 *  given commanded stage delta), so this inverts it with `algo/csm.ts#invert2`. Sign/orientation is
 *  taken directly from that inversion with no extra flip - **unverified against real hardware** (no
 *  device available while writing this); if a live pan/scan shows the temporal filter trailing motion
 *  instead of compensating for it, negate both `dx`/`dy` in `stageShiftPx` below.
 *
 *  Resets whenever `device.moving` flips (a real stage move must never be blended into the recursive
 *  history - matches the live-stack/stabiliser precedent) and whenever the frame chain itself resets
 *  (stream reconnect, new recording). Allocation-free per frame after the first: `TemporalDenoiser`
 *  reuses its own buffers, and this module keeps only a couple of numbers as state. */

import { frameChain, toImageData, type FrameProcessor, type FrameTarget, type FrameInput } from './frameChain'
import { TemporalDenoiser } from '../algo/temporalDenoise'
import { settings } from '../store/settings.svelte'
import { device } from '../store/device.svelte'
import { calibration } from '../store/calibration.svelte'
import { invert2, apply2, type Vec2 } from '../algo/csm'

const MAX_SHIFT_PX = 60 // beyond this the denoiser itself treats the frame as unrelated (scene cut / bad shift)

let denoiser = new TemporalDenoiser({ alpha: settings.liveDenoiseAlpha, maxShiftPx: MAX_SHIFT_PX })
let curAlpha = settings.liveDenoiseAlpha
let lastPos: { x: number; y: number; z: number } | null = null
let wasMoving = false

function ensureDenoiser(): TemporalDenoiser {
  if (settings.liveDenoiseAlpha !== curAlpha) {
    curAlpha = settings.liveDenoiseAlpha
    denoiser = new TemporalDenoiser({ alpha: curAlpha, maxShiftPx: MAX_SHIFT_PX })
  }
  return denoiser
}

/** Pixel shift of the scene since the last processed frame, from the stage position delta and the
 *  CSM calibration; `{ dx: 0, dy: 0 }` when there is no calibration, no prior position, or the
 *  calibration matrix turns out singular. */
function stageShiftPx(): { dx: number; dy: number } {
  const cur = device.position
  const csm = calibration.csm
  const prev = lastPos
  lastPos = { ...cur }
  if (!prev || !csm) return { dx: 0, dy: 0 }
  const dSteps: Vec2 = [cur.x - prev.x, cur.y - prev.y]
  if (dSteps[0] === 0 && dSteps[1] === 0) return { dx: 0, dy: 0 }
  try {
    const stageToImage = invert2(csm.matrix) // matrix: image px -> stage steps; invert for the other direction
    const [dx, dy] = apply2(stageToImage, dSteps)
    return { dx, dy }
  } catch {
    return { dx: 0, dy: 0 } // singular calibration matrix
  }
}

export const denoiseProcessor: FrameProcessor = {
  id: 'denoise',
  order: 100,
  enabled(target: FrameTarget): boolean {
    if (target === 'view') return settings.liveDenoise
    if (target === 'record') return settings.liveDenoise && settings.liveDenoiseRecord
    return false
  },
  process(frame: FrameInput): FrameInput {
    if (device.moving) {
      if (!wasMoving) { ensureDenoiser().reset(); wasMoving = true }
      lastPos = { ...device.position }
      return frame
    }
    if (wasMoving) { ensureDenoiser().reset(); wasMoving = false; lastPos = { ...device.position } }
    const rgba = toImageData(frame)
    const shift = stageShiftPx()
    const out = ensureDenoiser().push(rgba.data, rgba.width, rgba.height, shift)
    return { data: out, width: rgba.width, height: rgba.height }
  },
  reset(): void {
    denoiser.reset()
    lastPos = null
    wasMoving = false
  },
}

frameChain.register(denoiseProcessor)
