// Stitch quality check: the repeated per-tile shading left in a scan mosaic, with and without the
// self-calibrating shading correction. Needs a fake started with a fine specimen (the default coarse
// cells are too few per field for the fold metric to separate texture from shading, see
// mosaicMetric.mjs), on its own port so it does not fight app.mjs for the stage:
//   cd device && OPENFLEXITO_FAKE_SPECIMEN=fine .venv/bin/python -m openflexito --fake --port 8098 --webapp-dir ../webapp/dist
//   cd webapp && node e2e/stitchQuality.mjs [http://127.0.0.1:8098]
// Runs a 3×3 scan twice (shading 'off', then 'auto'), folds each mosaic by the tile pitch and prints
// the residual contrast. Fails when the corrected mosaic is not clearly flatter than the uncorrected
// one or still above the shading-free floor.
//
// Environment:
//   STITCH_FOCUS=none|every|interpolate   scan focus mode (default: leave the page's setting)
//   STITCH_RANGE=300|600|1200             autofocus sweep (total steps) when STITCH_FOCUS is set
//   STITCH_ONLY=auto        run only the corrected scan (no off baseline, no ratio assertions); prints its focus line
//   STITCH_SAVE=<dir>       save each mosaic (≤1600 px wide JPEG) and a 2× crop of the first tile-corner
//                           junction to <dir>, plus the gallery item's stitch meta as JSON
//   STITCH_ABS=<n>          absolute contrast ceiling for the corrected mosaic (default 0.10, tuned for the
//                           fake's fine specimen); 0 or "none" keeps only the off→auto ratio check
//   STITCH_RATIO=<f>        corrected contrast must be below f × uncorrected (default 0.7)
//   STITCH_MULTIBAND=1      run a third scan: shading auto + multi-band blend (saved as "auto-mb")
//   STITCH_SCAN_TIMEOUT=ms  per-scan wait (default 300000; a 3×3 full-res scan on the Pi takes minutes)
//   STITCH_NUDGE=<steps>    on a failed stage-camera calibration (blank field) move x by this many raw
//                           steps over the device WebSocket and retry, up to 3 tries (default 0 = no retry)
import { chromium } from 'playwright'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tilePeriodicitySource } from './mosaicMetric.mjs'

const base = process.argv[2] || 'http://127.0.0.1:8098'
const saveDir = process.env.STITCH_SAVE || ''
const absEnv = (process.env.STITCH_ABS ?? '0.10').toLowerCase()
const absLimit = absEnv === 'none' || Number(absEnv) === 0 ? null : Number(absEnv)
const ratioLimit = Number(process.env.STITCH_RATIO ?? '0.7')
const scanTimeout = Number(process.env.STITCH_SCAN_TIMEOUT ?? '300000')
const nudge = Number(process.env.STITCH_NUDGE ?? '0')
const withMultiband = process.env.STITCH_MULTIBAND === '1'
if (saveDir) mkdirSync(saveDir, { recursive: true })

const browser = await chromium.launch(process.env.CHROME_EXE ? { executablePath: process.env.CHROME_EXE, headless: true } : { channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const problems = []
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message.slice(0, 300)}`))
page.on('console', (m) => { if (m.type() === 'error') problems.push(`[console.error] ${m.text().slice(0, 300)}`) })
const expect = (cond, msg) => { if (!cond) throw new Error(msg) }

/** One JSON-RPC call over the device WebSocket (through the same origin as the page, so a Vite proxy works). */
async function rpc(method, params = {}) {
  const ws = new WebSocket(base.replace(/^http/, 'ws') + '/ws')
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws failed')) })
  const reply = new Promise((res) => { ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) res(m) } })
  ws.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))
  const m = await reply
  ws.close()
  if (m.error) throw new Error(`${method}: ${JSON.stringify(m.error)}`)
  return m.result
}

// the fake persists power state and calibrations in ~/.openflexito like the Pi does: a fake left idle for
// 10 minutes restarts in standby, so wake it, and start every suite with no stored calibration
for (const [method, params] of [['power.set', { on: true }], ['calibration.clear', {}]])
  await (await page.request.post(base + '/rpc', { data: { jsonrpc: '2.0', method, params } })).json()
await page.goto(`${base}/#/calibrate`, { waitUntil: 'load' })
await page.waitForFunction(() => /\d+ fps/.test(document.querySelector('nav')?.textContent || ''), null, { timeout: 15000 })

// a fresh browser profile has no camera-to-stage mapping, and the scan needs one to space the tiles
for (let attempt = 1; ; attempt++) {
  await page.click('button:has-text("Calibrate XY")')
  await page.waitForFunction(() => /stage-camera mapping: (done|FAILED)/.test(document.querySelector('pre.log')?.textContent || ''), null, { timeout: 240000 })
  const log = await page.locator('pre.log').innerText()
  if (/stage-camera mapping: done/.test(log)) break
  const why = log.split('\n').filter((l) => /FAILED|error|fail/i.test(l)).slice(-2).join(' | ')
  if (!nudge || attempt >= 3) throw new Error('stage-camera calibration failed: ' + why)
  console.log(`calibration attempt ${attempt} failed (${why}); nudging the stage by x ${nudge} steps and retrying`)
  await rpc('stage.move_rel', { x: nudge, compensate: false })
  await page.waitForTimeout(1500)
  await page.reload({ waitUntil: 'load' })
  await page.waitForFunction(() => /\d+ fps/.test(document.querySelector('nav')?.textContent || ''), null, { timeout: 15000 })
}
console.log('stage position: ' + JSON.stringify((await rpc('stage.status')).position))
await page.click('nav a[href="#/scan"]')
await page.waitForTimeout(500)

// 3×3 grid (the default), overlap 0.3 (the default), stitching details open
const adv = page.locator('details.adv')
if (!(await adv.getAttribute('open'))) await adv.locator('summary').click()
const overlap = 0.3
for (const i of [0, 1]) {
  const box = page.locator('main input[type=number]').nth(i)
  await box.click({ clickCount: 3 }); await box.pressSequentially('3'); await page.waitForTimeout(200)
}
await page.waitForFunction(() => /9 tiles/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 8000 })

/** The newest scan item's stitch meta from the gallery database. */
const stitchMeta = () => page.evaluate(() => new Promise((res) => {
  const req = indexedDB.open('openflexito')
  req.onerror = () => res(null)
  req.onsuccess = () => {
    const db = req.result
    const q = db.transaction('items', 'readonly').objectStore('items').getAll()
    q.onsuccess = () => {
      const scans = q.result.filter((it) => it.kind === 'scan').sort((a, b) => (a.when < b.when ? 1 : -1))
      const it = scans[0]
      db.close()
      res(it ? { name: it.name, when: it.when, width: it.width, height: it.height, stitch: it.scan?.stitch ?? null, cfg: it.scan?.cfg ?? null,
                 tiles: it.scan?.tiles?.map((t) => ({ col: t.col, row: t.row, z: t.z, zMeasured: t.zMeasured, focus: t.focus ?? null })) ?? [] } : null)
    }
    q.onerror = () => { db.close(); res(null) }
  }
}))

const focusMode = process.env.STITCH_FOCUS || ''
const onlyAuto = process.env.STITCH_ONLY === 'auto'
if (focusMode) {
  await page.selectOption('.panel:has(h3:has-text("Focus")) select >> nth=0', focusMode)
  if (process.env.STITCH_RANGE && focusMode !== 'none') await page.selectOption('.panel:has(h3:has-text("Focus")) select >> nth=1', process.env.STITCH_RANGE)
}

async function scanWith(shading, { multiband = false, tag = shading } = {}) {
  await page.selectOption('label.shading select', shading)
  const mb = page.locator('details.adv label.check:has-text("multi-band") input')
  if ((await mb.isChecked()) !== multiband) await mb.click()
  await page.click('button:has-text("Start scan")')
  const t0 = Date.now()
  while (!(await page.locator('img[alt="stitched scan"]').count())) {
    if (Date.now() - t0 > scanTimeout) throw new Error('scan did not finish; last progress: ' + (await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(-200))
    await page.waitForTimeout(2000)
  }
  const summary = (await page.locator('main').innerText()).replace(/\s+/g, ' ')
  const focusLine = summary.match(/focus: [^·]*?(measured|predicted|failed)[^·]*/)?.[0]
  if (focusLine) console.log(`        ${focusLine.trim()}`)
  const m = await page.evaluate(async ({ src, overlap, cols, save }) => {
    const tilePeriodicity = new Function('return ' + src)()
    const img = document.querySelector('img[alt="stitched scan"]')
    const bmp = await createImageBitmap(await (await fetch(img.src)).blob())
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height
    const ctx = c.getContext('2d'); ctx.drawImage(bmp, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height)
    // the mosaic spans cols tiles with (cols − 1) pitches of (1 − overlap) tile widths
    const tileW = c.width / (1 + (cols - 1) * (1 - overlap)), tileH = c.height / (1 + (cols - 1) * (1 - overlap))
    const pitchX = tileW * (1 - overlap), pitchY = tileH * (1 - overlap)
    const r = tilePeriodicity(d.data, c.width, c.height, pitchX, pitchY)
    const out = { width: c.width, height: c.height, contrast: r.contrast, colourContrast: r.colourContrast, rawContrast: r.rawContrast, fitRms: r.fitRms, coverage: r.coverage }
    if (save) {
      // whole mosaic, ≤1600 px wide
      const s = Math.min(1, 1600 / c.width)
      const small = document.createElement('canvas'); small.width = Math.round(c.width * s); small.height = Math.round(c.height * s)
      small.getContext('2d').drawImage(bmp, 0, 0, small.width, small.height)
      out.mosaicDataUrl = small.toDataURL('image/jpeg', 0.9)
      // 2× crop centred on the first tile-corner junction: the overlap zone between tiles (0,0),(1,0),(0,1),(1,1)
      const cw = Math.round(Math.min(tileW * overlap * 2.5, 700)), ch = Math.round(Math.min(tileH * overlap * 2.5, 700))
      const cx = Math.round(pitchX + tileW * overlap / 2 - cw / 2), cy = Math.round(pitchY + tileH * overlap / 2 - ch / 2)
      const crop = document.createElement('canvas'); crop.width = cw * 2; crop.height = ch * 2
      crop.getContext('2d').drawImage(bmp, cx, cy, cw, ch, 0, 0, cw * 2, ch * 2)
      out.cropDataUrl = crop.toDataURL('image/jpeg', 0.92)
      out.crop = { x: cx, y: cy, w: cw, h: ch }
    }
    return out
  }, { src: tilePeriodicitySource, overlap, cols: 3, save: !!saveDir })
  const sh = summary.match(/· shading \w+( \(rms [\d.]+\))?/)?.[0] ?? '(no shading in summary)'
  const fullSummary = summary.match(/\d+×\d+ px · .*?· scale [\d.]+( · \d+ tile\(s\) with failed autofocus)?/)?.[0] ?? '(no summary line found)'
  console.log(`${tag.padEnd(7)} ${m.width}×${m.height} ${sh}: contrast ${m.contrast.toFixed(3)} colour ${m.colourContrast.toFixed(3)} raw ${m.rawContrast.toFixed(3)} fitRms ${m.fitRms.toFixed(3)} coverage ${m.coverage.toFixed(2)}`)
  console.log(`        summary: ${fullSummary}`)
  const meta = await stitchMeta()
  if (meta?.stitch) {
    const st = meta.stitch
    console.log(`        gains: ${JSON.stringify(st.gains)} blend ${st.blend} shading ${st.shading} flatField ${st.flatField}${st.shadingFit ? ' fit ' + JSON.stringify(st.shadingFit) : ''}`)
    if (st.gainsRgb) console.log(`        gainsRgb: ${JSON.stringify(st.gainsRgb)}`)
  } else console.log('        (no stitch meta found in the gallery database)')
  if (meta?.tiles?.some((t) => t.focus && t.focus.status !== 'none')) {
    // one line per tile: status, reason, contrast, z — the summary line only counts failures
    const line = meta.tiles.map((t) => `(${t.col},${t.row}) ${t.focus?.status ?? '-'}${t.focus?.reason ? '/' + t.focus.reason : ''}${t.focus?.contrast != null ? ' c' + t.focus.contrast : ''}${t.z != null ? ' z' + t.z : ''}`).join('  ')
    console.log(`        tiles: ${line}`)
  }
  if (saveDir) {
    const write = (name, dataUrl) => { const p = join(saveDir, name); writeFileSync(p, Buffer.from(dataUrl.split(',')[1], 'base64')); console.log('        saved ' + p) }
    write(`mosaic-${tag}.jpg`, m.mosaicDataUrl)
    write(`junction-${tag}.jpg`, m.cropDataUrl)
    const p = join(saveDir, `meta-${tag}.json`)
    writeFileSync(p, JSON.stringify({ metric: { ...m, mosaicDataUrl: undefined, cropDataUrl: undefined }, summary: fullSummary, gallery: meta }, null, 1))
    console.log('        saved ' + p)
  }
  return { ...m, summary }
}

let failed = 0
try {
  if (onlyAuto) {
    const auto = await scanWith('auto')
    console.log('        ' + auto.summary.match(/\d+×\d+ px ·[^\n]*?scale [\d.]+/)?.[0])
    throw { done: true }
  }
  const off = await scanWith('off')
  const auto = await scanWith('auto')
  console.log(`ratio auto/off: contrast ${(auto.contrast / off.contrast).toFixed(3)} colour ${(auto.colourContrast / off.colourContrast).toFixed(3)} raw ${(auto.rawContrast / off.rawContrast).toFixed(3)}`)
  if (withMultiband) {
    const mb = await scanWith('auto', { multiband: true, tag: 'auto-mb' })
    console.log(`ratio auto-mb/off: contrast ${(mb.contrast / off.contrast).toFixed(3)} colour ${(mb.colourContrast / off.colourContrast).toFixed(3)} raw ${(mb.rawContrast / off.rawContrast).toFixed(3)}`)
  }
  expect(/· shading auto/.test(auto.summary), 'the corrected scan did not report "shading auto": ' + auto.summary.slice(-200))
  expect(auto.contrast < ratioLimit * off.contrast, `corrected mosaic (${auto.contrast.toFixed(3)}) is not clearly flatter than the uncorrected one (${off.contrast.toFixed(3)})`)
  if (absLimit != null) expect(auto.contrast < absLimit, `corrected mosaic still shows a tiled pattern: contrast ${auto.contrast.toFixed(3)} (limit ${absLimit})`)
  console.log('ok   shading correction removes the tiled pattern')
} catch (e) { if (!e?.done) { failed++; console.log('FAIL ' + e.message.split('\n')[0]) } }
if (problems.length) { console.log('browser problems:'); for (const p of problems) console.log('  ' + p) }
await browser.close()
process.exit(failed || problems.length ? 1 : 0)
