import { describe, expect, it } from 'vitest'
import { applyOverrides, expandForReplay, normalizeSteps, stepDelays, totalDurationMs, type MacroStep } from '../macro'

const step = (t: number, method: string, params: Record<string, unknown> = {}): MacroStep => ({ kind: 'call', t, method, params, label: method })

describe('normalizeSteps', () => {
  it('sorts by time and rebases to 0', () => {
    const out = normalizeSteps([step(1500, 'b'), step(1000, 'a'), step(2000, 'c')])
    expect(out.map((s) => s.method)).toEqual(['a', 'b', 'c'])
    expect(out.map((s) => s.t)).toEqual([0, 500, 1000])
  })
  it('returns an empty array unchanged', () => {
    expect(normalizeSteps([])).toEqual([])
  })
})

describe('stepDelays', () => {
  const steps = normalizeSteps([step(0, 'a'), step(300, 'b'), step(900, 'c')])
  it('recorded speed reproduces the gaps between steps', () => {
    expect(stepDelays(steps, 'recorded')).toEqual([0, 300, 600])
  })
  it('fast speed has no delays', () => {
    expect(stepDelays(steps, 'fast')).toEqual([0, 0, 0])
  })
})

describe('expandForReplay', () => {
  const steps = normalizeSteps([step(0, 'a'), step(100, 'b')])
  it('repeats the steps in order', () => {
    const out = expandForReplay(steps, 3, 0)
    expect(out.map((s) => s.method)).toEqual(['a', 'b', 'a', 'b', 'a', 'b'])
  })
  it('inserts a wait step between repeats when loopWaitMs > 0', () => {
    const out = expandForReplay(steps, 2, 500)
    expect(out.map((s) => s.kind)).toEqual(['call', 'call', 'wait', 'call', 'call'])
    expect(out[2].waitMs).toBe(500)
  })
  it('never repeats fewer than once', () => {
    expect(expandForReplay(steps, 0).length).toBe(steps.length)
    expect(expandForReplay(steps, -5).length).toBe(steps.length)
  })
})

describe('applyOverrides', () => {
  it('merges params for call steps by index, leaving others untouched', () => {
    const steps = normalizeSteps([step(0, 'stage.move_rel', { x: 100 }), step(0, 'stage.move_rel', { y: 50 })])
    const out = applyOverrides(steps, { 0: { x: 999 } })
    expect(out[0].params).toEqual({ x: 999 })
    expect(out[1].params).toEqual({ y: 50 })
  })
  it('merges actionParams for action steps', () => {
    const steps: MacroStep[] = [{ kind: 'action', t: 0, action: 'photo', actionParams: { mode: 'single' }, label: 'photo' }]
    const out = applyOverrides(steps, { 0: { mode: 'raw' } })
    expect(out[0].actionParams).toEqual({ mode: 'raw' })
  })
  it('leaves wait steps untouched', () => {
    const steps: MacroStep[] = [{ kind: 'wait', t: 0, waitMs: 200, label: 'wait 200 ms' }]
    const out = applyOverrides(steps, { 0: { anything: 1 } })
    expect(out[0]).toEqual(steps[0])
  })
})

describe('totalDurationMs', () => {
  it('sums recorded delays and wait steps', () => {
    const steps = normalizeSteps([step(0, 'a'), step(400, 'b')])
    const expanded = expandForReplay(steps, 2, 1000)
    expect(totalDurationMs(expanded, 'recorded')).toBe(400 + 1000 + 400)
  })
  it('is zero-delay-driven at fast speed except explicit waits', () => {
    const steps = normalizeSteps([step(0, 'a'), step(400, 'b')])
    const expanded = expandForReplay(steps, 2, 1000)
    expect(totalDurationMs(expanded, 'fast')).toBe(1000)
  })
})
