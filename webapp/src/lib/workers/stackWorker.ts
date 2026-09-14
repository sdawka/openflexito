/** Focus stack fusion off the main thread. Slices arrive one at a time, in ascending capture order
 *  (bottom of the stack first), 8-bit RGBA (from JPEG stills) or 16-bit RGB (developed RAW), aligned
 *  sub-pixel to a *reference* slice (`algo/align`: chained neighbour-to-neighbour in arrival order,
 *  coarse-to-fine, then re-expressed relative to the reference via `SliceAligner.relativeTo` — a z
 *  move on a flexure stage shifts the image slightly) and fused into a Laplacian pyramid.
 *
 *  The reference is the middle slice by default (`chooseReference`), never slice 0 — resampling the
 *  bottom (most defocused) slice's neighbours instead of it is exactly the defect this pipeline
 *  replaced (see `algo/align.ts`'s docstring). Knowing the reference index needs either the slice
 *  count up front (`init.count`, `reference: 'middle'`, the default — every caller in this codebase
 *  has the count before it starts capturing) or every slice's luminance (`reference: 'sharpest'`).
 *  With the count known, only slices *at or before* the reference need to be buffered (their final
 *  shift depends on the reference, which hasn't arrived yet); slices after it are resampled and fed
 *  to the pyramid immediately on arrival, same as the original single-pass design. Without the count
 *  (or in 'sharpest' mode, which needs every slice regardless) every slice is buffered and the whole
 *  alignment happens at `finish` — correct, just not streaming.
 *
 *  `method: 'hybrid'` additionally blends in a Zerene DMap-style pass (`algo/pyramidFuse#hybridFuse`)
 *  on the smooth depth surface where confidence is high; that needs every aligned slice kept (packed,
 *  not as float planes) regardless of the above, so it costs more than the default and is opt-in. */
import { defineWorker, post } from './workerUtil'
import { PyramidFuser, packRgba8, packRgb16, unpackPlanes, hybridFuse } from '../algo/pyramidFuse'
import { SliceAligner, chooseReference, luminance, translatePlanesSubpixel, type Resample } from '../algo/align'
import type { Gray } from '../algo/sharpness'

export type FuseMethod = 'pyramid' | 'hybrid'
export type ReferenceMode = 'middle' | 'sharpest'

export type StackMessage =
  | { type: 'init'; width: number; height: number; depth: 8 | 16; count?: number; reference?: ReferenceMode; resample?: Resample; method?: FuseMethod }
  | { type: 'add'; index: number; data: Uint8ClampedArray | Uint16Array }
  | { type: 'finish' }

type Planes = [Float32Array, Float32Array, Float32Array]

let fuser: PyramidFuser | null = null
let aligner = new SliceAligner()
let W = 0, H = 0, depth: 8 | 16 = 8, resample: Resample = 'lanczos3', method: FuseMethod = 'pyramid', refMode: ReferenceMode = 'middle'
let count = -1                 // slice total, if known up front (streaming path); -1 otherwise (buffer-all)
let reference = -1             // resolved once known
let seen = 0
const shifts: { dx: number; dy: number }[] = []
const aligned: (Uint8ClampedArray | Uint16Array)[] = []      // kept only for method: 'hybrid'
// buffer for slices at/before the reference (streaming path), or every slice ('sharpest' / no count)
const pendingLum = new Map<number, Gray>()
const pendingPlanes = new Map<number, Planes>()

defineWorker<StackMessage>((m) => {
  if (m.type === 'init') {
    W = m.width; H = m.height; depth = m.depth; resample = m.resample ?? 'lanczos3'; method = m.method ?? 'pyramid'
    refMode = m.reference ?? 'middle'
    count = refMode === 'middle' && m.count ? m.count : -1
    reference = count > 0 ? chooseReference(count, 'middle') : -1
    fuser = new PyramidFuser(W, H); aligner = new SliceAligner(); seen = 0
    shifts.length = 0; aligned.length = 0; pendingLum.clear(); pendingPlanes.clear()
    return
  }
  if (m.type === 'add') {
    if (!fuser) throw new Error('stack not initialised')
    // the bounded-buffer path below relies on arrival order matching ascending slice index (so the
    // k-th call to aligner.next() is slice k, and SliceAligner's plain call-order history lines up
    // with slice index) — true for every capture path in this codebase (bottom of the stack first).
    if (m.index !== seen) throw new Error(`stack worker: slices must arrive in order (expected ${seen}, got ${m.index})`)
    const planes = unpackPlanes(m.data, W, H)
    const lum = luminance(planes, W, H)
    seen++
    aligner.next(lum)   // chain in arrival order regardless of the branch below (SliceAligner.relativeTo needs every index recorded)
    if (reference < 0) {
      // reference not known yet: buffer everything (resolved at 'finish', for 'sharpest' or a
      // caller that didn't supply `count`)
      pendingLum.set(m.index, lum); pendingPlanes.set(m.index, planes)
      post({ progress: `slice ${m.index + 1} received` })
      return
    }
    if (m.index <= reference) {
      // its shift-to-reference isn't computable until the reference itself has been fed
      pendingPlanes.set(m.index, planes)
      post({ progress: `slice ${m.index + 1} received` })
      if (m.index === reference) flushBuffered()
      return
    }
    fuseOne(m.index, planes, aligner.relativeTo(m.index, reference))
    return
  }
  if (m.type === 'finish') {
    if (!fuser) throw new Error('stack not initialised')
    if (reference < 0) {
      // full-buffer path: resolve the reference now that every slice (and its luminance) is in
      reference = chooseReference(seen, refMode, indexed(pendingLum, seen))
      for (let i = 0; i < seen; i++) fuseOne(i, pendingPlanes.get(i)!, aligner.relativeTo(i, reference))
    }
    const depthIndex = fuser.depthIndex()
    let result: { data: Uint8ClampedArray | Uint16Array; width: number; height: number; contributions: number[] }
    if (method === 'hybrid' && aligned.length >= 2) {
      const pyr = fuser.resultPlanes()
      const hy = hybridFuse(pyr, fuser.depthSoft(), fuser.depthConfidence(), aligned.filter(Boolean))
      result = { data: depth === 16 ? packRgb16(hy.planes, W, H) : packRgba8(hy.planes, W, H), width: W, height: H, contributions: pyr.contributions }
    } else {
      result = depth === 16 ? fuser.result16() : fuser.result()
    }
    post({ result: { ...result, shifts: [...shifts], depthIndex } }, [result.data.buffer, depthIndex.buffer])
    fuser = null
  }
})

function indexed(m: Map<number, Gray>, n: number): Gray[] {
  const out: Gray[] = new Array(n)
  for (let i = 0; i < n; i++) out[i] = m.get(i)!
  return out
}

/** Once the reference slice has been fed to `aligner`, every buffered (at-or-before-reference) slice
 *  can finally have its shift-to-reference computed and be fused; drained in ascending order so
 *  `fuser`'s first-slice-sets-the-noise-floor calibration sees the lowest index, same as before. */
function flushBuffered(): void {
  const idxs = [...pendingPlanes.keys()].sort((a, b) => a - b)
  for (const i of idxs) { const p = pendingPlanes.get(i)!; pendingPlanes.delete(i); fuseOne(i, p, aligner.relativeTo(i, reference)) }
}

function fuseOne(index: number, planes: Planes, shift: { dx: number; dy: number }): void {
  const dx = -shift.dx, dy = -shift.dy
  shifts[index] = { dx: +dx.toFixed(2), dy: +dy.toFixed(2) }
  const p = translatePlanesSubpixel(planes, W, H, dx, dy, resample)
  fuser!.addPlanes(p, index)
  if (method === 'hybrid') aligned[index] = depth === 16 ? packRgb16(p, W, H) : packRgba8(p, W, H)
  post({ progress: `slice ${index + 1} fused${Math.hypot(dx, dy) >= 0.05 ? ` (aligned ${dx.toFixed(1)}, ${dy.toFixed(1)} px)` : ''}` })
}
