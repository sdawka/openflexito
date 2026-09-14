/** Wires the autofocus algorithms to the live device. */

import { fastAutofocus, loopingAutofocus, stepAutofocus, twoPassAutofocus, type FastAutofocusResult, type PeakModel, type SharpnessMetric, type TwoPassResult } from '../algo/autofocus'
import { laplacianVariance } from '../algo/sharpness'
import { grabGray } from '../api/sampler'
import { device } from '../store/device.svelte'

export interface AutofocusOptions {
  mode: 'fast' | 'looping' | 'step' | 'twopass'
  dz: number
  metric: SharpnessMetric
  onProgress?: (m: string) => void
  /** 'twopass' only: z span and sample count of the fine Laplacian sweep, and its peak-fit shape. */
  fineRange?: number
  fineSteps?: number
  fineModel?: PeakModel
  /** 'twopass' only: confirm the fitted peak against a full-resolution capture (any function that
   *  returns a sharpness figure comparable to the fine-pass metric, e.g. Laplacian on a full still);
   *  falls back to the best fine sample if the confirmation disagrees. Costs one extra capture. */
  confirm?: (z: number) => Promise<number>
}

let cancelFlag = false
export function cancelAutofocus(): void { cancelFlag = true }

/** `runAutofocus` stays backward compatible: existing callers passing `mode: 'fast' | 'looping' |
 *  'step'` see no change. `mode: 'twopass'` additionally reports the coarse peak and the fine
 *  samples/fit, in case a caller wants to show or log them. */
export async function runAutofocus(opts: AutofocusOptions): Promise<{ peakZ: number; samples: { z: number; s: number }[]; coarse?: FastAutofocusResult; confirmed?: boolean }> {
  cancelFlag = false
  const io = {
    moveZ: (dz: number, compensate: false | 'z' = false) => device.moveRel({ z: dz }, compensate),
    currentZ: () => device.position.z,
    frames: () => device.frames,
    onProgress: opts.onProgress,
    cancelled: () => cancelFlag,
  }
  const measure = async () => laplacianVariance(await grabGray(410, 60))
  if (opts.mode === 'step') return stepAutofocus({ ...io, measure }, opts.dz, 9)
  if (opts.mode === 'twopass') {
    const r: TwoPassResult = await twoPassAutofocus({ ...io, measure }, {
      coarseDz: opts.dz, coarseMetric: opts.metric, fineRange: opts.fineRange, fineSteps: opts.fineSteps, fineModel: opts.fineModel, confirm: opts.confirm,
    })
    return { peakZ: r.peakZ, samples: r.fineSamples, coarse: r.coarse, confirmed: r.confirmed }
  }
  const r: FastAutofocusResult = opts.mode === 'looping' ? await loopingAutofocus(io, opts.dz, opts.metric) : await fastAutofocus(io, opts.dz, opts.metric)
  return { peakZ: r.peakZ, samples: r.samples }
}
