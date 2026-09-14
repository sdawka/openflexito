/** libcamera tuning-file helpers (v2 format: { version, target, algorithms: [ { "rpi.x": {...} } ] }). */

import type { LensShading } from './lst'

export type Tuning = { version?: number; target?: string; algorithms?: Record<string, any>[] } & Record<string, any>

export const CT_UNCALIBRATED = 1234   // marker used by OpenFlexure: "tables are placeholders"
export const CT_CALIBRATED = 5000     // colour temperature of the illumination LED

export function findAlgo(t: Tuning, name: string): any | undefined {
  if (Array.isArray(t.algorithms)) {
    for (const entry of t.algorithms) if (name in entry) return entry[name]
    return undefined
  }
  return t[name]   // v1 format
}

export function setAlgo(t: Tuning, name: string, value: any): Tuning {
  const out: Tuning = structuredClone(t)
  if (Array.isArray(out.algorithms)) {
    const i = out.algorithms.findIndex((e) => name in e)
    if (i >= 0) out.algorithms[i] = { [name]: value }
    else out.algorithms.push({ [name]: value })
  } else {
    out[name] = value
  }
  return out
}

export function setLensShading(t: Tuning, lst: LensShading, ct: number): Tuning {
  const alsc = { ...(findAlgo(t, 'rpi.alsc') ?? {}) }
  alsc.n_iter = 0
  alsc.luminance_strength = 1.0
  alsc.luminance_lut = lst.luminance
  alsc.calibrations_Cr = [{ ct, table: lst.cr }]
  alsc.calibrations_Cb = [{ ct, table: lst.cb }]
  return setAlgo(t, 'rpi.alsc', alsc)
}

export function isLensShadingCalibrated(t: Tuning): boolean {
  const alsc = findAlgo(t, 'rpi.alsc')
  return alsc?.calibrations_Cr?.[0]?.ct === CT_CALIBRATED
}

export function setStaticGreenEqualisation(t: Tuning, offset = 65535): Tuning {
  return setAlgo(t, 'rpi.geq', { ...(findAlgo(t, 'rpi.geq') ?? {}), offset, slope: 0 })
}

export function setContrastEnhancement(t: Tuning, enabled: boolean): Tuning {
  return setAlgo(t, 'rpi.contrast', { ...(findAlgo(t, 'rpi.contrast') ?? {}), ce_enable: enabled ? 1 : 0 })
}

export function setColourMatrix(t: Tuning, ccm: number[], ct = CT_CALIBRATED): Tuning {
  if (ccm.length !== 9) throw new Error('ccm needs 9 values')
  return setAlgo(t, 'rpi.ccm', { ...(findAlgo(t, 'rpi.ccm') ?? {}), ccms: [{ ct, ccm }] })
}

export function getGammaCurve(t: Tuning): number[] | undefined {
  return findAlgo(t, 'rpi.contrast')?.gamma_curve
}

export function setGammaCurve(t: Tuning, curve: number[]): Tuning {
  return setAlgo(t, 'rpi.contrast', { ...(findAlgo(t, 'rpi.contrast') ?? {}), gamma_curve: curve })
}

/** Colour temperature implied by a pair of white-balance gains, read off the tuning file's AWB
 *  `ct_curve` ([ct, r, b, ct, r, b, ...] where r and b are the red/green and blue/green ratios of a
 *  grey patch under that illuminant, i.e. 1/gain): the curve point nearest to (1/gr, 1/gb), linearly
 *  interpolated between the two nearest knots. Undefined when the tuning has no curve. Used to pick
 *  the CCM and ALSC tables for a RAW develop when libcamera's ColourTemperature is not available. */
export function estimateColourTemperature(t: Tuning, gains: [number, number]): number | undefined {
  const curve = findAlgo(t, 'rpi.awb')?.ct_curve
  if (!Array.isArray(curve) || curve.length < 6 || !(gains[0] > 0) || !(gains[1] > 0)) return undefined
  const r = 1 / gains[0], b = 1 / gains[1]
  let best = Infinity, bestCt = curve[0]
  for (let i = 0; i + 5 < curve.length; i += 3) {
    // project (r, b) onto the segment between knots i and i+3
    const ct0 = curve[i], r0 = curve[i + 1], b0 = curve[i + 2], ct1 = curve[i + 3], r1 = curve[i + 4], b1 = curve[i + 5]
    const dr = r1 - r0, db = b1 - b0, len2 = dr * dr + db * db
    const u = len2 > 0 ? Math.min(1, Math.max(0, ((r - r0) * dr + (b - b0) * db) / len2)) : 0
    const pr = r0 + u * dr, pb = b0 + u * db
    const d = (pr - r) ** 2 + (pb - b) ** 2
    if (d < best) { best = d; bestCt = ct0 + u * (ct1 - ct0) }
  }
  return bestCt
}
