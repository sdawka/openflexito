/** Develops a /raw.bin capture off the main thread: parse -> develop (16-bit RGB) -> 16-bit PNG. */
import { parseRaw } from '../algo/raw'
import { develop, toRgba8 } from '../algo/rawdev'
import { encodePng16 } from '../png16'

export interface RawDevelopRequest { buffer: ArrayBuffer; gains?: [number, number]; exposure?: number }
export interface RawDevelopResult { png: Blob; preview: { data: Uint8ClampedArray; width: number; height: number }; width: number; height: number; bitDepth: number; bayer: string; blackLevel: number }

self.onmessage = async (ev: MessageEvent<RawDevelopRequest>) => {
  try {
    const raw = parseRaw(ev.data.buffer)
    ;(self as any).postMessage({ progress: `developing ${raw.width}×${raw.height} ${raw.bitDepth}-bit ${raw.bayer}` })
    const img = develop(raw, { gains: ev.data.gains, exposure: ev.data.exposure })
    ;(self as any).postMessage({ progress: 'encoding 16-bit PNG' })
    const png = await encodePng16(img.data, img.width, img.height)
    const preview = toRgba8(img, 4)
    const result: RawDevelopResult = { png, preview, width: raw.width, height: raw.height, bitDepth: raw.bitDepth, bayer: raw.bayer, blackLevel: raw.blackLevel }
    ;(self as any).postMessage({ result }, [preview.data.buffer])
  } catch (e) {
    ;(self as any).postMessage({ error: (e as Error).message })
  }
}
