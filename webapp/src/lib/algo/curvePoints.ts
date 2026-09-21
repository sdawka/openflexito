/** Pure editing helpers for the interactive tone-curve editor (`components/CurveEditor.svelte`): point
 *  insert/move/remove with monotone x-ordering, hit-testing, and the bridge from edited points to the
 *  `algo/curves.ts` curve-function / `Lut1D` machinery. No DOM access, fully unit-testable.
 *
 *  A curve is a sorted array of `[x, y]` points in 0..1, always starting at x=0 and ending at x=1 (the
 *  two endpoints are structurally fixed in x - only their y is draggable - so `points[0][0] === 0` and
 *  `points[points.length - 1][0] === 1` are invariants every function here preserves). A `CurveChannels`
 *  bundles four such curves: `master` (applied first, to all channels) plus per-channel `r`/`g`/`b`. */

import { curveToLut1D, monotoneCubic, type CurveFn, type CurveSet } from './curves'
import type { Lut1D } from './lut'

export type CurvePoint = [number, number]

export interface CurveChannels {
  master: CurvePoint[]
  r: CurvePoint[]
  g: CurvePoint[]
  b: CurvePoint[]
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v }

export function identityCurve(): CurvePoint[] { return [[0, 0], [1, 1]] }

export function identityCurveChannels(): CurveChannels {
  return { master: identityCurve(), r: identityCurve(), g: identityCurve(), b: identityCurve() }
}

export function isIdentityCurve(points: CurvePoint[]): boolean {
  return points.length === 2 && points[0][0] === 0 && points[0][1] === 0 && points[1][0] === 1 && points[1][1] === 1
}

export function isIdentityCurveChannels(ch: CurveChannels): boolean {
  return isIdentityCurve(ch.master) && isIdentityCurve(ch.r) && isIdentityCurve(ch.g) && isIdentityCurve(ch.b)
}

/** Insert a new point at `(x, y)`, keeping the array sorted by x. `x` is clamped away from 0/1 (a small
 *  epsilon) so the new point never collides with - or is mistaken for - an endpoint; `y` is clamped to
 *  0..1. Returns a new array; `points` is left untouched. */
export function insertPoint(points: CurvePoint[], x: number, y: number, epsilon = 0.004): CurvePoint[] {
  const cx = clamp01(x) < epsilon ? epsilon : clamp01(x) > 1 - epsilon ? 1 - epsilon : clamp01(x)
  const cy = clamp01(y)
  const next = [...points, [cx, cy] as CurvePoint]
  next.sort((a, b) => a[0] - b[0])
  return next
}

/** Move the point at `index`. The two endpoints (x===0 or x===1) keep their x fixed and only move in
 *  y; any other point moves freely in x (clamped into the open interval between its neighbours isn't
 *  enforced here - the array is simply re-sorted, so a point dragged past a neighbour swaps order,
 *  which is the "snaps back into monotone order" behaviour the editor wants). Returns a new array. */
export function movePoint(points: CurvePoint[], index: number, x: number, y: number): CurvePoint[] {
  if (index < 0 || index >= points.length) return points
  const pts = points.map((p) => [p[0], p[1]] as CurvePoint)
  const cy = clamp01(y)
  const isLeftEndpoint = pts[index][0] === 0
  const isRightEndpoint = pts[index][0] === 1
  if (isLeftEndpoint) { pts[index] = [0, cy]; return pts }
  if (isRightEndpoint) { pts[index] = [1, cy]; return pts }
  const cx = clamp01(x)
  pts[index] = [cx, cy]
  pts.sort((a, b) => a[0] - b[0])
  return pts
}

/** Remove the point at `index`. Endpoints (x===0 or x===1) can never be removed, and a curve with only
 *  two points (just the endpoints) is left alone - there is always at least a start and end point. */
export function removePoint(points: CurvePoint[], index: number): CurvePoint[] {
  if (index < 0 || index >= points.length) return points
  if (points.length <= 2) return points
  const p = points[index]
  if (p[0] === 0 || p[0] === 1) return points
  return [...points.slice(0, index), ...points.slice(index + 1)]
}

/** Index of the point nearest `(x, y)` within `threshold` (both axes in normalised 0..1 units), or -1
 *  if none is within range. Used for pointer-down hit-testing (grab vs. insert) and double-click / Delete
 *  removal. */
export function nearestPoint(points: CurvePoint[], x: number, y: number, threshold = 0.05): number {
  let best = -1, bestDist = Infinity
  for (let i = 0; i < points.length; i++) {
    const dx = points[i][0] - x, dy = points[i][1] - y
    const d = Math.hypot(dx, dy)
    if (d < bestDist) { bestDist = d; best = i }
  }
  return bestDist <= threshold ? best : -1
}

/** Bridge to `algo/curves.ts`: the master curve applied first, then each channel's own curve on top -
 *  `{ r, g, b }` each evaluate as `channelFn(masterFn(x))`, matching `bakeAdjustments`'s expectation of
 *  a plain `CurveSet` of curve functions. */
export function curveChannelsToFns(ch: CurveChannels): CurveSet {
  const masterFn = monotoneCubic(ch.master)
  const rFn = monotoneCubic(ch.r)
  const gFn = monotoneCubic(ch.g)
  const bFn = monotoneCubic(ch.b)
  const compose = (f: CurveFn): CurveFn => (x: number) => f(masterFn(x))
  return { r: compose(rFn), g: compose(gFn), b: compose(bFn) }
}

/** Bake `CurveChannels` directly into a `Lut1D` (master-then-channel composition), for callers that
 *  want a standalone 1D LUT rather than curve functions to fold into `bakeAdjustments`. */
export function curveChannelsToLut1D(ch: CurveChannels, size = 256): Lut1D {
  const fns = curveChannelsToFns(ch)
  return curveToLut1D(fns.r!, fns.g!, fns.b!, size)
}
