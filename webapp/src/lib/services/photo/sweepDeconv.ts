/** Focal-sweep deconvolution for the sweep focus stack (`photo/sweepStack.ts`, method
 *  'deconvolve'): every frame of the sweep around the in-focus band is aligned (shift interpolated
 *  by z from the pyramid's aligned slices), averaged in linear light and deconvolved with the
 *  sweep's integrated defocus blur (`algo/sweepDeconv.ts`, in `workers/sweepDeconvWorker.ts`). The
 *  blur slope is measured from the sweep itself; the objective's NA and the XY/z calibrations are
 *  the fallback. */

import { shiftAtZ, sweepWindow, theoreticalSlope, srgbToLinearLut, type GrayImage, type SlopeEstimate } from '../../algo/sweepDeconv'
import { translateRgbaSubpixel } from '../../algo/align'
import type { SweepDeconvIn } from '../../workers/sweepDeconvWorker'
import { settings } from '../../store/settings.svelte'
import { umPerPxAt } from '../../store/scaleCal.svelte'
import type { Say } from './common'

export interface SweepFrames {
  width: number
  height: number
  /** the frame exposed at device time `t` (ns), ready to draw */
  frame(t: number): Promise<CanvasImageSource>
}

export interface DeconvInput {
  video: SweepFrames
  /** every frame of the sweep, in capture order */
  samples: readonly { z: number; t: number }[]
  /** index of the sharpest sample */
  peak: number
  /** the in-focus band (z) */
  band: [number, number]
  /** z extent of the whole sweep */
  sweep: [number, number]
  /** the pyramid's aligned slices: their z and the translation applied to each */
  alignedZ: readonly number[]
  shifts: readonly { dx: number; dy: number }[]
  /** Wiener noise-to-signal ratio (`algo/sweepDeconv#DeconvOptions.noise`) */
  noise?: number
}

export interface DeconvResult {
  data: Uint8ClampedArray
  width: number
  height: number
  frames: number
  slope: number
  slopeSource: 'measured' | 'theory'
  window: [number, number]
}

const SLOPE_WIDTH = 410

function worker() {
  const w = new Worker(new URL('../../workers/sweepDeconvWorker.ts', import.meta.url), { type: 'module' })
  let onAdded: ((n: number) => void) | null = null
  let pending: { resolve: (v: unknown) => void; reject: (e: Error) => void; key: 'slope' | 'result' } | null = null
  let failure: Error | null = null
  let progress: ((m: string) => void) | null = null
  w.onmessage = (ev) => {
    const d = ev.data
    if (d.error) { failure = new Error(d.error); pending?.reject(failure); pending = null; onAdded?.(-1) }
    else if (d.progress) progress?.(d.progress)
    else if (d.added != null) onAdded?.(d.added)
    else if (pending && d[pending.key] !== undefined) { pending.resolve(d[pending.key]); pending = null }
  }
  w.onerror = (e) => { failure = new Error(e.message); pending?.reject(failure); pending = null; onAdded?.(-1) }
  const post = (m: SweepDeconvIn, transfer: Transferable[] = []) => w.postMessage(m, transfer)
  const request = <T>(m: SweepDeconvIn, key: 'slope' | 'result', transfer: Transferable[] = []): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (failure) return reject(failure)
      pending = { resolve: resolve as (v: unknown) => void, reject, key }
      post(m, transfer)
    })
  return {
    terminate: () => w.terminate(),
    post, request,
    set onProgress(f: ((m: string) => void) | null) { progress = f },
    set onAdded(f: ((n: number) => void) | null) { onAdded = f },
    get failure() { return failure },
  }
}

/** A frame drawn small, aligned, as linear-light grey. */
async function smallGray(v: SweepFrames, t: number, shift: { dx: number; dy: number }, canvas: OffscreenCanvas): Promise<GrayImage> {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(await v.frame(t), 0, 0, canvas.width, canvas.height)
  const k = canvas.width / v.width
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const px = translateRgbaSubpixel(img.data, canvas.width, canvas.height, shift.dx * k, shift.dy * k)
  const lut = srgbToLinearLut(), out = new Float32Array(canvas.width * canvas.height)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = 0.2126 * lut[px[p]] + 0.7152 * lut[px[p + 1]] + 0.0722 * lut[px[p + 2]]
  return { data: out, width: canvas.width, height: canvas.height }
}

/** Nearest sample to `z`. */
function nearest(samples: readonly { z: number }[], z: number): number {
  let best = 0
  for (let i = 1; i < samples.length; i++) if (Math.abs(samples[i].z - z) < Math.abs(samples[best].z - z)) best = i
  return best
}

export async function deconvolveSweepFrames(o: DeconvInput, say: Say): Promise<DeconvResult> {
  const { video, samples } = o, w = video.width, h = video.height
  const shift = (z: number) => shiftAtZ(o.alignedZ, o.shifts, z)
  const wk = worker()
  wk.onProgress = (m) => say(`sweep EDOF: ${m}`)
  try {
    // 1. blur slope: the sharpest frame against frames a quarter and half of the sweep away from it
    say('sweep EDOF: measuring the defocus blur…')
    const small = new OffscreenCanvas(SLOPE_WIDTH, Math.round((SLOPE_WIDTH * h) / w))
    const peak = samples[o.peak]
    const half = (o.sweep[1] - o.sweep[0]) / 2
    const picks = new Set<number>()
    for (const f of [-0.5, -0.25, 0.25, 0.5]) {
      const i = nearest(samples, peak.z + f * half)
      if (i !== o.peak) picks.add(i)
    }
    const sharp = await smallGray(video, peak.t, shift(peak.z), small)
    const others: { img: GrayImage; dz: number }[] = []
    for (const i of picks) others.push({ img: await smallGray(video, samples[i].t, shift(samples[i].z), small), dz: samples[i].z - peak.z })
    const est = await wk.request<SlopeEstimate>({ type: 'slope', sharp, others, maxR: 24 }, 'slope')
    let slope: number, slopeSource: DeconvResult['slopeSource']
    if (est.slope) {
      slope = est.slope * (w / SLOPE_WIDTH)
      slopeSource = 'measured'
    } else {
      const umPerPx = umPerPxAt(w), zUm = settings.stageStepUm?.z
      if (!umPerPx || !(zUm > 0)) throw new Error('could not measure the defocus blur from the sweep, and without an XY calibration it cannot be computed either (run "Calibrate XY")')
      slope = theoreticalSlope(settings.objectiveNA ?? 0.65, zUm, umPerPx)
      slopeSource = 'theory'
    }
    say(`sweep EDOF: blur grows ${slope.toFixed(3)} px/step (${slopeSource}; fits ${est.fits.map((f) => `r=${f.r}@${Math.round(f.dz)}`).join(', ')})`)

    // 2. the frames to average: the in-focus band plus enough margin for a depth-invariant blur
    const win = sweepWindow(o.band[0], o.band[1], o.sweep[0], o.sweep[1], slope)
    const use = samples.filter((s) => s.z >= win.lo && s.z <= win.hi)
    if (use.length < 5) throw new Error(`only ${use.length} sweep frames around the in-focus band: sweep slower (fewer steps per frame)`)
    say(`sweep EDOF: averaging ${use.length} frames over z ${Math.round(win.lo)}…${Math.round(win.hi)}`)

    // 3. accumulate, at most two full frames in flight
    wk.post({ type: 'init', width: w, height: h })
    const full = new OffscreenCanvas(w, h)
    const ctx = full.getContext('2d', { willReadFrequently: true })!
    let acked = 0, sent = 0
    let wake: (() => void) | null = null
    wk.onAdded = (n) => { acked = n < 0 ? Infinity : n; wake?.() }
    for (const s of use) {
      while (sent - acked >= 2) await new Promise<void>((r) => { wake = r })
      if (wk.failure) throw wk.failure
      ctx.drawImage(await video.frame(s.t), 0, 0)
      const img = ctx.getImageData(0, 0, w, h)
      const d = shift(s.z)
      wk.post({ type: 'add', data: img.data, dx: d.dx, dy: d.dy }, [img.data.buffer])
      sent++
      if (sent % 20 === 0) say(`sweep EDOF: ${sent}/${use.length} frames averaged`)
    }

    // 4. deconvolve
    const radii = use.map((s) => slope * Math.abs(s.z - win.z0))
    const r = await wk.request<{ data: Uint8ClampedArray; width: number; height: number }>({ type: 'finish', radii, noise: o.noise }, 'result')
    return { ...r, frames: use.length, slope, slopeSource, window: [win.lo, win.hi] }
  } finally {
    wk.terminate()
  }
}
