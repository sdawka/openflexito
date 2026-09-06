/** Wires the autofocus algorithms to the live device. */

import { fastAutofocus, loopingAutofocus, stepAutofocus, type FastAutofocusResult, type SharpnessMetric } from '../algo/autofocus'
import { laplacianVariance } from '../algo/sharpness'
import { grabGray } from '../api/sampler'
import { device } from '../store/device.svelte'

export interface AutofocusOptions { mode: 'fast' | 'looping' | 'step'; dz: number; metric: SharpnessMetric; onProgress?: (m: string) => void }

let cancelFlag = false
export function cancelAutofocus(): void { cancelFlag = true }

export async function runAutofocus(opts: AutofocusOptions): Promise<{ peakZ: number; samples: { z: number; s: number }[] }> {
  cancelFlag = false
  const io = {
    moveZ: (dz: number) => device.moveRel({ z: dz }, false),
    currentZ: () => device.position.z,
    frames: () => device.frames,
    onProgress: opts.onProgress,
    cancelled: () => cancelFlag,
  }
  if (opts.mode === 'step') {
    return stepAutofocus({ ...io, measure: async () => laplacianVariance(await grabGray(410, 60)) }, opts.dz, 9)
  }
  const r: FastAutofocusResult = opts.mode === 'looping' ? await loopingAutofocus(io, opts.dz, opts.metric) : await fastAutofocus(io, opts.dz, opts.metric)
  return { peakZ: r.peakZ, samples: r.samples }
}
