import { describe, expect, it } from 'vitest'
import { GridFlow, renderFlowHsv } from '../opticalFlow'

const W = 128, H = 96
function texture(shift: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = 128 + 60 * Math.sin((x - shift) * 0.5) * Math.cos(y * 0.45)
    const i = (y * W + x) * 4; d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255
  }
  return d
}

describe('GridFlow', () => {
  it('recovers a rightward shift of a textured field', () => {
    const gf = new GridFlow(W, H, { analysisWidth: 128, cell: 8, alpha: 1, tau: 5 })
    gf.update(texture(0))
    const f = gf.update(texture(1.5))
    const st = gf.stats()
    expect(st.validFrac).toBeGreaterThan(0.5)
    expect(st.meanSpeed).toBeGreaterThan(0.8); expect(st.meanSpeed).toBeLessThan(2.5)
    expect(Math.abs(st.directionDeg)).toBeLessThan(25)
    const out = new Uint8ClampedArray(W * H * 4)
    renderFlowHsv(texture(1.5), W, H, f, out)
    const i = (48 * W + 64) * 4
    expect(Math.max(out[i], out[i + 1], out[i + 2]) - Math.min(out[i], out[i + 1], out[i + 2])).toBeGreaterThan(40)
  })
})
