/** Focus-stack range planning: how deep the *specimen* is, not how deep one focal plane is.
 *
 *  The fine stack used to size its z range from the width of the whole-frame sharpness peak
 *  (≈2× its FWHM, capped at the slice count by shrinking the range around the peak). That width is
 *  the optics' depth of field plus a little of the specimen, so on anything thicker than one DOF
 *  the top and bottom of the specimen were never in any slice and no fusion could make them sharp.
 *  Now the range is the whole band of the autofocus sweep where anything is in focus (the curve
 *  above `threshold` of the way from its floor to its peak, one sample spacing of margin each
 *  side), and the slice spacing comes from the depth of field alone; when the slice cap cannot
 *  cover the band at that spacing the slices spread out over the band (coverage beats density: a
 *  gap between two slices is soft, a missing end is not there at all). */

export interface FocusSample { z: number; s: number }

export interface FocusBand {
  /** z extent of the in-focus band, margin included */
  lo: number
  hi: number
  /** z of the sharpest sample */
  peakZ: number
  /** the band reaches the first/last sample: the specimen may extend past the sweep */
  clipped: boolean
}

/** Median gap between consecutive distinct sample z's (the sweep's sampling interval). */
function medianSpacing(zs: number[]): number {
  const d: number[] = []
  for (let i = 1; i < zs.length; i++) if (zs[i] > zs[i - 1]) d.push(zs[i] - zs[i - 1])
  if (!d.length) return 0
  d.sort((a, b) => a - b)
  return d[d.length >> 1]
}

/** In-focus band of a sharpness curve. Samples may come in any order (an autofocus sweep can pass
 *  over the same z twice); every sample above the cut counts, so a thick specimen with two
 *  sharpness peaks gets one band spanning both. */
export function focusBand(samples: readonly FocusSample[], threshold = 0.2): FocusBand | null {
  if (!samples.length) return null
  let lo = Infinity, hi = -Infinity, peak = samples[0]
  for (const p of samples) { if (p.s < lo) lo = p.s; if (p.s > hi) { hi = p.s; peak = p } }
  const cut = lo + threshold * (hi - lo)
  const zs = samples.map((p) => p.z).sort((a, b) => a - b)
  let a = peak.z, b = peak.z
  for (const p of samples) if (p.s > cut) { if (p.z < a) a = p.z; if (p.z > b) b = p.z }
  const margin = medianSpacing(zs)
  const zMin = zs[0], zMax = zs[zs.length - 1]
  return {
    lo: Math.max(zMin, a - margin), hi: Math.min(zMax, b + margin), peakZ: peak.z,
    clipped: a <= zMin || b >= zMax,
  }
}

/** Depth of field (µm) of a widefield objective: the wave-optical term λ/NA² plus the geometric
 *  term e/NA for the object-space pixel size e (Inoué & Spring; in air, n = 1). */
export function depthOfFieldUm(na: number, umPerPx = 0, lambdaUm = 0.55): number {
  const a = Math.max(0.01, Math.min(1.4, na))
  return lambdaUm / (a * a) + (umPerPx > 0 ? umPerPx / a : 0)
}

export interface StackPlan {
  /** z of the middle slice */
  centreZ: number
  /** z steps between slices */
  step: number
  slices: number
  /** z steps from the first slice to the last */
  span: number
  /** the cap forced a spacing wider than `dofStep` */
  undersampled: boolean
}

/** Slices over `[lo, hi]` at most `dofStep` apart (at least 3, at most `maxSlices`, never closer
 *  than `minStep`), centred on the band. */
export function planStack(lo: number, hi: number, dofStep: number, maxSlices: number, minStep = 2): StackPlan {
  const band = Math.max(0, hi - lo), cap = Math.max(3, Math.round(maxSlices))
  const want = Math.max(minStep, dofStep)
  let slices = Math.max(3, Math.ceil(band / want) + 1)
  const undersampled = slices > cap
  if (undersampled) slices = cap
  const step = Math.max(minStep, Math.round(Math.max(band, want * (slices - 1)) / (slices - 1)))
  return { centreZ: Math.round((lo + hi) / 2), step, slices, span: step * (slices - 1), undersampled }
}
