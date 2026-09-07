import { describe, expect, it } from 'vitest'
import { detectBlobs, BlobTracker, trackStats, tracksToCsv, type Track } from '../tracking'
import type { Gray } from '../sharpness'

const W = 100, H = 100

/** A bright field (200) with round dark blobs (40) at the given centres, radius r. */
function frame(centres: { x: number; y: number }[], r = 6): Gray {
  const data = new Float32Array(W * H).fill(200)
  for (const c of centres) {
    for (let y = Math.max(0, Math.round(c.y - r)); y < Math.min(H, c.y + r); y++) {
      for (let x = Math.max(0, Math.round(c.x - r)); x < Math.min(W, c.x + r); x++) {
        if (Math.hypot(x - c.x, y - c.y) <= r) data[y * W + x] = 40
      }
    }
  }
  return { data, width: W, height: H }
}

describe('detectBlobs', () => {
  it('finds dark blobs on a bright field near their true centres and areas', () => {
    const centres = [{ x: 20, y: 20 }, { x: 70, y: 60 }]
    const blobs = detectBlobs(frame(centres, 6))
    expect(blobs.length).toBe(2)
    for (const c of centres) {
      const hit = blobs.find((b) => Math.hypot(b.x - c.x, b.y - c.y) < 1.5)
      expect(hit).toBeDefined()
      expect(hit!.area).toBeGreaterThan(80)   // ~pi*6^2 ≈ 113
      expect(hit!.area).toBeLessThan(140)
    }
  })

  it('finds bright blobs on a dark field when dark:false', () => {
    const data = new Float32Array(W * H).fill(20)
    for (let y = 40; y < 60; y++) for (let x = 40; x < 60; x++) data[y * W + x] = 220
    const blobs = detectBlobs({ data, width: W, height: H }, { dark: false })
    expect(blobs.length).toBe(1)
    expect(blobs[0].x).toBeCloseTo(49.5, 0)
    expect(blobs[0].y).toBeCloseTo(49.5, 0)
  })

  it('drops blobs outside the area gate', () => {
    const blobs = detectBlobs(frame([{ x: 50, y: 50 }], 6), { minArea: 1000 })
    expect(blobs.length).toBe(0)
  })

  it('returns nothing on a featureless field', () => {
    expect(detectBlobs({ data: new Float32Array(W * H).fill(150), width: W, height: H })).toEqual([])
  })
})

describe('BlobTracker', () => {
  it('links a blob moving in a straight line across frames', () => {
    const tracker = new BlobTracker(15, 3)
    const path = [{ x: 10, y: 10 }, { x: 15, y: 10 }, { x: 20, y: 10 }, { x: 25, y: 10 }]
    let tracks: Track[] = []
    path.forEach((p, i) => { tracks = tracker.step(i, [p]) })
    expect(tracks.length).toBe(1)
    expect(tracks[0].points.length).toBe(4)
    expect(tracks[0].points[3]).toMatchObject({ x: 25, y: 10 })
  })

  it('starts a new track when a blob jumps further than the displacement gate', () => {
    const tracker = new BlobTracker(5, 3)
    tracker.step(0, [{ x: 0, y: 0 }])
    tracker.step(1, [{ x: 50, y: 50 }])   // far beyond the gate
    const tracks = tracker.allTracks()
    expect(tracks.length).toBe(2)
    expect(tracks[0].active).toBe(true)   // missed a frame, but not yet past maxMissed
    expect(tracks[0].missed).toBe(1)
    expect(tracks[1].points).toEqual([{ x: 50, y: 50, t: 1, area: undefined }])
  })

  it('keeps a track alive across a few missed frames then drops it', () => {
    const tracker = new BlobTracker(10, 2)
    tracker.step(0, [{ x: 0, y: 0 }])
    tracker.step(1, [])
    tracker.step(2, [])
    let tracks = tracker.step(3, [{ x: 1, y: 1 }])   // reappears within the gate before maxMissed is exceeded
    expect(tracks.find((t) => t.id === 0)!.active).toBe(true)
    expect(tracks.find((t) => t.id === 0)!.points.length).toBe(2)
    tracks = tracker.step(4, [])
    tracks = tracker.step(5, [])
    tracks = tracker.step(6, [])
    expect(tracks.find((t) => t.id === 0)!.active).toBe(false)
  })

  it('links two simultaneous blobs to their nearest match each', () => {
    const tracker = new BlobTracker(10)
    tracker.step(0, [{ x: 0, y: 0 }, { x: 100, y: 100 }])
    const tracks = tracker.step(1, [{ x: 103, y: 100 }, { x: 3, y: 0 }])
    const near0 = tracks.find((t) => t.points[0].x === 0)!
    const near100 = tracks.find((t) => t.points[0].x === 100)!
    expect(near0.points[1]).toMatchObject({ x: 3, y: 0 })
    expect(near100.points[1]).toMatchObject({ x: 103, y: 100 })
  })
})

describe('trackStats', () => {
  it('computes path length, net displacement and straightness for a straight line', () => {
    const track: Track = { id: 0, active: true, missed: 0, points: [
      { t: 0, x: 0, y: 0 }, { t: 1, x: 10, y: 0 }, { t: 2, x: 20, y: 0 },
    ] }
    const s = trackStats(track)
    expect(s.pathLength).toBeCloseTo(20)
    expect(s.netDisplacement).toBeCloseTo(20)
    expect(s.straightness).toBeCloseTo(1)
    expect(s.durationS).toBe(2)
    expect(s.meanSpeedPxS).toBeCloseTo(10)
  })

  it('gives a straightness under 1 for a bent path and converts to µm/s', () => {
    const track: Track = { id: 1, active: true, missed: 0, points: [
      { t: 0, x: 0, y: 0 }, { t: 1, x: 10, y: 0 }, { t: 2, x: 10, y: 10 },
    ] }
    const s = trackStats(track, 0.5)
    expect(s.pathLength).toBeCloseTo(20)
    expect(s.netDisplacement).toBeCloseTo(Math.hypot(10, 10))
    expect(s.straightness).toBeLessThan(1)
    expect(s.meanSpeedUmS).toBeCloseTo(s.meanSpeedPxS * 0.5)
  })

  it('handles a single-point track without dividing by zero', () => {
    const s = trackStats({ id: 2, active: true, missed: 0, points: [{ t: 0, x: 5, y: 5 }] })
    expect(s.pathLength).toBe(0)
    expect(s.straightness).toBe(0)
    expect(s.meanSpeedPxS).toBe(0)
  })
})

describe('tracksToCsv', () => {
  it('emits a per-frame section and a per-track summary section', () => {
    const tracks: Track[] = [{ id: 0, active: true, missed: 0, points: [{ t: 0, x: 1, y: 2, area: 30 }, { t: 1, x: 3, y: 4, area: 32 }] }]
    const csv = tracksToCsv(tracks)
    const lines = csv.split('\n')
    expect(lines[0]).toBe('track_id,t_s,x_px,y_px,area_px2')
    expect(lines[1]).toBe('0,0,1.00,2.00,30')
    expect(lines[2]).toBe('0,1,3.00,4.00,32')
    expect(lines[3]).toBe('')
    expect(lines[4]).toContain('mean_speed_px_s')
    expect(lines[5].split(',')[0]).toBe('0')
  })

  it('adds a µm/s column when umPerPx is given', () => {
    const tracks: Track[] = [{ id: 0, active: true, missed: 0, points: [{ t: 0, x: 0, y: 0 }, { t: 1, x: 10, y: 0 }] }]
    const csv = tracksToCsv(tracks, 0.2)
    expect(csv).toContain('mean_speed_um_s')
  })
})
