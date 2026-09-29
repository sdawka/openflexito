import { describe, it, expect } from 'vitest'
import { solveZCalibration, sweepPeak } from '../zCalibration'
import { samplesFromSweep, type Sample } from '../autofocus'
import { zAtTime } from '../sweepStack'
import type { FrameMeta } from '../types'

function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/** A stage with backlash b (a play operator: physical z stays within [cmd, cmd + b] of the commanded
 *  z in the up-engaged frame) and a camera whose frame stamped ts was exposed at ts + lag. */
class Rig {
  cmd = 0; phys = 0; t = 0
  frames: FrameMeta[] = []
  private seq = 0
  constructor(public b: number, public lagNs: number, public focus: number, public fps = 30, private noise = 0, private rnd = mulberry32(7)) {}

  private sharp(z: number): number { return 1000 + 600 * Math.exp(-(((z - this.focus) / 60) ** 2)) + this.noise * (this.rnd() - 0.5) }

  /** Raw move by dz at `stepUs` µs/step; records frames during it; returns t0/t1 and the end z. */
  move(dz: number, stepUs: number): { t0: number; t1: number; z0: number; z1: number } {
    const t0 = this.t, dur = Math.abs(dz) * stepUs * 1e3, z0 = this.cmd, frameNs = 1e9 / this.fps
    const cmdAt = (t: number) => z0 + dz * Math.min(1, Math.max(0, (t - t0) / dur))
    const physAt = (t: number, prev: number) => Math.min(Math.max(prev, cmdAt(t)), cmdAt(t) + this.b)
    // integrate the play operator finely, sampling exposures on the way
    let phys = this.phys
    const dt = Math.min(frameNs / 20, 1e6)
    let nextFrame = Math.ceil((t0 - this.lagNs) / frameNs) * frameNs + this.lagNs // exposure times on the frame grid
    for (let t = t0; t <= t0 + dur + frameNs; t += dt) {
      phys = physAt(t, phys)
      while (nextFrame <= t) {
        this.frames.push({ seq: this.seq++, size: this.sharp(phys), stream: 'main', ts: nextFrame - this.lagNs, t: nextFrame })
        nextFrame += frameNs
      }
    }
    this.phys = phys; this.cmd = z0 + dz; this.t = t0 + dur + frameNs
    return { t0, t1: t0 + dur, z0, z1: this.cmd }
  }

  peak(dz: number, stepUs: number) {
    const m = this.move(dz, stepUs)
    const s = samplesFromSweep(this.frames, m.t0, m.t1, m.z0, m.z1, 'jpeg')
    return { peak: sweepPeak(s).z, speed: Math.abs(dz) / (m.t1 - m.t0) }
  }
}

function calibrate(rig: Rig, span = 1000, slowUs = 6000, fastUs = 1000) {
  rig.move(-span / 2 - 400, fastUs); rig.move(400, fastUs)
  const up1 = rig.peak(span, slowUs), down = rig.peak(-span, slowUs), up2 = rig.peak(span, slowUs)
  rig.move(-span - 400, fastUs); rig.move(400, fastUs)
  const fast = rig.peak(span, fastUs)
  return solveZCalibration(up1, down, up2, fast)
}

describe('focus calibration model', () => {
  it('recovers backlash and frame lag from four sweeps', () => {
    const rig = new Rig(180, 12e6, 0)
    const r = calibrate(rig)
    expect(r.backlash).toBeGreaterThan(180 - 4)
    expect(r.backlash).toBeLessThan(180 + 4)
    expect(r.lagNs / 1e6).toBeGreaterThan(12 - 2.5)
    expect(r.lagNs / 1e6).toBeLessThan(12 + 2.5)
    expect(r.repeatability).toBeLessThan(2)
    // without the lag correction the up/down difference understates the backlash by 2·v·δ
    expect(r.naiveBacklash).toBeLessThan(r.backlash - 2)
  })

  it('stays accurate over lag, focus position (frame phase) and frame rate', () => {
    for (const lag of [0, 4e6, 12e6, 25e6]) for (const F of [-37, 0, 71]) for (const fps of [30, 95]) {
      const r = calibrate(new Rig(200, lag, F, fps, 10, mulberry32(F + 100)))
      expect(Math.abs(r.backlash - 200), `lag ${lag / 1e6} ms, F ${F}, ${fps} fps`).toBeLessThan(2)
      expect(Math.abs(r.lagNs - lag) / 1e6, `lag ${lag / 1e6} ms, F ${F}, ${fps} fps`).toBeLessThan(1.5)
    }
  })

  it('gives zero backlash and lag for an ideal stage and camera, with noise', () => {
    const r = calibrate(new Rig(0, 0, 50, 30, 20))
    expect(Math.abs(r.backlash)).toBeLessThan(6)
    expect(Math.abs(r.lagNs) / 1e6).toBeLessThan(4)
  })

  it('solves the linear model exactly', () => {
    // F = 100, b = 150, δ = 10 ms; v1 = 1/6000 steps/µs, v2 = 1/1000 steps/µs (in steps/ns)
    const F = 100, b = 150, d = 10e6, v1 = 1 / 6e6, v2 = 1 / 1e6
    const r = solveZCalibration({ peak: F - v1 * d, speed: v1 }, { peak: F - b + v1 * d, speed: v1 }, { peak: F - v1 * d, speed: v1 }, { peak: F - v2 * d, speed: v2 })
    expect(r.backlash).toBeCloseTo(b, 6)
    expect(r.lagNs).toBeCloseTo(d, 0)
    expect(r.repeatability).toBe(0)
    expect(() => solveZCalibration({ peak: 0, speed: 1 }, { peak: 0, speed: 1 }, { peak: 0, speed: 1 }, { peak: 0, speed: 1 })).toThrow(/faster/)
  })
})

describe('sweepPeak', () => {
  const curve = (centre: number, amp = 600): Sample[] => Array.from({ length: 60 }, (_, i) => ({ z: i * 10, s: 1000 + amp * Math.exp(-(((i * 10 - centre) / 60) ** 2)) }))
  it('refines the peak between samples', () => {
    const p = sweepPeak(curve(303))
    expect(p.fitted).toBe(true)
    expect(Math.abs(p.z - 303)).toBeLessThan(1.5)
    expect(p.zMax).toBe(300)
  })
  it('rejects a featureless field, a peak at the end and too few frames', () => {
    expect(() => sweepPeak(curve(300, 10))).toThrow(/contrast/)
    expect(() => sweepPeak(curve(10))).toThrow(/end of the sweep/)
    expect(() => sweepPeak(curve(300).slice(20, 25))).toThrow(/only 5 frames/)
  })
})

describe('frame lag in the timestamp → z interpolation', () => {
  it('samplesFromSweep and zAtTime interpolate at ts + lag', () => {
    const frames: FrameMeta[] = [0, 10, 20].map((ms, i) => ({ seq: i, size: 1, stream: 'main', ts: ms * 1e6, t: ms * 1e6 }))
    // move from z 0 to 100 over 0..20 ms
    const s0 = samplesFromSweep(frames, 0, 20e6, 0, 100, 'jpeg')
    expect(s0.map((s) => s.z)).toEqual([50, 100])
    const s1 = samplesFromSweep(frames, 0, 20e6, 0, 100, 'jpeg', 5e6)
    expect(s1.map((s) => s.z)).toEqual([25, 75])
    expect(s1.map((s) => s.t)).toEqual([0, 10e6]) // t stays the stamp
    const mv = { t0: 0, t1: 20e6, z0: 0, z1: 100 }
    expect(zAtTime(10e6, mv)).toBe(50)
    expect(zAtTime(10e6, mv, 5e6)).toBe(75)
    expect(zAtTime(18e6, mv, 5e6)).toBeNull()
  })
})
