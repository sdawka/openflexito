import { describe, expect, it } from 'vitest'
import { StateLog, ClockMap, AMBIGUOUS } from '../frameAttrib'

// Timestamp attribution (creative.md §0): a frame belongs to the illumination state that held over
// its whole exposure window; a window that straddles a switch is ambiguous and must be dropped.

describe('StateLog', () => {
  it('attributes a window fully inside one state and rejects one that straddles a switch', () => {
    const log = new StateLog<'bright' | 'dim'>()
    log.push(0, 'bright')
    log.push(1000, 'dim')
    log.push(2000, 'bright')
    expect(log.stateOver(100, 900)).toBe('bright')
    expect(log.stateOver(1000, 1500)).toBe('dim')      // the switch instant itself belongs to the new state
    expect(log.stateOver(900, 1100)).toBe(AMBIGUOUS)  // exposure crosses the switch
    expect(log.stateOver(1500, 2000)).toBe(AMBIGUOUS) // switch exactly at the end of the exposure
    expect(log.stateOver(2100, 2600)).toBe('bright')
    expect(log.latest()).toBe('bright')
  })

  it('is ambiguous before the first known switch and on an empty log', () => {
    const log = new StateLog<number>()
    expect(log.stateOver(0, 1)).toBe(AMBIGUOUS)
    log.push(500, 1)
    expect(log.stateOver(0, 400)).toBe(AMBIGUOUS)
    expect(log.stateOver(600, 700)).toBe(1)
  })

  it('treats the uncertainty interval of a browser-timed switch as ambiguous', () => {
    const log = new StateLog<'A' | 'B'>()
    log.push(0, 'A')
    log.push(1000, 'B', 1300)   // sent at 1000, acknowledged at 1300
    expect(log.stateOver(500, 900)).toBe('A')
    expect(log.stateOver(500, 1000)).toBe(AMBIGUOUS)
    expect(log.stateOver(1100, 1200)).toBe(AMBIGUOUS)
    expect(log.stateOver(1200, 1400)).toBe(AMBIGUOUS)
    expect(log.stateOver(1300, 1400)).toBe('B')
  })

  it('keeps only the newest `capacity` switches and still answers correctly after wrap-around', () => {
    const log = new StateLog<number>(8)
    for (let i = 0; i < 100; i++) log.push(i * 10, i)
    expect(log.length).toBe(8)
    expect(log.stateOver(0, 5)).toBe(AMBIGUOUS)    // evicted history
    expect(log.stateOver(921, 929)).toBe(92)
    expect(log.stateOver(995, 1200)).toBe(99)
    expect(log.stateOver(925, 935)).toBe(AMBIGUOUS)
  })

  it('clamps an out-of-order push to the previous switch instead of corrupting the order', () => {
    const log = new StateLog<string>()
    log.push(100, 'a')
    log.push(50, 'b')
    expect(log.stateOver(100, 100)).toBe('b')
    expect(log.stateOver(60, 90)).toBe(AMBIGUOUS)
  })

  it('handles a zero-length window (instant) and swapped bounds', () => {
    const log = new StateLog<string>()
    log.push(0, 'a'); log.push(10, 'b')
    expect(log.stateOver(5, 5)).toBe('a')
    expect(log.stateOver(12, 11)).toBe('b')
  })
})

describe('ClockMap', () => {
  it('uses the observation with the least latency and maps browser time onto the device clock', () => {
    const map = new ClockMap(8)
    expect(map.ready).toBe(false)
    expect(Number.isNaN(map.offsetNs())).toBe(true)
    const trueOffset = 5e12   // device clock is 5000 s ahead of performance.now()
    // frames seen 40, 25, 60 ms after their device time
    for (const [tDev, lagMs] of [[1e9, 40], [2e9, 25], [3e9, 60]] as [number, number][]) map.observe(tDev, (tDev - trueOffset) / 1e6 + lagMs)
    expect(map.ready).toBe(true)
    // the best estimate is short of the truth by the smallest latency seen
    expect(map.offsetNs()).toBeCloseTo(trueOffset - 25e6, -3)
    expect(map.toDevice((4e9 - trueOffset) / 1e6)).toBeCloseTo(4e9 - 25e6, -3)
  })

  it('forgets observations outside its window', () => {
    const map = new ClockMap(2)
    map.observe(100, 0)   // offset 100
    map.observe(50, 0)
    map.observe(40, 0)
    expect(map.offsetNs()).toBe(50)
  })
})
