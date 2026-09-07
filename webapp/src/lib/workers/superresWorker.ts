/** Pixel-shift super-resolution off the main thread. Full-resolution stills arrive one at a time
 *  (already decoded and, if oversized, centre-cropped by the caller); each is registered to the
 *  first by phase correlation (measured shift, not the commanded stage offset — backlash and any
 *  residual stage error would otherwise bias the reconstruction) and drizzled onto a finer grid
 *  once every frame is in. */
import { defineWorker, post } from './workerUtil'
import { displacement } from '../algo/fftTrack'
import { grayDown } from '../algo/stack'
import { drizzle } from '../algo/drizzle'

export type SuperresMessage =
  | { type: 'init'; width: number; height: number; scale: number }
  | { type: 'add'; index: number; data: Uint8ClampedArray }
  | { type: 'finish' }

export interface MeasuredShift { dx: number; dy: number; quality: number }

let W = 0, H = 0, scale = 2
let ref: { data: Float32Array; width: number; height: number } | null = null
const frames: { data: Uint8ClampedArray; dx: number; dy: number }[] = []
const shifts: MeasuredShift[] = []

defineWorker<SuperresMessage>((m) => {
  if (m.type === 'init') { W = m.width; H = m.height; scale = m.scale; ref = null; frames.length = 0; shifts.length = 0; return }
  if (m.type === 'add') {
    const g = grayDown(m.data, W, H)
    let dx = 0, dy = 0, quality = Infinity
    if (!ref) ref = g
    else {
      const d = displacement(ref, g)
      const f = W / g.width
      dx = -d.dx * f; dy = -d.dy * f; quality = d.quality
    }
    shifts.push({ dx, dy, quality })
    frames.push({ data: m.data, dx, dy })
    post({ progress: `frame ${m.index + 1} registered${m.index ? ` (measured shift ${dx.toFixed(2)}, ${dy.toFixed(2)} px)` : ' (reference)'}` })
    return
  }
  if (m.type === 'finish') {
    if (!frames.length) throw new Error('superres: no frames captured')
    post({ progress: `drizzling ${frames.length} frames onto a ${scale}× grid…` })
    const r = drizzle(frames.map((f) => ({ ...f, width: W, height: H })), scale)
    post({ result: { data: r.data, width: r.width, height: r.height, coverage: r.coverage, shifts: [...shifts] } }, [r.data.buffer])
    ref = null; frames.length = 0
  }
})
