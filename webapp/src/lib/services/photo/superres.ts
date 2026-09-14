/** Pixel-shift super-resolution: capture an S×S grid of full-resolution stills at 1/S-full-resolution-px
 *  stage offsets (S = output scale, 2 or 3), register every frame to the first at full resolution
 *  (`register()`, coarse-to-fine) and drizzle them onto a finer grid in a worker.
 *
 *  The shift pattern is planned in *image* pixels and converted to stage steps through the CSM
 *  calibration's 2x2 matrix (`csm.matrix`, image px → stage steps): the stage axes are not
 *  generally aligned with the sensor (measured ~4° rotation, README), so a plan that only scaled a
 *  per-axis step count (the previous implementation) put the wrong sub-pixel phase on the sensor.
 *  See superres-hdr-report.md §1/§3 (D3) and CAPTURE_AUDIT.md D3 for the defect this replaces.
 *
 *  Move order is a snake (boustrophedon) raster to minimise travel; whenever an axis's commanded
 *  step direction reverses (unavoidable at each row turn for a 2D grid) the reversal is preceded by
 *  a full backlash pre-load in the new direction before the real move, so the mechanism's slack is
 *  taken up predictably rather than silently eaten by the next hop (CLAUDE.md's `BaseStage`
 *  backlash convention, replicated here by hand because these are raw, uncompensated moves like the
 *  rest of the sub-pixel sweeps in this file). Target stage positions are computed directly from
 *  the absolute grid cell (not accumulated hop-by-hop), so rounding error never compounds.
 *
 *  After capture, a frame is rejected (drizzled with weight 0, but still reported) if its measured
 *  phase is more than 0.15 px from the nearest planned phase or duplicates another accepted frame's
 *  phase — see superres-hdr-report.md's D4/#2 recommendation. */

import { waitForFrames } from '../../api/sampler'
import { device } from '../../store/device.svelte'
import { calibration } from '../../store/calibration.svelte'
import { apply2, type Mat2 } from '../../algo/csm'
import { saveSnapshot, type GalleryItem } from '../../store/gallery'
import { lockCamera } from '../cameraLock'
import { makePsf, wiener } from '../../algo/deconvolve'
import type { SuperresMessage, SuperresRawResult } from '../../workers/superresWorker'
import { captureFull, decode, encodeRgba8, encodeRgba8Png, captureField, settle, type PhotoMeta, type Say } from './common'
import type { Rgba } from '../../algo/stack'
import { fetchRawBufferWithProgress } from '../../api/raw'
import { parseRaw, splitBayer, type RawImage } from '../../algo/raw'
import type { BayerOrder } from '../../algo/drizzle'
import { liveGains, tuningParams, currentFlatField } from './rawPhoto'
import type { Gray } from '../../algo/sharpness'

export interface SuperresOptions {
  /** Output grid scale: 2 (2x2 pattern at 1/2 px hops) or 3 (3x3 pattern at 1/3 px hops). */
  scale?: 2 | 3
  /** Drizzle drop size relative to one input pixel (0, 1]; default 0.5 (see algo/drizzle.ts). */
  pixfrac?: number
  /** Extra randomised frames beyond the S×S grid, for redundancy against a rejected frame. */
  extraFrames?: number
  /** Wiener-deconvolve the result afterwards against the drizzle-drop + pixel-aperture PSF. */
  sharpen?: boolean
  /** `superresraw`: each grid frame is a whole `/raw.bin` record (OFRW v2) instead of a JPEG still,
   *  drizzled directly as Bayer planes (`algo/drizzle.ts#drizzleRawSuperres`) with no demosaic step —
   *  see the module comment. Same grid/move/backlash plan as the JPEG mode; `sharpen` is not applied
   *  (the PSF model was derived for the JPEG pipeline's post-encode 8-bit output, not linear 16-bit
   *  planes — not implemented here, see the handoff). */
  raw?: boolean
  onProgress?: Say
}

/** Centre-crop an RGBA image so neither side exceeds `maxLong`; returns the crop rectangle used
 *  (null if the image was already small enough). A 2x/3x drizzle of the full ~6560x4928 sensor
 *  frame can exceed canvas/texture size limits in some browsers, so super-resolution works on a
 *  bounded central crop instead. */
export function centerCropRgba(img: Rgba, maxLong: number): { img: Rgba; crop: { width: number; height: number; x0: number; y0: number } | null } {
  if (Math.max(img.width, img.height) <= maxLong) return { img, crop: null }
  const w = Math.min(img.width, maxLong), h = Math.min(img.height, maxLong)
  const x0 = Math.floor((img.width - w) / 2), y0 = Math.floor((img.height - h) / 2)
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) data.set(img.data.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4), y * w * 4)
  return { img: { data, width: w, height: h }, crop: { width: w, height: h, x0, y0 } }
}

interface Cell { col: number; row: number; dx: number; dy: number; extra?: boolean }

/** S×S grid, 1/S-px hops per axis, visited in snake (boustrophedon) order; plus `extraFrames`
 *  randomised sub-pixel positions appended at the end (each within the same [0, 1) px cell as the
 *  grid, so they add phase diversity rather than travel). */
function planGrid(S: number, extraFrames: number): Cell[] {
  const cells: Cell[] = []
  for (let row = 0; row < S; row++) {
    const cols = row % 2 === 0 ? [...Array(S).keys()] : [...Array(S).keys()].reverse()
    for (const col of cols) cells.push({ col, row, dx: col / S, dy: row / S })
  }
  for (let i = 0; i < extraFrames; i++) cells.push({ col: -1, row: -1, dx: Math.random(), dy: Math.random(), extra: true })
  return cells
}

/** Stage steps (rounded) for an absolute image-pixel offset from the start, via the CSM matrix. */
function stepsForPixels(matrix: Mat2, px: number, py: number): { x: number; y: number } {
  const [sx, sy] = apply2(matrix, [px, py])
  return { x: Math.round(sx), y: Math.round(sy) }
}

/** Move to an absolute (x, y) stage target from `cur`, pre-loading backlash on any axis whose
 *  direction reverses from `lastDir`. Returns the new `lastDir`. */
async function moveWithBacklashGuard(
  target: { x: number; y: number }, cur: { x: number; y: number }, lastDir: { x: number; y: number }, backlash: { x: number; y: number },
): Promise<{ x: number; y: number }> {
  const delta = { x: target.x - cur.x, y: target.y - cur.y }
  const nextDir = { ...lastDir }
  const move: { x?: number; y?: number } = {}
  for (const axis of ['x', 'y'] as const) {
    const d = delta[axis]
    if (d === 0) continue
    const dir = Math.sign(d)
    if (lastDir[axis] !== 0 && dir !== lastDir[axis] && backlash[axis] > 0) {
      // reversal: take up the mechanical slack in the new direction before the real move
      await device.moveRel({ [axis]: dir * backlash[axis] }, false)
      move[axis] = d - dir * backlash[axis]
    } else {
      move[axis] = d
    }
    nextDir[axis] = dir
  }
  if (move.x || move.y) await device.moveRel(move, false)
  return nextDir
}

const REJECT_TOLERANCE = 0.15   // px, from the nearest valid planned phase
const DUPLICATE_TOLERANCE = 0.08   // px, between two accepted frames' phases

/** Nearest planned per-axis phase (0, 1/S, ..., (S-1)/S) to a measured value, wrapped mod 1. */
function nearestPhase(v: number, S: number): number {
  const frac = ((v % 1) + 1) % 1
  let best = frac, bestErr = Infinity
  for (let k = 0; k < S; k++) {
    const p = k / S
    const err = Math.min(Math.abs(frac - p), 1 - Math.abs(frac - p))
    if (err < bestErr) { bestErr = err; best = p }
  }
  return best
}

/** Reject a frame whose measured phase is far from any planned phase, or duplicates one already
 *  accepted; return which frames survived and a note per rejection. Shared by the JPEG and raw grid
 *  captures — both produce the same `MeasuredShift[]` shape from `register()`. */
function evaluateShifts(measuredShifts: { dx: number; dy: number; confident: boolean }[], S: number): { used: number; notes: string[] } {
  const acceptedPhases: { dx: number; dy: number }[] = []
  let used = 0
  const notes: string[] = []
  measuredShifts.forEach((s, i) => {
    if (i === 0) { used++; acceptedPhases.push({ dx: 0, dy: 0 }); return }
    if (!s.confident) { notes.push(`frame ${i + 1}: rejected (registration not confident)`); return }
    const px = nearestPhase(s.dx, S), py = nearestPhase(s.dy, S)
    const residual = Math.hypot(((s.dx % 1 + 1) % 1) - px, ((s.dy % 1 + 1) % 1) - py)
    if (residual > REJECT_TOLERANCE) { notes.push(`frame ${i + 1}: rejected (${residual.toFixed(2)} px from the nearest valid phase)`); return }
    const dup = acceptedPhases.some((a) => Math.hypot(a.dx - px, a.dy - py) < DUPLICATE_TOLERANCE)
    if (dup) { notes.push(`frame ${i + 1}: rejected (duplicate phase)`); return }
    acceptedPhases.push({ dx: px, dy: py }); used++
  })
  return { used, notes }
}

export async function superresPhoto(o: SuperresOptions, say: Say, meta: PhotoMeta): Promise<GalleryItem> {
  if (o.raw) return superresRawPhoto(o, say, meta)
  const csm = calibration.csm
  if (!csm) throw new Error('super-resolution: run the stage↔camera calibration first (Calibrate tab) — planning sub-pixel offsets needs the CSM matrix')
  const S = o.scale === 3 ? 3 : 2
  const pixfrac = o.pixfrac ?? 0.5
  const total0 = S * S
  const cells = planGrid(S, Math.max(0, o.extraFrames ?? 0))
  const total = cells.length

  say(`super-resolution: capturing frame 1/${total} (reference)…`)
  const lock = await lockCamera()
  const worker = new Worker(new URL('../../workers/superresWorker.ts', import.meta.url), { type: 'module' })
  const postMsg = (m: SuperresMessage, transfer?: Transferable[]) => worker.postMessage(m, transfer ?? [])
  const measured: { dx: number; dy: number; quality: number; confident: boolean }[] = []
  let progressHook: ((m: string) => void) | null = (m) => say(`super-resolution: ${m}`)
  const finished = new Promise<{ data: Uint8ClampedArray; width: number; height: number; coverage: number; shifts: typeof measured; used: number; total: number }>((resolve, reject) => {
    worker.onmessage = (ev) => {
      if (ev.data.progress) progressHook?.(ev.data.progress)
      else if (ev.data.error) reject(new Error(ev.data.error))
      else if (ev.data.result) resolve(ev.data.result)
    }
    worker.onerror = (e) => reject(new Error(e.message))
  })

  let crop: { width: number; height: number; x0: number; y0: number } | null = null
  let curX = 0, curY = 0
  const lastDir = { x: 0, y: 0 }
  const backlash = { x: Math.max(0, Math.round(csm.calX.backlash)), y: Math.max(0, Math.round(csm.calY.backlash)) }

  try {
    const firstImg = await decode(await captureFull())
    const cropped = centerCropRgba(firstImg, 4096)
    crop = cropped.crop
    const scaleFactor = firstImg.width / csm.imageWidth
    postMsg({ type: 'init', width: cropped.img.width, height: cropped.img.height, scale: S, pixfrac })
    postMsg({ type: 'add', index: 0, data: cropped.img.data }, [cropped.img.data.buffer])

    for (let i = 1; i < total; i++) {
      const cell = cells[i]
      const target = stepsForPixels(csm.matrix, cell.dx * scaleFactor, cell.dy * scaleFactor)
      const nextDir = await moveWithBacklashGuard(target, { x: curX, y: curY }, lastDir, backlash)
      lastDir.x = nextDir.x; lastDir.y = nextDir.y
      curX = target.x; curY = target.y
      await settle(150); await waitForFrames(2, 1500)
      say(`super-resolution: capturing frame ${i + 1}/${total}${cell.extra ? ' (extra)' : ` (grid ${cell.col},${cell.row})`}`)
      const { img: c } = centerCropRgba(await decode(await captureFull()), 4096)
      postMsg({ type: 'add', index: i, data: c.data }, [c.data.buffer])
    }
  } finally {
    say('super-resolution: returning to the starting position')
    await device.moveRel({ x: -curX, y: -curY }, false).catch((e) => say(`super-resolution: could not return to the start: ${(e as Error).message}`))
    await lock.release((msg) => say(`super-resolution: ${msg}`))
  }

  say('super-resolution: fusing…')
  postMsg({ type: 'finish' })
  const r = await finished
  worker.terminate()

  // reject a frame whose measured phase is far from any planned phase, or duplicates one already
  // accepted; report how many frames actually contributed
  const { used, notes: frameNotes } = evaluateShifts(r.shifts, S)
  say(`super-resolution: done, ${used}/${r.total} frames used, ${Math.round(r.coverage * 100)}% of the ${S}× grid covered`)
  if (frameNotes.length) say(`super-resolution: ${frameNotes.join('; ')}`)

  let out: { data: Uint8ClampedArray; width: number; height: number } = r
  if (o.sharpen) {
    say('super-resolution: sharpening (Wiener deconvolution against the drizzle/pixel-aperture PSF)…')
    out = sharpenRgba(r, S, pixfrac)
  }

  const image = await encodeRgba8Png({ data: out.data, width: out.width, height: out.height })
  return saveSnapshot(image, {
    ...meta, size: { width: out.width, height: out.height },
    name: `Super-resolution ${used}/${r.total} frames ×${S}`,
    extra: { superres: { frames: r.total, used, scale: S, pixfrac, shifts: r.shifts, crop, sharpened: !!o.sharpen } },
  })
}

/** Centre-crop a raw mosaic (`RawImage`) so neither side exceeds `maxLong`, keeping the crop window's
 *  width, height and offsets even so the CFA phase (which colour sits at which corner of the 2x2 tile)
 *  is unchanged — the mosaic equivalent of `centerCropRgba` above. A 2x/3x drizzle of the raw sensor's
 *  planes (Float32, one array per colour, no demosaic) is ~3x heavier per pixel than the RGBA path's
 *  8-bit image, so this crop is applied more eagerly (see `superresRawPhoto`). */
function centerCropMosaic(raw: RawImage, maxLong: number): RawImage {
  const long = Math.max(raw.width, raw.height)
  if (long <= maxLong) return raw
  const bound = maxLong - (maxLong % 2)
  const w = Math.min(raw.width, bound) & ~1, h = Math.min(raw.height, bound) & ~1
  let x0 = Math.floor((raw.width - w) / 2), y0 = Math.floor((raw.height - h) / 2)
  x0 -= x0 % 2; y0 -= y0 % 2
  const data = new Uint16Array(w * h)
  for (let y = 0; y < h; y++) data.set(raw.data.subarray((y0 + y) * raw.width + x0, (y0 + y) * raw.width + x0 + w), y * w)
  return { ...raw, width: w, height: h, data }
}

/** A registration proxy for a raw mosaic: the two green CFA phases averaged into one half-resolution
 *  plane (`register()`/`displacement()` assume a normal image, not CFA-patterned data, so the mosaic
 *  itself cannot be registered directly — see the worker's module comment). Black level already
 *  removed by `splitBayer`. */
function greenProxy(raw: RawImage): Gray {
  const p = splitBayer(raw)
  const data = new Float32Array(p.width * p.height)
  for (let i = 0; i < data.length; i++) data[i] = (p.g1[i] + p.g2[i]) / 2
  return { data, width: p.width, height: p.height }
}

/** `superresraw`: same S×S grid, move plan and backlash handling as `superresPhoto`, but each frame is
 *  `/raw.bin` (an OFRW v2 record) instead of a JPEG still. Frames are registered on a green-plane proxy
 *  of each mosaic (half resolution; the measured shift is doubled back to full mosaic-pixel units) and
 *  drizzled directly as Bayer planes (`drizzleRawSuperres`, no demosaic step), then run through the
 *  rest of the RAW develop pipeline (WB, shading, colour matrix, tone curve) in the worker. A capture
 *  on a memory-constrained device (`navigator.deviceMemory < 4`, when the browser exposes it) is
 *  centre-cropped up front (`centerCropMosaic`, phase-preserving); if the worker's drizzle still runs
 *  out of memory it retries at a smaller crop itself (see the worker's module comment) before giving up. */
async function superresRawPhoto(o: SuperresOptions, say: Say, meta: PhotoMeta): Promise<GalleryItem> {
  const csm = calibration.csm
  if (!csm) throw new Error('super-resolution: run the stage↔camera calibration first (Calibrate tab) — planning sub-pixel offsets needs the CSM matrix')
  const S = o.scale === 3 ? 3 : 2
  const pixfrac = o.pixfrac ?? 0.5
  const cells = planGrid(S, Math.max(0, o.extraFrames ?? 0))
  const total = cells.length

  const deviceMemory = (navigator as unknown as { deviceMemory?: number }).deviceMemory
  const maxLong = deviceMemory !== undefined && deviceMemory < 4 ? 2400 : 4096

  say(`super-resolution (RAW): capturing frame 1/${total} (reference)…`)
  const lock = await lockCamera()
  const worker = new Worker(new URL('../../workers/superresWorker.ts', import.meta.url), { type: 'module' })
  const postMsg = (m: SuperresMessage, transfer?: Transferable[]) => worker.postMessage(m, transfer ?? [])
  let progressHook: ((m: string) => void) | null = (m) => say(`super-resolution: ${m}`)
  const finished = new Promise<SuperresRawResult>((resolve, reject) => {
    worker.onmessage = (ev) => {
      if (ev.data.progress) progressHook?.(ev.data.progress)
      else if (ev.data.error) reject(new Error(ev.data.error))
      else if (ev.data.result) resolve(ev.data.result)
    }
    worker.onerror = (e) => reject(new Error(e.message))
  })

  let curX = 0, curY = 0
  const lastDir = { x: 0, y: 0 }
  const backlash = { x: Math.max(0, Math.round(csm.calX.backlash)), y: Math.max(0, Math.round(csm.calY.backlash)) }
  let refRaw: RawImage | null = null

  try {
    const buf0 = await fetchRawBufferWithProgress(say, { label: 'super-resolution (RAW)' })
    const raw0 = parseRaw(buf0)
    const scaleFactor = raw0.width / csm.imageWidth   // scaleFactor uses the *uncropped* full sensor width
    refRaw = centerCropMosaic(raw0, maxLong)
    const params = await tuningParams()
    const gains = (refRaw.meta?.colour_gains as [number, number] | undefined) ?? liveGains()
    const ccm = (refRaw.meta?.ccm as number[] | undefined) ?? params.ccm
    postMsg({
      type: 'initRaw', scale: S, pixfrac, bayer: refRaw.bayer.toUpperCase() as BayerOrder,
      opts: { gains, ccm, lsc: params.lsc, flatField: currentFlatField(), gammaCurve: params.gammaCurve, highlights: 'desaturate' },
    })
    const proxy0 = greenProxy(refRaw)
    postMsg({ type: 'addRaw', index: 0, raw: refRaw, proxy: proxy0 }, [refRaw.data.buffer, proxy0.data.buffer])

    for (let i = 1; i < total; i++) {
      const cell = cells[i]
      const target = stepsForPixels(csm.matrix, cell.dx * scaleFactor, cell.dy * scaleFactor)
      const nextDir = await moveWithBacklashGuard(target, { x: curX, y: curY }, lastDir, backlash)
      lastDir.x = nextDir.x; lastDir.y = nextDir.y
      curX = target.x; curY = target.y
      await settle(150); await waitForFrames(2, 1500)
      say(`super-resolution (RAW): capturing frame ${i + 1}/${total}${cell.extra ? ' (extra)' : ` (grid ${cell.col},${cell.row})`}`)
      const raw = centerCropMosaic(parseRaw(await fetchRawBufferWithProgress(say, { label: 'super-resolution (RAW)' })), maxLong)
      const proxy = greenProxy(raw)
      postMsg({ type: 'addRaw', index: i, raw, proxy }, [raw.data.buffer, proxy.data.buffer])
    }
  } finally {
    say('super-resolution: returning to the starting position')
    await device.moveRel({ x: -curX, y: -curY }, false).catch((e) => say(`super-resolution: could not return to the start: ${(e as Error).message}`))
    await lock.release((msg) => say(`super-resolution: ${msg}`))
  }

  say('super-resolution: fusing (RAW, no demosaic)…')
  postMsg({ type: 'finish' })
  const r = await finished
  worker.terminate()

  const { used, notes: frameNotes } = evaluateShifts(r.shifts, S)
  say(`super-resolution (RAW): done, ${used}/${r.total} frames used, coverage r ${Math.round(r.coverage.r * 100)}% g ${Math.round(r.coverage.g * 100)}% b ${Math.round(r.coverage.b * 100)}%`)
  if (frameNotes.length) say(`super-resolution: ${frameNotes.join('; ')}`)

  const preview = await encodeRgba8(r.preview)
  return saveSnapshot(r.png, {
    ...meta, size: { width: r.width, height: r.height }, thumbFrom: preview,
    name: `Super-resolution RAW ${used}/${r.total} frames ×${S}`,
    extra: {
      superres: { frames: r.total, used, scale: S, pixfrac, shifts: r.shifts, crop: null, sharpened: false },
      raw: { bitDepth: refRaw!.bitDepth, bayer: refRaw!.bayer, blackLevel: refRaw!.blackLevel, gains: (refRaw!.meta?.colour_gains as [number, number] | undefined) ?? liveGains(), applied: { lsc: true, ccm: true, gammaCurve: true, demosaic: 'none (drizzled Bayer planes)' } },
      capture: captureField(refRaw!.meta),
    },
  })
}

/** Post-drizzle sharpening: the PSF is the drizzle drop (pixfrac wide) convolved with the sensor's
 *  pixel aperture (one physical pixel = `scale` output pixels wide) — no extra assumed optical blur
 *  term, since it is not measured here (algo/deconvolve.ts takes a `sigma` for that when it is). */
function sharpenRgba(img: { data: Uint8ClampedArray; width: number; height: number }, scale: number, pixfrac: number): { data: Uint8ClampedArray; width: number; height: number } {
  const { width: w, height: h } = img
  let N = 16; while (N < Math.max(w, h)) N <<= 1
  const psf = makePsf(N, { dropHalfWidth: (pixfrac / 2) * scale, apertureHalfWidth: 0.5 })
  const out = new Uint8ClampedArray(w * h * 4)
  for (let c = 0; c < 3; c++) {
    const plane = new Float32Array(w * h)
    for (let i = 0; i < w * h; i++) plane[i] = img.data[i * 4 + c]
    const deconv = wiener({ data: plane, width: w, height: h }, psf, N, 0.02)
    for (let i = 0; i < w * h; i++) out[i * 4 + c] = deconv[i]
  }
  for (let i = 0; i < w * h; i++) out[i * 4 + 3] = img.data[i * 4 + 3]
  return { data: out, width: w, height: h }
}
