import { describe, expect, it } from 'vitest'
import { mertensFuse, mertensWeight, rgbaToPlanes, gaussianPyramid, laplacianPyramid, collapseLaplacian, maxPyramidLevels, type Plane } from '../exposureFuse'
import { exposureFuse as blockExposureFuse, type Rgba } from '../stack'

function makeRgba(fn: (x: number, y: number) => [number, number, number], w: number, h: number): Rgba {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = fn(x, y), o = (y * w + x) * 4
    data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255
  }
  return { data, width: w, height: h }
}

/** A frame that is well-exposed (mid-grey, high local contrast, a checker) only inside `region`
 *  (x0..x1, y0..y1), clipped/black elsewhere so the fusion must pick this frame there. */
function regionFrame(w: number, h: number, region: [number, number, number, number], dark: number): Rgba {
  const [x0, y0, x1, y1] = region
  return makeRgba((x, y) => {
    if (x >= x0 && x < x1 && y >= y0 && y < y1) {
      const v = (x + y) % 2 === 0 ? 200 : 80
      return [v, v, v]
    }
    return [dark, dark, dark]
  }, w, h)
}

describe('mertensFuse (multi-scale)', () => {
  it('recovers the well-exposed region from each of several frames (checker survives)', () => {
    const w = 64, h = 64
    // three frames, each well-exposed in a different horizontal third, clipped/black elsewhere
    const frames = [
      regionFrame(w, h, [0, 0, 22, h], 250),   // this one is bright/clipped outside its region
      regionFrame(w, h, [22, 0, 44, h], 5),    // dark outside its region
      regionFrame(w, h, [44, 0, w, h], 5),
    ]
    const fused = mertensFuse(frames)
    // sample the middle of each region: the checker (high local contrast) must be visible, i.e.
    // neighbouring pixels along x differ substantially
    for (const cx of [11, 33, 55]) {
      const y = 32
      const a = fused.data[(y * w + cx) * 4], b = fused.data[(y * w + cx + 1) * 4]
      expect(Math.abs(a - b)).toBeGreaterThan(40)
    }
  })

  it('keeps fine detail the old block blend washes out (the old blend weighs only per-8x8-cell mean luminance, no contrast term)', () => {
    // frame A: a high-contrast pattern (values 250/250/5 on a period-3 grid) whose per-8x8-cell mean
    // luminance (~0.66) is further from mid-grey than frame B's flat 127 (~0.50). The old
    // `exposureFuse` (algo/stack.ts) weighs cells only by closeness of mean luminance to 0.5, so it
    // actually prefers the flat frame here and washes out A's fine detail; Mertens' contrast term
    // overrides that and keeps the detail regardless of the (irrelevant) mean-luminance difference.
    const w = 32, h = 32
    const detailed = makeRgba((x) => { const v = x % 3 === 2 ? 5 : 250; return [v, v, v] }, w, h)
    const flat = makeRgba(() => [127, 127, 127], w, h)
    const fusedMulti = mertensFuse([detailed, flat])
    const fusedBlock = blockExposureFuse([detailed, flat])
    const localContrast = (img: Rgba): number => {
      let s = 0, n = 0
      for (let y = 8; y < h - 8; y++) for (let x = 8; x < w - 8; x++) {
        const o = (y * w + x) * 4, oNext = (y * w + x + 1) * 4
        s += Math.abs(img.data[o] - img.data[oNext]); n++
      }
      return s / n
    }
    expect(localContrast(fusedMulti)).toBeGreaterThan(localContrast(fusedBlock) * 1.5)
  })

  it('keeps colour consistent across frames of different brightness (no tint shift from fusion itself)', () => {
    const w = 16, h = 16
    // same hue (2:1:1 R:G:B ratio) at two different overall exposures
    const dim = makeRgba(() => [60, 30, 30], w, h)
    const bright = makeRgba(() => [200, 100, 100], w, h)
    const fused = mertensFuse([dim, bright])
    const o = (8 * w + 8) * 4
    const r = fused.data[o], g = fused.data[o + 1], b = fused.data[o + 2]
    expect(g).toBeGreaterThan(0)
    expect(r / g).toBeCloseTo(2, 1)
    expect(b / g).toBeCloseTo(1, 1)
  })

  it('mertensWeight favours well-exposed, high-contrast, saturated pixels over flat/clipped ones', () => {
    const w = 8, h = 8
    const goodImg = rgbaToPlanes(makeRgba((x, y) => ((x + y) % 2 === 0 ? [180, 60, 60] : [60, 180, 60]), w, h))
    const clippedImg = rgbaToPlanes(makeRgba(() => [255, 255, 255], w, h))
    const wGood = mertensWeight(goodImg), wClipped = mertensWeight(clippedImg)
    const mid = 4 * w + 4
    expect(wGood[mid]).toBeGreaterThan(wClipped[mid])
  })
})

describe('pyramid helpers with small images', () => {
  function makePlane(w: number, h: number, value: number): Plane {
    const data = new Float32Array(w * h)
    for (let i = 0; i < data.length; i++) data[i] = value
    return { data, width: w, height: h }
  }

  it('maxPyramidLevels correctly limits pyramid depth for 1xN images', () => {
    // 1x1: can't pyramid at all
    expect(maxPyramidLevels(1, 1)).toBe(1)
    // 1x100: w < 3 so pyrDown stops immediately, only 1 level
    const max1x100 = maxPyramidLevels(1, 100)
    expect(max1x100).toBe(1)
    let p = makePlane(1, 100, 0.5)
    const pyr1x100 = gaussianPyramid(p, 10)
    expect(pyr1x100.length).toBe(1)  // pyrDown returns input unchanged
    expect(pyr1x100[0].width).toBe(1)
    expect(pyr1x100[0].height).toBe(100)
  })

  it('maxPyramidLevels correctly limits pyramid depth for Nx1 images', () => {
    // 100x1: h < 3 so pyrDown stops immediately, only 1 level
    const max100x1 = maxPyramidLevels(100, 1)
    expect(max100x1).toBe(1)
    let p = makePlane(100, 1, 0.5)
    const pyr100x1 = gaussianPyramid(p, 10)
    expect(pyr100x1.length).toBe(1)  // pyrDown returns input unchanged
    expect(pyr100x1[0].width).toBe(100)
    expect(pyr100x1[0].height).toBe(1)
  })

  it('gaussianPyramid clamps levels for 1x1 images without crashing', () => {
    const p = makePlane(1, 1, 0.5)
    // Request 5 levels but should only get 1
    const pyr = gaussianPyramid(p, 5)
    expect(pyr.length).toBe(1)
    expect(pyr[0].width).toBe(1)
    expect(pyr[0].height).toBe(1)
  })

  it('gaussianPyramid clamps levels for 1xN images without crashing', () => {
    const p = makePlane(1, 100, 0.5)
    // Request 10 levels but should be clamped based on height
    const pyr = gaussianPyramid(p, 10)
    expect(pyr.length).toBeLessThan(10)
    // All levels should have width=1
    for (const level of pyr) expect(level.width).toBe(1)
    // Heights should be monotonically non-increasing
    for (let i = 1; i < pyr.length; i++) {
      expect(pyr[i].height).toBeLessThanOrEqual(pyr[i - 1].height)
    }
  })

  it('laplacianPyramid works correctly with clamped levels for 1xN images', () => {
    const p = makePlane(1, 100, 0.5)
    // Request more levels than possible
    const lap = laplacianPyramid(p, 10)
    expect(lap.length).toBeLessThan(10)
    // All levels should have width=1
    for (const level of lap) expect(level.width).toBe(1)
  })

  it('laplacianPyramid reconstruction matches original for normal image (regression test)', () => {
    // Normal 32x32 image with some pattern
    const w = 32, h = 32
    const p = makePlane(w, h, 0.5)
    const pyr = laplacianPyramid(p, 5)
    const reconstructed = collapseLaplacian(pyr)

    // Compare pixel-by-pixel with high precision since we're dealing with floats
    expect(reconstructed.width).toBe(w)
    expect(reconstructed.height).toBe(h)
    expect(reconstructed.data.length).toBe(w * h)

    // Check that reconstruction is close (within float precision)
    for (let i = 0; i < reconstructed.data.length; i++) {
      expect(reconstructed.data[i]).toBeCloseTo(p.data[i], 5)
    }
  })

  it('laplacianPyramid reconstruction matches original for 1x1 image', () => {
    const p = makePlane(1, 1, 0.5)
    const pyr = laplacianPyramid(p, 3)
    const reconstructed = collapseLaplacian(pyr)

    expect(reconstructed.width).toBe(1)
    expect(reconstructed.height).toBe(1)
    expect(reconstructed.data[0]).toBeCloseTo(p.data[0], 5)
  })

  it('laplacianPyramid handles 1xN image without crashing (single level, no filtering)', () => {
    const w = 1, h = 100
    const p = makePlane(w, h, 0.5)
    const pyr = laplacianPyramid(p, 10)  // Request more, but pyrDown stops at dimensions < 3
    const reconstructed = collapseLaplacian(pyr)

    expect(reconstructed.width).toBe(w)
    expect(reconstructed.height).toBe(h)
    // Single-level pyramid: just returns the original data unchanged
    expect(pyr.length).toBe(1)
    expect(reconstructed.data[0]).toBe(p.data[0])
  })

  it('laplacianPyramid handles Nx1 image without crashing (single level, no filtering)', () => {
    const w = 100, h = 1
    const p = makePlane(w, h, 0.5)
    const pyr = laplacianPyramid(p, 10)  // Request more, but pyrDown stops at dimensions < 3
    const reconstructed = collapseLaplacian(pyr)

    expect(reconstructed.width).toBe(w)
    expect(reconstructed.height).toBe(h)
    // Single-level pyramid: just returns the original data unchanged
    expect(pyr.length).toBe(1)
    expect(reconstructed.data[0]).toBe(p.data[0])
  })
})
