/** The four background-capable services (recording, live stack, tracking, time-lapse) must never leak
 *  an activity hold: whatever ends the run — normal completion, an error, or an early bail — has to
 *  release it exactly once. `activity.svelte.ts` is mocked here so the test is a pure unit test of the
 *  hold/release bookkeeping in each service, independent of the real visibility/heartbeat logic. */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../store/gallery', () => ({
  saveVideo: vi.fn(async () => ({ id: 'x', name: 'test.webm' })),
}))

const holds = { active: 0, released: 0 }
vi.mock('../activity.svelte', () => ({
  activity: {
    hold: (_reason: string) => {
      holds.active++
      let released = false
      return () => {
        if (released) return
        released = true
        holds.active--
        holds.released++
      }
    },
  },
}))

describe('activity holds', () => {
  beforeEach(() => { holds.active = 0; holds.released = 0 })

  it('recorder: stop() releases the hold taken when recording starts, once', async () => {
    const { Recorder } = await import('../recorder.svelte')
    const r = new Recorder()
    // Simulate a started recording without driving the real MediaRecorder/canvas machinery: poke the
    // private fields a real start() would have set, then exercise the public stop() path.
    ;(r as any).recording = true
    ;(r as any).rec = { stop: () => {}, onstop: null as (() => void) | null, mimeType: 'video/webm' }
    ;(r as any).canvas = { width: 1, height: 1, toBlob: (cb: (b: Blob | null) => void) => cb(null) }
    const { activity } = await import('../activity.svelte')
    ;(r as any).releaseActivity = activity.hold('video recording')
    expect(holds.active).toBe(1)
    const rec = (r as any).rec
    const origStop = rec.stop.bind(rec)
    rec.stop = () => { origStop(); rec.onstop?.() }
    await r.stop()
    expect(holds.active).toBe(0)
    expect(holds.released).toBe(1)
    // calling stop() again (already not recording) must not double-release or throw
    await r.stop()
    expect(holds.released).toBe(1)
  })

  it('liveStack: stop() releases a held activity hold, and is safe when nothing was held', async () => {
    const { liveStack } = await import('../liveStack.svelte')
    const { activity } = await import('../activity.svelte')
    // start() spins up a real Worker, unavailable under vitest's node environment, so the hold/release
    // wiring is exercised directly rather than by driving the full start()/stop() lifecycle.
    ;(liveStack as any).active = true
    ;(liveStack as any).releaseActivity = activity.hold('live focus stack')
    expect(holds.active).toBe(1)
    liveStack.stop()
    expect(holds.active).toBe(0)
    expect(holds.released).toBe(1)
    // calling stop() again (nothing held) must not double-release or throw
    liveStack.stop()
    expect(holds.released).toBe(1)
  })

  it('tracking: stop() releases the hold taken by start()', async () => {
    const { tracking } = await import('../tracking.svelte')
    tracking.start()
    expect(holds.active).toBe(1)
    tracking.stop()
    expect(holds.active).toBe(0)
    expect(holds.released).toBe(1)
  })
})
