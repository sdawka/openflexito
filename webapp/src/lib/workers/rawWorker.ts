/** Develops a /raw.bin capture off the main thread: parse -> develop (16-bit RGB, with the tuning
 *  file's lens shading, colour matrix and gamma) -> 16-bit PNG, plus a DNG of the untouched mosaic. */
import { defineWorker, post } from './workerUtil'
import { parseRaw, type RawTrailer } from '../algo/raw'
import { develop, toRgba8, type DevelopOptions } from '../algo/rawdev'
import { encodePng16 } from '../algo/png16'
import { encodeDng } from '../algo/dng'
import type { FlatField } from '../algo/flatField'

export interface RawDevelopRequest {
  buffer: ArrayBuffer; gains?: [number, number]; exposure?: number
  params?: Pick<DevelopOptions, 'lsc' | 'ccm' | 'gammaCurve'>
  /** measured flat field: replaces `params.lsc` in develop and rides along in the DNG as GainMap opcodes */
  flatField?: FlatField | null
  model?: string; want?: 'files' | 'rgb16'
}
export interface RawRgb16Result { rgb16: Uint16Array; width: number; height: number; bitDepth: number; bayer: string; meta: RawTrailer | null }
export interface RawDevelopResult {
  png: Blob; dng: Blob; preview: { data: Uint8ClampedArray; width: number; height: number }
  width: number; height: number; bitDepth: number; bayer: string; blackLevel: number
  /** the record's own trailer (device.md §1/§2: exposure, gain, colour_gains, ts, ...), null for a v1 capture */
  meta: RawTrailer | null
  applied: { lsc: boolean; ccm: boolean; gammaCurve: boolean; demosaic: 'malvar'; flatField: boolean }
}

defineWorker<RawDevelopRequest>(async (m) => {
  const raw = parseRaw(m.buffer)
  const p = m.params ?? {}
  // the record's own colour_gains/ccm (device.md §2) take precedence over the live stream's, when present
  const gains: [number, number] | undefined = (raw.meta?.colour_gains as [number, number] | undefined) ?? m.gains
  const ccm = (raw.meta?.ccm as number[] | undefined) ?? p.ccm
  post({ progress: `developing ${raw.width}×${raw.height} ${raw.bitDepth}-bit ${raw.bayer} (shading ${m.flatField ? 'flat-field' : p.lsc ? 'ALSC' : 'off'}, colour matrix ${ccm ? 'on' : 'off'})` })
  const img = develop(raw, { gains, exposure: m.exposure, lsc: p.lsc, flatField: m.flatField, ccm, gammaCurve: p.gammaCurve, demosaic: 'malvar' })
  if (m.want === 'rgb16') {
    const result: RawRgb16Result = { rgb16: img.data, width: img.width, height: img.height, bitDepth: raw.bitDepth, bayer: raw.bayer, meta: raw.meta }
    post({ result }, [img.data.buffer])
    return
  }
  post({ progress: 'encoding 16-bit PNG' })
  const png = await encodePng16(img.data, img.width, img.height)
  post({ progress: 'writing DNG' })
  // DateTimeOriginal: the worker runs immediately after the fetch, so "now" is a good proxy for the
  // capture instant; `raw.meta.ts` is CLOCK_BOOTTIME and cannot be converted to wall-clock time here.
  const dng = encodeDng(raw, { gains, ccm, model: m.model, flatField: m.flatField, exposureUs: raw.meta?.exposure ?? null, analogueGain: raw.meta?.gain ?? null })
  const preview = toRgba8(img, 4)
  const result: RawDevelopResult = {
    png, dng, preview, width: raw.width, height: raw.height, bitDepth: raw.bitDepth, bayer: raw.bayer, blackLevel: raw.blackLevel, meta: raw.meta,
    applied: { lsc: !!p.lsc, ccm: !!ccm, gammaCurve: !!p.gammaCurve, demosaic: 'malvar', flatField: !!m.flatField },
  }
  post({ result }, [preview.data.buffer])
})
