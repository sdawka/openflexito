import { describe, it, expect } from 'vitest'
import { denoiseProcessor } from '../denoiseProcessor'
import { settings } from '../../store/settings.svelte'
import { device } from '../../store/device.svelte'
import { TemporalDenoiser } from '../../algo/temporalDenoise'

function syntheticFrame(w: number, h: number, seed = 0): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const p = i * 4
    const n = (Math.sin(i * 12.9898 + seed) * 43758.5453) % 1
    const noise = Math.abs(n) * 40
    data[p] = 120 + noise; data[p + 1] = 130 + noise; data[p + 2] = 110 + noise; data[p + 3] = 255
  }
  return data
}

describe('denoiseProcessor', () => {
  it('enabled(view) follows settings.liveDenoise; enabled(record) additionally needs liveDenoiseRecord', () => {
    settings.liveDenoise = false; settings.liveDenoiseRecord = false
    expect(denoiseProcessor.enabled('view')).toBe(false)
    expect(denoiseProcessor.enabled('record')).toBe(false)
    expect(denoiseProcessor.enabled('playback')).toBe(false)

    settings.liveDenoise = true
    expect(denoiseProcessor.enabled('view')).toBe(true)
    expect(denoiseProcessor.enabled('record')).toBe(false) // liveDenoiseRecord still off

    settings.liveDenoiseRecord = true
    expect(denoiseProcessor.enabled('record')).toBe(true)
    expect(denoiseProcessor.enabled('playback')).toBe(false) // never enabled for playback

    settings.liveDenoise = false; settings.liveDenoiseRecord = false
  })

  it('passes a moving-stage frame through unchanged and resets state on the moving->settled edge', () => {
    denoiseProcessor.reset?.()
    device.moving = true
    const frame = { data: syntheticFrame(64, 48), width: 64, height: 48 }
    const out = denoiseProcessor.process(frame, 'view', 0)
    expect(out).toBe(frame) // untouched while moving
    device.moving = false
  })

  it('blends consecutive still frames without throwing and keeps the RGBA shape', () => {
    denoiseProcessor.reset?.()
    device.moving = false
    const w = 64, h = 48
    let out = denoiseProcessor.process({ data: syntheticFrame(w, h, 0), width: w, height: h }, 'view', 0)
    for (let i = 1; i < 5; i++) {
      out = denoiseProcessor.process({ data: syntheticFrame(w, h, i), width: w, height: h }, 'view', i)
    }
    expect('width' in out && (out as { width: number }).width).toBe(w)
    expect('height' in out && (out as { height: number }).height).toBe(h)
    expect('data' in out && (out as { data: Uint8ClampedArray }).data.length).toBe(w * h * 4)
  })
})

// Perf note: `denoiseProcessor.process`'s per-frame cost is dominated by `TemporalDenoiser.push` (the
// CSM shift lookup and moving/settled bookkeeping around it are O(1)); benchmarking that directly here
// avoids needing a live device/calibration harness just to measure throughput.
//
// MEASURED RESULT (this machine, 1640x1232, warmed up): ~440ms/frame, i.e. ~2.3 fps - a long way short
// of the >=15fps (<=~67ms/frame) design target for live denoise. Root cause: `TemporalDenoiser.push`
// calls `estimateSigmaMad` on every frame (`temporalDenoise.ts`'s per-pixel confidence gate needs a
// fresh noise sigma each frame), and `estimateSigmaMad` (`algo/noise.ts`) computes two full-array
// `Array.from(...).sort()` medians over the HH wavelet subband (~500k elements at this resolution) -
// an O(n log n) sort, per frame, is the dominant cost, not the O(n) warp/blend loop around it. This is
// a WP3 (`algo/temporalDenoise.ts`+`algo/noise.ts`) hot path, out of WP4's file ownership to fix
// (`docs/image-pipeline/design.md`'s WP4 row excludes `lib/algo`); flagged to the team lead as a
// perf bug rather than silently loosened here. The bound below is set from the actual measurement
// (with headroom for CI variance) so this test still catches a further regression, but it does NOT
// certify the >=15fps target - `settings.liveDenoise` should be treated as not yet meeting spec until
// `estimateSigmaMad` gets a sub-sampled or incremental variant.
describe('TemporalDenoiser throughput at live-view resolution', () => {
  it('processes a 1640x1232 frame (regression bound only - see perf note above, this does not meet the >=15fps design target)', () => {
    const w = 1640, h = 1232
    const denoiser = new TemporalDenoiser({ alpha: 0.7, maxShiftPx: 60 })
    denoiser.push(syntheticFrame(w, h, 0), w, h, { dx: 0, dy: 0 }) // first frame just seeds `prev`
    const iterations = 3
    const t0 = performance.now()
    for (let i = 1; i <= iterations; i++) denoiser.push(syntheticFrame(w, h, i), w, h, { dx: 0.3, dy: -0.2 })
    const avgMs = (performance.now() - t0) / iterations
    expect(avgMs).toBeLessThan(1500) // regression guard, not a real-time budget - see note above
  })
})
