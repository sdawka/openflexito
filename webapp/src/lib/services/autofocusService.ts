/** Wires the autofocus algorithms to the live device. */

import { curveQuality, fastAutofocus, loopingAutofocus, stepAutofocus, twoPassAutofocus, type CurveQuality, type FastAutofocusResult, type PeakModel, type SharpnessMetric, type TwoPassResult } from '../algo/autofocus'
import { focusMetric, tileMetric } from '../algo/sharpness'
import { grabGray } from '../api/sampler'
import { device } from '../store/device.svelte'
import { settings } from '../store/settings.svelte'
import { frameLagNs } from '../store/calibration.svelte'

export interface AutofocusOptions {
  mode: 'fast' | 'looping' | 'step' | 'twopass'
  dz: number
  /** Sweep metric (fast/looping/twopass coarse pass). Default `settings.focusSweepMetric` ('fom');
   *  'fom' falls back to 'jpeg' when the device sends no `focus_fom`. */
  metric?: SharpnessMetric
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

/** True when recent stream frames carry a finite libcamera FocusFoM (the Pi build sends null/NaN
 *  until the device change is deployed). */
export function fomAvailable(): boolean {
  const fr = device.frames
  for (let i = fr.length - 1; i >= 0 && i >= fr.length - 15; i--) if (Number.isFinite(fr[i].focus_fom ?? NaN)) return true
  return false
}

/** The sweep metric actually used for a requested one. */
export function resolveSweepMetric(requested?: SharpnessMetric): SharpnessMetric {
  const want = requested ?? settings.focusSweepMetric ?? 'fom'
  return want === 'fom' && !fomAvailable() ? 'jpeg' : want
}

/** At-rest focus measure for step / fine / local-refine sweeps: the configured metric
 *  (`settings.focusMetric`, default Laplacian) scored over a 4x4 tile grid (median, so one
 *  piece of debris cannot dominate) on a grab `settings.focusGrabWidth` wide. `grabGray` never
 *  upsamples, so a stream narrower than that is graded at its native width. */
export async function measureSharpness(): Promise<number> {
  const w = settings.focusGrabWidth
  const g = await grabGray(typeof w === 'number' && w > 0 ? w : Infinity, 60)   // 'native': the stream frame as is
  return tileMetric(g, focusMetric(settings.focusMetric ?? 'laplacian'))
}

let cancelFlag = false
export function cancelAutofocus(): void { cancelFlag = true }

/** `runAutofocus` stays backward compatible: existing callers passing `mode: 'fast' | 'looping' |
 *  'step'` see no change. `mode: 'twopass'` additionally reports the coarse peak and the fine
 *  samples/fit. `quality` scores the curve that decided the peak (`curveQuality`): callers that
 *  must not accept a random z (the scan) gate on `quality.ok`. `metric` is the sweep metric actually
 *  used (after the FocusFoM fallback), `startZ` where the stage was before the sweep. */
export async function runAutofocus(opts: AutofocusOptions): Promise<{ peakZ: number; samples: { z: number; s: number }[]; coarse?: FastAutofocusResult; confirmed?: boolean; quality: CurveQuality; metric: SharpnessMetric; startZ: number }> {
  cancelFlag = false
  const startZ = device.position.z
  const metric = resolveSweepMetric(opts.metric)
  if (metric !== (opts.metric ?? settings.focusSweepMetric ?? 'fom')) opts.onProgress?.('no FocusFoM from the device, scoring by JPEG size')
  const io = {
    moveZ: (dz: number, compensate: false | 'z' = false) => device.moveRel({ z: dz }, compensate),
    currentZ: () => device.position.z,
    frames: () => device.frames,
    onProgress: opts.onProgress,
    cancelled: () => cancelFlag,
    lagNs: frameLagNs(),
  }
  const measure = measureSharpness
  if (opts.mode === 'step') {
    const r = await stepAutofocus({ ...io, measure }, opts.dz, 9)
    return { ...r, quality: curveQuality(r.samples), metric, startZ }
  }
  if (opts.mode === 'twopass') {
    const r: TwoPassResult = await twoPassAutofocus({ ...io, measure }, {
      coarseDz: opts.dz, coarseMetric: metric, fineRange: opts.fineRange, fineSteps: opts.fineSteps, fineModel: opts.fineModel, confirm: opts.confirm,
    })
    return { peakZ: r.peakZ, samples: r.fineSamples, coarse: r.coarse, confirmed: r.confirmed, quality: r.quality, metric, startZ }
  }
  const r: FastAutofocusResult = opts.mode === 'looping' ? await loopingAutofocus(io, opts.dz, metric) : await fastAutofocus(io, opts.dz, metric)
  return { peakZ: r.peakZ, samples: r.samples, quality: r.quality, metric, startZ }
}
