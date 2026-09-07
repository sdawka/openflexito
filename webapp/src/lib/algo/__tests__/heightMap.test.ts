import { describe, expect, it } from 'vitest'
import { fitPlane, planeZ, rejectOutliers, buildSubGrid, bilinearZ, predictHeightMap, heightColor, subGridIndices, isSubGridCell, type HeightSample } from '../heightMap'

describe('height map: plane fit', () => {
  it('recovers an exact plane from noiseless samples', () => {
    const truth = { a: 12, b: -7, c: 1000 }
    const samples: HeightSample[] = []
    for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) samples.push({ col, row, z: planeZ(truth, col, row) })
    const fit = fitPlane(samples)
    expect(fit.a).toBeCloseTo(truth.a, 6)
    expect(fit.b).toBeCloseTo(truth.b, 6)
    expect(fit.c).toBeCloseTo(truth.c, 6)
  })

  it('falls back to the mean with fewer than 3 samples', () => {
    const fit = fitPlane([{ col: 0, row: 0, z: 100 }, { col: 1, row: 0, z: 200 }])
    expect(fit.a).toBe(0); expect(fit.b).toBe(0); expect(fit.c).toBe(150)
  })

  it('least-squares fit stays close to the true plane under small perturbations', () => {
    const truth = { a: 5, b: 3, c: 0 }
    const samples: HeightSample[] = [
      { col: 0, row: 0, z: 1 }, { col: 1, row: 0, z: 4 }, { col: 0, row: 1, z: 4 },
      { col: 1, row: 1, z: 7 }, { col: 2, row: 0, z: 11 }, { col: 0, row: 2, z: 5 },
    ]
    const fit = fitPlane(samples)
    expect(Math.abs(fit.a - truth.a)).toBeLessThan(2)
    expect(Math.abs(fit.b - truth.b)).toBeLessThan(2)
  })
})

describe('height map: outlier rejection', () => {
  it('drops a single wildly wrong sample and keeps the rest', () => {
    const truth = { a: 2, b: -1, c: 500 }
    const samples: HeightSample[] = []
    for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) samples.push({ col, row, z: planeZ(truth, col, row) })
    samples.push({ col: 1, row: 1, z: 999999 })   // dust on the coverslip, bogus autofocus reading
    // duplicate the good centre reading so the plane fit is not itself skewed by having only one bad point among few
    const kept = rejectOutliers(samples)
    expect(kept.some((s) => s.z === 999999)).toBe(false)
    expect(kept.length).toBe(samples.length - 1)
  })

  it('keeps everything when samples are consistent with a plane', () => {
    const truth = { a: 1, b: 1, c: 0 }
    const samples: HeightSample[] = []
    for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) samples.push({ col, row, z: planeZ(truth, col, row) })
    expect(rejectOutliers(samples).length).toBe(samples.length)
  })
})

describe('height map: bilinear interpolation', () => {
  it('reproduces the sub-grid values exactly at sub-grid nodes', () => {
    const samples: HeightSample[] = [
      { col: 0, row: 0, z: 0 }, { col: 4, row: 0, z: 40 }, { col: 0, row: 4, z: 400 }, { col: 4, row: 4, z: 440 },
    ]
    const grid = buildSubGrid(5, 5, 4, samples)
    expect(bilinearZ(grid, 0, 0)).toBeCloseTo(0)
    expect(bilinearZ(grid, 4, 0)).toBeCloseTo(40)
    expect(bilinearZ(grid, 0, 4)).toBeCloseTo(400)
    expect(bilinearZ(grid, 4, 4)).toBeCloseTo(440)
  })

  it('interpolates linearly between corners', () => {
    const samples: HeightSample[] = [{ col: 0, row: 0, z: 0 }, { col: 2, row: 0, z: 100 }, { col: 0, row: 2, z: 0 }, { col: 2, row: 2, z: 100 }]
    const grid = buildSubGrid(3, 3, 2, samples)
    expect(bilinearZ(grid, 1, 0)).toBeCloseTo(50)   // midpoint along a col gradient
    expect(bilinearZ(grid, 1, 1)).toBeCloseTo(50)
  })

  it('fills a missing sub-grid corner from the robust plane fit', () => {
    const truth = { a: 10, b: 0, c: 0 }
    // only 3 of the 4 corners of a 2x2 sub-grid measured, plus interior points on the true plane
    const samples: HeightSample[] = [
      { col: 0, row: 0, z: 0 }, { col: 4, row: 0, z: 40 }, { col: 0, row: 4, z: 0 },
      { col: 2, row: 0, z: 20 }, { col: 2, row: 4, z: 20 }, { col: 4, row: 2, z: 40 },
    ]
    const grid = buildSubGrid(5, 5, 4, samples)
    // the unmeasured corner (4,4) should be filled close to the true plane value (40)
    expect(grid.z[grid.subRows - 1][grid.subCols - 1]).toBeCloseTo(40, 0)
  })
})

describe('height map: full prediction', () => {
  it('bilinear mode predicts z for every tile of the grid', () => {
    const samples: HeightSample[] = [{ col: 0, row: 0, z: 0 }, { col: 2, row: 0, z: 20 }, { col: 0, row: 2, z: 0 }, { col: 2, row: 2, z: 20 }]
    const map = predictHeightMap(3, 3, samples, 'bilinear', 2)
    expect(map.length).toBe(3)
    expect(map[0].length).toBe(3)
    expect(map[0][0]).toBeCloseTo(0)
    expect(map[0][2]).toBeCloseTo(20)
    expect(map[1][1]).toBeCloseTo(10)
  })

  it('plane mode extrapolates a flat surface with too few samples', () => {
    const map = predictHeightMap(3, 3, [{ col: 0, row: 0, z: 50 }], 'plane')
    for (const row of map) for (const z of row) expect(z).toBeCloseTo(50)
  })
})

describe('height map: coarse sub-grid selection', () => {
  it('always includes 0 and the last index, spaced by step', () => {
    expect(subGridIndices(10, 3)).toEqual([0, 3, 6, 9])
    expect(subGridIndices(10, 4)).toEqual([0, 4, 8, 9])   // last index 9 forced in even though it is not a multiple of 4
    expect(subGridIndices(5, 1)).toEqual([0, 1, 2, 3, 4])
  })

  it('isSubGridCell agrees with subGridIndices on both axes', () => {
    const cols = 7, rows = 5, step = 3
    const colIdx = subGridIndices(cols, step), rowIdx = subGridIndices(rows, step)
    for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
      expect(isSubGridCell(col, row, cols, rows, step)).toBe(colIdx.includes(col) && rowIdx.includes(row))
    }
    // the four corners of the grid are always sub-grid cells
    expect(isSubGridCell(0, 0, cols, rows, step)).toBe(true)
    expect(isSubGridCell(cols - 1, rows - 1, cols, rows, step)).toBe(true)
  })
})

describe('height map: legend colour', () => {
  it('maps the extremes to the ends of the hue ramp and clamps out-of-range', () => {
    expect(heightColor(0, 0, 100)).toBe(heightColor(-50, 0, 100))
    expect(heightColor(100, 0, 100)).toBe(heightColor(200, 0, 100))
    expect(heightColor(0, 0, 100)).not.toBe(heightColor(100, 0, 100))
  })

  it('does not divide by zero when the range is flat', () => {
    expect(() => heightColor(5, 5, 5)).not.toThrow()
  })
})
