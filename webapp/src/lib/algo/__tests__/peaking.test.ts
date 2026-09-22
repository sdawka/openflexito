import { describe, expect, it } from 'vitest'
import { FocusPeaker, blur3, edgePercentiles, halfLuma, paintPeaking, paintZebra, parseColour, sobelMagnitude } from '../peaking'

function frame(w: number, h: number, fn: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = fn(x, y); const i = (y * w + x) * 4
    d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255
  }
  return d
}

describe('halfLuma / blur3 / sobelMagnitude', () => {
  it('half-res luma of a flat grey frame is that grey', () => {
    const f = frame(8, 6, () => [100, 100, 100])
    const l = halfLuma(f, 8, 6)
    expect(l.width).toBe(4); expect(l.height).toBe(3)
    for (const v of l.data) expect(v).toBeCloseTo(100, 4)
  })

  it('blur keeps a constant field constant and sobel of a constant field is 0', () => {
    const src = new Float32Array(25).fill(7)
    const b = blur3(src, 5, 5)
    for (const v of b) expect(v).toBeCloseTo(7, 6)
    const m = sobelMagnitude(b, 5, 5)
    for (const v of m) expect(v).toBe(0)
  })

  it('sobel finds a vertical step edge with magnitude 4*step', () => {
    const w = 8, h = 5
    const src = new Float32Array(w * h)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) src[y * w + x] = x < 4 ? 0 : 10
    const m = sobelMagnitude(src, w, h)
    expect(m[2 * w + 3]).toBeCloseTo(40, 6)
    expect(m[2 * w + 4]).toBeCloseTo(40, 6)
    expect(m[2 * w + 1]).toBe(0)
  })
})

describe('edgePercentiles / paintPeaking', () => {
  it('percentiles come out of the histogram at the right rank', () => {
    const mag = new Float32Array(1000)
    for (let i = 0; i < 1000; i++) mag[i] = i / 2 // 0 .. 499.5
    const s = edgePercentiles(mag)
    expect(s.p90).toBeGreaterThanOrEqual(449); expect(s.p90).toBeLessThanOrEqual(450)
    expect(s.p97).toBeGreaterThanOrEqual(484); expect(s.p97).toBeLessThanOrEqual(485)
  })

  it('paints a 2x2 block per half-res pixel above threshold, nothing below', () => {
    const w = 8, h = 6
    const rgba = frame(w, h, () => [10, 10, 10])
    const mag = new Float32Array(12) // 4x3
    mag[5] = 50 // (x=1, y=1)
    mag[6] = 20 // exactly at threshold: painted too (>=)
    const n = paintPeaking(rgba, w, mag, 4, 3, 20, [0, 255, 0])
    expect(n).toBe(2)
    const at = (x: number, y: number) => Array.from(rgba.subarray((y * w + x) * 4, (y * w + x) * 4 + 3))
    expect(at(2, 2)).toEqual([0, 255, 0]); expect(at(3, 3)).toEqual([0, 255, 0])
    expect(at(1, 1)).toEqual([10, 10, 10]); expect(at(4, 2)).toEqual([0, 255, 0]); expect(at(6, 2)).toEqual([10, 10, 10])
  })
})

describe('paintZebra', () => {
  it('stripes clipped and crushed pixels in opposite directions and leaves mid-tones alone', () => {
    const w = 32, h = 32
    const rgba = frame(w, h, (x) => (x < 10 ? [255, 200, 200] : x < 20 ? [2, 1, 0] : [128, 128, 128]))
    const n = paintZebra(rgba, w, h)
    expect(n.hi).toBe(10 * 32); expect(n.lo).toBe(10 * 32)
    // mid-grey untouched
    for (let y = 0; y < h; y++) expect(rgba[(y * w + 25) * 4]).toBe(128)
    // highlight zebra: a striped (x+y)>>3 odd pixel is white, an even one is dark
    const px = (x: number, y: number) => rgba[(y * w + x) * 4]
    expect(px(0, 8)).toBe(255) // (0+8)>>3 = 1 → white
    expect(px(0, 0)).toBe(40) // (0+0)>>3 = 0 → dark
    // shadow zebra uses (x-y): pixel (10,0): (10-0)>>3 = 1 → grey; (10,10): 0 → untouched (2)
    expect(px(10, 0)).toBe(128)
    expect(px(10, 10)).toBe(2)
  })
})

describe('FocusPeaker', () => {
  function sharpFrame(w: number, h: number): Uint8ClampedArray {
    // checkerboard of 8px cells: lots of strong edges
    return frame(w, h, (x, y) => (((x >> 3) + (y >> 3)) & 1 ? [230, 230, 230] : [20, 20, 20]))
  }

  it('paints edges on a sharp frame and nothing on a flat one (noise gate)', () => {
    const w = 64, h = 48
    const p = new FocusPeaker({ tauS: 0.5, minP90: 3 })
    const sharp = sharpFrame(w, h)
    p.process(sharp, w, h, 0, [0, 255, 0])
    expect(p.last.gated).toBe(false)
    expect(p.last.painted).toBeGreaterThan(0)
    let green = 0
    for (let i = 0; i < sharp.length; i += 4) if (sharp[i] === 0 && sharp[i + 1] === 255 && sharp[i + 2] === 0) green++
    expect(green).toBe(p.last.painted * 4)
    // roughly the top 3 % (percentile threshold) — never the whole frame
    expect(p.last.painted).toBeLessThan((w / 2) * (h / 2) * 0.2)

    const flat = frame(w, h, () => [100, 100, 100])
    const copy = flat.slice()
    p.process(flat, w, h, 0.1, [0, 255, 0])
    expect(p.last.gated).toBe(true)
    expect(Array.from(flat)).toEqual(Array.from(copy))
  })

  it('EMA moves the threshold toward the new frame with tau, and freeze holds it', () => {
    const w = 64, h = 48
    const p = new FocusPeaker({ tauS: 0.5 })
    p.process(sharpFrame(w, h), w, h, 0, [255, 0, 0])
    const t0 = p.last.threshold
    expect(t0).toBeCloseTo(p.last.p97, 6) // first frame snaps
    // a softer frame: same board with half the contrast
    const soft = frame(w, h, (x, y) => (((x >> 3) + (y >> 3)) & 1 ? [140, 140, 140] : [110, 110, 110]))
    p.process(soft.slice(), w, h, 0.5, [255, 0, 0]) // one tau later → ~63 % of the way
    const p97soft = p.last.p97
    expect(p97soft).toBeLessThan(t0)
    const expected = t0 + (1 - Math.exp(-1)) * (p97soft - t0)
    expect(p.last.threshold).toBeCloseTo(expected, 3)
    const held = p.last.threshold
    p.process(soft.slice(), w, h, 5, [255, 0, 0], true) // frozen: stage moving
    expect(p.last.threshold).toBe(held)
    p.process(soft.slice(), w, h, 50, [255, 0, 0]) // long gap → converges
    expect(p.last.threshold).toBeCloseTo(p97soft, 2)
  })
})

describe('parseColour', () => {
  it('parses hex and rgb() forms, falls back to green', () => {
    expect(parseColour('#00ff00')).toEqual([0, 255, 0])
    expect(parseColour('#F00')).toEqual([255, 0, 0])
    expect(parseColour('rgb(1, 2, 3)')).toEqual([1, 2, 3])
    expect(parseColour('nope')).toEqual([0, 255, 0])
  })
})
