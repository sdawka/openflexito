import { describe, expect, it } from 'vitest'
import { colormapPreview, COLORMAPS, listColormaps } from '../colormaps'

describe('COLORMAPS registry', () => {
  it('every colormap builds a 256-entry Lut1D with values in 0..1', () => {
    for (const [key, entry] of Object.entries(COLORMAPS)) {
      const lut = entry.build()
      expect(lut.size, key).toBe(256)
      for (let i = 0; i < 256; i++) {
        expect(lut.r[i], `${key}.r[${i}]`).toBeGreaterThanOrEqual(0)
        expect(lut.r[i], `${key}.r[${i}]`).toBeLessThanOrEqual(1)
        expect(lut.g[i], `${key}.g[${i}]`).toBeGreaterThanOrEqual(0)
        expect(lut.g[i], `${key}.g[${i}]`).toBeLessThanOrEqual(1)
        expect(lut.b[i], `${key}.b[${i}]`).toBeGreaterThanOrEqual(0)
        expect(lut.b[i], `${key}.b[${i}]`).toBeLessThanOrEqual(1)
      }
    }
  })

  it('viridis is monotone in perceptual luminance (dark to light)', () => {
    const lut = COLORMAPS.viridis.build()
    const luma = (i: number) => 0.2126 * lut.r[i] + 0.7152 * lut.g[i] + 0.0722 * lut.b[i]
    // viridis is not perfectly monotone in Rec.709 luma at every single step, but should trend strongly
    // upward: check coarse deciles rather than every adjacent pair
    let prev = luma(0)
    for (let i = 25; i < 256; i += 25) {
      const l = luma(i)
      expect(l).toBeGreaterThan(prev - 0.02)
      prev = l
    }
    expect(luma(255)).toBeGreaterThan(luma(0))
  })

  it('grays is a literal ramp', () => {
    const lut = COLORMAPS.grays.build()
    expect(lut.r[0]).toBeCloseTo(0, 3)
    expect(lut.r[255]).toBeCloseTo(1, 3)
    expect(lut.r[128]).toBeCloseTo(lut.g[128], 5)
    expect(lut.g[128]).toBeCloseTo(lut.b[128], 5)
  })

  it('fire starts black and ends white, per the ImageJ control points', () => {
    const lut = COLORMAPS.fire.build()
    expect(lut.r[0]).toBeCloseTo(0, 2); expect(lut.g[0]).toBeCloseTo(0, 2); expect(lut.b[0]).toBeCloseTo(0, 2)
    expect(lut.r[255]).toBeCloseTo(1, 2); expect(lut.g[255]).toBeCloseTo(1, 2); expect(lut.b[255]).toBeCloseTo(1, 2)
  })

  it('3-3-2 RGB is a bit-mask posterisation, not a smooth interpolation', () => {
    const lut = COLORMAPS['3-3-2 RGB'].build()
    // consecutive indices within the same 32-wide red band produce identical red output (posterised)
    expect(lut.r[0]).toBeCloseTo(lut.r[10], 5)
    expect(lut.r[0]).not.toBeCloseTo(lut.r[32], 5)
  })

  it('red/green/blue/cyan/magenta/yellow only vary their named channels', () => {
    const red = COLORMAPS.red.build()
    expect(red.r[128]).toBeGreaterThan(0)
    expect(red.g[128]).toBeCloseTo(0, 5)
    expect(red.b[128]).toBeCloseTo(0, 5)
    const cyan = COLORMAPS.cyan.build()
    expect(cyan.r[128]).toBeCloseTo(0, 5)
    expect(cyan.g[128]).toBeGreaterThan(0)
    expect(cyan.b[128]).toBeGreaterThan(0)
  })
})

describe('colormapPreview / listColormaps', () => {
  it('returns an RGBA strip of the requested width', () => {
    const strip = colormapPreview('viridis', 16)
    expect(strip.length).toBe(16 * 4)
    expect(strip[3]).toBe(255)
  })

  it('lists every registered colormap', () => {
    const list = listColormaps()
    expect(list.length).toBe(Object.keys(COLORMAPS).length)
    expect(list.find((c) => c.key === 'viridis')?.group).toBe('scientific')
  })
})
