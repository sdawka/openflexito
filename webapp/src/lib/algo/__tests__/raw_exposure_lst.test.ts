import { describe, expect, it } from 'vitest'
import { parseRaw, splitBayer, percentile, rawLevel, type RawImage } from '../raw'
import { autoExpose, nextExposure, nextGain } from '../exposure'
import { gridAverage, lensShadingFromPlanes, flatLensShading, LST_COLS, LST_ROWS } from '../lst'
import { findAlgo, setLensShading, isLensShadingCalibrated, setStaticGreenEqualisation, CT_CALIBRATED, CT_UNCALIBRATED } from '../tuning'

function makeRaw(w: number, h: number, fill: (x: number, y: number) => number, black = 64): ArrayBuffer {
  const buf = new ArrayBuffer(24 + w * h * 2)
  const dv = new DataView(buf)
  ;[...'OFRW'].forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)))
  dv.setUint32(4, w, true); dv.setUint32(8, h, true); dv.setUint16(12, 10, true); dv.setUint16(14, black, true)
  ;[...'BGGR'].forEach((c, i) => dv.setUint8(16 + i, c.charCodeAt(0)))
  const data = new Uint16Array(buf, 24)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = fill(x, y)
  return buf
}

describe('raw', () => {
  it('parses header and splits BGGR planes', () => {
    // B at (even,even)=100, G at (odd,even)/(even,odd)=200, R at (odd,odd)=300 (+black)
    const img = parseRaw(makeRaw(8, 6, (x, y) => 64 + (x % 2 === 0 && y % 2 === 0 ? 100 : x % 2 === 1 && y % 2 === 1 ? 300 : 200)))
    expect([img.width, img.height, img.bitDepth, img.blackLevel, img.bayer]).toEqual([8, 6, 10, 64, 'BGGR'])
    const p = splitBayer(img)
    expect(p.width).toBe(4); expect(p.height).toBe(3)
    expect(p.b[0]).toBe(100); expect(p.g1[0]).toBe(200); expect(p.g2[0]).toBe(200); expect(p.r[0]).toBe(300)
    expect(rawLevel(p)).toBeCloseTo(300, 0)
  })
  it('rejects bad magic', () => {
    expect(() => parseRaw(new ArrayBuffer(64))).toThrow()
  })
  it('percentile interpolates', () => {
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3)
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5)
    expect(percentile([0, 10], 99.9)).toBeCloseTo(9.99)
  })
})

describe('exposure', () => {
  it('scales exposure and gain with caps', () => {
    expect(nextExposure(1000, 100, 400)).toBe(4000)
    expect(nextExposure(1000, 10, 400)).toBe(8000)      // capped at 8x
    expect(nextExposure(1000, 800, 400)).toBe(500)
    expect(nextGain(1, 200, 400)).toBe(2)
    expect(nextGain(1, 100, 400)).toBe(2)               // capped at 2x
    expect(nextGain(8, 100, 400)).toBeCloseTo(10.67)    // clamped at max
  })
  it('converges on a simulated sensor', async () => {
    // level = 0.05 * exposure * gain, exposure limited to 20000 µs -> needs gain
    let exp = 0, gain = 1
    const io = {
      async setControls(c: any) { if (c.ExposureTime !== undefined) exp = Math.min(20000, c.ExposureTime); if (c.AnalogueGain !== undefined) gain = c.AnalogueGain; return { ExposureTime: exp, AnalogueGain: gain } },
      async measureLevel() { return Math.min(1023, 0.005 * exp * gain) },
    }
    const r = await autoExpose(io, { target: 400 })
    expect(r.converged).toBe(true)
    expect(r.exposure).toBe(20000)
    expect(r.gain).toBeGreaterThan(3.5); expect(r.gain).toBeLessThan(4.5)
    expect(Math.abs(r.level - 400)).toBeLessThan(20)
  })
})

describe('lens shading', () => {
  it('grid average has the right shape and remainder handling', () => {
    const w = 33, h = 25
    const plane = new Float32Array(w * h).fill(2)
    const g = gridAverage(plane, w, h)
    expect(g.length).toBe(LST_COLS * LST_ROWS)
    expect(Array.from(g).every((v) => Math.abs(v - 2) < 1e-9)).toBe(true)
  })
  it('recovers a vignette and colour imbalance', () => {
    const w = 160, h = 120
    const raw = parseRaw(makeRaw(w, h, (x, y) => {
      const vx = (x - w / 2) / (w / 2), vy = (y - h / 2) / (h / 2)
      const v = 1 - 0.3 * (vx * vx + vy * vy)   // 0.4 at the corners
      const colour = x % 2 === 0 && y % 2 === 0 ? 0.8 : x % 2 === 1 && y % 2 === 1 ? 0.5 : 1   // B 0.8, R 0.5
      return 64 + Math.round(600 * v * colour)
    }))
    const lst = lensShadingFromPlanes(splitBayer(raw))
    expect(lst.luminance.length).toBe(192)
    const centre = lst.luminance[5 * LST_COLS + 8], corner = lst.luminance[0]
    expect(centre).toBeCloseTo(1, 1)
    expect(corner).toBeGreaterThan(1.3)      // corners need boosting
    expect(lst.cr.every((v) => Math.abs(v - 2) < 0.1)).toBe(true)     // G/R = 1/0.5
    expect(lst.cb.every((v) => Math.abs(v - 1.25) < 0.1)).toBe(true)  // G/B = 1/0.8
    expect(lst.colourGains[0]).toBeCloseTo(2, 1)
    expect(lst.colourGains[1]).toBeCloseTo(1.25, 1)
  })
})

describe('tuning', () => {
  const base = { version: 2.0, target: 'bcm2835', algorithms: [{ 'rpi.black_level': { black_level: 4096 } }, { 'rpi.alsc': { n_iter: 100 } }] }
  it('sets alsc tables and marks calibration', () => {
    const t1 = setLensShading(base, flatLensShading(), CT_UNCALIBRATED)
    expect(isLensShadingCalibrated(t1)).toBe(false)
    const t2 = setLensShading(t1, flatLensShading(), CT_CALIBRATED)
    expect(isLensShadingCalibrated(t2)).toBe(true)
    const alsc = findAlgo(t2, 'rpi.alsc')
    expect(alsc.n_iter).toBe(0)
    expect(alsc.calibrations_Cr[0].table.length).toBe(192)
    expect(findAlgo(base, 'rpi.alsc').n_iter).toBe(100)   // immutability
  })
  it('appends missing algorithms', () => {
    const t = setStaticGreenEqualisation(base)
    expect(findAlgo(t, 'rpi.geq').offset).toBe(65535)
    expect(t.algorithms!.length).toBe(3)
  })
})
