/** Runs `algo/pipeline.ts#developPipeline` off the main thread for the gallery Enhance panel
 *  (`services/enhance.svelte.ts`). Two modes, driven by whether the request carries `preview`:
 *
 *  - **Preview** (`preview: { maxWidth }`): box-downsamples the input to `maxWidth` first (nearest
 *    multiple-of-N box average, cheap and alias-free enough for a live slider preview) and runs the
 *    pipeline at that size, so a parameter change stays interactive even on a large source image.
 *    Denoise/deconvolve cost scales with pixel count, so this is the difference between a slider that
 *    feels live and one that doesn't (WP3 measured integral-image NLM at ~6.7 s/MP full-res; a 1024px
 *    preview of a 4000px-wide photo is roughly 15x fewer pixels).
 *  - **Full** (no `preview`): runs at the input's own resolution, for "Apply -> new photo".
 *
 *  `id` lets the caller correlate a result with the request that produced it and drop stale ones when
 *  a newer request has since been sent (the worker itself always finishes whatever it started — see
 *  the module doc on `services/enhance.svelte.ts` for why superseding is the *caller's* job, not this
 *  worker's: cancelling mid-pipeline would mean threading an abort flag through every stage in
 *  `algo/pipeline.ts`, which stays a plain synchronous function on purpose). */

import { defineWorker, post } from './workerUtil'
import { developPipeline, type EnhanceParams, type DevelopInput } from '../algo/pipeline'
import type { NoiseModel } from '../algo/noise'

export interface EnhanceWorkerInput {
  /** Interleaved pixel data, transferred (its `.buffer` is in the request's transfer list). */
  data: Uint8ClampedArray | Uint16Array
  width: number
  height: number
  /** true: `data` is 16-bit linear RGB (see `algo/pipeline.ts#DevelopInput`). */
  linear?: boolean
  noise?: NoiseModel
}

export interface EnhanceRequest {
  kind: 'develop'
  id: number
  input: EnhanceWorkerInput
  params: EnhanceParams
  /** When present, the pipeline runs on a downsampled copy for an interactive preview. */
  preview?: { maxWidth: number }
}

export interface EnhanceResult {
  data: Uint8ClampedArray | Uint16Array
  width: number
  height: number
}

/** Box-downsample to at most `maxWidth` wide, preserving aspect ratio and the input's typed-array
 *  kind (so a 16-bit linear preview stays 16-bit — the pipeline's own decode/encode logic depends on
 *  `input.linear` matching the array type). Channel count is inferred from the array type: 3 for
 *  `Uint16Array` (interleaved RGB, matching `rawdev`/`pipeline`'s convention), 4 for `Uint8ClampedArray`
 *  (RGBA). A box filter rather than nearest-neighbour avoids aliasing that would otherwise show up as
 *  spurious moire in a denoise/sharpen preview. */
function downsample(input: EnhanceWorkerInput, maxWidth: number): EnhanceWorkerInput {
  const { data, width, height } = input
  if (width <= maxWidth) return input
  const channels = data instanceof Uint16Array ? 3 : 4
  const scale = maxWidth / width
  const outW = Math.max(1, Math.round(width * scale))
  const outH = Math.max(1, Math.round(height * scale))
  const isU16 = data instanceof Uint16Array
  const out = isU16 ? new Uint16Array(outW * outH * channels) : new Uint8ClampedArray(outW * outH * channels)
  const sx = width / outW, sy = height / outH
  for (let oy = 0; oy < outH; oy++) {
    const y0 = Math.floor(oy * sy), y1 = Math.max(y0 + 1, Math.min(height, Math.floor((oy + 1) * sy)))
    for (let ox = 0; ox < outW; ox++) {
      const x0 = Math.floor(ox * sx), x1 = Math.max(x0 + 1, Math.min(width, Math.floor((ox + 1) * sx)))
      const acc = new Float64Array(channels)
      let n = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = (y * width + x) * channels
          for (let c = 0; c < channels; c++) acc[c] += data[p + c]
          n++
        }
      }
      const o = (oy * outW + ox) * channels
      for (let c = 0; c < channels; c++) out[o + c] = n ? acc[c] / n : 0
      if (!isU16 && channels === 4) (out as Uint8ClampedArray)[o + 3] = n ? acc[3] / n : 255
    }
  }
  return { data: out, width: outW, height: outH, linear: input.linear, noise: input.noise }
}

defineWorker<EnhanceRequest>((m) => {
  if (m.kind !== 'develop') return
  const input = m.preview ? downsample(m.input, m.preview.maxWidth) : m.input
  const devInput: DevelopInput = { data: input.data, width: input.width, height: input.height, linear: input.linear, noise: input.noise }
  const result = developPipeline(devInput, m.params, (stage, frac) => post({ id: m.id, stage, frac }))
  const out: EnhanceResult = { data: result.data, width: result.width, height: result.height }
  post({ id: m.id, result: out }, [out.data.buffer])
})
