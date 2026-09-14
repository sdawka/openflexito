/** Helpers shared by the photo modes (services/photo/*): full-res capture, JPEG decode/encode via
 *  one reusable OffscreenCanvas, settle timer. Mode implementations live in their own files and
 *  `photoService.ts` only dispatches. */

import { fetchSnapshot, fetchSnapshotWithMeta, type StillFrameMeta } from '../../api/snapshot'
import type { Rgba } from '../../algo/stack'
import { currentScale } from '../../store/scaleCal.svelte'
import type { GalleryItem } from '../../store/gallery'

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
