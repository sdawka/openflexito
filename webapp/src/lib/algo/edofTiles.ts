/** Extended-focus scan tiles: where to centre a tile's focal sweep and how long to make it, and
 *  what it costs. Pure, so the scan service stays orchestration. The sweep itself is
 *  `services/photo/sweepStack.ts#captureSweepStack`. */

import { focusBand, type FocusSample } from './stackPlan'

/** shortest/longest sweep, steps */
export const EDOF_MIN_RANGE = 120
export const EDOF_MAX_RANGE = 2000
export const EDOF_DEFAULT_RANGE = 600
/** slices fused per tile (the Photo panel's sweep stack uses 9; fewer keeps a tile's fusion short) */
export const EDOF_SLICES = 7
/** z steps between recorded frames (same default as the Photo panel's sweep stack) */
export const EDOF_STEPS_PER_FRAME = 8
/** the recorded sweep must hold at least this many sharpness samples to trust a band */
const MIN_BAND_SAMPLES = 5

export const clampEdofRange = (r: number): number =>
  Math.max(EDOF_MIN_RANGE, Math.min(EDOF_MAX_RANGE, Math.round(Number.isFinite(r) ? r : EDOF_DEFAULT_RANGE)))

export interface EdofSweep {
  /** absolute z the sweep is centred on */
  centreZ: number
  /** total sweep length, steps */
  range: number
  /** sized from the tile's own autofocus curve (false: the configured range around the tile's z) */
  fromBand: boolean
}

/** The sweep for one tile. With an autofocus curve whose in-focus band lies inside its sweep, the
 *  sweep is centred on the band and twice as long, so the recorded frames see the band's edges and
 *  the sweep stack can pick its own slices; a band that touches the curve's ends (the specimen may
 *  extend past what autofocus looked at) or no curve at all gives the configured range around
 *  `tileZ`. */
export function edofSweepPlan(samples: readonly FocusSample[] | undefined, tileZ: number, configuredRange: number): EdofSweep {
  const band = samples && samples.length >= MIN_BAND_SAMPLES ? focusBand(samples) : null
  if (band && !band.clipped && band.hi > band.lo) {
    return { centreZ: Math.round((band.lo + band.hi) / 2), range: clampEdofRange(2 * (band.hi - band.lo)), fromBand: true }
  }
  return { centreZ: Math.round(tileZ), range: clampEdofRange(configuredRange), fromBand: false }
}

/** Rough seconds one tile's sweep takes: recording start and the move to the sweep's bottom, the
 *  sweep at `fps`, then decoding/measuring/fusing roughly 0.04 s per recorded frame. */
export function edofTileSeconds(range: number, fps = 30, stepsPerFrame = EDOF_STEPS_PER_FRAME): number {
  const r = clampEdofRange(range)
  return 8 + r / (fps * stepsPerFrame) + (0.04 * r) / stepsPerFrame
}
