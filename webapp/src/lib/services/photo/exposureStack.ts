/** Exposure/LED stacks fused for display (Mertens-style; see `algo/hdr.ts` for true HDR from linear
 *  RAW). `bracket: 'led'` (default, back-compatible) varies the illumination; `'exposure'` brackets the
 *  camera's exposure time instead via the device's `/bracket.bin` endpoint (device.md §3), which locks
 *  gain and colour gains for the whole bracket so there is no per-level tint drift; `'both'` captures
 *  an LED ladder and an exposure bracket and fuses everything together. AE and AWB are locked for the
 *  whole run (`services/cameraLock.ts`) rather than only AE, and the merge is multi-scale Mertens
 *  (`algo/exposureFuse.ts`, contrast + saturation + well-exposedness in a Laplacian pyramid) instead of
 *  the single-scale 8×8 block blend this replaces, which haloed at block boundaries. */

import { waitForFrames } from '../../api/sampler'
import { fetchBracketBuffer } from '../../api/raw'
import { parseBracket } from '../../algo/raw'
import { mertensFuse } from '../../algo/exposureFuse'
import { device } from '../../store/device.svelte'
import { saveSnapshot, type GalleryItem } from '../../store/gallery'
import { withCameraLock } from '../cameraLock'
import type { StillFrameMeta } from '../../api/snapshot'
import { captureFullWithMeta, decode, encode, captureField, settle, type Say, type PhotoMeta, type Rgba } from './common'

export type BracketKind = 'led' | 'exposure' | 'both'

export interface ExposureStackOptions {
  levels?: number[]        // LED factors relative to the current level (bracket 'led'/'both')
  factors?: number[]       // exposure-time multipliers relative to the metered exposure (bracket 'exposure'/'both')
  bracket?: BracketKind
  onProgress?: Say
}

/** Step the LED through `levels` × the current cc (deduplicated, clamped), one still per level.
 *  Also returns the metadata of whichever level is closest to the LED's starting brightness — a
 *  stack has no single "the" still, this is the closest fit. */
async function ledFrames(say: Say, levels: number[]): Promise<{ frames: Rgba[]; meta: StillFrameMeta | null }> {
  const base = device.light.cc
  if (base <= 0.02) throw new Error('exposure stack: turn the LED on first')
  const wanted = [...new Set(levels.map((f) => Math.min(1, Math.max(0.02, +(base * f).toFixed(3)))))]
  if (wanted.length < 2) throw new Error('exposure stack: the LED is already at maximum and cannot be varied enough')
  const frames: Rgba[] = []
  const metas: (StillFrameMeta | null)[] = []
  try {
    for (let i = 0; i < wanted.length; i++) {
      say(`LED stack: level ${i + 1}/${wanted.length} (${Math.round(wanted[i] * 100)} %)`)
      await device.setLight(wanted[i])
      await settle(250); await waitForFrames(3, 2000)
      const { blob, meta } = await captureFullWithMeta()
      frames.push(await decode(blob)); metas.push(meta)
    }
  } finally {
    await device.setLight(base).catch((e) => say(`LED stack: could not restore the LED to ${Math.round(base * 100)} %: ${(e as Error).message}`))
  }
  const closest = wanted.reduce((best, w, i) => (Math.abs(w - base) < Math.abs(wanted[best] - base) ? i : best), 0)
  return { frames, meta: metas[closest] }
}

/** One device-side exposure-time bracket: `/bracket.bin?factors=..` (JPEGs), gain and colour gains
 *  frozen for the whole run by the device itself. */
async function exposureBracketFrames(say: Say, factors: number[]): Promise<{ frames: Rgba[]; summary: Record<string, unknown> | null }> {
  say(`exposure bracket: capturing ${factors.length} exposures…`)
  const { buffer, summary } = await fetchBracketBuffer({ factors })
  const items = parseBracket(buffer)
  const frames: Rgba[] = []
  for (const it of items) frames.push(await decode(new Blob([it.data as BlobPart], { type: 'image/jpeg' })))
  return { frames, summary }
}

export async function exposureStackPhoto(o: ExposureStackOptions, meta: PhotoMeta): Promise<GalleryItem> {
  const say = o.onProgress ?? (() => {})
  const kind: BracketKind = o.bracket ?? 'led'
  const levels = o.levels ?? [0.4, 0.7, 1, 1.5]
  const factors = o.factors ?? (levels.length >= 2 ? levels : [0.5, 1, 2])
  return withCameraLock(async () => {
    let frames: Rgba[] = []
    let summary: Record<string, unknown> | null = null
    let ledMeta: StillFrameMeta | null = null
    if (kind === 'led' || kind === 'both') {
      const r = await ledFrames(say, levels)
      frames = frames.concat(r.frames)
      ledMeta = r.meta
    }
    if (kind === 'exposure' || kind === 'both') {
      const r = await exposureBracketFrames(say, factors)
      frames = frames.concat(r.frames)
      summary = r.summary
    }
    if (frames.length < 2) throw new Error('exposure stack: need at least two frames to fuse')
    say(`${kind === 'led' ? 'LED' : kind === 'exposure' ? 'exposure' : 'LED+exposure'} stack: fusing ${frames.length} frames (multi-scale Mertens)…`)
    const fused = mertensFuse(frames)
    const name = kind === 'led' ? `LED exposure stack ×${frames.length}` : kind === 'exposure' ? `Exposure bracket ×${frames.length}` : `LED+exposure stack ×${frames.length}`
    // the device-side bracket summary (gain/colour gains frozen for the whole run) is the richer of
    // the two when both are available; the LED stack's own still metadata otherwise
    const captureMeta = summary ?? ledMeta
    return saveSnapshot(await encode(fused), { ...meta, name, extra: captureMeta ? { capture: captureField(captureMeta) } : undefined })
  }, { onError: say })
}
