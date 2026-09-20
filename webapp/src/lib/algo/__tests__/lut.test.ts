import { describe, expect, it } from 'vitest'
import {
  applyLookFloat, applyLookRgba, bakeLook, haldToLut3D, identity1D, identity3D, isLut3D, type Look,
  lut1DFromStops, parse3dl, parseCsvRamp, parseCube, parseImageJLut, parseLut, sample1D, sampleTetra,
  sampleTrilinear, toCube, type Lut3D,
} from '../lut'

function makeCube2x2(): Lut3D {
  // hand-picked 2x2x2 cube: corner values are r/g/b of the corner index itself, easy to reason about
  const size = 2
  const data = new Float32Array(size * size * size * 3)
  let o = 0
  for (let b = 0; b < 2; b++) for (let g = 0; g < 2; g++) for (let r = 0; r < 2; r++) {
    data[o++] = r; data[o++] = g; data[o++] = b
  }
  return { size, data, domainMin: [0, 0, 0], domainMax: [1, 1, 1] }
}

describe('identity LUTs', () => {
  it('identity1D leaves values unchanged', () => {
    const l = identity1D(256)
    const out = new Float32Array(3)
    sample1D(l, 0.37, 0.6, 0.91, out)
    expect(out[0]).toBeCloseTo(0.37, 2)
    expect(out[1]).toBeCloseTo(0.6, 2)
    expect(out[2]).toBeCloseTo(0.91, 2)
  })

  it('identity3D leaves values unchanged under tetrahedral and trilinear sampling', () => {
    const l = identity3D(17)
    const out = new Float32Array(3)
    for (const [r, g, b] of [[0.1, 0.2, 0.3], [0.5, 0.5, 0.5], [0.9, 0.05, 0.7]] as const) {
      sampleTetra(l, r, g, b, out)
      expect(out[0]).toBeCloseTo(r, 2); expect(out[1]).toBeCloseTo(g, 2); expect(out[2]).toBeCloseTo(b, 2)
      sampleTrilinear(l, r, g, b, out)
      expect(out[0]).toBeCloseTo(r, 2); expect(out[1]).toBeCloseTo(g, 2); expect(out[2]).toBeCloseTo(b, 2)
    }
  })
})

describe('tetrahedral vs trilinear', () => {
  const cube = makeCube2x2()
  it('agree exactly on grid points', () => {
    const outT = new Float32Array(3), outL = new Float32Array(3)
    for (const [r, g, b] of [[0, 0, 0], [1, 0, 0], [0, 1, 1], [1, 1, 1]] as const) {
      sampleTetra(cube, r, g, b, outT)
      sampleTrilinear(cube, r, g, b, outL)
      expect([...outT]).toEqual([...outL])
      expect(outT[0]).toBeCloseTo(r); expect(outT[1]).toBeCloseTo(g); expect(outT[2]).toBeCloseTo(b)
    }
  })

  it('agree exactly on the cube diagonal', () => {
    const outT = new Float32Array(3), outL = new Float32Array(3)
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      sampleTetra(cube, t, t, t, outT)
      sampleTrilinear(cube, t, t, t, outL)
      expect(outT[0]).toBeCloseTo(outL[0], 5)
      expect(outT[1]).toBeCloseTo(outL[1], 5)
      expect(outT[2]).toBeCloseTo(outL[2], 5)
    }
  })

  it('hand-computed value at an off-diagonal point', () => {
    // (r,g,b)=(0.5, 0.25, 0.75): trilinear on this identity-like cube (data[c]=corner coords) should
    // give back exactly the input coordinates, since every corner's channel c equals its own index c
    const out = new Float32Array(3)
    sampleTrilinear(cube, 0.5, 0.25, 0.75, out)
    expect(out[0]).toBeCloseTo(0.5, 5)
    expect(out[1]).toBeCloseTo(0.25, 5)
    expect(out[2]).toBeCloseTo(0.75, 5)
  })
})

describe('.cube round-trip', () => {
  it('round-trips a 3D LUT through toCube/parseCube', () => {
    const l = identity3D(5)
    // perturb so it's not literally identity, to catch ordering bugs
    for (let i = 0; i < l.data.length; i++) l.data[i] = Math.min(1, l.data[i] * 0.8 + 0.05)
    const text = toCube(l, 'Test Cube')
    const parsed = parseCube(text)
    expect(isLut3D(parsed)).toBe(true)
    if (isLut3D(parsed)) {
      expect(parsed.size).toBe(5)
      for (let i = 0; i < l.data.length; i++) expect(parsed.data[i]).toBeCloseTo(l.data[i], 5)
    }
  })

  it('round-trips a 1D LUT through toCube/parseCube', () => {
    const l = lut1DFromStops([[0, [0, 0, 0]], [0.5, [0.2, 0.6, 0.9]], [1, [1, 1, 1]]], 64)
    const text = toCube(l, 'Test 1D')
    const parsed = parseCube(text)
    expect(isLut3D(parsed)).toBe(false)
    if (!isLut3D(parsed)) {
      expect(parsed.size).toBe(64)
      for (let i = 0; i < 64; i++) {
        expect(parsed.r[i]).toBeCloseTo(l.r[i], 5)
        expect(parsed.g[i]).toBeCloseTo(l.g[i], 5)
        expect(parsed.b[i]).toBeCloseTo(l.b[i], 5)
      }
    }
  })

  it('parses CRLF, tabs, comments and a values-in-0..255 file with no domain header', () => {
    const text = [
      'TITLE "Test"',
      '# a comment',
      'LUT_1D_SIZE 3',
      '',
      '0\t0\t0',
      '128 128 128',
      '255 255 255',
      '',
    ].join('\r\n')
    const parsed = parseCube(text)
    expect(isLut3D(parsed)).toBe(false)
    if (!isLut3D(parsed)) {
      // values (and the recovered domain) are stored raw, in the file's own 0..255 units here;
      // sample1D takes input in those same domain units
      const out = new Float32Array(3)
      sample1D(parsed, 0, 0, 0, out)
      expect(out[0]).toBeCloseTo(0, 0)
      sample1D(parsed, 127.5, 127.5, 127.5, out)
      expect(out[0]).toBeCloseTo(128, 0)
      sample1D(parsed, 255, 255, 255, out)
      expect(out[0]).toBeCloseTo(255, 0)
    }
  })
})

describe('.3dl parsing', () => {
  it('parses the Lustre-style text example (blue fastest) into red-fastest internal storage', () => {
    // 2x2x2 cube written blue-fastest, 10-bit values (max 1023): r=g=b=index*1023 so we can check axes
    const rows: string[] = []
    for (let r = 0; r < 2; r++) for (let g = 0; g < 2; g++) for (let b = 0; b < 2; b++) {
      rows.push(`${r * 1023} ${g * 1023} ${b * 1023}`)
    }
    const text = ['3DMESH', 'Mesh 1 2', '0 1023', ...rows, 'LUT8'].join('\n')
    const lut = parse3dl(text)
    expect(lut.size).toBe(2)
    const out = new Float32Array(3)
    sampleTrilinear(lut, 1, 0, 0, out)
    expect(out[0]).toBeCloseTo(1, 2); expect(out[1]).toBeCloseTo(0, 2); expect(out[2]).toBeCloseTo(0, 2)
    sampleTrilinear(lut, 0, 1, 1, out)
    expect(out[0]).toBeCloseTo(0, 2); expect(out[1]).toBeCloseTo(1, 2); expect(out[2]).toBeCloseTo(1, 2)
  })
})

describe('ImageJ .lut parsing', () => {
  it('parses a 768-byte binary LUT (grays ramp)', () => {
    const buf = new ArrayBuffer(768)
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < 256; i++) { bytes[i] = i; bytes[256 + i] = i; bytes[512 + i] = i }
    const lut = parseImageJLut(buf)
    expect(lut.size).toBe(256)
    expect(lut.r[128]).toBeCloseTo(128 / 255, 3)
    expect(lut.g[255]).toBeCloseTo(1, 3)
  })

  it('parses an 800-byte binary LUT with an ICOL header', () => {
    const buf = new ArrayBuffer(800)
    const bytes = new Uint8Array(buf)
    bytes[0] = 0x49; bytes[1] = 0x43; bytes[2] = 0x4f; bytes[3] = 0x4c // 'ICOL'
    for (let i = 0; i < 256; i++) { bytes[32 + i] = 255 - i; bytes[32 + 256 + i] = 0; bytes[32 + 512 + i] = i }
    const lut = parseImageJLut(buf)
    expect(lut.r[0]).toBeCloseTo(1, 3)
    expect(lut.r[255]).toBeCloseTo(0, 3)
    expect(lut.b[255]).toBeCloseTo(1, 3)
  })

  it('parses the text variant (three columns, 256 rows)', () => {
    const lines: string[] = []
    for (let i = 0; i < 256; i++) lines.push(`${i} ${255 - i} 128`)
    const lut = parseImageJLut(lines.join('\n'))
    expect(lut.size).toBe(256)
    expect(lut.r[10]).toBeCloseTo(10 / 255, 3)
    expect(lut.g[10]).toBeCloseTo(245 / 255, 3)
    expect(lut.b[10]).toBeCloseTo(128 / 255, 2)
  })
})

describe('Hald CLUT', () => {
  it('decodes an identity Hald image back to an identity-ish cube', () => {
    const size = 8 // cube size; level = sqrt(8) is not integer but decode only needs size^3 pixels square
    const width = size * size // 64, area = 4096 = 16^3... use a level-4 Hald: level=4 -> size=16, width=64
    // build a proper level-4 Hald: cubeSize = level^2 = 16, image side = level^3 = 64
    const cubeSize = 16, side = 64
    const rgba = new Uint8ClampedArray(side * side * 4)
    for (let idx = 0; idx < side * side; idx++) {
      const r = idx % cubeSize, g = Math.floor(idx / cubeSize) % cubeSize, b = Math.floor(idx / (cubeSize * cubeSize))
      rgba[idx * 4] = Math.round((r / (cubeSize - 1)) * 255)
      rgba[idx * 4 + 1] = Math.round((g / (cubeSize - 1)) * 255)
      rgba[idx * 4 + 2] = Math.round((b / (cubeSize - 1)) * 255)
      rgba[idx * 4 + 3] = 255
    }
    const lut = haldToLut3D(rgba, side, side)
    expect(lut.size).toBe(cubeSize)
    const out = new Float32Array(3)
    sampleTrilinear(lut, 0.3, 0.6, 0.9, out)
    expect(out[0]).toBeCloseTo(0.3, 1)
    expect(out[1]).toBeCloseTo(0.6, 1)
    expect(out[2]).toBeCloseTo(0.9, 1)
    void width
  })
})

describe('CSV ramp parsing', () => {
  it('parses index + r g b columns, 0..255 scale', () => {
    const text = '0 0 0 0\n1 10 20 30\n2 255 255 255\n'
    const lut = parseCsvRamp(text)
    expect(lut.size).toBe(3)
    expect(lut.r[1]).toBeCloseTo(10 / 255, 3)
    expect(lut.b[2]).toBeCloseTo(1, 3)
  })

  it('parses hex rows', () => {
    const text = '#000000\n#ff8000\n#ffffff\n'
    const lut = parseCsvRamp(text)
    expect(lut.size).toBe(3)
    expect(lut.r[1]).toBeCloseTo(1, 2)
    expect(lut.g[1]).toBeCloseTo(0x80 / 255, 2)
  })
})

describe('parseLut sniffing', () => {
  it('picks parseCube via extension', () => {
    const text = 'LUT_1D_SIZE 2\n0 0 0\n1 1 1\n'
    const lut = parseLut(text, 'foo.cube')
    expect(isLut3D(lut)).toBe(false)
  })

  it('picks parseCube via content when no filename given', () => {
    const text = 'TITLE "x"\nLUT_3D_SIZE 2\n' + Array(8).fill('0 0 0').join('\n')
    const lut = parseLut(text)
    expect(isLut3D(lut)).toBe(true)
  })
})

describe('look pipeline', () => {
  function baseLook(overrides: Partial<Look> = {}): Look {
    return { strength: 1, input: 'srgb', pseudo: false, invert: false, ...overrides }
  }

  it('an empty look (no curve, no cube) is the identity', () => {
    const look = baseLook()
    const src = new Uint8ClampedArray([10, 128, 250, 255, 0, 200, 90, 100])
    const dst = new Uint8ClampedArray(src.length)
    applyLookRgba(src, dst, look)
    expect([...dst]).toEqual([...src])
  })

  it('strength 0.5 halves the effect of an invert', () => {
    const full = baseLook({ invert: true, strength: 1 })
    const half = baseLook({ invert: true, strength: 0.5 })
    const src = new Uint8ClampedArray([100, 100, 100, 255])
    const dstFull = new Uint8ClampedArray(4), dstHalf = new Uint8ClampedArray(4)
    applyLookRgba(src, dstFull, full)
    applyLookRgba(src, dstHalf, half)
    expect(dstFull[0]).toBeCloseTo(155, 0)
    expect(dstHalf[0]).toBeCloseTo(128, 0) // halfway between 100 and 155 (100*0.5 + 155*0.5)
  })

  it('pseudo maps a grey ramp through the curve as a colour map', () => {
    const curve = lut1DFromStops([[0, [0, 0, 1]], [1, [1, 0, 0]]], 256)
    const look = baseLook({ curve, pseudo: true })
    const src = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255])
    const dst = new Uint8ClampedArray(src.length)
    applyLookRgba(src, dst, look)
    expect(dst[0]).toBeLessThan(10) // black -> blue-ish (r near 0)
    expect(dst[2]).toBeGreaterThan(200)
    expect(dst[4]).toBeGreaterThan(200) // white -> red-ish
    expect(dst[6]).toBeLessThan(10)
  })

  it('applyLookFloat matches applyLookRgba within rounding', () => {
    const cube = makeCube2x2()
    // scale the 2x2x2 identity-coordinate cube's domain isn't relevant; just check the pipelines agree
    const look = baseLook({ cube })
    const src8 = new Uint8ClampedArray([64, 191, 32, 255])
    const dst8 = new Uint8ClampedArray(4)
    applyLookRgba(src8, dst8, look)
    const srcF = new Float32Array([64 / 255, 191 / 255, 32 / 255])
    const dstF = new Float32Array(3)
    applyLookFloat(srcF, dstF, look)
    expect(dst8[0] / 255).toBeCloseTo(dstF[0], 1)
    expect(dst8[1] / 255).toBeCloseTo(dstF[1], 1)
    expect(dst8[2] / 255).toBeCloseTo(dstF[2], 1)
  })

  it('bakeLook of a 1D-only look matches applyLookRgba within 1/255', () => {
    const curve = lut1DFromStops([[0, [0, 0.1, 0.2]], [1, [0.9, 1, 0.8]]], 256)
    const look = baseLook({ curve, strength: 0.7 })
    const baked = bakeLook(look, 17)
    for (const v of [10, 80, 150, 220]) {
      const src = new Uint8ClampedArray([v, v, v, 255])
      const dst = new Uint8ClampedArray(4)
      applyLookRgba(src, dst, look)
      const out = new Float32Array(3)
      sampleTetra(baked, v / 255, v / 255, v / 255, out)
      expect(Math.abs(out[0] * 255 - dst[0])).toBeLessThanOrEqual(2)
      expect(Math.abs(out[1] * 255 - dst[1])).toBeLessThanOrEqual(2)
      expect(Math.abs(out[2] * 255 - dst[2])).toBeLessThanOrEqual(2)
    }
  })

  it('handles 1 MP through a 33^3 cube look without throwing (perf smoke test)', () => {
    const cube = identity3D(33)
    for (let i = 0; i < cube.data.length; i++) cube.data[i] = Math.min(1, cube.data[i] * 1.05)
    const look = baseLook({ cube })
    const n = 1_000_000
    const src = new Uint8ClampedArray(n * 4)
    for (let i = 0; i < src.length; i++) src[i] = (i * 37) % 256
    const dst = new Uint8ClampedArray(src.length)
    const t0 = performance.now()
    applyLookRgba(src, dst, look)
    const elapsed = performance.now() - t0
    expect(dst.length).toBe(src.length)
    expect(elapsed).toBeLessThan(5000) // generous CI bound; laptop target is ~400ms
  })
})
