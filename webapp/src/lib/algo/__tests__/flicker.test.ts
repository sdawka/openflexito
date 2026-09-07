import { describe, it, expect } from 'vitest'
import { analyseFlicker, distinctFrames, describeFlicker } from '../flicker'

const H = 240
function profiles(n: number, band: (i: number, y: number) => number, mean: (i: number) => number = () => 0): Float32Array[] {
  const out: Float32Array[] = []
  for (let i = 0; i < n; i++) {
    const p = new Float32Array(H)
    for (let y = 0; y < H; y++) p[y] = 120 + 20 * Math.cos((y / H) * Math.PI) + band(i, y) + mean(i) + 0.3 * Math.sin(i * 12.9898 + y * 78.233)  // vignetting + band + a little noise so frames differ
    out.push(p)
  }
  return out
}

describe('flicker analysis', () => {
  it('reports a steady picture as clean', () => {
    const r = analyseFlicker(profiles(30, () => 0))
    expect(r.band.amp).toBeLessThan(0.5); expect(r.mean.rms).toBeLessThan(0.5); expect(r.partialPaints).toBe(0)
    expect(describeFlicker(r, 18).join(' ')).toContain('no horizontal banding')
  })
  it('finds a rolling band and its speed', () => {
    const period = 60, drift = 7                       // rows, rows per frame
    const r = analyseFlicker(profiles(40, (i, y) => 3 * Math.sin((2 * Math.PI * (y - drift * i)) / period)))
    expect(Math.abs(r.band.periodRows - period)).toBeLessThan(6)
    expect(r.band.amp).toBeGreaterThan(2)
    expect(Math.abs(r.band.driftRowsPerFrame - drift)).toBeLessThan(1.5)
    expect(describeFlicker(r, 18).join(' ')).toContain('rolling')
  })
  it('finds whole-frame pulsing', () => {
    const r = analyseFlicker(profiles(40, () => 0, (i) => 4 * Math.sin((2 * Math.PI * i) / 8)))
    expect(Math.abs(r.mean.periodFrames - 8)).toBeLessThan(0.5); expect(r.mean.amp).toBeGreaterThan(3)
  })
  it('collapses repeated samples and counts partial paints', () => {
    const a = profiles(1, () => 0)[0], b = profiles(1, () => 2)[0]
    const half = a.slice(); half.set(b.subarray(0, H / 2))   // top half new, bottom half old
    const { frames, partialPaints } = distinctFrames([a, a, a, half, b, b])
    expect(frames.length).toBe(3); expect(partialPaints).toBe(1)
  })
})
