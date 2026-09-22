import { describe, expect, it } from 'vitest'
import { BurstMerge } from '../burstMerge'

const W = 32, H = 32
function noisy(base: number, sigma: number, spot?: { x: number; y: number; v: number }): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4)
  for (let p = 0; p < W * H; p++) { const v = base + (Math.random() - 0.5) * 2 * sigma * 1.7; d[p * 4] = d[p * 4 + 1] = d[p * 4 + 2] = v; d[p * 4 + 3] = 255 }
  if (spot) { const i = (spot.y * W + spot.x) * 4; d[i] = d[i + 1] = d[i + 2] = spot.v }
  return d
}

describe('BurstMerge', () => {
  it('averages a static noisy scene (count grows toward N_max) but keeps a sudden bright object', () => {
    const m = new BurstMerge({ maxFrames: 8, c: 4, maxShiftPx: 60 })
    let out = m.push(noisy(100, 6), W, H)
    for (let k = 0; k < 30; k++) out = m.push(noisy(100, 6), W, H)
    expect(m.meanCount).toBeGreaterThan(5)
    let dev = 0
    for (let p = 0; p < W * H; p++) dev += Math.abs(out[p * 4] - 100)
    expect(dev / (W * H)).toBeLessThan(4)   // one frame alone deviates ~5
    out = m.push(noisy(100, 6, { x: 10, y: 10, v: 250 }), W, H)
    expect(out[(10 * W + 10) * 4]).toBeGreaterThan(200)   // not smeared into the history
  })
  it('restarts on an implausible shift', () => {
    const m = new BurstMerge({ maxFrames: 8, c: 4, maxShiftPx: 10 })
    m.push(noisy(100, 2), W, H); m.push(noisy(100, 2), W, H)
    m.push(noisy(100, 2), W, H, { dx: 50, dy: 0 })
    expect(m.meanCount).toBe(1)
  })
})
