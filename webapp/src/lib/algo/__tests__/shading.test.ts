import { describe, expect, it } from 'vitest'
import { estimateShading, medianShading, type RgbTile } from '../shading'
import type { GainMap, StitchTile, Vec } from '../stitch'

let seed = 7
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
const gauss = () => { const a = rnd() || 1e-9, b = rnd(); return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b) }

/** Smooth textured scene: sum of sinusoids per channel + soft blobs, ~40..200. Evaluated analytically so tiles can sit anywhere. */
function makeScene() {
  seed = 7
  const waves = Array.from({ length: 12 }, () => ({ kx: (rnd() - 0.5) * 0.25, ky: (rnd() - 0.5) * 0.25, ph: rnd() * 6.28, amp: 6 + rnd() * 10, ch: Math.floor(rnd() * 3) }))
  const blobs = Array.from({ length: 60 }, () => ({ x: rnd() * 1100 - 50, y: rnd() * 850 - 50, r: 8 + rnd() * 30, amp: (rnd() - 0.5) * 60, ch: Math.floor(rnd() * 4) }))
  return (X: number, Y: number, c: number): number => {
    let v = 120 + 15 * Math.sin(X * 0.011 + c) + 10 * Math.cos(Y * 0.013 - c)
    for (const w of waves) if (w.ch === c) v += w.amp * Math.sin(w.kx * X + w.ky * Y + w.ph)
    for (const b of blobs) if (b.ch === c || b.ch === 3) { const d2 = (X - b.x) ** 2 + (Y - b.y) ** 2; if (d2 < 9 * b.r * b.r) v += b.amp * Math.exp(-d2 / (b.r * b.r)) }
    return v
  }
}

/** Ground truth: radial vignetting (corners 0.6) × colour gradient (yellow top-left → magenta bottom-right, ±4 %). */
function trueShading(u: number, v: number, c: number): number {
  const p = u - 0.5, q = v - 0.5
  const vig = 1 - 0.4 * (p * p + q * q) / 0.5
  const tint = c === 1 ? 1 - 0.04 * (p + q) : c === 2 ? 1 + 0.04 * (p + q) : 1
  return vig * tint
}

const TW = 400, TH = 300, IW = 200, IH = 150   // nominal tile px, analysis image px (scale 0.5)

function makeGrid(cols: number, rows: number, overlap: number): { tiles: StitchTile[]; positions: Vec[] } {
  const tiles: StitchTile[] = [], positions: Vec[] = []
  const dx = TW * (1 - overlap), dy = TH * (1 - overlap)
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const id = tiles.length, x = c * dx, y = r * dy
    tiles.push({ id, x, y, width: TW, height: TH })
    positions.push({ x: x + (rnd() - 0.5) * 2, y: y + (rnd() - 0.5) * 2 })  // solved positions, slightly off the nominal grid
  }
  return { tiles, positions }
}

function render(tiles: StitchTile[], positions: Vec[], scene: (X: number, Y: number, c: number) => number, gains: number[][], noise = 1.5, corrupt = 0): RgbTile[] {
  return tiles.map((t, i) => {
    const data = new Float32Array(IW * IH * 3)
    for (let y = 0; y < IH; y++) for (let x = 0; x < IW; x++) {
      const u = (x + 0.5) / IW, v = (y + 0.5) / IH
      const X = positions[i].x + u * t.width, Y = positions[i].y + v * t.height
      for (let c = 0; c < 3; c++) {
        let val = scene(X, Y, c) * trueShading(u, v, c) * gains[i][c] + noise * gauss()
        if (corrupt > 0 && rnd() < corrupt) val = 8 + rnd() * 240
        data[(y * IW + x) * 3 + c] = Math.min(255, Math.max(0, val))
      }
    }
    return { data, width: IW, height: IH }
  })
}

function randomGains(n: number): number[][] {
  return Array.from({ length: n }, () => { const g = 1 + (rnd() - 0.5) * 0.3; return [g, g * (1 + (rnd() - 0.5) * 0.04), g * (1 + (rnd() - 0.5) * 0.04)] })
}

/** RMS of (map / truth − 1) per channel, both normalised to mean 1 over the grid. */
function mapError(map: GainMap, truth: (u: number, v: number, c: number) => number): number[] {
  const n = map.width * map.height, out: number[] = []
  for (let c = 0; c < 3; c++) {
    const t = new Float64Array(n)
    let mt = 0, me = 0
    for (let i = 0; i < n; i++) { t[i] = truth(((i % map.width) + 0.5) / map.width, (Math.floor(i / map.width) + 0.5) / map.height, c); mt += t[i]; me += map.data[i * 3 + c] }
    mt /= n; me /= n
    let s = 0
    for (let i = 0; i < n; i++) { const r = (map.data[i * 3 + c] / me) / (t[i] / mt) - 1; s += r * r }
    out.push(Math.sqrt(s / n))
  }
  return out
}

function gainError(est: [number, number, number][], truth: number[][]): number[] {
  const n = est.length, out: number[] = []
  for (let c = 0; c < 3; c++) {
    let lm = 0
    for (let i = 0; i < n; i++) lm += Math.log(truth[i][c])
    lm /= n
    let s = 0
    for (let i = 0; i < n; i++) { const r = est[i][c] / (truth[i][c] / Math.exp(lm)) - 1; s += r * r }
    out.push(Math.sqrt(s / n))
  }
  return out
}

describe('estimateShading', () => {
  it('recovers vignetting, colour gradient and per-tile gains from a 3×3 grid with 25 % overlap', () => {
    seed = 7
    const scene = makeScene()
    const { tiles, positions } = makeGrid(3, 3, 0.25)
    const gains = randomGains(tiles.length)
    const images = render(tiles, positions, scene, gains)
    const est = estimateShading(tiles, positions, images)
    expect(est).not.toBeNull()
    expect(est!.ok).toBe(true)
    expect(est!.pairs).toBe(20)     // 12 edge + 8 diagonal overlaps
    expect(est!.samples).toBeGreaterThan(2000)
    expect(est!.map.channels).toBe(3)
    expect(est!.map.width).toBe(32)
    for (const e of mapError(est!.map, trueShading)) expect(e).toBeLessThan(0.03)
    for (const e of gainError(est!.gains, gains)) expect(e).toBeLessThan(0.03)
    // the map is mean 1 per channel
    for (let c = 0; c < 3; c++) { let s = 0; for (let i = 0; i < 32 * 24; i++) s += est!.map.data[i * 3 + c]; expect(s / (32 * 24)).toBeCloseTo(1, 3) }
    // corners darker than the centre, colour gradient has the right sign (G higher top-left, B higher bottom-right)
    const at = (gx: number, gy: number, c: number) => est!.map.data[(gy * 32 + gx) * 3 + c]
    expect(at(0, 0, 1) / at(16, 12, 1)).toBeLessThan(0.75)
    expect(at(0, 0, 1) / at(0, 0, 2)).toBeGreaterThan(at(31, 23, 1) / at(31, 23, 2))
  })

  it('order 2 still gets the bowl within a few percent', () => {
    seed = 7
    const scene = makeScene()
    const { tiles, positions } = makeGrid(3, 3, 0.25)
    const gains = randomGains(tiles.length)
    const est = estimateShading(tiles, positions, render(tiles, positions, scene, gains), { order: 2 })
    expect(est).not.toBeNull()
    for (const e of mapError(est!.map, trueShading)) expect(e).toBeLessThan(0.05)
  })

  it('is robust to 10 % corrupted pixels', () => {
    seed = 7
    const scene = makeScene()
    const { tiles, positions } = makeGrid(3, 3, 0.25)
    const gains = randomGains(tiles.length)
    const images = render(tiles, positions, scene, gains, 1.5, 0.1)
    const est = estimateShading(tiles, positions, images)
    expect(est).not.toBeNull()
    for (const e of mapError(est!.map, trueShading)) expect(e).toBeLessThan(0.04)
    for (const e of gainError(est!.gains, gains)) expect(e).toBeLessThan(0.04)
  })

  it('returns null for a single tile or tiles that do not overlap', () => {
    seed = 7
    const scene = makeScene()
    const one = makeGrid(1, 1, 0.25)
    expect(estimateShading(one.tiles, one.positions, render(one.tiles, one.positions, scene, randomGains(1)))).toBeNull()
    const apart = makeGrid(2, 1, -0.1)    // 10 % gap
    expect(estimateShading(apart.tiles, apart.positions, render(apart.tiles, apart.positions, scene, randomGains(2)))).toBeNull()
    expect(estimateShading([], [], [])).toBeNull()
  })

  it('returns null when the overlaps are saturated', () => {
    const { tiles, positions } = makeGrid(2, 2, 0.25)
    const images = tiles.map(() => ({ data: new Float32Array(IW * IH * 3).fill(255), width: IW, height: IH }))
    expect(estimateShading(tiles, positions, images)).toBeNull()
  })
})

describe('medianShading', () => {
  it('approximates the field from many tiles of a textured scene', () => {
    seed = 3
    const scene = makeScene()
    const tiles: StitchTile[] = [], positions: Vec[] = []
    for (let i = 0; i < 40; i++) {
      tiles.push({ id: i, x: 0, y: 0, width: TW, height: TH })
      positions.push({ x: rnd() * 600, y: rnd() * 500 })
    }
    const images = render(tiles, positions, scene, randomGains(40), 1.5)
    const map = medianShading(images, { width: 16, height: 12 })
    expect(map).not.toBeNull()
    for (const e of mapError(map!, trueShading)) expect(e).toBeLessThan(0.1)
    expect(medianShading(images.slice(0, 2))).toBeNull()
  })
})
