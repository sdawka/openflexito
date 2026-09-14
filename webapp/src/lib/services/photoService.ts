/** Full-resolution photos to the gallery: single still, focus stacks (`services/photo/focusStack.ts`),
 *  RAW develops/HDR (`services/photo/rawPhoto.ts`), LED/exposure stacks
 *  (`services/photo/exposureStack.ts`) or pixel-shift super-resolution (`services/photo/superres.ts`).
 *  This file only dispatches to the mode implementations. The stage does not move for a photo except
 *  the z sweep of a focus stack, which ends where it started using the device's z backlash
 *  compensation (v3 Z_ONLY) so the final image matches the live view. */

import { saveSnapshot, type GalleryItem } from '../store/gallery'
import { device } from '../store/device.svelte'
import { captureFullWithMeta, captureField } from './photo/common'
import { rawPhoto, rawAveragePhoto, hdrRawPhoto } from './photo/rawPhoto'
import { exposureStackPhoto, type BracketKind } from './photo/exposureStack'
import { superresPhoto, type SuperresOptions } from './photo/superres'
import { takeFocusStack, takeFineFocusStack } from './photo/focusStack'
import type { FuseMethod } from '../workers/stackWorker'

export type PhotoMode = 'single' | 'raw' | 'rawavg' | 'focus' | 'focusfine' | 'focusfineraw' | 'exposure' | 'hdrraw' | 'superres'
export interface PhotoOptions {
  mode: PhotoMode
  slices?: number        // focus: number of z slices (odd, centred on the current z); focusfine: the maximum
  stepZ?: number         // focus: steps between slices
  range?: number         // focusfine: total z range of the autofocus sweep that locates the focus plane
  method?: FuseMethod    // focusfine: 'pyramid' (default) or 'hybrid' (Zerene DMap-style fusion)
  levels?: number[]      // exposure: LED brightness factors (or, for hdrraw, exposure-time factors) relative to the current level
  factors?: number[]     // exposure: exposure-time multipliers for bracket 'exposure'/'both' (device /bracket.bin)
  frames?: number        // rawavg: raw frames to average (default 4)
  bracket?: BracketKind  // exposure: 'led' (default), 'exposure' (device-side exposure-time bracket) or 'both'
  superres?: SuperresOptions   // superres: scale (2|3), pixfrac, extraFrames, sharpen
  onProgress?: (msg: string) => void
}

export async function takePhoto(o: PhotoOptions): Promise<GalleryItem> {
  const say = o.onProgress ?? (() => {})
  const meta = { position: { ...device.position }, controls: device.controls ?? undefined }
  if (o.mode === 'single') {
    say('capturing full resolution…')
    const { blob, meta: frameMeta } = await captureFullWithMeta()
    return saveSnapshot(blob, { ...meta, name: 'Photo', extra: { capture: captureField(frameMeta) } })
  }
  if (o.mode === 'raw') return rawPhoto(say, meta)
  if (o.mode === 'rawavg') return rawAveragePhoto(say, meta, o.frames)
  if (o.mode === 'hdrraw') return hdrRawPhoto(say, meta, o.levels)
  if (o.mode === 'focusfine' || o.mode === 'focusfineraw') return takeFineFocusStack(o, say, meta, o.mode === 'focusfineraw' ? 'raw' : 'jpeg')
  if (o.mode === 'superres') return superresPhoto(o.superres ?? {}, say, meta)
  if (o.mode === 'focus') return takeFocusStack(o, say, meta)
  // LED/exposure stack (bracket: 'led' default, 'exposure', or 'both')
  return exposureStackPhoto({ levels: o.levels, factors: o.factors, bracket: o.bracket, onProgress: say }, meta)
}

