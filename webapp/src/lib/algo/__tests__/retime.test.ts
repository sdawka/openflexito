import { describe, expect, it } from 'vitest'
import { Retimer, outputTimeAt, speedAt, normaliseKeyframes } from '../retime'

// Irregular input timing like the device's MJPEG stream: ~18 fps with jitter, an occasional long gap
// (a dropped part) and a duplicated timestamp.
function jittered(n: number, fps = 18, seed = 3): number[] {
  let s = seed >>> 0
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 }
  const out: number[] = []
  let t = 10 // arbitrary origin: device time is CLOCK_BOOTTIME, never 0
  for (let i = 0; i < n; i++) {
    out.push(t)
    t += (1 + (rnd() - 0.5) * 0.4) / fps
    if (i % 23 === 22) t += 3 / fps  // a gap
    if (i % 31 === 30) out.push(t - 1e-9) // near-duplicate timestamp
  }
  return out
}

function strictlyIncreasing(ts: number[]): boolean {
  for (let i = 1; i < ts.length; i++) if (!(ts[i] > ts[i - 1])) return false
  return true
}

describe('Retimer vfr', () => {
  it('is the identity on well-ordered input', () => {
    const r = new Retimer({ mode: 'vfr' })
    for (const t of [5, 5.05, 5.11]) { const o = r.push(t); expect(o.emit).toBe(true); expect(o.tOut).toBe(t); expect(o.duplicates).toBe(0) }
    expect(r.stats()).toEqual({ pushed: 3, emitted: 3, duplicates: 0, dropped: 0 })
  })

  it('forces strictly increasing output on equal or reversed input times', () => {
    const r = new Retimer({ mode: 'vfr' })
    const a = r.push(1), b = r.push(1), c = r.push(0.9), d = r.push(1.1)
    expect(b.tOut).toBeGreaterThan(a.tOut)
    expect(c.tOut).toBeGreaterThan(b.tOut)
    expect(d.tOut).toBe(1.1)
    expect(b.tOut - a.tOut).toBeCloseTo(1e-6, 9)
  })

  it('drops a non-finite time', () => {
    const r = new Retimer({ mode: 'vfr' })
    expect(r.push(NaN).emit).toBe(false)
    expect(r.stats().dropped).toBe(1)
  })
})

describe('Retimer cfr', () => {
  it('requires fps', () => { expect(() => new Retimer({ mode: 'cfr' })).toThrow() })

  it('places frames on the slot grid, drops early frames and reports skipped slots as duplicates', () => {
    const r = new Retimer({ mode: 'cfr', fps: 10 })
    const t0 = 100
    const seq: [number, boolean, number, number][] = [
      // input, emit, tOut (rel), duplicates
      [0, true, 0, 0],
      [0.03, false, 0, 0],
      [0.11, true, 0.1, 0],
      [0.19, false, 0, 0],
      [0.35, true, 0.3, 1],   // slot 2 (0.2) missed → one duplicate
      [0.4, true, 0.4, 0],    // exactly on a slot
      [0.61, true, 0.6, 1],   // slot 5 missed
    ]
    for (const [dt, emit, rel, dups] of seq) {
      const o = r.push(t0 + dt)
      expect(o.emit).toBe(emit)
      if (emit) {
        expect(o.tOut).toBeCloseTo(t0 + rel, 9)
        expect(o.duplicates).toBe(dups)
        expect(o.duplicateTimes.length).toBe(dups)
        for (const d of o.duplicateTimes) expect(d).toBeLessThan(o.tOut)
        if (dups) expect(o.duplicateTimes[0]).toBeCloseTo(t0 + rel - 0.1, 9)
      }
    }
    // input time going backwards is clamped, so this lands on the already-filled slot 6: dropped
    expect(r.push(t0 + 0.35).emit).toBe(false)
    expect(r.stats()).toEqual({ pushed: 8, emitted: 7, duplicates: 2, dropped: 3 })
  })

  it('on jittered ~18 fps input to 15 fps output every emitted or duplicated time is an exact slot and the sequence is strictly increasing', () => {
    const fps = 15
    const r = new Retimer({ mode: 'cfr', fps })
    const input = jittered(200)
    const times: number[] = []
    for (const t of input) {
      const o = r.push(t)
      if (!o.emit) continue
      times.push(...o.duplicateTimes, o.tOut)
    }
    expect(strictlyIncreasing(times)).toBe(true)
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeCloseTo(1 / fps, 9)
    // slot count = spanned time × fps (+1 for slot 0)
    const span = input[input.length - 1] - input[0]
    expect(times.length).toBe(Math.floor(span * fps + 1e-6) + 1)
    const st = r.stats()
    expect(st.emitted).toBe(times.length)
    expect(st.pushed - st.dropped + st.duplicates).toBe(st.emitted)
  })

  it('to 30 fps from ~18 fps input, most emitted frames carry a duplicate and nothing is dropped', () => {
    const r = new Retimer({ mode: 'cfr', fps: 30 })
    const input = jittered(100)
    let emitted = 0
    for (const t of input) if (r.push(t).emit) emitted++
    const st = r.stats()
    expect(st.dropped).toBeLessThan(5)  // only the near-duplicate timestamps
    expect(st.duplicates).toBeGreaterThan(emitted * 0.4)
  })

  it('reset() starts a new slot grid', () => {
    const r = new Retimer({ mode: 'cfr', fps: 10 })
    r.push(0); r.push(0.5)
    r.reset()
    const o = r.push(7)
    expect(o.emit).toBe(true); expect(o.tOut).toBe(7); expect(o.duplicates).toBe(0)
    expect(r.stats().pushed).toBe(1)
  })
})

describe('speed ramp maths', () => {
  it('speedAt interpolates linearly and holds the end values', () => {
    const kf = normaliseKeyframes([{ tIn: 4, speed: 3 }, { tIn: 2, speed: 1 }])  // unsorted on purpose
    expect(kf[0].tIn).toBe(2)
    expect(speedAt(kf, 0)).toBe(1)
    expect(speedAt(kf, 3)).toBe(2)
    expect(speedAt(kf, 10)).toBe(3)
  })

  it('outputTimeAt: constant speed, linear ramp (ln), holds before/after', () => {
    expect(outputTimeAt([], 5)).toBe(5)
    expect(outputTimeAt([{ tIn: 0, speed: 2 }], 5)).toBeCloseTo(2.5, 12)
    // speed 1 → 3 over 0..2 s: ∫₀² dt/(1 + t) = ln 3
    const ramp = [{ tIn: 0, speed: 1 }, { tIn: 2, speed: 3 }]
    expect(outputTimeAt(ramp, 2)).toBeCloseTo(Math.log(3), 10)
    expect(outputTimeAt(ramp, 1)).toBeCloseTo(Math.log(2), 10)
    // after the last keyframe the speed holds at 3
    expect(outputTimeAt(ramp, 5)).toBeCloseTo(Math.log(3) + 3 / 3, 10)
    // before the first keyframe the speed holds at its value
    const late = [{ tIn: 1, speed: 4 }, { tIn: 3, speed: 4 }]
    expect(outputTimeAt(late, 0.5)).toBeCloseTo(0.125, 12)
    expect(outputTimeAt(late, 4)).toBeCloseTo(1, 12)
  })

  it('outputTimeAt is monotone non-decreasing and continuous across keyframes', () => {
    const kf = [{ tIn: 0, speed: 1 }, { tIn: 3, speed: 1 }, { tIn: 4, speed: 60 }, { tIn: 8, speed: 60 }, { tIn: 11, speed: 1 }, { tIn: 11, speed: 0.5 }]
    let prev = 0
    for (let t = 0; t <= 15; t += 0.01) {
      const o = outputTimeAt(kf, t)
      expect(o).toBeGreaterThanOrEqual(prev - 1e-12)
      expect(o - prev).toBeLessThan(0.01 / 0.5 + 1e-9)  // never faster than the slowest speed
      prev = o
    }
    // real time for 3 s, a 1 s ramp to 60× then 4 s at 60×: the compressed part adds little
    expect(outputTimeAt(kf, 3)).toBeCloseTo(3, 10)
    expect(outputTimeAt(kf, 8) - outputTimeAt(kf, 3)).toBeCloseTo(Math.log(60) / 59 + 4 / 60, 10)
  })
})

describe('Retimer ramp', () => {
  it('compresses time by the speed and keeps every frame without an fps', () => {
    const r = new Retimer({ mode: 'ramp', keyframes: [{ tIn: 0, speed: 4 }] })
    const input = jittered(60)
    const outs: number[] = []
    for (const t of input) { const o = r.push(t); expect(o.emit).toBe(true); outs.push(o.tOut) }
    expect(strictlyIncreasing(outs)).toBe(true)
    // the near-duplicate input times are nudged by 1 µs, all others sit at t0 + Δ/4
    for (let i = 0; i < input.length; i++) expect(Math.abs(outs[i] - (input[0] + (input[i] - input[0]) / 4))).toBeLessThan(2e-6)
  })

  it('with an fps, keeps a frame only when the output advanced by ≥ 1/fps (a 60× stretch does not flood the encoder)', () => {
    const fps = 18
    const kf = [{ tIn: 0, speed: 1 }, { tIn: 2, speed: 1 }, { tIn: 4, speed: 60 }, { tIn: 10, speed: 60 }, { tIn: 12, speed: 1 }]
    const r = new Retimer({ mode: 'ramp', fps, keyframes: kf })
    const input: number[] = []
    for (let t = 0; t < 14; t += 1 / fps) input.push(50 + t)
    const outs: number[] = []
    let keptRealTime = 0, keptFast = 0
    for (const t of input) {
      const o = r.push(t)
      if (!o.emit) continue
      outs.push(o.tOut)
      const rel = t - 50
      if (rel < 2) keptRealTime++
      else if (rel > 4.5 && rel < 10) keptFast++
    }
    expect(strictlyIncreasing(outs)).toBe(true)
    for (let i = 1; i < outs.length; i++) expect(outs[i] - outs[i - 1]).toBeGreaterThanOrEqual(1 / fps - 1e-9)
    expect(keptRealTime).toBeGreaterThanOrEqual(35)   // essentially every real-time frame
    // 5.5 s at 60× is 0.092 s of output: at most a couple of frames kept
    expect(keptFast).toBeLessThanOrEqual(2)
    expect(r.stats().dropped).toBeGreaterThan(80)
  })

  it('a ramp with no keyframes is real time', () => {
    const r = new Retimer({ mode: 'ramp', keyframes: [] })
    r.push(3); expect(r.push(3.5).tOut).toBe(3.5)
  })
})
