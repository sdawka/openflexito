/** Web Worker: refine tile positions by correlation and render a feather-blended mosaic. */

import { defineWorker, post } from './workerUtil'
import { pairwiseOffsets, solvePositions, featherWeight } from '../algo/stitch'
import type { Gray } from '../algo/sharpness'

export interface StitchRequest {
  tiles: { blob: Blob; x: number; y: number; width: number; height: number }[]
  maxDim: number          // cap the mosaic's long side (canvas limits)
  analysisWidth: number   // downsampled width per tile for correlation
  refine: boolean
}
export interface StitchResponse { positions: { x: number; y: number }[]; mosaic: Blob; width: number; height: number; scale: number; pairs: number }

async function toGrayScaled(bmp: ImageBitmap, width: number): Promise<Gray> {
  const scale = width / bmp.width, h = Math.round(bmp.height * scale)
  const c = new OffscreenCanvas(width, h), ctx = c.getContext('2d')!
  ctx.drawImage(bmp, 0, 0, width, h)
  const d = ctx.getImageData(0, 0, width, h).data
  const data = new Float32Array(width * h)
  for (let i = 0, j = 0; i < data.length; i++, j += 4) data[i] = 0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2]
  return { data, width, height: h }
}

defineWorker<StitchRequest>(async (m) => {
  const { tiles, maxDim, analysisWidth, refine } = m
  const bitmaps = await Promise.all(tiles.map((t) => createImageBitmap(t.blob)))
  const stitchTiles = tiles.map((t, id) => ({ id, x: t.x, y: t.y, width: t.width, height: t.height }))
  let positions = stitchTiles.map((t) => ({ x: t.x, y: t.y })), pairs = 0
  if (refine && tiles.length > 1) {
    const grays = await Promise.all(bitmaps.map((b) => toGrayScaled(b, analysisWidth)))
    const offsets = pairwiseOffsets(stitchTiles, grays)
    pairs = offsets.length
    positions = solvePositions(stitchTiles, offsets)
    post({ progress: `refined ${pairs} overlaps` })
  }
  const W = Math.max(...positions.map((p, i) => p.x + tiles[i].width)), H = Math.max(...positions.map((p, i) => p.y + tiles[i].height))
  const scale = Math.min(1, maxDim / Math.max(W, H))
  const canvas = new OffscreenCanvas(Math.round(W * scale), Math.round(H * scale))
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.width, canvas.height)
  const feather = Math.round(Math.min(tiles[0].width, tiles[0].height) * 0.08)
  for (let i = 0; i < tiles.length; i++) {
    const t = tiles[i], b = bitmaps[i]
    const tw = Math.round(t.width * scale), th = Math.round(t.height * scale)
    // feathered alpha mask for this tile
    const tc = new OffscreenCanvas(tw, th), tctx = tc.getContext('2d')!
    tctx.drawImage(b, 0, 0, tw, th)
    if (i > 0) {
      const img = tctx.getImageData(0, 0, tw, th), f = Math.max(1, Math.round(feather * scale))
      for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) img.data[(y * tw + x) * 4 + 3] = Math.round(255 * featherWeight(x, y, tw, th, f))
      tctx.putImageData(img, 0, 0)
    }
    ctx.drawImage(tc, Math.round(positions[i].x * scale), Math.round(positions[i].y * scale))
    b.close()
    post({ progress: `rendered tile ${i + 1}/${tiles.length}` })
  }
  const mosaic = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
  const res: StitchResponse = { positions, mosaic, width: canvas.width, height: canvas.height, scale, pairs }
  post({ result: res })
})
