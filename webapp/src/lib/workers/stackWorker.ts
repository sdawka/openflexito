/** Focus stack fusion off the main thread. Slices arrive one at a time, 8-bit RGBA (from JPEG
 *  stills) or 16-bit RGB (developed RAW), are aligned to the first slice by phase correlation (a z move
 *  on a flexure stage shifts the image slightly) and fused into a Laplacian pyramid. */
import { defineWorker, post } from './workerUtil'
import { PyramidFuser, translatePlanes } from '../algo/pyramidFuse'
import { displacement } from '../algo/fftTrack'
import { grayDown } from '../algo/stack'
import type { Gray } from '../algo/sharpness'

export type StackMessage =
  | { type: 'init'; width: number; height: number; depth: 8 | 16 }
  | { type: 'add'; index: number; data: Uint8ClampedArray | Uint16Array }
  | { type: 'finish' }

let fuser: PyramidFuser | null = null
let ref: Gray | null = null
let W = 0, H = 0, depth: 8 | 16 = 8
const shifts: { dx: number; dy: number }[] = []

function toPlanes(data: Uint8ClampedArray | Uint16Array): [Float32Array, Float32Array, Float32Array] {
  const n = W * H, planes: [Float32Array, Float32Array, Float32Array] = [new Float32Array(n), new Float32Array(n), new Float32Array(n)]
  const stride = data instanceof Uint16Array ? 3 : 4
  for (let i = 0, p = 0; i < n; i++, p += stride) { planes[0][i] = data[p]; planes[1][i] = data[p + 1]; planes[2][i] = data[p + 2] }
  return planes
}
function grayOfPlanes(pl: [Float32Array, Float32Array, Float32Array], maxW = 410): Gray {
  const f = Math.max(1, Math.floor(W / maxW)), gw = Math.floor(W / f), gh = Math.floor(H / f)
  const data = new Float32Array(gw * gh)
  for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) {
    let s = 0
    for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) { const q = (y * f + j) * W + x * f + i; s += 0.299 * pl[0][q] + 0.587 * pl[1][q] + 0.114 * pl[2][q] }
    data[y * gw + x] = s / (f * f)
  }
  return { data, width: gw, height: gh }
}

defineWorker<StackMessage>((m) => {
  if (m.type === 'init') { W = m.width; H = m.height; depth = m.depth; fuser = new PyramidFuser(W, H); ref = null; shifts.length = 0; return }
  if (m.type === 'add') {
    if (!fuser) throw new Error('stack not initialised')
    const planes = toPlanes(m.data)
    const g = m.data instanceof Uint16Array ? grayOfPlanes(planes) : grayDown(m.data, W, H)
    let dx = 0, dy = 0
    if (!ref) ref = g
    else {
      const d = displacement(ref, g)   // same-size phase correlation: how far this slice moved from the first
      const f = W / g.width
      // accept a plausible, confident shift only (a badly defocused slice correlates poorly)
      if (Number.isFinite(d.quality) && d.quality > 1.15 && Math.hypot(d.dx, d.dy) * f < W * 0.05) { dx = Math.round(-d.dx * f); dy = Math.round(-d.dy * f) }
    }
    shifts.push({ dx, dy })
    fuser.addPlanes(translatePlanes(planes, W, H, dx, dy), m.index)
    post({ progress: `slice ${m.index + 1} fused${dx || dy ? ` (aligned ${dx}, ${dy} px)` : ''}` })
    return
  }
  if (m.type === 'finish') {
    if (!fuser) throw new Error('stack not initialised')
    if (depth === 16) {
      const r = fuser.result16()
      post({ result: { ...r, shifts: [...shifts] } }, [r.data.buffer])
    } else {
      const r = fuser.result()
      post({ result: { ...r, shifts: [...shifts] } }, [r.data.buffer])
    }
    fuser = null; ref = null
  }
})
