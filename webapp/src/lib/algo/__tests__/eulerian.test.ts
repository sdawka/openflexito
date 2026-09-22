import { describe, expect, it } from 'vitest'
import { EulerianMagnifier } from '../eulerian'

const W = 32, H = 32
function frame(v: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4)
  for (let i = 0; i < d.length; i += 4) { d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255 }
  return d
}

describe('EulerianMagnifier', () => {
  it('amplifies a small 2 Hz intensity oscillation inside the band and ignores a constant', () => {
    const m = new EulerianMagnifier(W, H, { factor: 4, fLo: 0.5, fHi: 6, alpha: 10, maxDelta: 100 })
    const out = new Uint8ClampedArray(W * H * 4)
    let maxDev = 0
    for (let k = 0; k < 120; k++) {
      const t = k / 20
      m.update(frame(128 + Math.round(2 * Math.sin(2 * Math.PI * 2 * t))), t, out)
      if (k > 40) maxDev = Math.max(maxDev, Math.abs(out[0] - 128))
    }
    expect(maxDev).toBeGreaterThan(8)   // 2-unit swing amplified well beyond itself
    const s = new EulerianMagnifier(W, H, { factor: 4, fLo: 0.5, fHi: 6, alpha: 10, maxDelta: 100 })
    for (let k = 0; k < 60; k++) s.update(frame(128), k / 20, out)
    expect(out[0]).toBe(128)
  })
})
