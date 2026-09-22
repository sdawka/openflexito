import { describe, expect, it } from 'vitest'
import { SlidingMean, ExpIntegrator, TemporalMedian, QualityGate, frameSharpness } from '../videoStack'

function solid(v: number, n = 16): Uint8ClampedArray {
  const d = new Uint8ClampedArray(n * 4)
  for (let i = 0; i < d.length; i += 4) { d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255 }
  return d
}

describe('SlidingMean', () => {
  it('averages the last n frames and forgets older ones', () => {
    const m = new SlidingMean(4, 4, 3)
    m.push(solid(0)); m.push(solid(90))
    expect(m.push(solid(90))[0]).toBe(60)
    expect(m.push(solid(90))[0]).toBe(90)   // the 0 frame left the window
    expect(m.count).toBe(3)
  })
  it('keeps alpha opaque and warms up as a plain mean', () => {
    const m = new SlidingMean(4, 4, 8)
    const o = m.push(solid(200))
    expect(o[0]).toBe(200); expect(o[3]).toBe(255)
  })
})

describe('ExpIntegrator', () => {
  it('converges to a steady input and averages during warm-up', () => {
    const e = new ExpIntegrator(4, 4, 0.1)
    e.push(solid(0))
    expect(e.push(solid(100))[0]).toBe(50)   // 1/count during warm-up
    let o = e.out
    for (let i = 0; i < 100; i++) o = e.push(solid(100))
    expect(o[0]).toBeGreaterThan(98)
  })
})

describe('TemporalMedian', () => {
  it('median of 3 rejects a one-frame spike', () => {
    const t = new TemporalMedian(4, 4, 3)
    t.push(solid(50)); t.push(solid(50))
    expect(t.push(solid(250))[0]).toBe(50)
  })
  it('median of 5 rejects two outliers', () => {
    const t = new TemporalMedian(4, 4, 5)
    for (const v of [40, 250, 40, 0, 40]) t.push(solid(v))
    expect(t.out[0]).toBe(40)
  })
})

describe('frameSharpness', () => {
  it('scores a textured frame higher than a flat one', () => {
    const w = 32, h = 32
    const flat = solid(100, w * h)
    const tex = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; const v = ((x >> 2) + (y >> 2)) % 2 ? 200 : 20; tex[i] = tex[i + 1] = tex[i + 2] = v; tex[i + 3] = 255 }
    expect(frameSharpness(flat, w, h)).toBe(0)
    expect(frameSharpness(tex, w, h)).toBeGreaterThan(0.2)
  })
})

describe('QualityGate', () => {
  it('passes everything while warming up, then keeps roughly the top fraction', () => {
    const g = new QualityGate(0.3, 60, 8)
    for (let i = 0; i < 8; i++) expect(g.accept(i)).toBe(true)
    let kept = 0
    for (let i = 0; i < 200; i++) if (g.accept(Math.random() * 100)) kept++
    expect(kept / 200).toBeGreaterThan(0.2)
    expect(kept / 200).toBeLessThan(0.45)
  })
})
