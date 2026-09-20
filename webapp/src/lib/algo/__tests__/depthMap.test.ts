import { describe, expect, it } from 'vitest'
import { PyramidFuser } from '../pyramidFuse'
import { smoothDepthIndex, depthZMap, colorizeDepth, reliefShade, depthStats, stepsToUm, depthLegend } from '../depthMap'

// Big enough for PyramidFuser to build more than one pyramid level (it needs min(w, h) > 48);
// below that it degenerates to a plain average with no per-pixel winner selection at all.
const W = 128, H = 96

// Same "half blurred" scene as the pyramidFuse test: slice 0 is sharp on the left half (so it
// should win the depth vote there) and slice 1 sharp on the right half.
function scene(): Uint8ClampedArray {
  const data = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = ((Math.floor(x / 3) + Math.floor(y / 3)) % 2 ? 210 : 50)
    const p = (y * W + x) * 4; data[p] = v; data[p + 1] = v; data[p + 2] = v; data[p + 3] = 255
  }
  return data
}
function blurHalf(img: Uint8ClampedArray, left: boolean, r = 4): Uint8ClampedArray {
  const out = new Uint8ClampedArray(img)
  for (let y = 0; y < H; y++) for (let x = left ? 0 : W / 2; x < (left ? W / 2 : W); x++) for (let c = 0; c < 3; c++) {
    let s = 0, n = 0
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const yy = Math.min(H - 1, Math.max(0, y + dy)), xx = Math.min(W - 1, Math.max(0, x + dx)); s += img[(yy * W + xx) * 4 + c]; n++
    }
    out[(y * W + x) * 4 + c] = s / n
  }
  return out
}

describe('depth-from-focus', () => {
  it('recovers a two-slice depth split (left slice 0 in focus, right slice 1 in focus)', () => {
    const sharp = scene()
    const sliceA = blurHalf(sharp, false)   // sharp on the left (blurred on the right)
    const sliceB = blurHalf(sharp, true)    // sharp on the right (blurred on the left)
    const f = new PyramidFuser(W, H)
    f.add(sliceA, 0); f.add(sliceB, 1)
    f.result()   // collapses the pyramid; depthIndex() is populated during add()
    const index = smoothDepthIndex(f.depthIndex(), W, H, 1)

    // left half should mostly vote for slice 0, right half mostly for slice 1
    let leftZeros = 0, rightOnes = 0
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W / 2; x++) if (index[y * W + x] === 0) leftZeros++
      for (let x = W / 2; x < W; x++) if (index[y * W + x] === 1) rightOnes++
    }
    expect(leftZeros / (H * W / 2)).toBeGreaterThan(0.7)
    expect(rightOnes / (H * W / 2)).toBeGreaterThan(0.7)

    const zs = [100, 300]   // slice 0 at z=100, slice 1 at z=300
    const zMap = depthZMap(index, zs)
    const stats = depthStats(zMap)
    expect(stats.min).toBe(100); expect(stats.max).toBe(300)
    // left half z close to 100, right half close to 300
    let leftSum = 0, rightSum = 0
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W / 2; x++) leftSum += zMap[y * W + x]
      for (let x = W / 2; x < W; x++) rightSum += zMap[y * W + x]
    }
    expect(leftSum / (H * W / 2)).toBeLessThan(150)
    expect(rightSum / (H * W / 2)).toBeGreaterThan(250)

    const { data: colour } = colorizeDepth(zMap, W, H)
    expect(colour.length).toBe(W * H * 4)
    // colour differs meaningfully between the two halves (different z -> different colour ramp stop)
    const cLeft = colour[(H / 2 * W + 2) * 4], cRight = colour[(H / 2 * W + W - 2) * 4]
    expect(Math.abs(cLeft - cRight)).toBeGreaterThan(20)

    const relief = reliefShade(sharp, zMap, W, H)
    expect(relief.length).toBe(sharp.length)
    // relief is a modulation of the same image, not a random image: mean brightness stays in the ballpark
    let baseMean = 0, reliefMean = 0
    for (let i = 0; i < sharp.length; i += 4) { baseMean += sharp[i]; reliefMean += relief[i] }
    baseMean /= (sharp.length / 4); reliefMean /= (sharp.length / 4)
    expect(Math.abs(baseMean - reliefMean)).toBeLessThan(80)
  })

  it('smoothDepthIndex removes isolated single-pixel noise via majority vote', () => {
    const w = 5, h = 1
    const idx = new Uint8Array([0, 0, 1, 0, 0])   // a lone '1' surrounded by '0's
    const out = smoothDepthIndex(idx, w, h, 1)
    expect(out[2]).toBe(0)
  })

  it('stepsToUm scales a z lookup table and depthLegend reports the right unit', () => {
    const zsUm = stepsToUm([100, 300], 0.05)
    expect(zsUm).toEqual([5, 15])
    const idx = new Uint8Array([0, 1])
    const zMap = depthZMap(idx, zsUm)
    const stats = depthStats(zMap)
    expect(stats).toEqual({ min: 5, max: 15 })
    expect(depthLegend(stats, 0.05)).toEqual({ min: 5, max: 15, unit: 'µm' })
    // no calibrated step size: honest fallback to plain steps, not a fabricated distance
    const stepStats = depthStats(depthZMap(idx, [100, 300]))
    expect(depthLegend(stepStats)).toEqual({ min: 100, max: 300, unit: 'steps' })
    expect(depthLegend(stepStats, 0)).toEqual({ min: 100, max: 300, unit: 'steps' })
  })
})

describe('reliefShade size contract', () => {
  it('rejects a base image whose length does not match the dimensions', () => {
    // regression: the RAW fine stack passed a 4x-downscaled base with full-resolution width/height,
    // which only failed later inside `new ImageData(...)`
    const w = 8, h = 6
    const quarter = new Uint8ClampedArray((w / 4) * (h / 4) * 4)
    const z = new Float32Array(w * h)
    expect(() => reliefShade(quarter, z, w, h)).toThrow(/expected 192 for 8x6/)
  })
  it('accepts a correctly sized base', () => {
    const w = 8, h = 6
    const full = new Uint8ClampedArray(w * h * 4).fill(128)
    const z = new Float32Array(w * h).map((_, i) => i % w)
    const out = reliefShade(full, z, w, h)
    expect(out.length).toBe(w * h * 4)
  })
})

