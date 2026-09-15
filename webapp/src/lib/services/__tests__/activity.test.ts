import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ActivityService } from '../activity.svelte'

/** A fully injected harness: no real DOM, no real device/RPC. Mirrors real usage (App.svelte calls
 *  `start()` once at mount) so `active` reflects the injected visibility from the outset. `emitOpen()`
 *  and `emitVisibility()` simulate the two subscriptions `start()` wires up. */
function harness(opts: { visible?: boolean; isStandby?: boolean } = {}) {
  let visible = opts.visible ?? true
  let onOpen: (() => void) | null = null
  let onVisibility: (() => void) | null = null
  const call = vi.fn(async (_method: string, params?: Record<string, unknown>) => ({
    on: true, since: 0, idle_in: (params?.active as boolean) ? -1 : 42,
  }))
  const svc = new ActivityService({
    call,
    isStandby: () => opts.isStandby ?? false,
    subscribeOpen: (fn) => { onOpen = fn; return () => { onOpen = null } },
    getVisibility: () => visible,
    subscribeVisibility: (fn) => { onVisibility = fn; return () => { onVisibility = null } },
  })
  svc.start()
  return {
    svc, call,
    setVisible(v: boolean) { visible = v },
    emitOpen() { onOpen?.() },
    emitVisibility() { onVisibility?.() },
  }
}

describe('ActivityService', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('is active while visible with no holds, inactive once hidden (+ visibilitychange fires)', async () => {
    const h = harness({ visible: true })
    expect(h.svc.active).toBe(true)
    await vi.advanceTimersByTimeAsync(0)   // flush start()'s own declare()
    h.call.mockClear()
    h.setVisible(false)
    h.emitVisibility()
    // Hidden with no hold declares inactive immediately, not on the next 60s heartbeat.
    expect(h.svc.active).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.call).toHaveBeenCalledWith('power.activity', { active: false, reason: 'visibility' })
  })

  it('reference-counts holds: releasing one of two concurrent holds keeps it active', () => {
    const h = harness({ visible: false })
    expect(h.svc.active).toBe(false)
    const releaseA = h.svc.hold('recording')
    const releaseB = h.svc.hold('tracking')
    expect(h.svc.active).toBe(true)
    releaseA()
    expect(h.svc.active).toBe(true)   // B still holds
    releaseB()
    expect(h.svc.active).toBe(false)
  })

  it('release is idempotent', () => {
    const h = harness({ visible: false })
    const release = h.svc.hold('recording')
    release()
    expect(h.svc.active).toBe(false)
    expect(() => release()).not.toThrow()
    expect(h.svc.active).toBe(false)
    // a second, unrelated hold is unaffected by the stale release
    const release2 = h.svc.hold('tracking')
    expect(h.svc.active).toBe(true)
    release()   // stale call from the first hold must not touch the second
    expect(h.svc.active).toBe(true)
    release2()
    expect(h.svc.active).toBe(false)
  })

  it('a hold keeps the tab active even while hidden (locked-screen recording)', () => {
    const h = harness({ visible: false })
    const release = h.svc.hold('recording')
    expect(h.svc.active).toBe(true)
    release()
    expect(h.svc.active).toBe(false)
  })

  it('the standby screen suppresses active even while visible, holds included', () => {
    const h = harness({ visible: true, isStandby: true })
    expect(h.svc.active).toBe(false)
    const release = h.svc.hold('recording')
    expect(h.svc.active).toBe(false)
    release()
  })

  it('declares itself active on start()', async () => {
    const h = harness({ visible: true })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.call).toHaveBeenCalledWith('power.activity', { active: true, reason: 'start' })
  })

  it('re-declares immediately on reconnect (the device forgets a closed socket)', async () => {
    const h = harness({ visible: true })
    await vi.advanceTimersByTimeAsync(0)
    h.call.mockClear()
    h.emitOpen()
    await vi.advanceTimersByTimeAsync(0)
    expect(h.call).toHaveBeenCalledWith('power.activity', { active: true, reason: 'reconnect' })
  })

  it('sends a heartbeat every 60s while started, and stops after stop()', async () => {
    const h = harness({ visible: true })
    await vi.advanceTimersByTimeAsync(0)
    h.call.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.call).toHaveBeenCalledWith('power.activity', { active: true, reason: 'heartbeat' })
    h.call.mockClear()
    h.svc.stop()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.call).not.toHaveBeenCalled()
  })

  it('tracks idleIn from the reply', async () => {
    const h = harness({ visible: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.svc.idleIn).toBe(42)
  })
})
