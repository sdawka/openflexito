/** Lens shading table from a flat-field raw capture (port of OpenFlexure v3 lst_from_camera).
 *
 *  Each colour plane is averaged into a 16 (columns) x 12 (rows) grid. With g = mean(G1, G2):
 *    luminance = max(g) / g,  Cr = g / R,  Cb = g / B
 *  These go into libcamera's rpi.alsc as fixed tables (n_iter 0). The ISP normalises the chroma
 *  tables by their minimum, so the residual global white balance is ColourGains = (min Cr, min Cb).
 *
 *  The capture this is measured from must be an *empty, evenly lit* field. A frame with a specimen
 *  still in view is not flat, and because the luminance table is `max(g) / g` every dark part of the
 *  sample turns into a large gain that is then baked into the tuning file and multiplies every later
 *  RAW develop. `checkFlatField` rejects such a capture before it is written, and
 *  `lensShadingFromPlanes` clamps the gain it will ever produce. Reference: the vendor IMX219 tuning
 *  ships a luminance LUT of all 1.0 and chroma tables spanning only 1.28-1.40, so a genuine field on
 *  this optic stays well inside `MAX_FLAT_RATIO`. */

import type { BayerPlanes } from './raw'

export const LST_COLS = 16
export const LST_ROWS = 12

/** Average a plane into a rows x cols grid of (near-)equal cells. */
export function gridAverage(plane: Float32Array, width: number, height: number, cols = LST_COLS, rows = LST_ROWS): Float64Array {
  const sum = new Float64Array(cols * rows), cnt = new Float64Array(cols * rows)
  for (let y = 0; y < height; y++) {
    const gy = Math.min(rows - 1, Math.floor((y * rows) / height))
    for (let x = 0; x < width; x++) {
      const g = gy * cols + Math.min(cols - 1, Math.floor((x * cols) / width))
      sum[g] += plane[y * width + x]
      cnt[g]++
    }
  }
  for (let i = 0; i < sum.length; i++) sum[i] = cnt[i] ? sum[i] / cnt[i] : 0
  return sum
}

export interface LensShading { luminance: number[]; cr: number[]; cb: number[]; colourGains: [number, number] }

/** Largest bright:dark ratio a capture may span and still be treated as a flat field. Real vignetting
 *  on this optic is a smooth falloff well under this; anything beyond it is a sample in the view, a
 *  dark frame, or uneven illumination. */
export const MAX_FLAT_RATIO = 8

/** Hard ceiling on the luminance gain the table may ask for, so even a marginal flat cannot blow out
 *  the develop. Applied after the ratio check as defence in depth. */
export const MAX_LUMINANCE_GAIN = 8

export interface FlatFieldCheck {
  ok: boolean
  /** brightest:darkest cell of the green grid (1 = perfectly flat) */
  ratio: number
  /** mean green level of the grid, in raw units above black */
  level: number
  reason?: string
}

/** Is this capture usable as a flat field? Checks it is neither too dark to measure nor too uneven
 *  to be vignetting. Pure, so the calibration route and the tests can share one definition. */
export function checkFlatField(p: BayerPlanes, maxRatio = MAX_FLAT_RATIO): FlatFieldCheck {
  const g1 = gridAverage(p.g1, p.width, p.height), g2 = gridAverage(p.g2, p.width, p.height)
  const n = g1.length
  let lo = Infinity, hi = 0, sum = 0
  for (let i = 0; i < n; i++) {
    const g = (g1[i] + g2[i]) / 2
    if (g < lo) lo = g
    if (g > hi) hi = g
    sum += g
  }
  const level = sum / n
  const ratio = lo > 0 ? hi / lo : Infinity
  if (!(hi > 0) || level < 8) {
    return { ok: false, ratio, level, reason: `the field is too dark to measure (mean level ${level.toFixed(1)}): is the LED on?` }
  }
  if (!(ratio <= maxRatio)) {
    return {
      ok: false, ratio, level,
      reason: `the field is not flat (brightest part is ${ratio.toFixed(1)}x the darkest, limit ${maxRatio}x): ` +
        'move the sample out of the field of view and even out the illumination, then run this step again',
    }
  }
  return { ok: true, ratio, level }
}

const round3 = (v: number) => Math.round(v * 1000) / 1000

export function lensShadingFromPlanes(p: BayerPlanes, maxGain = MAX_LUMINANCE_GAIN): LensShading {
  const r = gridAverage(p.r, p.width, p.height), b = gridAverage(p.b, p.width, p.height)
  const g1 = gridAverage(p.g1, p.width, p.height), g2 = gridAverage(p.g2, p.width, p.height)
  const n = r.length
  const g = new Float64Array(n)
  let gmax = 0
  for (let i = 0; i < n; i++) { g[i] = (g1[i] + g2[i]) / 2; if (g[i] > gmax) gmax = g[i] }
  const eps = 1e-6
  const luminance: number[] = [], cr: number[] = [], cb: number[] = []
  for (let i = 0; i < n; i++) {
    luminance.push(round3(Math.min(maxGain, gmax / Math.max(g[i], eps))))
    cr.push(round3(g[i] / Math.max(r[i], eps)))
    cb.push(round3(g[i] / Math.max(b[i], eps)))
  }
  return { luminance, cr, cb, colourGains: [Math.min(...cr), Math.min(...cb)] }
}

export function flatLensShading(): LensShading {
  const ones = new Array(LST_COLS * LST_ROWS).fill(1)
  return { luminance: ones, cr: [...ones], cb: [...ones], colourGains: [1, 1] }
}
