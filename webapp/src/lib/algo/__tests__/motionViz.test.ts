import { describe, expect, it } from 'vitest'
import { BackgroundModel, MotionHistory, TemporalColorCode } from '../motionViz'

const W = 16, H = 16
function frame(fill: number, spot?: { x: number; y: number; v: number }): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = fill; d[i + 3] = 255 }
  if (spot) { const i = (spot.y * W + spot.x) * 4; d[i] = d[i + 1] = d[i + 2] = spot.v }
  return d
}

describe('BackgroundModel', () => {
  it('highlights a pixel that departs from a steady background, in colour', () => {
    const bg = new BackgroundModel(W, H, 0.05)
    for (let i = 0; i < 10; i++) bg.update(frame(60))
    const diff = bg.update(frame(60, { x: 5, y: 5, v: 250 }))
    const out = new Uint8ClampedArray(W * H * 4)
    bg.highlight(frame(60, { x: 5, y: 5, v: 250 }), diff, out)
    const i = (5 * W + 5) * 4, j = 0
    expect(out[i]).toBeGreaterThan(out[i + 2])          // orange: R > B
    expect(out[j]).toBe(out[j + 1]); expect(out[j]).toBeLessThan(60)   // dimmed grey elsewhere
  })
})

describe('MotionHistory', () => {
  it('leaves a decaying trail behind a moving spot', () => {
    const m = new MotionHistory(W, H, 0.9)
    const out = new Uint8ClampedArray(W * H * 4)
    m.update(frame(60), out)
    m.update(frame(60, { x: 3, y: 8, v: 255 }), out)
    m.update(frame(60, { x: 6, y: 8, v: 255 }), out)
    m.update(frame(60, { x: 9, y: 8, v: 255 }), out)
    const at = (x: number) => out[(8 * W + x) * 4 + 1]   // green channel of the trail colour (200)
    expect(at(6)).toBe(200)                               // moved this frame or last: full trail colour
    expect(at(3)).toBeGreaterThan(100)                    // two frames old: decayed but still visible
    expect(at(3)).toBeLessThan(at(6))
    expect(out[(0) * 4 + 1]).toBe(60)                     // untouched background
  })
})

describe('TemporalColorCode', () => {
  it('colours motion, leaves the still background grey', () => {
    const t = new TemporalColorCode(W, H, 20, 1)
    const out = new Uint8ClampedArray(W * H * 4)
    t.update(frame(60), out)
    t.update(frame(60, { x: 2, y: 2, v: 255 }), out)
    const i = (2 * W + 2) * 4
    const sat = Math.max(out[i], out[i + 1], out[i + 2]) - Math.min(out[i], out[i + 1], out[i + 2])
    expect(sat).toBeGreaterThan(50)
    expect(out[0]).toBe(out[1]); expect(out[0]).toBe(out[2])
  })
})
