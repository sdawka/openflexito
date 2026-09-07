import { describe, expect, it } from 'vitest'
import {
  distance, polylineLength, polygonArea, polygonPerimeter, angleDeg,
  umPerPixelFromStageCalibration, scaleForWidth, niceScaleBarLength, formatUm,
} from '../measure'

describe('measurement maths', () => {
  it('distance and polyline length', () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
    expect(polylineLength([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 0 }])).toBe(9)
  })

  it('polygon area via shoelace (unit square)', () => {
    const sq = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
    expect(Math.abs(polygonArea(sq))).toBe(100)
    expect(polygonPerimeter(sq)).toBe(40)
  })

  it('polygon area for a triangle', () => {
    const tri = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 3 }]
    expect(Math.abs(polygonArea(tri))).toBe(6)
    expect(polygonPerimeter(tri)).toBeCloseTo(4 + 3 + 5, 6)
  })

  it('angle at the middle point', () => {
    expect(angleDeg({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(90, 6)
    expect(angleDeg({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: -1, y: 0 })).toBeCloseTo(180, 6)
    expect(angleDeg({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(0, 6)
  })

  it('derives µm/px from a stage calibration', () => {
    // 10 px of image motion per stage step along both axes, 0.1 µm/step -> 0.01 µm/px
    const um = umPerPixelFromStageCalibration([10, 0], [0, 10], 0.1, 0.1)
    expect(um).toBeCloseTo(0.01, 9)
    expect(umPerPixelFromStageCalibration([0, 0], [0, 10], 0.1, 0.1)).toBeNull()
  })

  it('rescales µm/px between image widths', () => {
    expect(scaleForWidth(0.1, 820, 3280)).toBeCloseTo(0.025, 9)   // full res is 4x more pixels -> 4x finer
  })

  it('picks a nice round scale bar length that fits the budget', () => {
    const bar = niceScaleBarLength(0.5, 200)!   // budget = 100 µm across
    expect([1, 2, 5]).toContain(bar.um / 10 ** Math.floor(Math.log10(bar.um)))
    expect(bar.um).toBeLessThanOrEqual(100)
    expect(bar.px).toBeCloseTo(bar.um / 0.5, 9)
    expect(niceScaleBarLength(0, 100)).toBeNull()
  })

  it('formats µm/mm labels', () => {
    expect(formatUm(50)).toBe('50 µm')
    expect(formatUm(2500)).toBe('2.5 mm')
    expect(formatUm(1000)).toBe('1 mm')
  })
})
