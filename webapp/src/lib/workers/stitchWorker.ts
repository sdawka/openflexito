/** Web Worker: refine tile positions by correlation (robust global solve), remove the per-tile
 *  shading (vignetting + colour shading, repeated in every tile), equalise per-tile RGB gains from
 *  the overlaps, and render the mosaic as a normalised weighted average with feather weights on
 *  every tile. The blend is accumulated in row bands of Float32 planes (`BandAccumulator`), so
 *  memory stays near 128 MB however large the mosaic is; the optional multi-band (Laplacian) blend
 *  needs whole-mosaic float pyramids and is limited to mosaics of at most `MULTIBAND_MAX_DIM` on
 *  the long side (larger requests fall back to feather blending).
 *
 *  Shading: `'measured'` divides by the map the request carries (a blank-field capture);
 *  `'auto'` (default) uses that map when there is one, else estimates the shading from the tiles
 *  themselves (`algo/shading.ts#estimateShading`: the same scene point seen at two tile positions
 *  differs only by the shading), falling back to the per-pixel median of the tiles when the
 *  estimate is not trustworthy and there are enough tiles; `'off'` leaves the tiles as captured. */

import { defineWorker, post } from './workerUtil'
import {
  pairwiseOffsets, solvePositions, solvePositionsRobust, overlapGainsRgb, solveGainsRgb,
  applyFlatField, applyFlatFieldRGBA, normaliseGainMap, sampleGainMap, featherForOverlap,
  BandAccumulator, bandRows, blendMultiband,
  type GainMap, type PlacedTile, type RgbTile, type StitchTile, type Vec,
} from '../algo/stitch'
import { estimateShading, medianShading } from '../algo/shading'
import type { Gray } from '../algo/sharpness'

export type ShadingMode = 'off' | 'measured' | 'auto'
export type ShadingUsed = 'none' | 'measured' | 'auto' | 'median'
export type Rgb = [number, number, number]

export interface StitchRequest {
  tiles: { blob: Blob; x: number; y: number; width: number; height: number }[]
  maxDim: number          // cap the mosaic's long side (canvas limits)
  analysisWidth: number   // downsampled width per tile for correlation and shading
  refine: boolean
  /** MAD outlier rejection in the position solve (default true) */
  robust?: boolean
  /** per-tile RGB gain equalisation from overlap statistics (default true) */
  gainEqualise?: boolean
  /** 0 (default) = feather blend; 2 or 3 = multi-band Laplacian blend with that many levels */
  multiband?: number
  /** how the per-tile shading is removed (default 'auto', see the module comment) */
  shading?: ShadingMode
  /** measured flat-field map (relative illumination, mean ~1) for `shading` 'measured' / 'auto' */
  flatField?: { width: number; height: number; channels: 1 | 3; data: number[] | Float32Array } | null
  /** planned overlap fraction between neighbouring tiles; sizes the feather to the overlap (else `feather`) */
  overlap?: number
  /** feather width as a fraction of the shorter tile side (default 0.08) when `overlap` is not given */
  feather?: number
  /** output encoding (default JPEG q0.92) */
  output?: { type: 'image/jpeg' | 'image/png'; quality?: number }
}
export interface StitchResponse {
  positions: { x: number; y: number }[]; mosaic: Blob; width: number; height: number; scale: number
  pairs: number; dropped: number
  /** per-tile luminance gain (mean of `gainsRgb`), kept for old readers */
  gains: number[]
  /** per-tile per-channel gains applied in the blend */
  gainsRgb: Rgb[]
  blend: 'feather' | 'multiband'
  /** which shading map the tiles were divided by */
  shading: ShadingUsed
  /** true iff a shading map was applied (any of measured / auto / median) */
  flatField: boolean
  /** self-calibrated shading estimate diagnostics (only when `shading` is 'auto') */
  shadingFit?: { samples: number; pairs: number; rms: number }
  /** the self-calibrated map itself (shading 'auto' or 'median'), plain arrays, so the caller can remember it for the live view and stills */
  shadingMap?: { width: number; height: number; channels: 1 | 3; data: number[] }
}

const MULTIBAND_MAX_DIM = 4096

/** Analysis-size grey and interleaved-RGB float copies of one tile, from one draw. */
async function toAnalysis(bmp: ImageBitmap, width: number): Promise<{ gray: Gray; rgb: RgbTile }> {
  const scale = width / bmp.width, h = Math.max(1, Math.round(bmp.height * scale))
  const c = new OffscreenCanvas(width, h), ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bmp, 0, 0, width, h)
  const d = ctx.getImageData(0, 0, width, h).data
  const gray = new Float32Array(width * h), rgb = new Float32Array(width * h * 3)
  for (let i = 0, j = 0, k = 0; i < gray.length; i++, j += 4, k += 3) {
    const r = d[j], g = d[j + 1], b = d[j + 2]
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b
    rgb[k] = r; rgb[k + 1] = g; rgb[k + 2] = b
  }
  return { gray: { data: gray, width, height: h }, rgb: { data: rgb, width, height: h } }
}

/** Divide an interleaved-RGB float tile by the gain map (bilinear, per channel when the map has 3). */
function applyFlatFieldRgb(t: RgbTile, map: GainMap): RgbTile {
  const out = new Float32Array(t.data.length)
  for (let y = 0; y < t.height; y++) {
    const v = (y + 0.5) / t.height
    for (let x = 0; x < t.width; x++) {
      const u = (x + 0.5) / t.width, o = (y * t.width + x) * 3
      if (map.channels === 1) {
        const k = 1 / sampleGainMap(map, u, v, 0)
        out[o] = t.data[o] * k; out[o + 1] = t.data[o + 1] * k; out[o + 2] = t.data[o + 2] * k
      } else {
        out[o] = t.data[o] / sampleGainMap(map, u, v, 0)
        out[o + 1] = t.data[o + 1] / sampleGainMap(map, u, v, 1)
        out[o + 2] = t.data[o + 2] / sampleGainMap(map, u, v, 2)
      }
    }
  }
  return { data: out, width: t.width, height: t.height }
}

const lum = (g: Rgb) => 0.299 * g[0] + 0.587 * g[1] + 0.114 * g[2]

/** Choose the shading map for this run (see the module comment). */
function chooseShading(mode: ShadingMode, measured: GainMap | null, stitchTiles: StitchTile[], positions: Vec[], rgb: RgbTile[]): { map: GainMap | null; used: ShadingUsed; fit?: StitchResponse['shadingFit'] } {
  if (mode === 'off') return { map: null, used: 'none' }
  if (measured) return { map: measured, used: 'measured' }
  if (mode === 'measured') return { map: null, used: 'none' }
  if (rgb.length < 2) return { map: null, used: 'none' }
  post({ progress: 'estimating shading from the tiles' })
  const est = estimateShading(stitchTiles, positions, rgb)
  if (est && est.ok) return { map: est.map, used: 'auto', fit: { samples: est.samples, pairs: est.pairs, rms: est.rms } }
  if (rgb.length >= 6) {
    const w = rgb[0].width, h = rgb[0].height
    const gw = Math.min(32, w), gh = Math.max(2, Math.round((gw * h) / w))
    const med = medianShading(rgb, { width: gw, height: gh })
    if (med) return { map: med, used: 'median' }
  }
  return { map: null, used: 'none' }
}

defineWorker<StitchRequest>(async (m) => {
  const { tiles, maxDim, analysisWidth, refine } = m
  const robust = m.robust ?? true, gainEqualise = m.gainEqualise ?? true, shadingMode: ShadingMode = m.shading ?? 'auto'
  const measured: GainMap | null = m.flatField && shadingMode !== 'off'
    ? normaliseGainMap({ width: m.flatField.width, height: m.flatField.height, channels: m.flatField.channels, data: Float32Array.from(m.flatField.data) })
    : null
  const bitmaps = await Promise.all(tiles.map((t) => createImageBitmap(t.blob)))
  const stitchTiles: StitchTile[] = tiles.map((t, id) => ({ id, x: t.x, y: t.y, width: t.width, height: t.height }))
  let positions: Vec[] = stitchTiles.map((t) => ({ x: t.x, y: t.y })), pairs = 0, dropped = 0
  let gainsRgb: Rgb[] = tiles.map(() => [1, 1, 1])
  let shading: GainMap | null = measured, used: ShadingUsed = measured ? 'measured' : 'none'
  let shadingFit: StitchResponse['shadingFit']

  const wantAnalysis = tiles.length > 1 && (refine || gainEqualise || shadingMode !== 'off')
  if (wantAnalysis) {
    post({ progress: `analysing ${tiles.length} tiles` })
    const analysis = await Promise.all(bitmaps.map((b) => toAnalysis(b, analysisWidth)))
    let grays = analysis.map((a) => a.gray)
    const rgb = analysis.map((a) => a.rgb)
    // a measured map is known before the positions are: flatten the grey before correlating
    if (measured) grays = grays.map((g) => applyFlatField(g, measured))
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
    const chosen = chooseShading(shadingMode, measured, stitchTiles, positions, rgb)
    shading = chosen.map; used = chosen.used; shadingFit = chosen.fit
    post({ progress: used === 'none' ? 'no shading correction' : `shading: ${used}${shadingFit ? ` (rms ${shadingFit.rms.toFixed(3)})` : ''}` })
    if (gainEqualise) {
      const corrected = shading ? rgb.map((t) => applyFlatFieldRgb(t, shading!)) : rgb
      gainsRgb = solveGainsRgb(tiles.length, overlapGainsRgb(stitchTiles, positions, corrected))
      const l = gainsRgb.map(lum)
      post({ progress: `equalised gains (${Math.min(...l).toFixed(2)}–${Math.max(...l).toFixed(2)})` })
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
  const feather = m.overlap != null && m.overlap > 0
    ? featherForOverlap(tiles[0].width, tiles[0].height, m.overlap, scale)
    : Math.max(1, Math.round(Math.min(tiles[0].width, tiles[0].height) * (m.feather ?? 0.08) * scale))
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
      if (shading) applyFlatFieldRGBA(img.data, p.w, p.h, shading)
      full.push({ data: img.data, width: p.w, height: p.h, x: p.x, y: p.y, gain: gainsRgb[i] })
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
        if (shading) applyFlatFieldRGBA(img.data, p.w, rowsHere, shading, p.w, p.h, 0, sy0 - p.y)
        acc.add({ data: img.data, width: p.w, height: rowsHere, x: p.x, y: sy0, tileX: p.x, tileY: p.y, tileW: p.w, tileH: p.h, gain: gainsRgb[i] }, feather)
      }
      const rgba = acc.toRGBA(n)
      ctx.putImageData(new ImageData(rgba as Uint8ClampedArray<ArrayBuffer>, width, n), 0, y0)
      post({ progress: `blended rows ${Math.min(height, y0 + n)}/${height}` })
    }
    for (const b of bitmaps) b.close()
  }
  const out = m.output ?? { type: 'image/jpeg', quality: 0.92 }
  const mosaic = await canvas.convertToBlob(out.type === 'image/png' ? { type: 'image/png' } : { type: 'image/jpeg', quality: out.quality ?? 0.92 })
  const res: StitchResponse = {
    positions, mosaic, width, height, scale, pairs, dropped,
    gains: gainsRgb.map(lum), gainsRgb, blend, shading: used, flatField: !!shading, shadingFit,
    shadingMap: shading && (used === 'auto' || used === 'median') ? { width: shading.width, height: shading.height, channels: shading.channels, data: Array.from(shading.data) } : undefined,
  }
  post({ result: res })
})
