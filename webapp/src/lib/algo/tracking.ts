/** Organism tracking, pure TS. Detect blobs in a greyscale frame (threshold on global contrast, dark
 *  objects on a bright field by default; flood-fill connected components, one centroid + area each),
 *  link them frame to frame by nearest neighbour with a maximum-displacement gate and a few missed
 *  frames of memory (Trackpy-style), and summarise each track's motion. Runs the same on the live
 *  stream or on a stored time-lapse's frames. */

import type { Gray } from './sharpness'

export interface Blob { x: number; y: number; area?: number }

export interface DetectOptions {
  /** standard deviations from the mean used as the threshold */
  thresholdK?: number
  minArea?: number
  maxArea?: number
  /** true (default): dark objects on a bright field; false: bright objects on a dark field */
  dark?: boolean
}

/** Detect blobs by thresholding on the frame's mean ± k·σ and flood-filling 4-connected regions. */
export function detectBlobs(g: Gray, opts: DetectOptions = {}): Blob[] {
  const { thresholdK = 1.2, minArea = 4, maxArea = Infinity, dark = true } = opts
  const { data, width, height } = g
  const n = data.length
  let sum = 0
  for (let i = 0; i < n; i++) sum += data[i]
  const mean = sum / n
  let sq = 0
  for (let i = 0; i < n; i++) { const d = data[i] - mean; sq += d * d }
  const std = Math.sqrt(sq / n)
  const thr = dark ? mean - thresholdK * std : mean + thresholdK * std
  const mask = new Uint8Array(n)
  for (let i = 0; i < n; i++) mask[i] = (dark ? data[i] < thr : data[i] > thr) ? 1 : 0

  const labels = new Int32Array(n).fill(-1)
  const qx = new Int32Array(n), qy = new Int32Array(n)
  const blobs: Blob[] = []
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (!mask[idx] || labels[idx] !== -1) continue
      let head = 0, tail = 0
      qx[tail] = x; qy[tail] = y; tail++
      labels[idx] = blobs.length
      let sx = 0, sy = 0, area = 0
      while (head < tail) {
        const cx = qx[head], cy = qy[head]; head++
        sx += cx; sy += cy; area++
        const nb: [number, number][] = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]]
        for (const [nx, ny] of nb) {
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
          const nidx = ny * width + nx
          if (mask[nidx] && labels[nidx] === -1) { labels[nidx] = blobs.length; qx[tail] = nx; qy[tail] = ny; tail++ }
        }
      }
      if (area >= minArea && area <= maxArea) blobs.push({ x: sx / area, y: sy / area, area })
    }
  }
  return blobs
}

export interface TrackPoint { t: number; x: number; y: number; area?: number }
export interface Track { id: number; points: TrackPoint[]; missed: number; active: boolean }

/** Frame-to-frame nearest-neighbour linking with a maximum-displacement gate and a few missed frames
 *  of memory (Trackpy-style). Call `step` once per frame, in time order (t in seconds). */
export class BlobTracker {
  private tracks: Track[] = []
  private nextId = 0

  constructor(public maxDisplacement: number, public maxMissed = 3) {}

  step(t: number, blobs: Blob[]): Track[] {
    const unmatched = new Set(blobs.map((_, i) => i))
    for (const track of this.tracks) {
      if (!track.active) continue
      const last = track.points[track.points.length - 1]
      let best = -1, bestD = this.maxDisplacement
      for (const i of unmatched) {
        const d = Math.hypot(blobs[i].x - last.x, blobs[i].y - last.y)
        if (d < bestD) { bestD = d; best = i }
      }
      if (best >= 0) {
        track.points.push({ t, x: blobs[best].x, y: blobs[best].y, area: blobs[best].area })
        track.missed = 0
        unmatched.delete(best)
      } else if (++track.missed > this.maxMissed) {
        track.active = false
      }
    }
    for (const i of unmatched) {
      this.tracks.push({ id: this.nextId++, points: [{ t, x: blobs[i].x, y: blobs[i].y, area: blobs[i].area }], missed: 0, active: true })
    }
    return this.tracks
  }

  allTracks(): Track[] { return this.tracks }
}

export interface TrackStats {
  id: number
  points: number
  pathLength: number         // px
  netDisplacement: number    // px
  durationS: number
  meanSpeedPxS: number
  meanSpeedUmS?: number
  straightness: number       // 0..1, net / path (1 = a straight line)
}

/** `umPerPx` (optional): micrometres per pixel, to also report speed in µm/s. */
export function trackStats(track: Track, umPerPx?: number): TrackStats {
  const pts = track.points
  let pathLength = 0
  for (let i = 1; i < pts.length; i++) pathLength += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  const net = pts.length > 1 ? Math.hypot(pts[pts.length - 1].x - pts[0].x, pts[pts.length - 1].y - pts[0].y) : 0
  const durationS = pts.length > 1 ? pts[pts.length - 1].t - pts[0].t : 0
  const meanSpeedPxS = durationS > 0 ? pathLength / durationS : 0
  return {
    id: track.id, points: pts.length, pathLength, netDisplacement: net, durationS, meanSpeedPxS,
    meanSpeedUmS: umPerPx !== undefined ? meanSpeedPxS * umPerPx : undefined,
    straightness: pathLength > 0 ? net / pathLength : 0,
  }
}

/** CSV with per-frame positions for every track, a blank line, then per-track summary statistics. */
export function tracksToCsv(tracks: Track[], umPerPx?: number): string {
  const lines = ['track_id,t_s,x_px,y_px,area_px2']
  for (const tr of tracks) for (const p of tr.points) lines.push(`${tr.id},${p.t},${p.x.toFixed(2)},${p.y.toFixed(2)},${p.area ?? ''}`)
  lines.push('')
  lines.push(umPerPx !== undefined
    ? 'track_id,points,path_length_px,net_displacement_px,duration_s,mean_speed_px_s,mean_speed_um_s,straightness'
    : 'track_id,points,path_length_px,net_displacement_px,duration_s,mean_speed_px_s,straightness')
  for (const tr of tracks) {
    const s = trackStats(tr, umPerPx)
    const row = [String(s.id), String(s.points), s.pathLength.toFixed(2), s.netDisplacement.toFixed(2), s.durationS.toFixed(2), s.meanSpeedPxS.toFixed(3)]
    if (umPerPx !== undefined) row.push((s.meanSpeedUmS ?? 0).toFixed(3))
    row.push(s.straightness.toFixed(3))
    lines.push(row.join(','))
  }
  return lines.join('\n')
}
