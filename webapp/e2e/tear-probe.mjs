// Probe: does Chrome paint partially received MJPEG frames in an <img>? Samples the live <img>
// into a canvas at high rate and checks whether consecutive samples differ only in a top prefix of rows.
import { chromium } from 'playwright'
const base = process.argv[2] ?? 'http://microscope.local'
const browser = await chromium.launch({ channel: 'chrome', headless: false })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
await page.goto(base, { waitUntil: 'networkidle' })
await page.waitForSelector('img[alt="microscope live view"]')
await page.waitForTimeout(3000)
const r = await page.evaluate(async () => {
  const img = document.querySelector('img[alt="microscope live view"]')
  const w = img.naturalWidth, h = img.naturalHeight
  const c = new OffscreenCanvas(w, h), ctx = c.getContext('2d', { willReadFrequently: true })
  const rowMean = () => { ctx.drawImage(img, 0, 0); const d = ctx.getImageData(0, 0, w, h).data; const out = new Float32Array(h)
    for (let y = 0; y < h; y++) { let s = 0; for (let x = 0; x < w; x++) s += d[(y * w + x) * 4 + 1]; out[y] = s / w } return out }
  const samples = []; const t0 = performance.now()
  while (performance.now() - t0 < 4000) { samples.push(rowMean()); await new Promise((r) => setTimeout(r, 3)) }
  let changed = 0, partial = 0, boundaries = []
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1], b = samples[i]; let last = -1, first = -1, n = 0
    for (let y = 0; y < h; y++) if (Math.abs(a[y] - b[y]) > 0.05) { n++; if (first < 0) first = y; last = y }
    if (!n) continue; changed++
    // partial update: changed rows stop well before the bottom while the top changed
    if (first < h * 0.1 && last < h * 0.9) { partial++; boundaries.push(last) }
  }
  return { w, h, samples: samples.length, changed, partial, boundaries: boundaries.slice(0, 20) }
})
console.log(JSON.stringify(r))
await browser.close()
