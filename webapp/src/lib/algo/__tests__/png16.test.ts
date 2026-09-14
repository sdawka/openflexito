import { describe, expect, it } from 'vitest'
import { encodePng16, decodePng16 } from '../png16'

describe('png16 round trip', () => {
  it('decodes back to the exact 16-bit values for every adaptive filter choice', async () => {
    const w = 20, h = 15
    const rgb = new Uint16Array(w * h * 3)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3
      // a mix of smooth gradient and a few isolated high-frequency spikes, so the adaptive filter
      // picker has to choose between filter types row to row
      rgb[o] = Math.round(((x / w) * 65535 + (y % 3 === 0 ? 12345 : 0)) % 65536)
      rgb[o + 1] = Math.round(((y / h) * 65535) % 65536)
      rgb[o + 2] = (x * 37 + y * 911) % 65536
    }
    for (const filter of ['none', 'up', 'paeth', 'adaptive'] as const) {
      const blob = await encodePng16(rgb, w, h, filter)
      const back = await decodePng16(new Uint8Array(await blob.arrayBuffer()))
      expect(back.width).toBe(w); expect(back.height).toBe(h)
      expect(Array.from(back.data)).toEqual(Array.from(rgb))
    }
  })

  it('the adaptive encoding is not larger than the unfiltered one for a smooth image', async () => {
    const w = 64, h = 64
    const rgb = new Uint16Array(w * h * 3)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3, v = Math.round(((x + y) / (w + h)) * 65535)
      rgb[o] = v; rgb[o + 1] = v; rgb[o + 2] = v
    }
    const none = await encodePng16(rgb, w, h, 'none')
    const adaptive = await encodePng16(rgb, w, h, 'adaptive')
    expect(adaptive.size).toBeLessThanOrEqual(none.size)
  })

  it('rejects a non-16-bit-RGB PNG', async () => {
    // a minimal 8-bit greyscale PNG signature + IHDR claiming bit depth 8, colour type 0
    const bytes = new Uint8Array(33)
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0)
    const dv = new DataView(bytes.buffer)
    dv.setUint32(8, 13)
    bytes.set([73, 72, 68, 82], 12)  // "IHDR"
    dv.setUint32(16, 1); dv.setUint32(20, 1)
    bytes[24] = 8; bytes[25] = 0
    await expect(decodePng16(bytes)).rejects.toThrow()
  })
})
