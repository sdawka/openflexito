import { describe, expect, it } from 'vitest'
import { describeTileFocus, summariseTileFocus } from './focusReasons'

describe('describeTileFocus', () => {
  it('measured tile', () => {
    expect(describeTileFocus({ status: 'measured', contrast: 1.94 }, { col: 2, row: 1, z: -920 })).toBe('(2,1) measured · contrast 1.9 · z −920')
  })
  it('predicted with reason', () => {
    expect(describeTileFocus({ status: 'predicted', reason: 'flat' }, { col: 0, row: 0 })).toBe('(0,0) predicted from the plane (flat curve)')
  })
  it('failed with error, none and missing', () => {
    expect(describeTileFocus({ status: 'failed', error: 'stage busy' }, { col: 1, row: 1 })).toBe('(1,1) failed: stage busy')
    expect(describeTileFocus({ status: 'none' }, { col: 1, row: 1 })).toBe('(1,1) not autofocused')
    expect(describeTileFocus(undefined, { col: 1, row: 1 })).toBe('(1,1) not autofocused')
  })
})

describe('summariseTileFocus', () => {
  it('counts by status and reason', () => {
    const f = [...Array(7).fill({ status: 'measured' }), { status: 'predicted', reason: 'flat' }, { status: 'predicted', reason: 'multimodal' }, undefined, { status: 'none' }]
    expect(summariseTileFocus(f)).toBe('7 measured · 2 predicted (1 flat curve, 1 several peaks)')
  })
  it('empty', () => expect(summariseTileFocus([])).toBe(''))
})
