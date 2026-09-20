/** Depth-from-focus for a fine focus stack: `PyramidFuser.depthIndex()` gives, for every pixel, the
 *  index of the slice whose Laplacian energy won at the finest pyramid level (the sharpest slice at
 *  that pixel). Paired with each slice's z this is a coarse depth map (z steps), noisy at the pixel
 *  level near ties between adjacent slices; a small majority-vote smoothing pass cleans it up before
 *  colour-mapping or relief shading. `depthZMap` itself just looks up z (in whatever unit `zs` is);
 *  `stepsToUm`/`depthLegend` below convert to micrometres using Settings' `stageStepUm.z` where a
 *  caller has it, and fall back to plain z steps where they don't. */

export interface DepthStats { min: number; max: number }

/** Majority-vote smoothing of the winner-take-all index map over a 3x3 neighbourhood (edge
 *  clamped), removing salt-and-pepper noise from near-tied pixels while preserving real depth
 *  edges (unlike a mean filter, which would blur the index values themselves into nonsense). */
export function smoothDepthIndex(index: Uint8Array, width: number, height: number, passes = 1): Uint8Array {
  let src = index
  for (let p = 0; p < passes; p++) {
    const out = new Uint8Array(src.length)
    const counts = new Map<number, number>()
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        counts.clear()
        for (let dy = -1; dy <= 1; dy++) {
          const yy = Math.min(height - 1, Math.max(0, y + dy))
          for (let dx = -1; dx <= 1; dx++) {
            const xx = Math.min(width - 1, Math.max(0, x + dx))
            const v = src[yy * width + xx]
            counts.set(v, (counts.get(v) ?? 0) + 1)
          }
        }
        let best = src[y * width + x], bestN = -1
        for (const [v, n] of counts) if (n > bestN) { bestN = n; best = v }
        out[y * width + x] = best
      }
    }
    src = out
  }
  return src
}

/** z (in stage steps) of every pixel, looked up from its winning slice index. */
export function depthZMap(index: Uint8Array, zs: number[]): Float32Array {
  const out = new Float32Array(index.length)
  for (let i = 0; i < index.length; i++) out[i] = zs[index[i]] ?? zs[0] ?? 0
  return out
}

export function depthStats(z: Float32Array): DepthStats {
  let min = Infinity, max = -Infinity
  for (const v of z) { if (v < min) min = v; if (v > max) max = v }
  if (!Number.isFinite(min)) { min = 0; max = 0 }
  return { min, max }
}

/** Convert a z lookup table (stage steps, as passed to `depthZMap`) to micrometres, given the stage's
 *  z distance-per-step (Settings' `stageStepUm.z`, `store/settings.svelte.ts`; 0.05 µm/step by
 *  default on this rig). Feed the result to `depthZMap` in place of the raw step values to get a
 *  z map already in µm — `colorizeDepth`/`reliefShade`/`depthStats` are unit-agnostic, so nothing
 *  else needs to change. */
export function stepsToUm(zs: number[], umPerStep: number): number[] {
  return zs.map((z) => z * umPerStep)
}

export interface DepthLegend extends DepthStats { unit: 'µm' | 'steps' }

/** Legend for a depth map's min/max: µm if a positive z µm/step factor is supplied (i.e. `zs` was
 *  converted with `stepsToUm` before `depthZMap`), plain z steps otherwise — not every rig has that
 *  factor calibrated, so steps is the honest fallback rather than a fabricated distance. */
export function depthLegend(stats: DepthStats, umPerStep?: number): DepthLegend {
  return { ...stats, unit: umPerStep && umPerStep > 0 ? 'µm' : 'steps' }
}

// A few hand-picked stops of a blue -> cyan -> green -> yellow -> red colour ramp (cheap
// approximation of the "turbo" colormap: perceptually ordered, colour-blind tolerant enough for a
// depth preview without pulling in a palette library).
const STOPS: readonly [number, number, number][] = [
  [48, 18, 130], [24, 108, 209], [39, 174, 175], [90, 200, 90], [220, 210, 50], [230, 120, 40], [180, 30, 30],
]

function rampColor(t: number): [number, number, number] {
  const c = Math.max(0, Math.min(1, t)) * (STOPS.length - 1)
  const i0 = Math.floor(c), i1 = Math.min(STOPS.length - 1, i0 + 1), f = c - i0
  const a = STOPS[i0], b = STOPS[i1]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

/** Colour-mapped depth image (8-bit RGBA), normalised over the map's own min/max z. */
export function colorizeDepth(z: Float32Array, width: number, height: number): { data: Uint8ClampedArray; stats: DepthStats } {
  const stats = depthStats(z), span = stats.max - stats.min || 1
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < z.length; i++) {
    const [r, g, b] = rampColor((z[i] - stats.min) / span)
    const p = i * 4; data[p] = r; data[p + 1] = g; data[p + 2] = b; data[p + 3] = 255
  }
  return { data, stats }
}

/** Pseudo-3D relief: the fused image's brightness modulated by the depth gradient, like hill-shading
 *  a digital elevation model — surfaces sloping towards the (fixed, upper-left) light are brightened,
 *  the opposite darkened, flat regions unchanged. `strength` around 1 gives a subtle effect. */
export function reliefShade(image: Uint8ClampedArray, z: Float32Array, width: number, height: number, strength = 1.2): Uint8ClampedArray {
  // Fail here, where the caller is named, rather than several steps later inside an ImageData
  // constructor: a downscaled base with full-resolution dimensions is otherwise silently indexed
  // out of range and only surfaces at encode time.
  if (image.length !== width * height * 4) {
    throw new Error(`reliefShade: image is ${image.length} bytes, expected ${width * height * 4} for ${width}x${height}`)
  }
  const out = new Uint8ClampedArray(image.length)
  const stats = depthStats(z), span = Math.max(1e-6, stats.max - stats.min)
  const at = (x: number, y: number) => z[Math.min(height - 1, Math.max(0, y)) * width + Math.min(width - 1, Math.max(0, x))]
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const gx = (at(x + 1, y) - at(x - 1, y)) / (2 * span), gy = (at(x, y + 1) - at(x, y - 1)) / (2 * span)
      const shade = 1 + strength * Math.tanh(-(gx + gy) * width * 0.02)
      const p = (y * width + x) * 4
      out[p] = image[p] * shade; out[p + 1] = image[p + 1] * shade; out[p + 2] = image[p + 2] * shade; out[p + 3] = 255
    }
  }
  return out
}
