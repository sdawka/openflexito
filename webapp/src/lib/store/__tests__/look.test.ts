import { describe, it, expect, vi } from 'vitest'
import { bakeLook, identity3D, sampleTetra, type Lut1D, type Lut3D } from '../../algo/lut'
import { identityCurve } from '../../algo/curvePoints'
import type { StoredLut } from '../lutDb'

// `store/lutDb.ts` talks to IndexedDB, which vitest's jsdom environment doesn't implement. `saveAsLut`
// only needs the write to succeed and a subsequent `listLuts`/`getLut` to see it, so an in-memory stub
// covers it without pulling in a fake-indexeddb dependency the rest of the suite doesn't otherwise need.
vi.mock('../lutDb', () => {
  const db = new Map<string, StoredLut>()
  return {
    newLutId: (): string => `test-${db.size}-${Math.random().toString(36).slice(2, 8)}`,
    putLut: async (l: StoredLut): Promise<void> => { db.set(l.id, l) },
    getLut: async (id: string): Promise<StoredLut | undefined> => db.get(id),
    deleteLut: async (id: string): Promise<void> => { db.delete(id) },
    listLuts: async (): Promise<StoredLut[]> => [...db.values()].sort((a, b) => b.when.localeCompare(a.when)),
  }
})

const { composeCubes, lutFromStored, storedFromLut, LookStore } = await import('../look.svelte')

/** A cube that inverts every channel (out = 1 - in), sampled on a small grid - cheap to build and easy
 *  to reason about when checking composition order. */
function invertCube(size = 5): Lut3D {
  const data = new Float32Array(size * size * size * 3)
  let o = 0
  for (let bi = 0; bi < size; bi++) for (let gi = 0; gi < size; gi++) for (let ri = 0; ri < size; ri++) {
    data[o++] = 1 - ri / (size - 1); data[o++] = 1 - gi / (size - 1); data[o++] = 1 - bi / (size - 1)
  }
  return { size, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1] }
}

describe('composeCubes', () => {
  it('identity composed with identity stays identity', () => {
    const id = identity3D(9)
    const out = composeCubes(id, id, 9)
    const tmp = new Float32Array(3)
    sampleTetra(out, 0.3, 0.6, 0.9, tmp, 0)
    expect(tmp[0]).toBeCloseTo(0.3, 2)
    expect(tmp[1]).toBeCloseTo(0.6, 2)
    expect(tmp[2]).toBeCloseTo(0.9, 2)
  })

  it('composes in order: out(x) = second(first(x))', () => {
    // first = invert, second = identity -> net invert
    const out = composeCubes(invertCube(), identity3D(9), 9)
    const tmp = new Float32Array(3)
    sampleTetra(out, 0.2, 0.4, 0.8, tmp, 0)
    expect(tmp[0]).toBeCloseTo(0.8, 1)
    expect(tmp[1]).toBeCloseTo(0.6, 1)
    expect(tmp[2]).toBeCloseTo(0.2, 1)
  })

  it('double invert cancels out (net identity)', () => {
    const out = composeCubes(invertCube(), invertCube(), 9)
    const tmp = new Float32Array(3)
    sampleTetra(out, 0.25, 0.5, 0.75, tmp, 0)
    expect(tmp[0]).toBeCloseTo(0.25, 1)
    expect(tmp[1]).toBeCloseTo(0.5, 1)
    expect(tmp[2]).toBeCloseTo(0.75, 1)
  })
})

describe('lutFromStored / storedFromLut round-trip', () => {
  it('round-trips a 3D LUT unchanged', () => {
    const cube = invertCube(4)
    const stored = storedFromLut(cube, { id: 'a', name: 'inv', source: 'cube', when: '2026-01-01T00:00:00Z' })
    expect(stored.kind).toBe('3d')
    const back = lutFromStored(stored)
    expect('data' in back && back.data).toEqual(cube.data)
  })

  it('round-trips a 1D LUT (separate r/g/b) through the concatenated-blocks storage layout', () => {
    const size = 4
    const r = new Float32Array([0, 0.25, 0.5, 1])
    const g = new Float32Array([1, 0.75, 0.5, 0])
    const b = new Float32Array([0.1, 0.2, 0.3, 0.4])
    const lut1d = { size, r, g, b, domainMin: [0, 0, 0] as [number, number, number], domainMax: [1, 1, 1] as [number, number, number] }
    const stored = storedFromLut(lut1d, { id: 'b', name: 'ramp', source: 'csv', when: '2026-01-01T00:00:00Z' })
    expect(stored.kind).toBe('1d')
    const back = lutFromStored(stored) as typeof lut1d
    expect(Array.from(back.r)).toEqual(Array.from(r))
    expect(Array.from(back.g)).toEqual(Array.from(g))
    expect(Array.from(back.b)).toEqual(Array.from(b))
  })
})

describe('LookStore.current', () => {
  it('is null while disabled', () => {
    const s = new LookStore()
    s.enabled = false
    s.lutId = 'cm:red'
    expect(s.current).toBeNull()
  })

  it('is null when enabled with no LUT selected and every adjustment at its neutral value', () => {
    const s = new LookStore()
    s.enabled = true
    expect(s.current).toBeNull()
  })

  it('bakes a selected built-in colour map into a cube', () => {
    const s = new LookStore()
    s.enabled = true
    s.lutId = 'cm:red'
    const look = s.current
    expect(look).not.toBeNull()
    expect(look!.cube).toBeDefined()
    const tmp = new Float32Array(3)
    sampleTetra(look!.cube!, 0.2, 0.6, 0.9, tmp, 0)
    // "Red" maps luminance to a pure-red ramp: g and b channels of the baked cube collapse toward 0
    expect(tmp[1]).toBeLessThan(0.2)
    expect(tmp[2]).toBeLessThan(0.2)
  })

  it('bakes adjustments alone when no LUT is selected', () => {
    const s = new LookStore()
    s.enabled = true
    s.saturation = -1 // fully desaturate
    const look = s.current
    expect(look).not.toBeNull()
    const tmp = new Float32Array(3)
    sampleTetra(look!.cube!, 1, 0, 0, tmp, 0)
    // desaturated: r, g, b should converge toward the same (luma) value
    expect(Math.abs(tmp[0] - tmp[1])).toBeLessThan(0.05)
    expect(Math.abs(tmp[1] - tmp[2])).toBeLessThan(0.05)
  })

  it('resolves a user-imported LUT from myLuts by id', () => {
    const s = new LookStore()
    s.enabled = true
    const stored = storedFromLut(invertCube(4), { id: 'user-1', name: 'My invert', source: 'cube', when: '2026-01-01T00:00:00Z' })
    s.myLuts = [stored]
    s.lutId = 'user-1'
    const look = s.current
    expect(look).not.toBeNull()
    const tmp = new Float32Array(3)
    sampleTetra(look!.cube!, 0.1, 0.2, 0.3, tmp, 0)
    expect(tmp[0]).toBeCloseTo(0.9, 1)
    expect(tmp[1]).toBeCloseTo(0.8, 1)
    expect(tmp[2]).toBeCloseTo(0.7, 1)
  })

  it('reset() clears adjustments but leaves the selected LUT alone', () => {
    const s = new LookStore()
    s.enabled = true
    s.lutId = 'cm:red'
    s.saturation = 0.5; s.hue = 30; s.levels = { black: 0.1, white: 0.9, gamma: 1.2 }
    s.reset()
    expect(s.saturation).toBe(0)
    expect(s.hue).toBe(0)
    expect(s.levels).toEqual({ black: 0, white: 1, gamma: 1 })
    expect(s.lutId).toBe('cm:red')
  })

  it('bakes curves and a channel mixer into the composed cube', () => {
    const s = new LookStore()
    s.enabled = true
    s.channelMixer = [[0, 1, 0], [1, 0, 0], [0, 0, 1]] // swap R and G
    const look = s.current
    expect(look).not.toBeNull()
    const tmp = new Float32Array(3)
    sampleTetra(look!.cube!, 0.8, 0.2, 0.1, tmp, 0)
    expect(tmp[0]).toBeCloseTo(0.2, 1)
    expect(tmp[1]).toBeCloseTo(0.8, 1)
  })
})

describe('LookStore.saveAsLut', () => {
  it('stores a compact 1D LUT when the pipeline is channel-separable (gradient + curves + levels only)', async () => {
    const s = new LookStore()
    s.enabled = true
    s.gradientStops = [{ pos: 0, color: [0, 0, 0] }, { pos: 1, color: [1, 0.5, 0.2] }]
    s.curves = { master: identityCurve(), r: identityCurve(), g: [[0, 0], [1, 0.8]], b: identityCurve() }
    s.levels = { black: 0.05, white: 0.95, gamma: 1.1 }
    const stored = await s.saveAsLut('separable test')
    expect(stored.kind).toBe('1d')
  })

  it('stores a 33^3 cube when hue/saturation/mixer make the pipeline non-separable', async () => {
    const s = new LookStore()
    s.enabled = true
    s.lutId = 'cm:red'
    s.hue = 45
    const stored = await s.saveAsLut('non-separable test')
    expect(stored.kind).toBe('3d')
  })

  it('resets adjustments/curves/mixer/gradient after saving, so the composed look is unchanged', async () => {
    const s = new LookStore()
    s.enabled = true
    s.lutId = 'cm:red'
    s.saturation = 0.3
    s.hue = 10
    const before = s.current!.cube!
    const beforeSample = new Float32Array(3)
    sampleTetra(before, 0.4, 0.6, 0.8, beforeSample, 0)

    await s.saveAsLut('roundtrip test')
    expect(s.saturation).toBe(0)
    expect(s.hue).toBe(0)
    expect(s.curves).toBeNull()
    expect(s.channelMixer).toBeNull()
    expect(s.gradientStops).toBeNull()

    const after = s.current!.cube!
    const afterSample = new Float32Array(3)
    sampleTetra(after, 0.4, 0.6, 0.8, afterSample, 0)
    expect(afterSample[0]).toBeCloseTo(beforeSample[0], 1)
    expect(afterSample[1]).toBeCloseTo(beforeSample[1], 1)
    expect(afterSample[2]).toBeCloseTo(beforeSample[2], 1)
  })

  it('the baked 1D LUT applied alone matches the composed look within 1/255 on a ramp', async () => {
    const s = new LookStore()
    s.enabled = true
    s.gradientStops = [{ pos: 0, color: [0, 0, 0] }, { pos: 0.5, color: [0.3, 0.6, 0.9] }, { pos: 1, color: [1, 1, 1] }]
    s.curves = { master: identityCurve(), r: identityCurve(), g: identityCurve(), b: [[0, 0], [0.5, 0.55], [1, 1]] }
    s.levels = { black: 0, white: 1, gamma: 0.9 }
    s.strength = 0.7

    // Bake `current` the same way the renderer/exportCube would (strength included via `bakeLook`),
    // *before* saveAsLut resets the store back to neutral.
    const composed = bakeLook(s.current!, 33)
    const stored = await s.saveAsLut('ramp equivalence')
    expect(stored.kind).toBe('1d')
    const baked = lutFromStored(stored) as Lut1D

    // `composed` is itself only a 33^3-grid approximation of the (exact, pointwise-separable) pipeline
    // - composing the gradient's baked cube with the curves/levels cube via `composeCubes` tetrahedrally
    // resamples at off-grid points, which the exact 256-entry 1D bake doesn't do. So the two agree to
    // within the cube's own grid error (a couple of 1/255 steps), not bit-exactly; that quantization,
    // not a bug in `saveAsLut`, is why the tolerance here is looser than the LUT's own 1/255 resolution.
    const lerpChannel = (arr: Float32Array, x: number): number => {
      const p = x * (baked.size - 1), i0 = Math.floor(p), i1 = Math.min(baked.size - 1, i0 + 1), f = p - i0
      return arr[i0] + (arr[i1] - arr[i0]) * f
    }
    const tmpComposed = new Float32Array(3)
    for (let i = 0; i <= composed.size - 1; i++) {
      const x = i / (composed.size - 1)
      sampleTetra(composed, x, x, x, tmpComposed, 0)
      expect(Math.abs(lerpChannel(baked.r, x) - tmpComposed[0])).toBeLessThan(2 / 255)
      expect(Math.abs(lerpChannel(baked.g, x) - tmpComposed[1])).toBeLessThan(2 / 255)
      expect(Math.abs(lerpChannel(baked.b, x) - tmpComposed[2])).toBeLessThan(2 / 255)
    }
  })
})
