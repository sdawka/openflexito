/** Runs the temporal focus stacker off the main thread. */
import { defineWorker, post } from './workerUtil'
import { LiveStacker, LiveAverager } from '../algo/liveStack'

export type LiveStackMessage =
  | { type: 'init'; width: number; height: number; cell?: number; mode?: 'stack' | 'average' }
  | { type: 'frame'; data: Uint8ClampedArray }
  | { type: 'reset' }

let st: LiveStacker | LiveAverager | null = null
defineWorker<LiveStackMessage>((m) => {
  if (m.type === 'init') { st = m.mode === 'average' ? new LiveAverager(m.width, m.height) : new LiveStacker(m.width, m.height, m.cell ?? 16); return }
  if (!st) return
  if (m.type === 'reset') { st.reset(); return }
  const stats = st.update(m.data)
  const copy = new Uint8ClampedArray(st.composite)   // the composite stays here; send a copy for display
  post({ composite: copy, width: st.width, height: st.height, stats }, [copy.buffer])
})
