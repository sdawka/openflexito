import { describe, expect, it } from 'vitest'
import { IDENTITY, clampScale, cssTransform, normalize, panBy, pinchDistance, pinchMidpoint, zoomAt } from '../zoomPan'

describe('zoomPan', () => {
  it('clamps scale to [1, 8]', () => {
    expect(clampScale(0.2)).toBe(1)
    expect(clampScale(20)).toBe(8)
    expect(clampScale(3)).toBe(3)
  })

  it('zooming in keeps the anchor point fixed on screen', () => {
    const s = zoomAt(IDENTITY, 2, 100, 50)
    expect(s.scale).toBe(2)
    // the anchor (100,50) must map to itself: tx + scale*localX === px, where localX = (px-tx0)/scale0
    expect(s.tx + s.scale * ((100 - IDENTITY.tx) / IDENTITY.scale)).toBeCloseTo(100)
    expect(s.ty + s.scale * ((50 - IDENTITY.ty) / IDENTITY.scale)).toBeCloseTo(50)
  })

  it('zooming back out to 1x and normalizing snaps back to identity', () => {
    const zoomed = zoomAt(IDENTITY, 4, 100, 50)
    const back = zoomAt(zoomed, 0.25, 100, 50)
    expect(back.scale).toBe(1)
    expect(normalize(back)).toEqual(IDENTITY)
  })

  it('never zooms out past 1x even if asked to', () => {
    const s = zoomAt(IDENTITY, 0.1, 0, 0)
    expect(s.scale).toBe(1)
    expect(normalize(s)).toEqual(IDENTITY)
  })

  it('panBy just translates', () => {
    const s = panBy({ scale: 2, tx: 10, ty: 20 }, 5, -5)
    expect(s).toEqual({ scale: 2, tx: 15, ty: 15 })
  })

  it('pinch distance and midpoint', () => {
    expect(pinchDistance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5)
    expect(pinchMidpoint({ x: 0, y: 0 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 10 })
  })

  it('renders a CSS transform string', () => {
    expect(cssTransform({ scale: 2, tx: 3, ty: 4 })).toBe('translate(3px, 4px) scale(2)')
  })
})
