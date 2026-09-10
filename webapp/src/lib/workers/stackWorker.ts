/** Focus stack fusion off the main thread. Slices arrive one at a time, 8-bit RGBA (from JPEG
 *  stills) or 16-bit RGB (developed RAW), are aligned sub-pixel to the first slice (`algo/align`:
 *  neighbour-chained, coarse-to-fine; a z move on a flexure stage shifts the image slightly) and
 *  fused into a Laplacian pyramid. */
import { defineWorker, post } from './workerUtil'
import { PyramidFuser } from '../algo/pyramidFuse'
import { SliceAligner, luminance, translatePlanesSubpixel } from '../algo/align'

export type StackMessage =
  | { type: 'init'; width: number; height: number; depth: 8 | 16 }
  | { type: 'add'; index: number; data: Uint8ClampedArray | Uint16Array }
  | { type: 'finish' }

let fuser: PyramidFuser | null = null
let aligner = new SliceAligner()
let W = 0, H = 0, depth: 8 | 16 = 8
const shifts: { dx: number; dy: number }[] = []

function toPlanes(data: Uint8ClampedArray | Uint16Array): [Float32Array, Float32Array, Float32Array] {
  const n = W * H, planes: [Float32Array, Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]
  const stride = data instanceof Uint16Array ? 3 : 4
  for (let i = 0, p = 0; i < n; i++, p += stride) { planes[0][i] = data[p]; planes[1][i] = data[p + 1]; planes[2][i] = data[p + 2] }
  return planes
}

defineWorker<StackMessage>((m) => {
  if (m.type === 'init') { W = m.width; H = m.height; depth = m.depth; fuser = new PyramidFuser(W, H); aligner = new SliceAligner(); shifts.length = 0; return }
  if (m.type === 'add') {
    if (!fuser) throw new Error('stack not initialised')
    const planes = toPlanes(m.data)
    // cumulative displacement from the first slice (chained through the neighbours); undo it
    const d = aligner.next(luminance(planes, W, H))
    const dx = -d.dx, dy = -d.dy
    shifts.push({ dx: +dx.toFixed(2), dy: +dy.toFixed(2) })
    fuser.addPlanes(translatePlanesSubpixel(planes, W, H, dx, dy), m.index)
    post({ progress: `slice ${m.index + 1} fused${Math.hypot(dx, dy) >= 0.05 ? ` (aligned ${dx.toFixed(1)}, ${dy.toFixed(1)} px)` : ''}` })
    return
  }
  if (m.type === 'finish') {
    if (!fuser) throw new Error('stack not initialised')
    const depthIndex = fuser.depthIndex()
    if (depth === 16) {
      const r = fuser.result16()
      post({ result: { ...r, shifts: [...shifts], depthIndex } }, [r.data.buffer, depthIndex.buffer])
    } else {
      const r = fuser.result()
      post({ result: { ...r, shifts: [...shifts], depthIndex } }, [r.data.buffer, depthIndex.buffer])
    }
    fuser = null
  }
})
