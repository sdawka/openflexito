import { describe, it, expect } from 'vitest'
import { LegGrouper, SweepFuser, deadBandEnd, deadBandFraction, usefulFraction, legMidTime, legPeakStep, suggestBacklash, type SweepLegStart } from '../sweepFuse'

function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

function image(w: number, h: number, lum: (x: number, y: number) => number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = lum(x, y), p = (y * w + x) * 4
    out[p] = v; out[p + 1] = v; out[p + 2] = v; out[p + 3] = 255
  }
  return out
}

/** ±1 checker of 2 px cells (still a 1 px checker after the fuser's 2×2 averaging) */
const checker = (x: number, y: number) => (((x >> 1) + (y >> 1)) & 1 ? 1 : -1)

describe('LegGrouper', () => {
  const leg = (n: number, t_ack: number): SweepLegStart => ({ leg: n, t_cmd: t_ack - 10, t_ack, steps: 400, step_us: 250 })

  it('assigns frames by time, including frames that arrive after the leg end', () => {
    const g = new LegGrouper()
    expect(g.frame(500).group).toBeNull() // before any leg
    g.startLeg(leg(0, 1000))
    expect(g.frame(1100).group?.leg).toBe(0)
    expect(g.endLeg({ leg: 0, t_end: 1500 })).toEqual([])
    const late = g.frame(1400) // exposed during the leg, delivered after leg_end
    expect(late.group?.leg).toBe(0)
    expect(late.completed).toEqual([])
    const after = g.frame(1600) // between legs: belongs to none, completes leg 0
    expect(after.group).toBeNull()
    expect(after.completed.map((c) => c.leg)).toEqual([0])
    g.startLeg(leg(1, 1700))
    expect(g.frame(1650).group).toBeNull()
    expect(g.frame(1800).group?.leg).toBe(1)
    expect(g.flush().map((c) => c.leg)).toEqual([1])
  })

  it('completes a leg at once when its end arrives after a later frame', () => {
    const g = new LegGrouper()
    g.startLeg(leg(0, 0))
    g.frame(100); g.frame(300)
    expect(g.endLeg({ leg: 0, t_end: 200 }).map((c) => c.leg)).toEqual([0])
  })

  it('ends a leg whose end record was lost where the next one was commanded', () => {
    const g = new LegGrouper()
    g.startLeg(leg(0, 0))
    g.frame(100)
    g.startLeg(leg(1, 1000))
    const r = g.frame(995) // after leg 0's implicit end (990), before leg 1's t_ack
    expect(r.completed.map((c) => [c.leg, c.t1])).toEqual([[0, 990]])
    expect(r.group).toBeNull()
  })

  it('groups by fixed time windows when there are no legs (steps = 0)', () => {
    const g = new LegGrouper({ windowMs: 150 })
    const ms = 1e6
    const a = g.frame(10 * ms), b = g.frame(140 * ms)
    expect(a.group).toBe(b.group)
    expect(a.group?.leg).toBeNull()
    const c = g.frame(160 * ms)
    expect(c.completed).toEqual([a.group])
    expect(c.group).not.toBe(a.group)
    // the first leg record closes the window and switches to legs
    expect(g.startLeg(leg(0, 200 * ms))).toEqual([c.group])
    expect(g.frame(210 * ms).group?.leg).toBe(0)
  })

  it('without windowMs, frames before any leg belong to none', () => {
    expect(new LegGrouper().frame(1e9).group).toBeNull()
  })
})

describe('backlash dead band', () => {
  const l: SweepLegStart = { leg: 0, t_ack: 0, steps: -400, step_us: 250 } // 100 ms leg
  it('models the first backlash steps as not moving', () => {
    expect(deadBandEnd(l, 200)).toBe(50e6)
    expect(deadBandFraction(l, { leg: 0, t_end: 100e6 }, 200)).toBeCloseTo(0.5)
    expect(deadBandFraction(l, undefined, 0)).toBe(0)
    const times = Array.from({ length: 20 }, (_, i) => i * 5e6)
    expect(usefulFraction(times, l, 200)).toBeCloseTo(0.5)
    expect(legMidTime(l, { leg: 0, t_end: 100e6 }, 200)).toBe(75e6)
  })

  it('estimates the backlash from the focus peaks of up and down legs', () => {
    const S = 400, b = 150, zStar = 100, stepUs = 250
    const peaks: { dir: number; peakStep: number }[] = []
    for (let k = 0; k < 8; k++) {
      const dir = k % 2 ? -1 : 1, leg: SweepLegStart = { leg: k, t_ack: k * 1e9, steps: dir * S, step_us: stepUs }
      const times: number[] = [], focus: number[] = []
      for (let s = 0; s <= S; s += 7) {
        const moved = Math.max(0, s - b), z = dir > 0 ? moved : S - b - moved
        times.push(leg.t_ack + s * stepUs * 1e3)
        focus.push(1 + 10 * Math.exp(-(((z - zStar) / 25) ** 2)) + 0.05 * Math.sin(s + k))
      }
      const p = legPeakStep(times, focus, leg)
      expect(p).not.toBeNull()
      peaks.push({ dir, peakStep: p! })
    }
    expect(Math.abs(suggestBacklash(peaks, S)! - b)).toBeLessThanOrEqual(3)
    expect(suggestBacklash(peaks.slice(0, 4), S)).toBeNull() // two per direction is not enough
  })

  it('finds no peak in a flat curve', () => {
    const times = Array.from({ length: 20 }, (_, i) => i * 1e6)
    expect(legPeakStep(times, times.map(() => 1), { leg: 0, t_ack: 0, steps: 100, step_us: 100 })).toBeNull()
  })
})

describe('SweepFuser', () => {
  it('takes each block from the frame where it is sharp', () => {
    const w = 128, h = 96, n = 9, cell = 16, cx = w / cell
    const sharpOf = (bx: number, by: number) => (bx * 2 + by * 3) % n
    const frames: Uint8ClampedArray[] = []
    const f = new SweepFuser(w, h, { cell })
    for (let k = 0; k < n; k++) {
      const img = image(w, h, (x, y) => {
        const d = Math.abs(k - sharpOf(x >> 4, y >> 4))
        return 128 + checker(x, y) * (d === 0 ? 100 : d === 1 ? 30 : 10)
      })
      frames.push(img); f.add(img, k * 1e6)
    }
    const r = f.finish()!
    expect(r.frames).toBe(n)
    expect(r.flatBlocks).toBe(0)
    for (let by = 0; by < h / cell; by++) for (let bx = 0; bx < cx; bx++) {
      const s = sharpOf(bx, by)
      expect(r.chosen[by * cx + bx]).toBe(s)
      for (const [x, y] of [[bx * 16 + 8, by * 16 + 8], [bx * 16 + 9, by * 16 + 7]]) {
        const p = (y * w + x) * 4
        expect(Math.abs(r.composite[p] - frames[s][p])).toBeLessThan(15)
      }
    }
    expect(f.count).toBe(0) // cleared for the next leg
    expect(f.finish()).toBeNull()
  })

  it('a flat block takes the frame nearest the middle, however the noise falls', () => {
    const w = 96, h = 96, n = 9, rnd = mulberry32(3)
    const f = new SweepFuser(w, h, { cell: 16 })
    for (let k = 0; k < n; k++) {
      f.add(image(w, h, (x, y) => (x < 64 && y < 64 ? 90 + 4 * rnd() : 128 + checker(x, y) * (k === 1 ? 100 : 20))), k * 1e6)
    }
    const r = f.finish()!
    for (const c of [0, 1, 6, 7]) expect(r.chosen[c]).toBe(4)
    expect(r.tMid).toBe(4e6)
    expect(r.flatBlocks).toBeGreaterThanOrEqual(4)
    expect(r.chosen[35]).toBe(1) // textured blocks still take their sharp frame
  })

  it('an explicit reference time moves the fallback frame', () => {
    const f = new SweepFuser(32, 32)
    for (let k = 0; k < 5; k++) f.add(image(32, 32, () => 100), k * 10)
    const r = f.finish(31)!
    expect([...r.chosen]).toEqual([3, 3, 3, 3])
    expect(r.flatBlocks).toBe(4)
  })

  it('a noise-only scene does not flicker: nearly every block is flat', () => {
    const w = 160, h = 128, n = 32, rnd = mulberry32(11)
    const f = new SweepFuser(w, h)
    for (let k = 0; k < n; k++) f.add(image(w, h, () => 100 + 12 * (rnd() - 0.5)), k * 1e6)
    const r = f.finish()!
    expect(r.flatBlocks / r.chosen.length).toBeGreaterThan(0.9)
  })

  it('does not ghost: a moving square appears once, where it was at the reference time', () => {
    const w = 320, h = 96, n = 7, rnd = mulberry32(5), side = 24, y0 = 36
    const at = (k: number) => 8 + 40 * k
    const f = new SweepFuser(w, h)
    for (let k = 0; k < n; k++) {
      // the square is sharpest in frame 1, but the reference (middle) frame is 3
      const amp = k === 1 ? 50 : 15
      f.add(image(w, h, (x, y) => {
        const inside = x >= at(k) && x < at(k) + side && y >= y0 && y < y0 + side
        return inside ? 200 + checker(x, y) * amp : 10 + 4 * rnd()
      }), k * 1e6)
    }
    const r = f.finish()!
    expect(r.tMid).toBe(3e6)
    const bright = new Set<number>()
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (r.composite[(y * w + x) * 4] > 100) bright.add(x)
    const xs = [...bright]
    expect(xs.length).toBeGreaterThan(side - 4)
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(at(3) - 2)
    expect(Math.max(...xs)).toBeLessThan(at(3) + side + 2)
    expect(r.motionBlocks).toBeGreaterThan(0)
  })

  it('subsamples a leg longer than maxFrames', () => {
    const f = new SweepFuser(32, 32, { maxFrames: 8 })
    for (let k = 0; k < 20; k++) f.add(image(32, 32, () => 50), k)
    const r = f.finish()!
    expect(r.frames).toBeLessThanOrEqual(8)
    expect([...r.times]).toEqual([0, 4, 8, 12, 16])
  })

  it('runs add in ≲2 ms and finish in ≲10 ms at 640×480 (generous CI budget)', () => {
    const w = 640, h = 480, n = 40, rnd = mulberry32(1)
    const base = image(w, h, (x, y) => 128 + 60 * Math.sin(x * 0.3) * Math.cos(y * 0.23))
    const frames = Array.from({ length: n }, (_, k) => {
      const img = new Uint8ClampedArray(base)
      for (let i = 0; i < img.length; i += 4) { const v = img[i] + (rnd() - 0.5) * 8 * (1 + (k % 5)); img[i] = v; img[i + 1] = v; img[i + 2] = v }
      return img
    })
    const f = new SweepFuser(w, h)
    // warm-up leg (JIT), then time a full leg
    for (let k = 0; k < 8; k++) f.add(frames[k], k)
    f.finish()
    const adds: number[] = [], fins: number[] = []
    for (let rep = 0; rep < 3; rep++) {
      for (let k = 0; k < n; k++) { const t = performance.now(); f.add(frames[k], k * 1e6); adds.push(performance.now() - t) }
      const t = performance.now(); f.finish(); fins.push(performance.now() - t)
    }
    const med = (a: number[]) => [...a].sort((x, y) => x - y)[a.length >> 1]
    // eslint-disable-next-line no-console
    console.log(`SweepFuser @ 640x480: add ${med(adds).toFixed(2)} ms median of ${adds.length}, finish (${n} frames) ${med(fins).toFixed(2)} ms median of ${fins.length}`)
    expect(med(adds)).toBeLessThan(8)
    expect(med(fins)).toBeLessThan(40)
  })
})
