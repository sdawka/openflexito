import { describe, it, expect } from 'vitest'
import { resolveHdrExposures } from '../rawPhoto'

/** `resolveHdrExposures` covers device.md's "unverified against a device that reorders or partially
 *  completes a bracket" loose end (TODO.md): the per-frame exposure lookup must be correct-by-
 *  construction rather than trusting `item.meta.factor`/positional `factors[i]`. See the function's
 *  own doc in rawPhoto.ts for the three-tier unit strategy. */
describe('resolveHdrExposures', () => {
  const factors = [0.25, 1, 4]

  it('prefers each item\'s own real ExposureTime, in order, complete bracket', () => {
    const items = [
      { meta: { exposure: 200, factor: 0.25, index: 0 } },
      { meta: { exposure: 800, factor: 1, index: 1 } },
      { meta: { exposure: 3200, factor: 4, index: 2 } },
    ]
    expect(resolveHdrExposures(items, factors, null)).toEqual([200, 800, 3200])
  })

  it('a reordered bracket still pairs the right exposure to the right item (real exposure, order-independent)', () => {
    const items = [
      { meta: { exposure: 3200, factor: 4, index: 2 } },
      { meta: { exposure: 200, factor: 0.25, index: 0 } },
      { meta: { exposure: 800, factor: 1, index: 1 } },
    ]
    expect(resolveHdrExposures(items, factors, null)).toEqual([3200, 200, 800])
  })

  it('a reordered bracket falling back to factors still uses meta.index, not array position', () => {
    // no per-item `exposure` or `factor` at all: must fall back to factors[] looked up by `index`,
    // not by loop position `i` -- item 0 here is really the factor-4 shot (index 2).
    const items = [
      { meta: { index: 2 } },
      { meta: { index: 0 } },
      { meta: { index: 1 } },
    ]
    expect(resolveHdrExposures(items, factors, null)).toEqual([4, 0.25, 1])
  })

  it('a partially-completed bracket (fewer items than factors) still pairs each item to its own factor by index', () => {
    // only the first and last shots arrived; the middle (factor 1, index 1) never made it into the
    // container. Position-based lookup (factors[i]) would wrongly assign factors[1] = 1 to the
    // second item instead of its real factor 4.
    const items = [
      { meta: { index: 0 } },
      { meta: { index: 2 } },
    ]
    expect(resolveHdrExposures(items, factors, null)).toEqual([0.25, 4])
  })

  it('one frame missing exposure metadata: base_exposure present -> real exposure wins where present, base*factor fills the gap', () => {
    const items = [
      { meta: { exposure: 210, factor: 0.25, index: 0 } },
      { meta: { factor: 1, index: 1 } },            // no real exposure for this one
      { meta: { exposure: 3150, factor: 4, index: 2 } },
    ]
    const summary = { base_exposure: 800 }
    expect(resolveHdrExposures(items, factors, summary)).toEqual([210, 800, 3150])
  })

  it('no real exposure anywhere and no base_exposure: falls back to the bare requested factor for every item', () => {
    const items = [
      { meta: { factor: 0.25, index: 0 } },
      { meta: { factor: 1, index: 1 } },
      { meta: { factor: 4, index: 2 } },
    ]
    expect(resolveHdrExposures(items, factors, null)).toEqual([0.25, 1, 4])
  })

  it('a frame with no exposure, no factor and an unresolvable index resolves to null so the caller can drop it', () => {
    const items = [
      { meta: { exposure: 210, factor: 0.25, index: 0 } },
      { meta: {} },                         // nothing at all, and no fallback array position either
      { meta: { exposure: 3150, factor: 4, index: 2 } },
    ]
    // no real exposure on every item (the middle one has none) and no base_exposure supplied, so the
    // bracket falls back to bare factors; the middle item still resolves via loop position `i = 1`
    // because its `index` is missing -- factors[1] = 1.
    expect(resolveHdrExposures(items, factors, null)).toEqual([0.25, 1, 4])
  })

  it('a genuinely unresolvable item (bad index, no factor, factors array too short) resolves to null', () => {
    const shortFactors = [1]
    const items = [{ meta: { index: 5 } }]
    // index 5 is out of range for shortFactors, falls back to position i = 0 -> factors[0] = 1... to
    // force a real null, drop the factors entry entirely by using an out-of-range position too.
    expect(resolveHdrExposures(items, shortFactors, null)).toEqual([1])
    const emptyFactors: number[] = []
    expect(resolveHdrExposures(items, emptyFactors, null)).toEqual([null])
  })
})
