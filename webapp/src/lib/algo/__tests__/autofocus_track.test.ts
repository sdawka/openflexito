import { describe, expect, it } from 'vitest'
import { samplesFromSweep, quadraticPeak, countTurningPoints, fastAutofocus, stepAutofocus } from '../autofocus'
import { fft1d, fft2d } from '../fft'
import { displacement, centralCrop } from '../fftTrack'
import { effectivePositions, fitBacklash, imageToStageMatrix, pixelsToStage, invert2 } from '../csm'
import { laplacianVariance, type Gray } from '../sharpness'
import type { FrameMeta, MoveResult } from '../../api/types'

const frame = (t: number, size: number): FrameMeta => ({ seq: t, size, stream: 'main', ts: t, t })

describe('autofocus maths', () => {
  it('interpolates z from frame times within a sweep', () => {
    const frames = [frame(0, 1), frame(100, 5), frame(200, 9), frame(300, 5), frame(400, 1)]
    const s = samplesFromSweep(frames, 0, 400, -200, 200, 'jpeg')
    expect(s.map((v) => v.z)).toEqual([-100, 0, 100, 200])     // t=0 excluded (t0 < t)
    expect(s[1].s).toBe(9)
  })
  it('fits a confident parabola', () => {
    const pts = [-2, -1, 0, 1, 2].map((z) => ({ z: z + 10, s: 100 - 3 * (z - 0.4) ** 2 }))
    const p = quadraticPeak(pts)!
    expect(p.z).toBeCloseTo(10.4, 6)
    expect(p.confident).toBe(true)
    const flat = quadraticPeak([{ z: 0, s: 1 }, { z: 1, s: 1.01 }, { z: 2, s: 0.99 }, { z: 3, s: 1 }])!
    expect(flat.confident).toBe(false)
  })
  it('counts turning points', () => {
    expect(countTurningPoints([1, 3, 6, 4, 2])).toBe(1)
    expect(countTurningPoints([1, 4, 2, 5, 1])).toBe(3)
  })
  it('fast autofocus finds the peak of a simulated focus curve', async () => {
    // Simulated device: z position; sharpness = gaussian around z=137; frames every 10 "ns" of a
    // constant-speed move with 1 step per ns.
    let z = 0, now = 1000
    const frames: FrameMeta[] = []
    const io = {
      currentZ: () => z,
      frames: () => frames,
      async moveZ(dz: number): Promise<MoveResult> {
        const t0 = now, z0 = z
        for (let k = 10; k <= Math.abs(dz); k += 10) {
          const zz = z0 + Math.sign(dz) * k
          frames.push(frame(t0 + k, Math.round(1000 + 5000 * Math.exp(-(((zz - 137) / 300) ** 2)))))
        }
        z += dz; now += Math.abs(dz) + 1
        return { position: { x: 0, y: 0, z }, t0, t1: now - 1, start_hw: { x: 0, y: 0, z: z0 }, end_hw: { x: 0, y: 0, z }, cancelled: false }
      },
    }
    const r = await fastAutofocus(io, 2000)
    expect(Math.abs(r.peakZ - 137)).toBeLessThanOrEqual(10)
    expect(z).toBe(r.peakZ)
    expect(r.samples.length).toBeGreaterThan(100)
  })
  it('step autofocus converges', async () => {
    let z = 0
    const io = { currentZ: () => z, async moveZ(dz: number) { z += dz }, async measure() { return 100 * Math.exp(-(((z - 210) / 400) ** 2)) } }
    const r = await stepAutofocus(io, 1000, 9)
    expect(Math.abs(r.peakZ - 210)).toBeLessThan(60)
    expect(z).toBe(r.peakZ)
  })
})

describe('fft', () => {
  it('matches a naive DFT', () => {
    const n = 8, re = new Float64Array(n), im = new Float64Array(n)
    for (let i = 0; i < n; i++) re[i] = Math.sin(i) + i / 3
    const ref: [number, number][] = []
    for (let k = 0; k < n; k++) { let r = 0, m = 0; for (let t = 0; t < n; t++) { r += re[t] * Math.cos(-2 * Math.PI * k * t / n); m += re[t] * Math.sin(-2 * Math.PI * k * t / n) } ref.push([r, m]) }
    fft1d(re, im)
    for (let k = 0; k < n; k++) { expect(re[k]).toBeCloseTo(ref[k][0], 9); expect(im[k]).toBeCloseTo(ref[k][1], 9) }
    fft1d(re, im, true)
    for (let i = 0; i < n; i++) expect(re[i]).toBeCloseTo(Math.sin(i) + i / 3, 9)
  })
  it('2d round trip', () => {
    const w = 4, h = 8, re = new Float64Array(w * h).map((_, i) => (i * 7) % 5), im = new Float64Array(w * h)
    const orig = Float64Array.from(re)
    fft2d(re, im, w, h); fft2d(re, im, w, h, true)
    for (let i = 0; i < re.length; i++) expect(re[i]).toBeCloseTo(orig[i], 9)
  })
})

function texture(w: number, h: number, ox: number, oy: number, seed = 3): Gray {
  const data = new Float32Array(w * h)
  // smooth pseudo-random blobs so the scene has structure at several scales
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const X = x - ox, Y = y - oy
    data[y * w + x] = 128 + 40 * Math.sin(X * 0.21 + seed) * Math.cos(Y * 0.17) + 30 * Math.sin((X + Y) * 0.05)
      + 20 * Math.cos(X * 0.5 - Y * 0.3) + 15 * Math.sin(X * 0.9 + Y * 1.1) + 15 * Math.cos(X * 0.35 - Y * 0.8 + seed)
  }
  return { data, width: w, height: h }
}

describe('image tracking', () => {
  it('recovers a known shift', () => {
    const a = centralCrop(texture(128, 96, 0, 0), 0.5)
    const b = centralCrop(texture(128, 96, 7, -4), 0.5)   // scene moved right 7, up 4
    const d = displacement(a, b)
    expect(Math.abs(d.dx - 7)).toBeLessThan(0.75)
    expect(Math.abs(d.dy + 4)).toBeLessThan(0.75)
    expect(d.quality).toBeGreaterThan(1.2)
  })
  it('laplacian variance rises with sharpness', () => {
    const sharp = texture(64, 64, 0, 0)
    const blurred: Gray = { ...sharp, data: Float32Array.from(sharp.data) }
    for (let y = 1; y < 63; y++) for (let x = 1; x < 63; x++) {
      let s = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += sharp.data[(y + dy) * 64 + x + dx]
      blurred.data[y * 64 + x] = s / 9
    }
    expect(laplacianVariance(sharp)).toBeGreaterThan(laplacianVariance(blurred))
  })
})

describe('camera-stage mapping', () => {
  it('models backlash', () => {
    // forward 3x100, back 3x100 with backlash 50: first reverse step only moves 50
    expect(effectivePositions([100, 200, 300, 200, 100, 0], 50)).toEqual([100, 200, 300, 250, 150, 50])
    expect(effectivePositions([100, 200, 300, 200, 100, 0], 0)).toEqual([100, 200, 300, 200, 100, 0])
  })
  it('fits pixels/step and backlash from a synthetic run', () => {
    const b = 80, k: [number, number] = [0.5, -0.1]
    const steps = [0, 200, 400, 600, 800, 600, 400, 200, 0, -200, -400, -200, 0, 200, 400]
    const eff = effectivePositions(steps, b)
    const samples = steps.map((s, i) => ({ steps: s, pos: [k[0] * eff[i] + 3, k[1] * eff[i] - 1] as [number, number] }))
    const fit = fitBacklash(samples, 400, 5)
    expect(fit.backlash).toBe(80)
    expect(fit.pixelsPerStep[0]).toBeCloseTo(0.5, 3)
    expect(fit.pixelsPerStep[1]).toBeCloseTo(-0.1, 3)
    expect(fit.residual).toBeLessThan(1e-6)
  })
  it('builds and applies the image->stage matrix', () => {
    const calX = { direction: { x: 1, y: 0, z: 0 }, pixelsPerStep: [0.2, 0.02] as [number, number], backlash: 0, residual: 0, samples: [] }
    const calY = { direction: { x: 0, y: 1, z: 0 }, pixelsPerStep: [-0.01, 0.25] as [number, number], backlash: 0, residual: 0, samples: [] }
    const M = imageToStageMatrix(calX, calY)
    // moving stage by (100, 0) shifts the image by (20, 2) px; inverse should recover (100, 0)
    expect(pixelsToStage(M, [20, 2])).toEqual({ x: 100, y: 0 })
    expect(pixelsToStage(M, [-1, 25])).toEqual({ x: 0, y: 100 })
    expect(() => invert2([[1, 2], [2, 4]])).toThrow()
  })
})
