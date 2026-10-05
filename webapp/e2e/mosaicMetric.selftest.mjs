// node --test webapp/e2e/mosaicMetric.selftest.mjs   (not part of vitest: this is an e2e helper)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tilePeriodicity, tilePeriodicitySource } from './mosaicMetric.mjs'

/** Deterministic non-periodic specimen: random coloured blobs of radius rmin..rmin+rspan (`count`
 *  per 700 k px) on a light background, plus fine noise, like cells on a slide. */
function specimen(width, height, { rmin = 1, rspan = 4, count = 20000, seed = 7 } = {}) {
  let s = seed >>> 0
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  const blobs = Array.from({ length: Math.round(count * width * height / 700000) }, () => ({ x: rnd() * width, y: rnd() * height, r: rmin + rnd() * rspan, c: [120 + rnd() * 100, 60 + rnd() * 100, 120 + rnd() * 80] }))
  const img = new Float32Array(width * height * 3).fill(0)
  for (let i = 0; i < img.length; i += 3) { img[i] = 236; img[i + 1] = 232; img[i + 2] = 226 }
  for (const b of blobs) {   // paint each blob (later blobs overwrite)
    const r2 = b.r * b.r
    for (let y = Math.max(0, Math.floor(b.y - b.r)); y <= Math.min(height - 1, Math.ceil(b.y + b.r)); y++)
      for (let x = Math.max(0, Math.floor(b.x - b.r)); x <= Math.min(width - 1, Math.ceil(b.x + b.r)); x++)
        if ((x - b.x) ** 2 + (y - b.y) ** 2 < r2) { const i = (y * width + x) * 3; img[i] = b.c[0]; img[i + 1] = b.c[1]; img[i + 2] = b.c[2] }
  }
  for (let i = 0; i < img.length; i += 3) { const nz = (rnd() - 0.5) * 12; img[i] += nz; img[i + 1] += nz; img[i + 2] += nz }
  return img
}

/** The fake camera's shading (fake_camera.py `shading`): vignette to 0.66 at the corners, warm
 *  top-left, magenta bottom-right, ±3 % horizontal gradient. Returns linear multipliers (r, g, b). */
export function fakeShading(u, v) {
  const base = (1 - 0.17 * ((2 * u - 1) ** 2 + (2 * v - 1) ** 2)) * (1 + 0.06 * (u - 0.5))
  const tl = (1 - u) * (1 - v), br = u * v
  return [base * (1 + 0.06 * tl + 0.045 * br), base * (1 + 0.035 * tl), base * (1 + 0.06 * br)]
}
const scaled = (k) => (u, v) => fakeShading(u, v).map((m) => 1 + (m - 1) * k)

/** Mosaic of cols×rows tiles cut from the specimen at the given pitch, each multiplied in linear
 *  light by `shade(u, v)` (or none); overlaps are feathered like the stitcher does. `blankRight`
 *  leaves an uncovered black band. */
function mosaic(spec, specW, cols, rows, tileW, tileH, pitchX, pitchY, shade, blankRight = 0) {
  const width = Math.round(pitchX * (cols - 1) + tileW) + blankRight, height = Math.round(pitchY * (rows - 1) + tileH)
  const acc = new Float32Array(width * height * 3), wsum = new Float32Array(width * height)
  const fx = tileW - pitchX, fy = tileH - pitchY   // overlap = feather width
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const ox = Math.round(c * pitchX), oy = Math.round(r * pitchY)
    for (let y = 0; y < tileH; y++) for (let x = 0; x < tileW; x++) {
      const X = ox + x, Y = oy + y
      if (X >= width - blankRight) continue
      const w = Math.min(1, (x + 1) / fx, (tileW - x) / fx, (y + 1) / fy, (tileH - y) / fy)
      const si = (Y * specW + X) * 3, oi = Y * width + X
      const m = shade ? shade((x + 0.5) / tileW, (y + 0.5) / tileH) : [1, 1, 1]
      for (let ch = 0; ch < 3; ch++) acc[oi * 3 + ch] += w * Math.pow(Math.max(0, spec[si + ch]) / 255, 2.2) * m[ch]
      wsum[oi] += w
    }
  }
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) {
    if (!wsum[i]) continue
    for (let ch = 0; ch < 3; ch++) data[i * 4 + ch] = Math.round(Math.pow(Math.min(1, acc[i * 3 + ch] / wsum[i]), 1 / 2.2) * 255)
    data[i * 4 + 3] = 255
  }
  return { data, width, height }
}

const tileW = 200, tileH = 150, pitchX = 160.4, pitchY = 120.3   // ~20 % overlap, fractional pitch
function build(cols, rows, shade, specOpts, blankRight = 0) {
  const sw = Math.ceil(pitchX * cols + tileW), sh = Math.ceil(pitchY * rows + tileH)
  return mosaic(specimen(sw, sh, specOpts), sw, cols, rows, tileW, tileH, pitchX, pitchY, shade, blankRight)
}
const run = (m, opts) => tilePeriodicity(m.data, m.width, m.height, pitchX, pitchY, opts)
const show = (label, r) => console.log(label.padEnd(28), JSON.stringify({ L: +r.contrast.toFixed(3), colour: +r.colourContrast.toFixed(3), rg: +r.rgContrast.toFixed(3), bg: +r.bgContrast.toFixed(3), raw: +r.rawContrast.toFixed(2), rms: +r.fitRms.toFixed(3), cov: +r.coverage.toFixed(3) }))

// Features ~1–3 % of the tile: the fold has the statistics to separate shading from texture.
test('fine specimen, 5×4: shading-free folds flat, the fake shading does not', () => {
  const clean = run(build(5, 4, null)), full = run(build(5, 4, fakeShading))
  show('fine 5x4 clean', clean); show('fine 5x4 full shading', full)
  show('fine 5x4 quarter shading', run(build(5, 4, scaled(0.25))))
  show('fine 5x4 tenth shading', run(build(5, 4, scaled(0.1))))
  assert.ok(clean.contrast < 0.1, `clean luminance contrast ${clean.contrast}`)
  assert.ok(full.contrast > 0.15, `shaded luminance contrast ${full.contrast}`)
  assert.ok(full.contrast > 2 * clean.contrast)
  assert.ok(clean.coverage > 0.99)
})

test('fine specimen, 3×3 and 2×2', () => {
  for (const [c, r] of [[3, 3], [2, 2]]) {
    const clean = run(build(c, r, null)), full = run(build(c, r, fakeShading))
    show(`fine ${c}x${r} clean`, clean); show(`fine ${c}x${r} full shading`, full)
    if (c >= 3) assert.ok(full.contrast > 1.8 * clean.contrast, `${c}x${r}: ${full.contrast} vs ${clean.contrast}`)
  }
})

// Features ~10–20 % of the tile, as the fake camera's cells are on a full-res still: printed for
// reference, no assertion — the fold cannot tell these apart (see the module comment).
test('coarse specimen (fake-camera-like cells): reference figures', () => {
  const coarse = { rmin: 6, rspan: 30, count: 400 }
  for (const [c, r] of [[5, 4], [3, 3]]) {
    show(`coarse ${c}x${r} clean`, run(build(c, r, null, coarse)))
    show(`coarse ${c}x${r} full shading`, run(build(c, r, fakeShading, coarse)))
  }
})

test('uncovered (black) pixels are ignored and a wrong pitch scrambles the pattern', () => {
  const m = build(5, 4, fakeShading, undefined, 60)
  const r = run(m, { floor: true })
  show('fine 5x4 shaded + blank band', r); console.log('  floor (incommensurate pitch)', JSON.stringify(r.floor))
  assert.ok(r.coverage < 0.98 && r.coverage > 0.9, `coverage ${r.coverage}`)
  assert.ok(r.contrast > 0.15)
  assert.ok(r.floor.contrast < r.contrast / 1.5, `floor ${r.floor.contrast} vs ${r.contrast}`)
})

test('the source string rebuilds the same function (browser path)', () => {
  const f = new Function('return ' + tilePeriodicitySource)()
  const m = build(3, 3, fakeShading)
  const a = f(m.data, m.width, m.height, pitchX, pitchY), b = run(m)
  assert.equal(a.contrast, b.contrast)
  assert.equal(a.colourContrast, b.colourContrast)
})
