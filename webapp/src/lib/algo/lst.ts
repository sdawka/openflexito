/** Lens shading table from a flat-field raw capture (port of OpenFlexure v3 lst_from_camera).
 *
 *  Each colour plane is averaged into a 16 (columns) x 12 (rows) grid. With g = mean(G1, G2):
 *    luminance = max(g) / g,  Cr = g / R,  Cb = g / B
 *  These go into libcamera's rpi.alsc as fixed tables (n_iter 0). The ISP normalises the chroma
 *  tables by their minimum, so the residual global white balance is ColourGains = (min Cr, min Cb). */

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

const round3 = (v: number) => Math.round(v * 1000) / 1000

export function lensShadingFromPlanes(p: BayerPlanes): LensShading {
  const r = gridAverage(p.r, p.width, p.height), b = gridAverage(p.b, p.width, p.height)
  const g1 = gridAverage(p.g1, p.width, p.height), g2 = gridAverage(p.g2, p.width, p.height)
  const n = r.length
  const g = new Float64Array(n)
  let gmax = 0
  for (let i = 0; i < n; i++) { g[i] = (g1[i] + g2[i]) / 2; if (g[i] > gmax) gmax = g[i] }
  const eps = 1e-6
  const luminance: number[] = [], cr: number[] = [], cb: number[] = []
  for (let i = 0; i < n; i++) {
    luminance.push(round3(gmax / Math.max(g[i], eps)))
    cr.push(round3(g[i] / Math.max(r[i], eps)))
    cb.push(round3(g[i] / Math.max(b[i], eps)))
  }
  return { luminance, cr, cb, colourGains: [Math.min(...cr), Math.min(...cb)] }
}

export function flatLensShading(): LensShading {
  const ones = new Array(LST_COLS * LST_ROWS).fill(1)
  return { luminance: ones, cr: [...ones], cb: [...ones], colourGains: [1, 1] }
}
