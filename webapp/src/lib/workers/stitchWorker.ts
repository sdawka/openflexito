/** Web Worker: refine tile positions by correlation (robust global solve), equalise per-tile luminance
 *  gains from the overlaps, optionally flat-field the tiles, and render the mosaic as a normalised
 *  weighted average with feather weights on every tile. The blend is accumulated in row bands of
 *  Float32 planes (`BandAccumulator`), so memory stays near 128 MB however large the mosaic is; the
 *  optional multi-band (Laplacian) blend needs whole-mosaic float pyramids and is limited to mosaics
 *  of at most `MULTIBAND_MAX_DIM` on the long side (larger requests fall back to feather blending). */

import { defineWorker, post } from './workerUtil'
import {
  pairwiseOffsets, solvePositions, solvePositionsRobust, overlapGains, solveGains,
  applyFlatField, applyFlatFieldRGBA, normaliseGainMap, BandAccumulator, bandRows, blendMultiband,
  type GainMap, type PlacedTile,
} from '../algo/stitch'
import type { Gray } from '../algo/sharpness'

export interface StitchRequest {
  tiles: { blob: Blob; x: number; y: number; width: number; height: number }[]
  maxDim: number          // cap the mosaic's long side (canvas limits)
  analysisWidth: number   // downsampled width per tile for correlation
  refine: boolean
  /** MAD outlier rejection in the position solve (default true) */
  robust?: boolean
  /** per-tile luminance gain equalisation from overlap statistics (default true) */
  gainEqualise?: boolean
  /** 0 (default) = feather blend; 2 or 3 = multi-band Laplacian blend with that many levels */
  multiband?: number
  /** flat-field map (relative illumination, mean ~1) the tiles are divided by before correlation and blending */
  flatField?: { width: number; height: number; channels: 1 | 3; data: number[] | Float32Array } | null
  /** feather width as a fraction of the shorter tile side (default 0.08) */
  feather?: number
  /** output encoding (default JPEG q0.92) */
  output?: { type: 'image/jpeg' | 'image/png'; quality?: number }
}
export interface StitchResponse {
  positions: { x: number; y: number }[]; mosaic: Blob; width: number; height: number; scale: number
  pairs: number; dropped: number; gains: number[]; blend: 'feather' | 'multiband'; flatField: boolean
}

const MULTIBAND_MAX_DIM = 4096

async function toGrayScaled(bmp: ImageBitmap, width: number): Promise<Gray> {
  const scale = width / bmp.width, h = Math.round(bmp.height * scale)
  const c = new OffscreenCanvas(width, h), ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bmp, 0, 0, width, h)
  const d = ctx.getImageData(0, 0, width, h).data
  const data = new Float32Array(width * h)
  for (let i = 0, j = 0; i < data.length; i++, j += 4) data[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]
  return { data, width, height: h }
}

defineWorker<StitchRequest>(async (m) => {
  const { tiles, maxDim, analysisWidth, refine } = m
  const robust = m.robust ?? true, gainEqualise = m.gainEqualise ?? true
  const flat: GainMap | null = m.flatField ? normaliseGainMap({ width: m.flatField.width, height: m.flatField.height, channels: m.flatField.channels, data: Float32Array.from(m.flatField.data) }) : null
  const bitmaps = await Promise.all(tiles.map((t) => createImageBitmap(t.blob)))
  const stitchTiles = tiles.map((t, id) => ({ id, x: t.x, y: t.y, width: t.width, height: t.height }))
  let positions = stitchTiles.map((t) => ({ x: t.x, y: t.y })), pairs = 0, dropped = 0
  let gains: number[] = tiles.map(() => 1)
  if (tiles.length > 1 && (refine || gainEqualise)) {
    let grays = await Promise.all(bitmaps.map((b) => toGrayScaled(b, analysisWidth)))
    if (flat) grays = grays.map((g) => applyFlatField(g, flat))
    if (refine) {
      const offsets = pairwiseOffsets(stitchTiles, grays)
      pairs = offsets.length
      if (robust) {
        const r = solvePositionsRobust(stitchTiles, offsets)
        positions = r.positions; dropped = r.dropped.length
      } else {
        positions = solvePositions(stitchTiles, offsets)
      }
      post({ progress: `refined ${pairs} overlaps${dropped ? `, ${dropped} rejected` : ''}` })
    } else {
      positions = solvePositions(stitchTiles, [])
    }
    if (gainEqualise) {
      gains = solveGains(tiles.length, overlapGains(stitchTiles, positions, grays))
      post({ progress: `equalised gains (${Math.min(...gains).toFixed(2)}–${Math.max(...gains).toFixed(2)})` })
    }
  }
  const W = Math.max(...positions.map((p, i) => p.x + tiles[i].width)), H = Math.max(...positions.map((p, i) => p.y + tiles[i].height))
  const wantMultiband = (m.multiband ?? 0) >= 2
  const cap = wantMultiband ? Math.min(maxDim, MULTIBAND_MAX_DIM) : maxDim
  const scale = Math.min(1, cap / Math.max(W, H))
  const width = Math.round(W * scale), height = Math.round(H * scale)
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, width, height)
  const feather = Math.max(1, Math.round(Math.min(tiles[0].width, tiles[0].height) * (m.feather ?? 0.08) * scale))
  // scaled placement of every tile (integer mosaic px)
  const placed = tiles.map((t, i) => ({ x: Math.round(positions[i].x * scale), y: Math.round(positions[i].y * scale), w: Math.max(1, Math.round(t.width * scale)), h: Math.max(1, Math.round(t.height * scale)) }))
  let blend: 'feather' | 'multiband' = 'feather'

  if (wantMultiband) {
    blend = 'multiband'
    const full: PlacedTile[] = []
    for (let i = 0; i < tiles.length; i++) {
      const p = placed[i], c = new OffscreenCanvas(p.w, p.h), cx = c.getContext('2d', { willReadFrequently: true })!
      cx.drawImage(bitmaps[i], 0, 0, p.w, p.h)
      const img = cx.getImageData(0, 0, p.w, p.h)
      if (flat) applyFlatFieldRGBA(img.data, p.w, p.h, flat)
      full.push({ data: img.data, width: p.w, height: p.h, x: p.x, y: p.y, gain: gains[i] })
      bitmaps[i].close()
      post({ progress: `prepared tile ${i + 1}/${tiles.length}` })
    }
    post({ progress: `multi-band blend (${m.multiband} levels)` })
    const out = blendMultiband(full, width, height, feather, m.multiband)
    ctx.putImageData(new ImageData(out as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0)
  } else {
    const rows = bandRows(width, height)
    const acc = new BandAccumulator(width, rows)
    const maxTw = Math.max(...placed.map((p) => p.w))
    const strip = new OffscreenCanvas(maxTw, rows), sctx = strip.getContext('2d', { willReadFrequently: true })!
    for (let y0 = 0; y0 < height; y0 += rows) {
      const n = Math.min(rows, height - y0)
      acc.reset(y0)
      for (let i = 0; i < tiles.length; i++) {
        const p = placed[i]
        const sy0 = Math.max(y0, p.y), sy1 = Math.min(y0 + n, p.y + p.h)
        if (sy1 <= sy0) continue
        const b = bitmaps[i], ky = b.height / p.h
        const rowsHere = sy1 - sy0
        sctx.clearRect(0, 0, p.w, rowsHere)
        sctx.drawImage(b, 0, (sy0 - p.y) * ky, b.width, rowsHere * ky, 0, 0, p.w, rowsHere)
        const img = sctx.getImageData(0, 0, p.w, rowsHere)
        if (flat) applyFlatFieldRGBA(img.data, p.w, rowsHere, flat, p.w, p.h, 0, sy0 - p.y)
        acc.add({ data: img.data, width: p.w, height: rowsHere, x: p.x, y: sy0, tileX: p.x, tileY: p.y, tileW: p.w, tileH: p.h, gain: gains[i] }, feather)
      }
      const rgba = acc.toRGBA(n)
      ctx.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, width, n), 0, y0)
      post({ progress: `blended rows ${Math.min(height, y0 + n)}/${height}` })
    }
    for (const b of bitmaps) b.close()
  }
  const out = m.output ?? { type: 'image/jpeg', quality: 0.92 }
  const mosaic = await canvas.convertToBlob(out.type === 'image/png' ? { type: 'image/png' } : { type: 'image/jpeg', quality: out.quality ?? 0.92 })
  const res: StitchResponse = { positions, mosaic, width, height, scale, pairs, dropped, gains, blend, flatField: !!flat }
  post({ result: res })
})
