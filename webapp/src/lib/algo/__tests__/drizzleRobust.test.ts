import { describe, expect, it } from 'vitest'
import { drizzle } from '../drizzle'
import { drizzleRobust, robustWeightMap, type RobustDrizzleFrame } from '../drizzleRobust'
import { makeScene } from './helpers/scene'
import type { Gray } from '../sharpness'

// Wronski et al. 2019 robustness: a frame's contribution falls to zero where it disagrees with the
// reference beyond the noise, so a specimen that moved inside the drizzle window is not smeared into
// the output, while a static scene is drizzled exactly as before.

const W = 64, H = 48
const SHIFTS: [number, number][] = [[0.3, 0.2], [-0.4, 0.35], [0.15, -0.45], [0, 0]]   // last = reference

function frames(scene = makeScene(W, H, { seed: 11 })): (RobustDrizzleFrame & { gray: Gray })[] {
  return SHIFTS.map(([sx, sy]) => ({ data: scene.rgba(W, H, sx, sy), gray: scene.gray(W, H, sx, sy), width: W, height: H, dx: sx, dy: sy }))
}

function paintSquare(f: { data: Uint8ClampedArray }, x0: number, y0: number, side: number, v: number): void {
  for (let y = y0; y < y0 + side; y++) for (let x = x0; x < x0 + side; x++) { const i = (y * W + x) * 4; f.data[i] = v; f.data[i + 1] = v; f.data[i + 2] = v }
}

function withMaps(fs: (RobustDrizzleFrame & { gray: Gray })[], k = 3): { fs: RobustDrizzleFrame[]; rejected: number[] } {
  const ref = fs[fs.length - 1], rejected: number[] = []
  const out = fs.map((f, i) => {
    if (i === fs.length - 1) return f
    const r = robustWeightMap(ref.gray, f.gray, f.dx - ref.dx, f.dy - ref.dy, { k })
    rejected.push(r.rejectedFrac)
    return { ...f, weightMap: r.map }
  })
  return { fs: out, rejected }
}

function meanAbsDiff(a: Uint8ClampedArray, b: Uint8ClampedArray, region?: (x: number, y: number) => boolean, w = W * 2): number {
  let s = 0, n = 0
  for (let i = 0; i < a.length; i += 4) {
    const p = i >> 2, x = p % w, y = (p / w) | 0
    if (region && !region(x, y)) continue
    s += Math.abs(a[i] - b[i]); n++
  }
  return s / n
}

describe('drizzleRobust', () => {
  it('leaves a static scene alone: weights ≈ 1 and the output matches plain drizzle', () => {
    const { fs, rejected } = withMaps(frames())
    for (const r of rejected) expect(r).toBeLessThan(0.02)
    const plain = drizzle(fs, 2, 0.6), robust = drizzleRobust(fs, 2, 0.6)
    expect(robust.width).toBe(plain.width)
    expect(meanAbsDiff(plain.data, robust.data)).toBeLessThan(0.5)
  })

  it('does not smear a square that appears in one non-reference frame', () => {
    const clean = frames()
    const cleanOut = drizzleRobust(withMaps(clean).fs, 2, 0.6)
    const moved = frames()
    paintSquare(moved[1], 20, 14, 12, 250)
    // the grey plane must see the same content as the RGBA (the worker derives it from the frame)
    for (let y = 14; y < 26; y++) for (let x = 20; x < 32; x++) moved[1].gray.data[y * W + x] = 250
    const inSquare = (x: number, y: number) => x >= 42 && x < 62 && y >= 30 && y < 50   // 2× grid, inset
    const plain = drizzle(moved, 2, 0.6)
    const { fs, rejected } = withMaps(moved)
    const robust = drizzleRobust(fs, 2, 0.6)
    const smear = meanAbsDiff(plain.data, cleanOut.data, inSquare)
    const residual = meanAbsDiff(robust.data, cleanOut.data, inSquare)
    expect(smear).toBeGreaterThan(15)          // plain drizzle averages the square in at ~1/4 weight
    expect(residual).toBeLessThan(smear / 8)   // robust drizzle rejects it
    expect(rejected[1]).toBeGreaterThan(0.03)  // ~144 of 3072 plane pixels plus a 1-px rim
    expect(rejected[1]).toBeLessThan(0.12)
    expect(rejected[0]).toBeLessThan(0.02)
    // outside the square the two agree
    expect(meanAbsDiff(robust.data, cleanOut.data, (x, y) => !(x >= 36 && x < 68 && y >= 24 && y < 56))).toBeLessThan(0.5)
  })

  it('equals single-frame upsampling of the reference when every other frame is rejected (no holes)', () => {
    const fs = frames()
    const zero = { data: new Float32Array(W * H), width: W, height: H }
    const rejectedAll: RobustDrizzleFrame[] = fs.map((f, i) => (i === fs.length - 1 ? f : { ...f, weightMap: zero }))
    const robust = drizzleRobust(rejectedAll, 2, 0.6)
    const single = drizzle([fs[fs.length - 1]], 2, 0.6)
    expect(robust.data).toEqual(single.data)
    for (let i = 3; i < robust.data.length; i += 4) expect(robust.data[i]).toBe(255)
  })

  it('fills cells no frame covers from the reference instead of leaving holes', () => {
    const fs = frames()
    const zero = { data: new Float32Array(W * H), width: W, height: H }
    const only: RobustDrizzleFrame[] = fs.map((f, i) => (i === fs.length - 1 ? f : { ...f, weightMap: zero }))
    // pixfrac 0.3 on a 3× grid: each drop covers only the central cell of its 3×3 block
    const r = drizzleRobust(only, 3, 0.3)
    expect(r.coverage).toBeLessThan(0.4)
    let dark = 0
    for (let i = 0; i < r.data.length; i += 4) if (r.data[i] === 0 && r.data[i + 1] === 0) dark++
    expect(dark).toBe(0)
  })

  it('samples a weight map of a different resolution than the frame', () => {
    const fs = frames()
    const small = { data: new Float32Array(16 * 12).fill(1), width: 16, height: 12 }
    // reject the right half of the plane
    for (let y = 0; y < 12; y++) for (let x = 8; x < 16; x++) small.data[y * 16 + x] = 0
    const withMap = fs.map((f, i) => (i === fs.length - 1 ? f : { ...f, weightMap: small }))
    paintSquare(fs[0], 40, 10, 8, 255)
    const r = drizzleRobust(withMap, 2, 0.6)
    const clean = drizzleRobust(fs.map((f, i) => (i === fs.length - 1 ? f : { ...f, weightMap: { ...small, data: new Float32Array(16 * 12).fill(1) } })), 2, 0.6)
    // the painted square lies in the rejected half: it must not show up
    expect(meanAbsDiff(r.data, drizzle([fs[3]], 2, 0.6).data, (x, y) => x >= 82 && x < 94 && y >= 22 && y < 34)).toBeLessThan(1)
    expect(meanAbsDiff(clean.data, drizzle([fs[3]], 2, 0.6).data, (x, y) => x >= 82 && x < 94 && y >= 22 && y < 34)).toBeGreaterThan(5)
  })
})
