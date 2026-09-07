/** Pure maths for the live histogram (Camera panel): binning, clipping fractions and the exposure
 *  step suggestion behind the "Expose to 60% grey" button. No DOM/canvas access here — the caller
 *  (`components/Histogram.svelte`) samples an OffscreenCanvas and hands this module plain RGBA bytes. */

export interface Histogram {
  lum: number[]        // 256 bins, Rec. 709 luma
  r: number[]
  g: number[]
  b: number[]
  clippedHigh: number   // fraction of pixels with luma >= 250
  clippedLow: number    // fraction of pixels with luma <= 5
  mean: number          // mean luma, 0..255
  n: number             // pixel count
}

/** Bin an RGBA buffer (as from canvas getImageData/OffscreenCanvas) into luminance + per-channel
 *  histograms. `stride` lets the caller skip pixels (sampling every Nth pixel) for speed; default 1. */
export function computeHistogram(data: Uint8ClampedArray | Uint8Array, stride = 1): Histogram {
  const lum = new Array(256).fill(0), r = new Array(256).fill(0), g = new Array(256).fill(0), b = new Array(256).fill(0)
  let sum = 0, n = 0, high = 0, low = 0
  const step = Math.max(1, Math.round(stride)) * 4
  for (let i = 0; i + 2 < data.length; i += step) {
    const R = data[i], G = data[i + 1], B = data[i + 2]
    r[R]++; g[G]++; b[B]++
    const y = Math.round(0.2126 * R + 0.7152 * G + 0.0722 * B)
    lum[y]++
    sum += y
    if (y >= 250) high++
    if (y <= 5) low++
    n++
  }
  return { lum, r, g, b, clippedHigh: n ? high / n : 0, clippedLow: n ? low / n : 0, mean: n ? sum / n : 0, n }
}

export interface ExposureState { exposureUs: number; gain: number }
export interface ExposureLimits { exposureUs: [number, number]; gain: [number, number] }

/** One step of "expose to target grey": scale exposure time to move `mean` toward `target` (0..255),
 *  then, if that runs past the exposure limits, take up the rest with analogue gain. Returns null once
 *  `mean` is already within `tolerance` of `target` (nothing to do). Call this 2-3 times, re-measuring
 *  the histogram between calls, since the response is not perfectly linear (gamma/ISP tone curve). */
export function suggestExposureStep(
  mean: number, target: number, state: ExposureState, limits: ExposureLimits, tolerance = 3,
): ExposureState | null {
  if (Math.abs(mean - target) <= tolerance) return null
  const ratio = target / Math.max(1, mean)
  let exposureUs = state.exposureUs * ratio
  let gain = state.gain
  if (exposureUs > limits.exposureUs[1]) { gain *= exposureUs / limits.exposureUs[1]; exposureUs = limits.exposureUs[1] }
  else if (exposureUs < limits.exposureUs[0]) { gain *= exposureUs / limits.exposureUs[0]; exposureUs = limits.exposureUs[0] }
  gain = Math.min(limits.gain[1], Math.max(limits.gain[0], gain))
  exposureUs = Math.min(limits.exposureUs[1], Math.max(limits.exposureUs[0], exposureUs))
  return { exposureUs: Math.round(exposureUs), gain: +gain.toFixed(3) }
}
