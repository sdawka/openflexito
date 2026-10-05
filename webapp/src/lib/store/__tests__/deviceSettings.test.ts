import { describe, expect, it } from 'vitest'
import { acceptRemote, pickKeys, sameSubset } from '../deviceSettings'

const defaults = { a: 1, b: { x: 1, y: 2 }, c: 'native' as number | 'native', d: true, e: 'local' }
const keys = ['a', 'b', 'c'] as const

describe('deviceSettings', () => {
  it('picks only the listed keys and deep-copies', () => {
    const s = { ...defaults }
    const p = pickKeys(s, keys)
    expect(Object.keys(p)).toEqual(['a', 'b', 'c'])
    p.b.x = 9
    expect(s.b.x).toBe(1)
  })
  it('accepts matching fields, drops unknown keys, when and wrong types', () => {
    const got = acceptRemote({ a: 3, b: { x: 2, y: 3 }, d: false, e: 'z', when: 't' }, keys, defaults)
    expect(got).toEqual({ a: 3, b: { x: 2, y: 3 } })
    expect(acceptRemote({ a: 'nope' }, keys, defaults)).toEqual({})
    expect(acceptRemote(null, keys, defaults)).toEqual({})
  })
  it('compares subsets', () => {
    expect(sameSubset({ a: 1 }, { a: 1 })).toBe(true)
    expect(sameSubset({ a: 1 }, { a: 2 })).toBe(false)
  })
})
