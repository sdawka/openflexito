/** Catalogue and dispatcher of the video modes, the counterpart of `services/photoService.ts` for
 *  recordings. `VIDEO_MODES` is what the Photo panel lists (label, blurb, cost, whether the stage is
 *  driven); `createVideoMode` builds the `VideoModeRun` the recorder drives. Mode implementations
 *  live one family per file (`stackModes`, `motionModes`, `stageModes`, `hdrVideo`, `timeModes`). */

import type { VideoModeRun } from './types'
import { denoiseMode, integrateMode, medianMode, binMode, luckyMode } from './stackModes'
import { motionMode, trailsMode, timecodeMode, magnifyMode } from './motionModes'
import { edofMode, sweepMode, superresVideoMode } from './stageModes'
import { hdrVideoMode } from './hdrVideo'
import { timelapseMode } from './timeModes'

export type VideoModeId =
  | 'plain' | 'denoise' | 'integrate' | 'median' | 'bin' | 'lucky'
  | 'edof' | 'sweep' | 'superres' | 'hdr'
  | 'motion' | 'trails' | 'timecode' | 'magnify'
  | 'timelapse'

export interface VideoModeInfo {
  id: VideoModeId
  label: string
  blurb: string
  /** what it costs the viewer: output rate / size / delay */
  cost: string
  group: 'quality' | 'stage' | 'motion' | 'time'
  drivesStage?: boolean
  needsLed?: boolean
}

export const VIDEO_MODES: VideoModeInfo[] = [
  { id: 'plain', label: 'Live view', group: 'quality', blurb: 'The stream as it is, with the options below.', cost: 'full rate' },
  { id: 'denoise', label: 'Temporal denoise', group: 'quality', blurb: 'Motion-compensated recursive averaging with a ghost gate: noise fades where the scene is steady, moving organisms stay crisp. The stage shift is taken from the calibration when there is one.', cost: 'full rate' },
  { id: 'integrate', label: 'Long exposure', group: 'quality', blurb: 'Mean of the last N frames (a software long exposure): noise falls by √N, dim fluorescence becomes visible, moving things smear as they would in a real long exposure.', cost: 'full rate, N-frame lag' },
  { id: 'median', label: 'Temporal median', group: 'quality', blurb: 'Per-pixel median of 3 or 5 frames: rejects hot pixels, JPEG glitches and single-frame flicker without blurring anything that stays still.', cost: 'full rate' },
  { id: 'bin', label: 'Binned', group: 'quality', blurb: 'Software 2×2/3×3/4×4 binning: the noise averages down, the file shrinks to a fraction, and the encoder stops fighting sensor noise. The edge-aware kernel keeps sharp boundaries a step instead of a smear.', cost: 'full rate, smaller frame' },
  { id: 'lucky', label: 'Lucky imaging', group: 'quality', blurb: 'Keeps only the sharpest fraction of frames (astronomers\' frame selection, live): vibration and focus wobble drop out; the video runs at the reduced rate with the real frame times.', cost: 'reduced rate' },
  { id: 'edof', label: 'Extended depth of field', group: 'stage', drivesStage: true, blurb: 'Dithers z by ±Δz while a block-wise sharpest-over-time stack builds an all-in-focus view of a thick specimen. The stage returns to the starting z when you stop.', cost: 'worker rate, ~1 s lag' },
  { id: 'sweep', label: 'Focus sweep', group: 'stage', drivesStage: true, blurb: 'A slow triangular z sweep over ±range in N stops, recorded as it goes: a walk through the specimen\'s depth. Turn on the position burn-in to read z off the frame.', cost: 'full rate' },
  { id: 'superres', label: 'Super-resolution (2× zoom)', group: 'stage', drivesStage: true, blurb: 'Dithers the stage by half a pixel (through the stage↔camera calibration) and drizzles the last few registered frames of the central half onto a 2× grid: a 2× digital zoom that is actually resolved, at the source frame size. Stabilisation is off (the dither is intentional).', cost: 'a few fps' },
  { id: 'hdr', label: 'HDR (LED alternation)', group: 'stage', needsLed: true, blurb: 'Locks exposure, alternates the LED between a bright and a dim level and fuses each frame with the newest frame of the other level by well-exposedness: highlights from the dim frame, shadows from the bright one. The LED level is restored on stop.', cost: 'full rate' },
  { id: 'motion', label: 'Motion highlight', group: 'motion', blurb: 'A slowly learning background; whatever departs from it is painted orange over a dimmed grey view. Swimming organisms and beating cilia stand out from the static field.', cost: 'full rate' },
  { id: 'trails', label: 'Motion trails', group: 'motion', blurb: 'Motion-history image: every moving pixel lights up and fades over ~N frames, so a moving organism drags a trail showing where it came from.', cost: 'full rate' },
  { id: 'timecode', label: 'Temporal colour code', group: 'motion', blurb: 'ImageJ\'s temporal colour code, live: motion is painted in the hue of its time in a cycling window, so a trajectory becomes a rainbow with time along it.', cost: 'full rate' },
  { id: 'magnify', label: 'Motion magnification', group: 'motion', blurb: 'Eulerian video magnification (Wu et al. 2012): tiny periodic intensity changes in a frequency band are amplified ×α so a heartbeat, flagellum or vibration too small to see becomes obvious.', cost: 'full rate' },
  { id: 'timelapse', label: 'Time compression', group: 'time', blurb: 'Keeps one frame every N seconds and lays them out at the chosen fps: an hour of growth in a minute, recorded live with no frame store.', cost: 'sparse' },
]

export interface VideoModeParams {
  denoise: { alpha: number }
  integrate: { frames: number; kind: 'mean' | 'exp' }
  median: { frames: 3 | 5 }
  bin: { factor: 2 | 3 | 4; kernel: 'mean' | 'edge' }
  lucky: { keep: number }
  edof: { dz: number; dwellMs: number }
  sweep: { range: number; steps: number; dwellMs: number }
  superres: { pixfrac: number; window: number }
  hdr: { ratio: number; period: number }
  motion: { sensitivity: number; learn: number }
  trails: { decay: number; sensitivity: number }
  timecode: { period: number; decay: number; map: string }
  magnify: { factor: number; fLo: number; fHi: number; alpha: number; maxDelta: number; colour: boolean }
  timelapse: { intervalS: number; fps: number }
}

export const DEFAULT_VIDEO_PARAMS: VideoModeParams = {
  denoise: { alpha: 0.7 },
  integrate: { frames: 8, kind: 'mean' },
  median: { frames: 3 },
  bin: { factor: 2, kernel: 'mean' },
  lucky: { keep: 0.4 },
  edof: { dz: 40, dwellMs: 120 },
  sweep: { range: 300, steps: 24, dwellMs: 400 },
  superres: { pixfrac: 0.6, window: 4 },
  hdr: { ratio: 4, period: 1 },
  motion: { sensitivity: 4, learn: 0.03 },
  trails: { decay: 0.92, sensitivity: 4 },
  timecode: { period: 90, decay: 0.985, map: 'spectrum' },
  magnify: { factor: 8, fLo: 0.5, fHi: 4, alpha: 15, maxDelta: 60, colour: false },
  timelapse: { intervalS: 5, fps: 15 },
}

export function videoModeInfo(id: VideoModeId): VideoModeInfo { return VIDEO_MODES.find((m) => m.id === id)! }

/** Build the run for `id` with `params` (the matching entry of `VideoModeParams`); `null` for plain. */
export function createVideoMode(id: VideoModeId, params: VideoModeParams): VideoModeRun | null {
  switch (id) {
    case 'plain': return null
    case 'denoise': return denoiseMode(params.denoise)
    case 'integrate': return integrateMode(params.integrate)
    case 'median': return medianMode(params.median)
    case 'bin': return binMode(params.bin)
    case 'lucky': return luckyMode(params.lucky)
    case 'edof': return edofMode(params.edof)
    case 'sweep': return sweepMode(params.sweep)
    case 'superres': return superresVideoMode(params.superres)
    case 'hdr': return hdrVideoMode(params.hdr)
    case 'motion': return motionMode(params.motion)
    case 'trails': return trailsMode(params.trails)
    case 'timecode': return timecodeMode(params.timecode)
    case 'magnify': return magnifyMode(params.magnify)
    case 'timelapse': return timelapseMode(params.timelapse)
  }
}

/** The parameters of `id` as a flat record for the gallery item. */
export function modeParamsRecord(id: VideoModeId, params: VideoModeParams): Record<string, unknown> | undefined {
  if (id === 'plain') return undefined
  return { ...(params[id] as Record<string, unknown>) }
}
