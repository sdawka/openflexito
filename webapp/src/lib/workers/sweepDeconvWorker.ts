/** Focal-sweep deconvolution off the main thread (`algo/sweepDeconv.ts`). Protocol:
 *  - `slope`: estimate the defocus blur slope from small linear-grey images (the sharpest sweep frame
 *    and a few defocused ones) → `{ slope: SlopeEstimate }`;
 *  - `init`, then one `add` per sweep frame (RGBA 8-bit, transferred, with the translation that
 *    aligns it) → `{ added: n }` after each (the caller waits on these so frames don't pile up);
 *  - `finish` with every added frame's blur radius → `{ result: { data, width, height } }` (RGBA
 *    8-bit sRGB, transferred). */
import { defineWorker, post } from './workerUtil'
import { SweepAccumulator, deconvolveSweep, estimateDefocusSlope, planesToRgba8, type GrayImage } from '../algo/sweepDeconv'

export type SweepDeconvIn =
  | { type: 'slope'; sharp: GrayImage; others: { img: GrayImage; dz: number }[]; maxR?: number }
  | { type: 'init'; width: number; height: number }
  | { type: 'add'; data: Uint8ClampedArray; dx: number; dy: number }
  | { type: 'finish'; radii: number[]; noise?: number }

let acc: SweepAccumulator | null = null

defineWorker<SweepDeconvIn>((m) => {
  if (m.type === 'slope') {
    post({ slope: estimateDefocusSlope(m.sharp, m.others, m.maxR) })
  } else if (m.type === 'init') {
    acc = new SweepAccumulator(m.width, m.height)
  } else if (m.type === 'add') {
    if (!acc) throw new Error('sweep deconvolution: add before init')
    acc.add(m.data, m.dx, m.dy)
    // the caller keeps only a couple of 8 MB frames in flight: acknowledge each one
    post({ added: acc.count })
  } else {
    if (!acc) throw new Error('sweep deconvolution: finish before init')
    if (m.radii.length !== acc.count) throw new Error(`sweep deconvolution: ${m.radii.length} radii for ${acc.count} frames`)
    post({ progress: `deconvolving the mean of ${acc.count} frames…` })
    const out = deconvolveSweep(acc.mean(), { radii: m.radii, noise: m.noise })
    const data = planesToRgba8(out)
    post({ result: { data, width: out.width, height: out.height } }, [data.buffer])
    acc = null
  }
})
