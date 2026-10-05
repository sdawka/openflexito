/** Helpers shared by the photo modes (services/photo/*): full-res capture, JPEG decode/encode via
 *  one reusable OffscreenCanvas, settle timer. Mode implementations live in their own files and
 *  `photoService.ts` only dispatches. */

import { fetchSnapshot, fetchSnapshotWithMeta, type StillFrameMeta } from '../../api/snapshot'
import type { Rgba } from '../../algo/stack'
import { currentScale } from '../../store/scaleCal.svelte'
import type { GalleryItem } from '../../store/gallery'
import { settings } from '../../store/settings.svelte'
import { illuminationMap } from '../../store/calibration.svelte'
import { applyGainMapRgba } from '../../algo/flatField'

export type { Rgba }
export type Say = (m: string) => void
export interface PhotoMeta { position: { x: number; y: number; z: number }; controls?: object }

export const captureFull = () => fetchSnapshot({ full: true })
export const captureFullWithMeta = () => fetchSnapshotWithMeta({ full: true })

/** Build the additive `capture` field (still metadata + pixel scale) for `saveSnapshot`'s `extra`. */
export function captureField(meta: StillFrameMeta | Record<string, unknown> | null | undefined): NonNullable<GalleryItem['capture']> {
  const scale = currentScale()
  return { meta: (meta as Record<string, unknown> | null) ?? null, ...(scale ? { umPerPx: scale.umPerPx, scaleSource: scale.source } : {}) }
}

let canvas: OffscreenCanvas | null = null
export function ctx2d(w: number, h: number): OffscreenCanvasRenderingContext2D {
  if (!canvas) canvas = new OffscreenCanvas(w, h)
  canvas.width = w; canvas.height = h
  return canvas.getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D
}
export async function decode(blob: Blob): Promise<Rgba> {
  const bmp = await createImageBitmap(blob)
  const c = ctx2d(bmp.width, bmp.height)
  c.drawImage(bmp, 0, 0); bmp.close()
  const d = c.getImageData(0, 0, canvas!.width, canvas!.height)
  return { data: d.data, width: d.width, height: d.height }
}
export async function encode(img: Rgba, quality = 0.95): Promise<Blob> {
  const c = ctx2d(img.width, img.height)
  c.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0)
  return canvas!.convertToBlob({ type: 'image/jpeg', quality })
}
export async function encodeRgba8Png(img: { data: Uint8ClampedArray; width: number; height: number }): Promise<Blob> {
  const c = ctx2d(img.width, img.height)
  c.putImageData(new ImageData(img.data as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0)
  return canvas!.convertToBlob({ type: 'image/png' })
}
export const encodeRgba8 = (img: { data: Uint8ClampedArray; width: number; height: number }, quality = 0.9) => encode(img as Rgba, quality)

export const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Where a corrected still's illumination map came from (recorded in the item's `capture.meta.shading`). */
export interface ShadingNote { source: 'measured' | 'raw' | 'auto'; when?: string }

/** Full-resolution still, divided by the illumination map in linear light when `settings.shadingStills`
 *  is on and a map exists (`services/shadingProcessor.ts` does the same for the live view). Otherwise
 *  the blob is returned untouched. The JPEG is re-encoded once at quality 0.95. */
export async function captureFullShaded(): Promise<{ blob: Blob; meta: StillFrameMeta | null; shading?: ShadingNote }> {
  const { blob, meta } = await captureFullWithMeta()
  const map = settings.shadingStills ? illuminationMap() : null
  if (!map) return { blob, meta }
  const img = await decode(blob)
  applyGainMapRgba(img.data, img.width, img.height, map)
  return { blob: await encode(img, 0.95), meta, shading: { source: map.source === 'flat' ? 'measured' : map.source, when: map.when } }
}

/** `captureField` plus the `shading` note, when the still was corrected. */
export function captureFieldShaded(meta: StillFrameMeta | Record<string, unknown> | null | undefined, shading?: ShadingNote): NonNullable<GalleryItem['capture']> {
  const f = captureField(meta)
  return shading ? { ...f, meta: { ...(f.meta ?? {}), shading } } : f
}
