/** Camera-stage mapping (port of the camera-stage-mapping package's 1-D calibration).
 *
 *  For each stage axis: move until the image shifts, then step back and forth while tracking the
 *  image; fit pixels = k * (steps with backlash lag) to get pixels/step, the backlash, and the
 *  direction of motion in the image. Two axes give a 2x2 matrix from image displacement to stage
 *  displacement, used for click-to-move and closed-loop moves. */

import type { Gray } from './sharpness'
import { centralCrop, displacement } from './fftTrack'

export type Vec2 = [number, number]   // [x, y] in pixels (x = column, y = row)

export interface TrackerIO {
  grab(): Promise<Gray>                        // settled, downsampled greyscale frame
  moveRel(d: { x?: number; y?: number; z?: number }): Promise<unknown>   // raw move, no backlash compensation
  onProgress?(msg: string): void
}

/** Tracks scene displacement relative to a template, re-templating (leapfrog) when the shift grows. */
export class Tracker {
  private template: Gray | null = null
  private origin: Vec2 = [0, 0]     // pixel position of the current template's origin in the global frame
  constructor(private io: TrackerIO, private frac = 0.5, private maxShiftFrac = 0.2) {}

  async reset(): Promise<void> {
    this.template = centralCrop(await this.io.grab(), this.frac)
    this.origin = [0, 0]
  }

  /** Current scene displacement (pixels) relative to the reset() frame. */
  async measure(): Promise<{ pos: Vec2; quality: number }> {
    if (!this.template) await this.reset()
    const frame = await this.io.grab()
    const d = displacement(this.template!, centralCrop(frame, this.frac))
    const pos: Vec2 = [this.origin[0] + d.dx, this.origin[1] + d.dy]
    const limit = this.maxShiftFrac * Math.min(frame.width, frame.height)
    if (Math.abs(d.dx) > limit || Math.abs(d.dy) > limit) {
      // leapfrog: new template from this frame, accumulating the offset
      this.template = centralCrop(frame, this.frac)
      this.origin = pos
    }
    return { pos, quality: d.quality }
  }
}

/** Increase the step size (x2 each time) until the image moves by more than minShift pixels. */
/** Standard deviation of a greyscale image (0..255 scale); a featureless field is below ~3. */
export function contrast(g: { data: ArrayLike<number> }): number {
  let sum = 0, sq = 0
  const n = g.data.length
  for (let i = 0; i < n; i++) { const v = g.data[i]; sum += v; sq += v * v }
  const mean = sum / n
  return Math.sqrt(Math.max(0, sq / n - mean * mean))
}

export async function moveUntilMotionDetected(io: TrackerIO, direction: Vec3, minShift = 10, maxPow = 11): Promise<number> {
  const tracker = new Tracker(io)
  await tracker.reset()
  for (let p = 0; p <= maxPow; p++) {
    const steps = 2 ** p
    await io.moveRel(scale(direction, steps))
    const { pos } = await tracker.measure()
    io.onProgress?.(`step ${steps}: shift ${Math.hypot(pos[0], pos[1]).toFixed(1)} px`)
    if (Math.hypot(pos[0], pos[1]) > minShift) {
      await io.moveRel(scale(direction, -(2 ** (p + 1) - 1)))   // undo all moves so far
      return steps
    }
  }
  throw new Error(`no image motion after ${2 ** maxPow} steps; is the stage connected and a focused sample in view?`)
}

export type Vec3 = { x: number; y: number; z: number }
const scale = (d: Vec3, k: number): Vec3 => ({ x: Math.round(d.x * k), y: Math.round(d.y * k), z: Math.round(d.z * k) })

export interface Calibration1D {
  direction: Vec3               // stage axis unit vector
  pixelsPerStep: Vec2           // image displacement (px) per stage step along `direction`
  backlash: number              // steps
  residual: number              // rms pixel error of the fit
  samples: { steps: number; pos: Vec2 }[]
}

/** Move back and forth along one axis with `step`-sized moves and fit the pixel response. */
export async function calibrate1D(io: TrackerIO, direction: Vec3, step: number, nSteps = 4): Promise<Calibration1D> {
  const tracker = new Tracker(io)
  await tracker.reset()
  const samples: { steps: number; pos: Vec2 }[] = [{ steps: 0, pos: [0, 0] }]
  const seq: number[] = [...Array(nSteps).fill(step), ...Array(2 * nSteps).fill(-step), ...Array(nSteps).fill(step)]
  let cum = 0
  for (const s of seq) {
    await io.moveRel(scale(direction, s))
    cum += s
    const { pos } = await tracker.measure()
    samples.push({ steps: cum, pos })
    io.onProgress?.(`steps ${cum}: (${pos[0].toFixed(1)}, ${pos[1].toFixed(1)}) px`)
  }
  return { ...fitBacklash(samples), direction, samples }
}

/** Brute-force backlash: for each candidate b, compute the "effective" position where a direction
 *  reversal only produces motion after b steps, and least-squares fit pos = k * effective + c. */
export function fitBacklash(samples: { steps: number; pos: Vec2 }[], maxBacklash = 2000, resolution = 5): { pixelsPerStep: Vec2; backlash: number; residual: number } {
  let best = { pixelsPerStep: [0, 0] as Vec2, backlash: 0, residual: Infinity }
  for (let b = 0; b <= maxBacklash; b += resolution) {
    const eff = effectivePositions(samples.map((s) => s.steps), b)
    const fit = fitLinear2(eff, samples.map((s) => s.pos))
    if (fit.residual < best.residual) best = { pixelsPerStep: fit.k, backlash: b, residual: fit.residual }
  }
  return best
}

/** Positions the mechanism actually reaches given a backlash band of width b. */
export function effectivePositions(steps: number[], b: number): number[] {
  const out: number[] = []
  let lo = -b, hi = 0, prev = 0   // the "slack window" [lo, hi] the commanded position can sit in without moving
  let eff = 0
  for (const s of steps) {
    const d = s - prev
    prev = s
    if (d > 0) { if (s > hi) { eff += s - hi; hi = s; lo = s - b } }
    else if (d < 0) { if (s < lo) { eff += s - lo; lo = s; hi = s + b } }
    out.push(eff)
  }
  return out
}

function fitLinear2(x: number[], y: Vec2[]): { k: Vec2; c: Vec2; residual: number } {
  const n = x.length, mx = x.reduce((a, v) => a + v, 0) / n
  const my: Vec2 = [y.reduce((a, v) => a + v[0], 0) / n, y.reduce((a, v) => a + v[1], 0) / n]
  let sxx = 0, sxy0 = 0, sxy1 = 0
  for (let i = 0; i < n; i++) { const dx = x[i] - mx; sxx += dx * dx; sxy0 += dx * (y[i][0] - my[0]); sxy1 += dx * (y[i][1] - my[1]) }
  const k: Vec2 = sxx > 0 ? [sxy0 / sxx, sxy1 / sxx] : [0, 0]
  const c: Vec2 = [my[0] - k[0] * mx, my[1] - k[1] * mx]
  let rss = 0
  for (let i = 0; i < n; i++) { const e0 = y[i][0] - (k[0] * x[i] + c[0]), e1 = y[i][1] - (k[1] * x[i] + c[1]); rss += e0 * e0 + e1 * e1 }
  return { k, c, residual: Math.sqrt(rss / n) }
}

export type Mat2 = [[number, number], [number, number]]

/** From per-axis pixel responses build M such that stage(x,y) = M · image(dx,dy). */
export function imageToStageMatrix(calX: Calibration1D, calY: Calibration1D): Mat2 {
  // A maps stage steps (x,y) -> pixels: [px] = [ax bx][sx] ; [py] = [ay by][sy]
  const A: Mat2 = [[calX.pixelsPerStep[0], calY.pixelsPerStep[0]], [calX.pixelsPerStep[1], calY.pixelsPerStep[1]]]
  return invert2(A)
}

export function invert2(m: Mat2): Mat2 {
  const det = m[0][0] * m[1][1] - m[0][1] * m[1][0]
  if (Math.abs(det) < 1e-12) throw new Error('camera-stage matrix is singular')
  return [[m[1][1] / det, -m[0][1] / det], [-m[1][0] / det, m[0][0] / det]]
}

export function apply2(m: Mat2, v: Vec2): Vec2 {
  return [m[0][0] * v[0] + m[0][1] * v[1], m[1][0] * v[0] + m[1][1] * v[1]]
}

/** Stage move (steps) that shifts the scene by `px` pixels (e.g. to centre a clicked point). */
export function pixelsToStage(m: Mat2, px: Vec2): { x: number; y: number } {
  const [x, y] = apply2(m, px)
  return { x: Math.round(x), y: Math.round(y) }
}

/** Move, measure, correct — up to `iterations` times or until within `tolerancePx`. */
export async function closedLoopMove(io: TrackerIO, m: Mat2, targetPx: Vec2, tolerancePx = 5, iterations = 3): Promise<Vec2> {
  const tracker = new Tracker(io)
  await tracker.reset()
  let remaining: Vec2 = targetPx
  for (let i = 0; i < iterations; i++) {
    await io.moveRel(pixelsToStage(m, remaining))
    const { pos } = await tracker.measure()
    remaining = [targetPx[0] - pos[0], targetPx[1] - pos[1]]
    io.onProgress?.(`closed loop ${i + 1}: error ${Math.hypot(...remaining).toFixed(1)} px`)
    if (Math.hypot(...remaining) < tolerancePx) break
  }
  return remaining
}
