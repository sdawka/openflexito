/** Live extended depth of field off the main thread: decodes the `/edof.bin` JPEG frames, groups
 *  them into sweep legs by timestamp (`LegGrouper`) and fuses each leg (`SweepFuser`), posting one
 *  composite per completed leg. Leg records are applied as they arrive; frames are decoded one at a
 *  time in arrival (= time) order. Backlash dead-band frames are dropped undecoded except the last
 *  one of each band (`DeadBandFilter`), and when decoding falls more than `MAX_QUEUE` frames behind the
 *  oldest undecoded frames are dropped (counted in `droppedInWorker`).
 *
 *  Protocol: post `EdofWorkerIn` (`init` first, carrying the stream's `backlash_z` as `backlash`;
 *  pass `windowMs` only for a camera-only stream, steps = 0), receive `EdofWorkerOut`. */
import { defineWorker, post } from './workerUtil'
import { DeadBandFilter, LegGrouper, SweepFuser, legMidTime, legPeakStep, suggestBacklash, type LegGroup, type SweepLegEnd, type SweepLegStart } from '../algo/sweepFuse'

export type EdofWorkerIn =
  | { type: 'init'; width: number; height: number; cell?: number; flatRatio?: number; windowMs?: number; backlash?: number }
  | { type: 'leg'; leg: SweepLegStart }
  | { type: 'leg_end'; end: SweepLegEnd }
  /** `jpeg` is transferred */
  | { type: 'frame'; jpeg: ArrayBuffer; ts: number | null; seq: number }
  | { type: 'reset' }
  /** complete whatever is pending once the queued frames are decoded (stream ended) */
  | { type: 'flush' }

export interface EdofComposite {
  type: 'composite'
  /** transferred; the caller closes it */
  bitmap: ImageBitmap
  /** leg number, null for a camera-only time window */
  leg: number | null
  frames: number
  /** fraction of the leg's frames exposed after the backlash dead band (skipped ones included) */
  useful: number
  flatBlocks: number
  motionBlocks: number
  /** ns: first/last fused frame, and the reference frame (moving things are shown where they were then) */
  t0: number
  t1: number
  tMid: number
  /** the composite's true time window, t1 − t0 of the fused frames, ms */
  windowMs: number
  /** mean decode time per frame of this leg, ms */
  decodeMs: number
  /** fusion time of this leg (all `add`s + `finish`), ms */
  fuseMs: number
  /** focus peak of this leg in steps from t_ack (static scenes), or null */
  peakStep: number | null
  /** dead band estimated from recent legs' focus peaks (static scene only), or null */
  backlashEstimate: number | null
}

/** `deadBand`: dead-band frames skipped undecoded (by design, not a loss) */
export interface EdofStats { type: 'stats'; received: number; decoded: number; droppedInWorker: number; deadBand: number }

export type EdofWorkerOut = EdofComposite | EdofStats | { error: string }

const MAX_QUEUE = 16 // finish takes ~30 ms on the Pi's client, ~3 frame intervals at 95 fps

let width = 0, height = 0, cell = 16, flatRatio = 1.25, backlash = 0
let fuser: SweepFuser | null = null
let grouper = new LegGrouper()
let deadBand = new DeadBandFilter<Extract<EdofWorkerIn, { type: 'frame' }>>(0)
let cur: LegGroup | null = null
let decodeMs = 0, fuseMs = 0
let received = 0, decoded = 0, droppedInWorker = 0
let queue: Extract<EdofWorkerIn, { type: 'frame' }>[] = []
let flushWanted = false, pumping = false, generation = 0
let expireTimer: ReturnType<typeof setTimeout> | null = null
let peaks: { dir: number; peakStep: number }[] = []
let lastSteps = 0
let canvas: OffscreenCanvas | null = null
let ctx: OffscreenCanvasRenderingContext2D | null = null

function stats(): void { post({ type: 'stats', received, decoded, droppedInWorker, deadBand: deadBand.skipped } satisfies EdofStats) }

async function emit(g: LegGroup): Promise<void> {
  if (cur !== g || !fuser) return
  cur = null
  const t = performance.now()
  const n = fuser.count
  const r = fuser.finish(g.start ? legMidTime(g.start, g.end, backlash) : undefined)
  fuseMs += performance.now() - t
  const dMs = n ? decodeMs / n : 0, fMs = fuseMs
  decodeMs = 0; fuseMs = 0
  if (!r) return
  let peakStep: number | null = null
  if (g.start) {
    peakStep = legPeakStep(r.times, r.focus, g.start)
    const dir = Math.sign(g.end?.z1 != null && g.start.z0 != null ? g.end.z1 - g.start.z0 : g.start.steps)
    if (peakStep != null && dir && !g.end?.cancelled) { peaks.push({ dir, peakStep }); if (peaks.length > 16) peaks.shift() }
    lastSteps = g.start.steps
  }
  const gen = generation
  const bitmap = await createImageBitmap(new ImageData(r.composite as Uint8ClampedArray<ArrayBuffer>, fuser.width, fuser.height))
  if (gen !== generation) { bitmap.close(); return }
  post({
    type: 'composite', bitmap, leg: g.leg, frames: r.frames,
    useful: g.leg != null ? deadBand.useful(g.leg) : 1,
    flatBlocks: r.flatBlocks, motionBlocks: r.motionBlocks, t0: r.t0, t1: r.t1, tMid: r.tMid, windowMs: (r.t1 - r.t0) / 1e6,
    decodeMs: dMs, fuseMs: fMs, peakStep, backlashEstimate: suggestBacklash(peaks, lastSteps),
  } satisfies EdofComposite, [bitmap])
  stats()
}

async function emitAll(groups: LegGroup[]): Promise<void> { for (const g of groups) await emit(g) }

function armExpiry(): void {
  // a leg whose end is known but no later frame arrives (stream paused): complete it anyway
  if (expireTimer) clearTimeout(expireTimer)
  expireTimer = setTimeout(() => {
    expireTimer = null
    if (pumping || queue.length) armExpiry()
    else void emitAll(grouper.expireEnded())
  }, 500)
}

async function decode(jpeg: ArrayBuffer): Promise<Uint8ClampedArray> {
  const bmp = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }))
  try {
    if (!fuser || bmp.width !== width || bmp.height !== height) {
      width = bmp.width; height = bmp.height
      fuser = new SweepFuser(width, height, { cell, flatRatio }); cur = null
    }
    if (!canvas || canvas.width !== width || canvas.height !== height) {
      canvas = new OffscreenCanvas(width, height)
      ctx = canvas.getContext('2d', { willReadFrequently: true })
    }
    ctx!.drawImage(bmp, 0, 0)
    return ctx!.getImageData(0, 0, width, height).data
  } finally { bmp.close() }
}

async function pump(): Promise<void> {
  if (pumping) return
  pumping = true
  const gen = generation
  try {
    while (queue.length && gen === generation) {
      const m = queue.shift()!
      const t = performance.now()
      let rgba: Uint8ClampedArray
      try { rgba = await decode(m.jpeg) } catch { droppedInWorker++; continue }
      if (gen !== generation) return
      const dt = performance.now() - t
      decoded++
      const { group, completed } = grouper.frame(m.ts)
      await emitAll(completed)
      if (!group || m.ts == null || !fuser) continue
      if (cur && cur !== group) await emit(cur)
      cur = group
      decodeMs += dt
      const t2 = performance.now()
      fuser.add(rgba, m.ts)
      fuseMs += performance.now() - t2
    }
    if (flushWanted && gen === generation) { flushWanted = false; await emitAll(grouper.flush()); stats() }
  } finally {
    pumping = false
    if (gen !== generation && (queue.length || flushWanted)) void pump()
  }
}

function clear(): void {
  generation++
  queue = []; flushWanted = false; cur = null; peaks = []
  decodeMs = 0; fuseMs = 0
  fuser?.reset()
  grouper.reset()
  deadBand.reset()
  if (expireTimer) { clearTimeout(expireTimer); expireTimer = null }
}

defineWorker<EdofWorkerIn>(async (m) => {
  switch (m.type) {
    case 'init':
      clear()
      width = m.width; height = m.height; cell = m.cell ?? 16; flatRatio = m.flatRatio ?? 1.25; backlash = m.backlash ?? 0
      fuser = new SweepFuser(width, height, { cell, flatRatio })
      grouper = new LegGrouper({ windowMs: m.windowMs })
      deadBand = new DeadBandFilter(backlash)
      received = 0; decoded = 0; droppedInWorker = 0
      return
    case 'reset':
      clear(); stats()
      return
    case 'leg':
      deadBand.startLeg(m.leg)
      await emitAll(grouper.startLeg(m.leg))
      return
    case 'leg_end':
      await emitAll(grouper.endLeg(m.end))
      armExpiry()
      return
    case 'frame':
      received++
      queue.push(...deadBand.offer(m.ts, m))
      while (queue.length > MAX_QUEUE) { queue.shift(); droppedInWorker++ }
      void pump()
      return
    case 'flush':
      queue.push(...deadBand.flush())
      flushWanted = true
      void pump()
      return
  }
})
