/** Develops a /raw.bin capture off the main thread: parse -> develop (16-bit RGB, with the tuning
 *  file's lens shading, colour matrix and gamma) -> 16-bit PNG, plus a DNG of the untouched mosaic. */
import { parseRaw } from '../algo/raw'
import { develop, toRgba8, type DevelopOptions } from '../algo/rawdev'
import { encodePng16 } from '../png16'
import { encodeDng } from '../dng'

export interface RawDevelopRequest { buffer: ArrayBuffer; gains?: [number, number]; exposure?: number; params?: Pick<DevelopOptions, 'lsc' | 'ccm' | 'gammaCurve'>; model?: string; want?: 'files' | 'rgb16' }
export interface RawRgb16Result { rgb16: Uint16Array; width: number; height: number; bitDepth: number; bayer: string }
export interface RawDevelopResult {
  png: Blob; dng: Blob; preview: { data: Uint8ClampedArray; width: number; height: number }
  width: number; height: number; bitDepth: number; bayer: string; blackLevel: number
  applied: { lsc: boolean; ccm: boolean; gammaCurve: boolean; demosaic: 'malvar' }
}

self.onmessage = async (ev: MessageEvent<RawDevelopRequest>) => {
  try {
    const raw = parseRaw(ev.data.buffer)
    const p = ev.data.params ?? {}
    ;(self as any).postMessage({ progress: `developing ${raw.width}×${raw.height} ${raw.bitDepth}-bit ${raw.bayer} (shading ${p.lsc ? 'on' : 'off'}, colour matrix ${p.ccm ? 'on' : 'off'})` })
    const img = develop(raw, { gains: ev.data.gains, exposure: ev.data.exposure, lsc: p.lsc, ccm: p.ccm, gammaCurve: p.gammaCurve, demosaic: 'malvar' })
    if (ev.data.want === 'rgb16') {
      const result: RawRgb16Result = { rgb16: img.data, width: img.width, height: img.height, bitDepth: raw.bitDepth, bayer: raw.bayer }
      ;(self as any).postMessage({ result }, [img.data.buffer])
      return
    }
    ;(self as any).postMessage({ progress: 'encoding 16-bit PNG' })
    const png = await encodePng16(img.data, img.width, img.height)
    ;(self as any).postMessage({ progress: 'writing DNG' })
    const dng = encodeDng(raw, { gains: ev.data.gains, ccm: p.ccm, model: ev.data.model })
    const preview = toRgba8(img, 4)
    const result: RawDevelopResult = {
      png, dng, preview, width: raw.width, height: raw.height, bitDepth: raw.bitDepth, bayer: raw.bayer, blackLevel: raw.blackLevel,
      applied: { lsc: !!p.lsc, ccm: !!p.ccm, gammaCurve: !!p.gammaCurve, demosaic: 'malvar' },
    }
    ;(self as any).postMessage({ result }, [preview.data.buffer])
  } catch (e) {
    ;(self as any).postMessage({ error: (e as Error).message })
  }
}
