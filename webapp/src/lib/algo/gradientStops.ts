/** Pure editing helpers for the 1D colour-stop gradient editor (`components/GradientEditor.svelte`):
 *  seeding stops from an existing `Lut1D`, insert/move/remove/recolour, reverse, even-spacing, and the
 *  bridge back to `Lut1D` via `algo/lut.ts#lut1DFromStops`. No DOM access, fully unit-testable. */

import { lut1DFromStops, type Lut1D } from './lut'

export interface Stop {
  pos: number // 0..1
  color: [number, number, number] // 0..1 each
}

function clamp01(v: number): number { return v < 0 ? 0 : v > 1 ? 1 : v }

function sampleChannel1D(arr: Float32Array, size: number, t: number): number {
  const x = clamp01(t) * (size - 1)
  const i0 = Math.floor(x)
  const i1 = i0 + 1 < size ? i0 + 1 : size - 1
  const f = x - i0
  return arr[i0] + (arr[i1] - arr[i0]) * f
}

/** Sample a `Lut1D` (treated as a gradient: each channel is its own ramp evaluated at the same
 *  position) at `n` evenly spaced positions, producing seed stops for "edit as gradient". */
export function sampleLutToStops(lut: Lut1D, n = 12): Stop[] {
  const stops: Stop[] = []
  for (let i = 0; i < n; i++) {
    const pos = n === 1 ? 0 : i / (n - 1)
    stops.push({
      pos,
      color: [sampleChannel1D(lut.r, lut.size, pos), sampleChannel1D(lut.g, lut.size, pos), sampleChannel1D(lut.b, lut.size, pos)],
    })
  }
  return stops
}

/** Linear-interpolated colour of the gradient described by `stops` at `pos` (stops need not be sorted;
 *  the ends hold constant past the first/last stop). Mirrors `algo/lut.ts`'s internal stop sampling. */
export function sampleStopsColor(stops: Stop[], pos: number): [number, number, number] {
  if (stops.length === 0) return [0, 0, 0]
  const sorted = [...stops].sort((a, b) => a.pos - b.pos)
  const p = clamp01(pos)
  if (p <= sorted[0].pos) return sorted[0].color
  const last = sorted[sorted.length - 1]
  if (p >= last.pos) return last.color
  for (let i = 0; i < sorted.length - 1; i++) {
    const s0 = sorted[i], s1 = sorted[i + 1]
    if (p >= s0.pos && p <= s1.pos) {
      const f = s1.pos === s0.pos ? 0 : (p - s0.pos) / (s1.pos - s0.pos)
      return [
        s0.color[0] + (s1.color[0] - s0.color[0]) * f,
        s0.color[1] + (s1.color[1] - s0.color[1]) * f,
        s0.color[2] + (s1.color[2] - s0.color[2]) * f,
      ]
    }
  }
  return last.color
}

/** Insert a new stop at `pos`, coloured by sampling the gradient's current colour there (so inserting
 *  a stop never visibly changes the gradient until it's dragged or recoloured). Returns a new array
 *  sorted by position. */
export function insertStop(stops: Stop[], pos: number): Stop[] {
  const p = clamp01(pos)
  const color = sampleStopsColor(stops, p)
  const next = [...stops, { pos: p, color }]
  next.sort((a, b) => a.pos - b.pos)
  return next
}

export function moveStop(stops: Stop[], index: number, pos: number): Stop[] {
  if (index < 0 || index >= stops.length) return stops
  const next = stops.map((s) => ({ ...s }))
  next[index] = { ...next[index], pos: clamp01(pos) }
  return next
}

export function setStopColor(stops: Stop[], index: number, color: [number, number, number]): Stop[] {
  if (index < 0 || index >= stops.length) return stops
  const next = stops.map((s) => ({ ...s }))
  next[index] = { ...next[index], color }
  return next
}

/** Remove the stop at `index`, keeping at least two stops (a gradient needs at least a start and end). */
export function removeStop(stops: Stop[], index: number): Stop[] {
  if (index < 0 || index >= stops.length) return stops
  if (stops.length <= 2) return stops
  return [...stops.slice(0, index), ...stops.slice(index + 1)]
}

/** Flip the gradient: positions mirror (`1 - pos`), colours stay attached to their stop, order flips. */
export function reverseStops(stops: Stop[]): Stop[] {
  return stops.map((s) => ({ pos: 1 - s.pos, color: s.color })).sort((a, b) => a.pos - b.pos)
}

/** Re-space stops evenly across 0..1, keeping their colours (and relative order). */
export function evenlySpace(stops: Stop[]): Stop[] {
  const sorted = [...stops].sort((a, b) => a.pos - b.pos)
  const n = sorted.length
  return sorted.map((s, i) => ({ pos: n === 1 ? 0 : i / (n - 1), color: s.color }))
}

export function stopsToLut1D(stops: Stop[], size = 256): Lut1D {
  return lut1DFromStops(stops.map((s) => [s.pos, s.color] as [number, [number, number, number]]), size)
}
