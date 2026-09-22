/** Catalogue and dispatcher of the video modes, the counterpart of `services/photoService.ts` for
 *  recordings. `VIDEO_MODES` is what the Photo panel lists (label, blurb, cost, whether the stage is
 *  driven); `createVideoMode` builds the `VideoModeRun` the recorder drives. Mode implementations
 *  live one family per file (`stackModes`, `motionModes`, `stageModes`, `hdrVideo`, `timeModes`). */

import type { VideoModeRun } from './types'
import { denoiseMode, integrateMode, medianMode, binMode, luckyMode } from './stackModes'
import { motionMode, trailsMode, timecodeMode, magnifyMode, projectMode, flowMode } from './motionModes'
import { edofMode, sweepMode, superresVideoMode, servoMode } from './stageModes'
import { hdrVideoMode } from './hdrVideo'
import { illumMode } from './illumModes'
import { timelapseMode } from './timeModes'
import { enhanceVideoMode, reliefMode } from './toneModes'
import { kymographMode, triggerMode } from './analysisModes'

export type VideoModeId =
  | 'plain' | 'denoise' | 'integrate' | 'median' | 'bin' | 'lucky'
  | 'edof' | 'sweep' | 'superres' | 'hdr' | 'illum' | 'servo'
  | 'motion' | 'trails' | 'timecode' | 'project' | 'magnify' | 'flow'
  | 'enhance' | 'relief'
  | 'kymograph' | 'trigger' | 'timelapse'

export interface VideoModeInfo {
  id: VideoModeId
  label: string
  blurb: string
  /** what it costs the viewer: output rate / size / delay */
  cost: string
  group: 'quality' | 'stage' | 'motion' | 'tone' | 'analysis' | 'time'
  drivesStage?: boolean
  needsLed?: boolean
}

export const VIDEO_MODES: VideoModeInfo[] = [
  { id: 'plain', label: 'Live view', group: 'quality', blurb: 'The stream as it is, with the options below.', cost: 'full rate' },
  { id: 'denoise', label: 'Temporal denoise', group: 'quality', blurb: 'HDR+-style soft Wiener merge, recursive per pixel: each pixel averages as many frames as the scene lets it (a per-pixel frame count with a measured noise curve), so noise fades where the picture is steady and moving organisms stay crisp with no hard gate. History is warped by the known stage shift, so it survives pans.', cost: 'full rate' },
  { id: 'integrate', label: 'Long exposure', group: 'quality', blurb: 'Mean of the last N frames (a software long exposure): noise falls by √N, dim fluorescence becomes visible, moving things smear as they would in a real long exposure.', cost: 'full rate, N-frame lag' },
  { id: 'median', label: 'Temporal median', group: 'quality', blurb: 'Per-pixel median of 3 or 5 frames: rejects hot pixels, JPEG glitches and single-frame flicker without blurring anything that stays still.', cost: 'full rate' },
  { id: 'bin', label: 'Binned', group: 'quality', blurb: 'Software 2×2/3×3/4×4 binning: the noise averages down, the file shrinks to a fraction, and the encoder stops fighting sensor noise. The edge-aware kernel keeps sharp boundaries a step instead of a smear. "Keep size" upscales back so scale bars and calibrations made on the stream stay valid.', cost: 'full rate' },
  { id: 'lucky', label: 'Lucky imaging', group: 'quality', blurb: 'Keeps only the sharpest fraction of frames (astronomers\' frame selection, live, with an exposure-invariant gradient metric): vibration and focus wobble drop out. Either at the reduced rate with the real frame times, or with dropped frames filled from the last kept one for constant-rate playback.', cost: 'reduced rate' },
  { id: 'edof', label: 'Extended depth of field', group: 'stage', drivesStage: true, blurb: 'Dithers z by ±Δz while a block-wise sharpest-over-time stack builds an all-in-focus view of a thick specimen. The stage returns to the starting z when you stop.', cost: 'worker rate, ~1 s lag' },
  { id: 'sweep', label: 'Focus sweep', group: 'stage', drivesStage: true, blurb: 'A slow triangular z sweep over ±range in N stops, recorded as it goes: a walk through the specimen\'s depth. Turn on the position burn-in to read z off the frame.', cost: 'full rate' },
  { id: 'superres', label: 'Super-resolution zoom', group: 'stage', drivesStage: true, blurb: 'Dithers the stage by the smallest steps that shift the image by about half a pixel (through the stage↔camera calibration) and drizzles the last few registered frames of the central crop onto a 1.5× or 2× grid: a digital zoom that is actually resolved, at the source frame size. With the dither off it is "lucky drizzle": no stage motion, the specimen\'s own jitter supplies the phases and a sharpness gate rejects blurred frames, so it also works on a moving specimen.', cost: 'a few fps' },
  { id: 'hdr', label: 'HDR (LED alternation)', group: 'stage', needsLed: true, blurb: 'Locks exposure, alternates the LED between a bright and a dim level and fuses each frame with the newest frame of the other level by well-exposedness: highlights from the dim frame (clipped bright pixels get no weight), shadows from the bright one. The LED level is restored on stop.', cost: 'full rate' },
  { id: 'illum', label: 'Interleaved illumination', group: 'stage', needsLed: false, blurb: 'Alternates two illumination presets (two oblique directions, or brightfield and dark-field) frame by frame with exposure locked and combines the newest frame of each: pseudo differential phase contrast from a left/right pair, a Rheinberg colour composite from brightfield + dark-field, or a split view. Needs presets on the extra LED channels.', cost: 'half rate or less' },
  { id: 'servo', label: 'Focus servo', group: 'stage', drivesStage: true, blurb: 'Keeps a long recording sharp: every N seconds, in a quiet moment, z is nudged ±δ, the sharpness at the three positions is fitted with a parabola and z moves to the best (clamped, backlash-compensated). The probe frames are replaced by the last good frame, so the film never shows the search; z returns to its start on stop.', cost: 'full rate' },
  { id: 'motion', label: 'Motion highlight', group: 'motion', blurb: 'A running-median background (never learns something that is there less than half the time, so a resting organism is not absorbed and a passing one leaves no ghost); whatever departs from it in any colour channel is painted orange over a dimmed grey view.', cost: 'full rate' },
  { id: 'trails', label: 'Motion trails', group: 'motion', blurb: 'Motion-history image: every moving pixel lights up and fades over ~N frames, so a moving organism drags a trail showing where it came from. The background-difference source also catches slow movers a two-frame difference misses.', cost: 'full rate' },
  { id: 'timecode', label: 'Temporal colour code', group: 'motion', blurb: 'ImageJ\'s temporal colour code, live: motion is painted in the hue of its time in a cycling window, so a trajectory becomes a rainbow with time along it. The fade defaults to keeping a whole cycle visible.', cost: 'full rate' },
  { id: 'project', label: 'Projection over time', group: 'motion', blurb: 'Fiji\'s Z Project on the time axis, live: per-pixel running max (tracks of bright particles on dark-field as a photo finish), min (paths of dark swimmers on brightfield) or range (activity), optionally fading.', cost: 'full rate' },
  { id: 'magnify', label: 'Motion magnification', group: 'motion', blurb: 'Eulerian video magnification (Wu et al. 2012): tiny periodic intensity changes in a frequency band are amplified ×α so a heartbeat, flagellum or vibration too small to see becomes obvious. The band is clamped below half the measured frame rate (~8 Hz on this stream: cilia beat faster than that and alias).', cost: 'full rate' },
  { id: 'flow', label: 'Optical flow', group: 'motion', blurb: 'Dense motion field (grid Lucas–Kanade, two levels) painted as a colour wheel: hue is the direction, brightness the speed. Shows currents, cytoplasmic streaming and swimming headings that highlight/trails cannot; the commanded stage pan is subtracted.', cost: 'full rate' },
  { id: 'enhance', label: 'Enhance (stable)', group: 'tone', blurb: 'Video grading that does not pump: auto-levels whose black/white points ease with a dead band (fast when something would clip, slow otherwise) and a soft highlight knee; optional software white balance anchored to the first frame\'s background (lock the camera AWB first), rolling background flattening for uneven illumination, and clarity (local contrast at a chosen scale).', cost: 'full rate' },
  { id: 'relief', label: 'Relief / dark-field / phase', group: 'tone', blurb: 'Contrast methods emulated from the brightfield stream: relief renders the directional derivative as light and shadow (the DIC look), digital dark-field shows the high-pass on black, pseudo-phase shows it on grey. Visualisations for transparent, unstained samples, not phase data.', cost: 'full rate' },
  { id: 'kymograph', label: 'Kymograph', group: 'analysis', blurb: 'The video becomes a growing space–time image: each frame contributes one row sampled along a line (the Distance measurement\'s two points, or the centre line), so slopes are velocities. Cilia beat, flow in a channel and growing tips read at a glance; side-by-side keeps the live view.', cost: 'full rate' },
  { id: 'trigger', label: 'Motion-triggered', group: 'analysis', blurb: 'Watch an empty field for as long as you like: frames are encoded only while something moves (plus a post-roll) and the idle stretches are cut from the timeline, so an hour of waiting becomes a film of the events. Inhibited around stage moves and light changes.', cost: 'sparse' },
  { id: 'timelapse', label: 'Time compression', group: 'time', blurb: 'Keeps one frame every N seconds and lays them out at the chosen fps: an hour of growth in a minute, recorded live with no frame store. Optionally each kept frame is the mean of its whole interval (free noise reduction for slow scenes).', cost: 'sparse' },
]

export interface VideoModeParams {
  denoise: { frames: number; c: number; lockExposure: boolean }
  integrate: { frames: number; kind: 'mean' | 'exp'; lockExposure: boolean }
  median: { frames: 3 | 5; lockExposure: boolean }
  bin: { factor: 2 | 3 | 4; kernel: 'mean' | 'edge'; keepSize: boolean }
  lucky: { keep: number; fill: boolean; lockExposure: boolean }
  edof: { dz: number; dwellMs: number }
  sweep: { range: number; steps: number; dwellMs: number }
  superres: { pixfrac: number; window: number; scale: 1.5 | 2; dither: boolean; keep: number }
  hdr: { ratio: number; period: number }
  illum: { presetA: string; presetB: string; hold: number; output: 'dpc' | 'rheinberg' | 'split'; gain: number; tintA: string; tintB: string }
  servo: { periodS: number; delta: number; maxExcursion: number; hideProbe: boolean }
  motion: { sensitivity: number; learn: number; background: 'median' | 'mean' }
  trails: { decay: number; sensitivity: number; source: 'frame' | 'background' }
  timecode: { period: number; decay: number; map: string }
  project: { kind: 'max' | 'min' | 'range'; decay: number }
  magnify: { factor: number; fLo: number; fHi: number; alpha: number; maxDelta: number; colour: boolean }
  flow: { cell: number; alpha: number; vMax: number }
  enhance: { levels: boolean; lowPct: number; highPct: number; knee: boolean; wb: boolean; flatten: boolean; clarity: number; scale: number }
  relief: { style: 'relief' | 'darkfield' | 'phase'; angle: number; strength: number; mix: number; scale: number }
  kymograph: { band: number; rows: number; sideBySide: boolean }
  trigger: { sensitivity: number; postRollS: number; compressGaps: boolean }
  timelapse: { intervalS: number; fps: number; average: boolean }
}

export const DEFAULT_VIDEO_PARAMS: VideoModeParams = {
  denoise: { frames: 8, c: 4, lockExposure: true },
  integrate: { frames: 8, kind: 'mean', lockExposure: true },
  median: { frames: 3, lockExposure: true },
  bin: { factor: 2, kernel: 'mean', keepSize: false },
  lucky: { keep: 0.5, fill: false, lockExposure: true },
  edof: { dz: 40, dwellMs: 260 },
  sweep: { range: 300, steps: 24, dwellMs: 400 },
  superres: { pixfrac: 0.6, window: 4, scale: 2, dither: true, keep: 0.6 },
  hdr: { ratio: 4, period: 1 },
  illum: { presetA: 'Brightfield', presetB: 'Darkfield', hold: 3, output: 'rheinberg', gain: 4, tintA: '#4060ff', tintB: '#ff6030' },
  servo: { periodS: 30, delta: 4, maxExcursion: 60, hideProbe: true },
  motion: { sensitivity: 4, learn: 0.03, background: 'median' },
  trails: { decay: 0.92, sensitivity: 4, source: 'frame' },
  timecode: { period: 90, decay: 0, map: 'spectrum' },
  project: { kind: 'max', decay: 1 },
  magnify: { factor: 8, fLo: 0.5, fHi: 4, alpha: 15, maxDelta: 60, colour: false },
  flow: { cell: 8, alpha: 0.3, vMax: 0 },
  enhance: { levels: true, lowPct: 0.5, highPct: 99.5, knee: true, wb: false, flatten: false, clarity: 0.6, scale: 16 },
  relief: { style: 'relief', angle: 45, strength: 2.5, mix: 0.3, scale: 8 },
  kymograph: { band: 3, rows: 600, sideBySide: true },
  trigger: { sensitivity: 0.5, postRollS: 3, compressGaps: true },
  timelapse: { intervalS: 5, fps: 15, average: false },
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
    case 'illum': return illumMode(params.illum)
    case 'servo': return servoMode(params.servo)
    case 'motion': return motionMode(params.motion)
    case 'trails': return trailsMode(params.trails)
    case 'timecode': return timecodeMode(params.timecode)
    case 'project': return projectMode(params.project)
    case 'magnify': return magnifyMode(params.magnify)
    case 'flow': return flowMode(params.flow)
    case 'enhance': return enhanceVideoMode(params.enhance)
    case 'relief': return reliefMode(params.relief)
    case 'kymograph': return kymographMode(params.kymograph)
    case 'trigger': return triggerMode(params.trigger)
    case 'timelapse': return timelapseMode(params.timelapse)
  }
}

/** The parameters of `id` as a flat record for the gallery item. */
export function modeParamsRecord(id: VideoModeId, params: VideoModeParams): Record<string, unknown> | undefined {
  if (id === 'plain') return undefined
  return { ...(params[id] as Record<string, unknown>) }
}
