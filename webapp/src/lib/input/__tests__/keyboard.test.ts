import { describe, expect, it } from 'vitest'
import { keyVector } from '../keyboard'

describe('keyVector', () => {
  it('maps arrows to XY and PgUp/PgDn to Z', () => {
    expect(keyVector(['ArrowUp', 'ArrowRight'], false, false)).toEqual({ x: 1, y: 1, z: 0 })
    expect(keyVector(['PageDown'], false, false)).toEqual({ x: 0, y: 0, z: -1 })
  })
  it('drives Z with Shift+up/down and leaves left/right on X', () => {
    expect(keyVector(['ArrowUp'], true, false)).toEqual({ x: 0, y: 0, z: 1 })
    expect(keyVector(['ArrowDown', 'ArrowLeft'], true, false)).toEqual({ x: -1, y: 0, z: -1 })
    expect(keyVector(['s'], true, false)).toEqual({ x: 0, y: 0, z: -1 })
  })
  it('inverts Y but never the Shift Z', () => {
    expect(keyVector(['ArrowUp'], false, true)).toEqual({ x: 0, y: -1, z: 0 })
    expect(keyVector(['ArrowUp'], true, true)).toEqual({ x: 0, y: 0, z: 1 })
  })
})
