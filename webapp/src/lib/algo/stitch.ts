/** Mosaic stitching: refine nominal tile positions with pairwise FFT correlation on overlaps, then a
 *  global least-squares solve (port of the approach in openflexure-stitching, simplified). */

import { displacement } from './fftTrack'
import type { Gray } from './sharpness'

export interface StitchTile { id: number; x: number; y: number; width: number; height: number }   // nominal px positions
export interface PairOffset { a: number; b: number; dx: number; dy: number; weight: number }

function crop(g: Gray, x0: number, y0: number, w: number, h: number): Gray {
  const data = new Float32Array(w * h)
  for (let y = 0; y < h; y++) data.set(g.data.subarray((y0 + y) * g.width + x0, (y0 + y) * g.width + x0 + w), y * w)
  return { data, width: w, height: h }
}

/** For every overlapping pair, measure the actual offset (b relative to a) from the overlap region.
 *  `images` are downsampled greyscale versions of the tiles (scale = image width / tile width). */
export function pairwiseOffsets(tiles: StitchTile[], images: Gray[], minOverlapPx = 24, minQuality = 1.3): PairOffset[] {
  const out: PairOffset[] = []
  for (let i = 0; i < tiles.length; i++) for (let j = i + 1; j < tiles.length; j++) {
    const a = tiles[i], b = tiles[j], ia = images[i], ib = images[j]
    const s = ia.width / a.width
    // overlap rectangle in mosaic coordinates
    const ox0 = Math.max(a.x, b.x), oy0 = Math.max(a.y, b.y)
    const ox1 = Math.min(a.x + a.width, b.x + b.width), oy1 = Math.min(a.y + a.height, b.y + b.height)
    const ow = Math.floor((ox1 - ox0) * s), oh = Math.floor((oy1 - oy0) * s)
    if (ow < minOverlapPx || oh < minOverlapPx) continue
    const ca = crop(ia, Math.floor((ox0 - a.x) * s), Math.floor((oy0 - a.y) * s), ow, oh)
    const cb = crop(ib, Math.floor((ox0 - b.x) * s), Math.floor((oy0 - b.y) * s), ow, oh)
    const d = displacement(ca, cb)
    if (!Number.isFinite(d.quality) || d.quality < minQuality) continue
    // content in b appears shifted by (dx,dy) relative to a -> b's true position is nominal minus the shift
    out.push({ a: i, b: j, dx: (b.x - a.x) - d.dx / s, dy: (b.y - a.y) - d.dy / s, weight: Math.min(d.quality, 10) })
  }
  return out
}

/** Solve for positions p minimising sum w (p_b - p_a - d)^2 with p_0 fixed (Gauss-Seidel iterations). */
export function solvePositions(tiles: StitchTile[], pairs: PairOffset[], iterations = 200): { x: number; y: number }[] {
  const pos = tiles.map((t) => ({ x: t.x, y: t.y }))
  if (!pairs.length) return pos
  const adj: { other: number; dx: number; dy: number; w: number }[][] = tiles.map(() => [])
  for (const p of pairs) {
    adj[p.b].push({ other: p.a, dx: p.dx, dy: p.dy, w: p.weight })
    adj[p.a].push({ other: p.b, dx: -p.dx, dy: -p.dy, w: p.weight })
  }
  for (let it = 0; it < iterations; it++) {
    for (let i = 1; i < tiles.length; i++) {
      if (!adj[i].length) continue
      let sx = 0, sy = 0, sw = 0
      for (const e of adj[i]) { sx += e.w * (pos[e.other].x + e.dx); sy += e.w * (pos[e.other].y + e.dy); sw += e.w }
      pos[i] = { x: sx / sw, y: sy / sw }
    }
  }
  // normalise so the mosaic starts at (0,0)
  const minX = Math.min(...pos.map((p) => p.x)), minY = Math.min(...pos.map((p) => p.y))
  return pos.map((p) => ({ x: p.x - minX, y: p.y - minY }))
}

/** Per-pixel feather weight for blending: 1 in the middle, tapering to 0 over `feather` px at the edges. */
export function featherWeight(x: number, y: number, w: number, h: number, feather: number): number {
  const fx = Math.min(1, Math.min(x + 0.5, w - x - 0.5) / feather)
  const fy = Math.min(1, Math.min(y + 0.5, h - y - 0.5) / feather)
  return Math.max(0, fx) * Math.max(0, fy)
}
