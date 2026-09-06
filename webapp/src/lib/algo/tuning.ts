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
