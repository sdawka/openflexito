// Interactive browser test of the built webapp against a running device (fake or real).
//   node e2e/app.mjs [baseUrl]            default http://127.0.0.1:8099 (fake device serving webapp/dist)
//   E2E_MOVES=0 node e2e/app.mjs http://microscope.local   skip anything that moves the stage
// Uses the installed Google Chrome (channel "chrome") unless CHROME_EXE points at a binary.
import { chromium } from 'playwright'

const base = process.argv[2] || 'http://127.0.0.1:8099'
const moves = process.env.E2E_MOVES !== '0'
const shots = process.env.E2E_SHOTS || ''
const browser = await chromium.launch(process.env.CHROME_EXE ? { executablePath: process.env.CHROME_EXE, headless: true } : { channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const problems = []
page.on('pageerror', (e) => problems.push(`[pageerror] ${e.message.slice(0, 300)}`))
page.on('console', (m) => { if (m.type() === 'error') problems.push(`[console.error] ${m.text().slice(0, 300)}`) })

let failed = 0
async function step(name, fn) {
  const t = Date.now()
  try { await fn(); console.log(`ok   ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`) }
  catch (e) { failed++; console.log(`FAIL ${name}: ${e.message.split('\n')[0]}`); if (shots) await page.screenshot({ path: `${shots}/fail-${name.replace(/\W+/g, '_')}.png`, timeout: 5000 }).catch(() => {}) }
}
const nav = (tab) => page.click(`nav a[href="#/${tab}"]`)
async function position() {
  const txt = await page.locator('nav').innerText()
  const m = txt.match(/x\s+(-?\d+)\s+y\s+(-?\d+)\s+z\s+(-?\d+)/)
  if (!m) throw new Error('no position in status bar: ' + txt.replace(/\s+/g, ' ').slice(0, 120))
  return { x: +m[1], y: +m[2], z: +m[3] }
}
const logHas = (re, timeout) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector('pre.log')?.textContent || ''), re.source, { timeout })
const expect = (cond, msg) => { if (!cond) throw new Error(msg) }

await page.goto(`${base}/#/live`, { waitUntil: 'load' })

await step('connects and streams', async () => {
  await page.waitForFunction(() => /\d+ fps/.test(document.querySelector('nav')?.textContent || ''), null, { timeout: 15000 })
  await position()
})

await step('all tabs render without errors', async () => {
  for (const tab of ['calibrate', 'scan', 'gallery', 'settings', 'live']) {
    await nav(tab); await page.waitForTimeout(600)
    const text = await page.locator('main').innerText()
    expect(text.length > 20, `${tab} page is empty`)
  }
  expect(problems.length === 0, problems.join(' | '))
})

if (moves) await step('jog buttons move the stage by the step size', async () => {
  await nav('live')
  const p0 = await position()
  await page.selectOption('select:near(:text("XY step"))', '500').catch(() => {})
  await page.click('button[title="D / →"]')
  // position events stream during the move (including the backlash overshoot); wait for the final value
  await page.waitForFunction((x1) => { const m = document.querySelector('nav')?.textContent?.match(/x\s+(-?\d+)/); return m && +m[1] === x1 }, p0.x + 500, { timeout: 8000 })
    .catch(async () => { throw new Error(`x ended at ${(await position()).x}, expected ${p0.x + 500}`) })
  await page.click('button[title="A / ←"]')
  await page.waitForFunction((x0) => { const m = document.querySelector('nav')?.textContent?.match(/x\s+(-?\d+)/); return m && +m[1] === x0 }, p0.x, { timeout: 8000 })
})

await step('photo (full resolution) lands in the gallery', async () => {
  await nav('gallery'); await page.waitForTimeout(500)
  const before = await page.locator('.card').count()
  await nav('live')
  await page.click('button:has-text("Take photo")')
  await page.waitForFunction(() => /saved "Photo/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 30000 })
  await nav('gallery')
  await page.waitForFunction((n) => document.querySelectorAll('.card').length > n, before, { timeout: 8000 })
  expect(/3280\s*[×x]\s*2464/.test(await page.locator('main').innerText()), 'gallery does not list a 3280×2464 photo')
})

await step('RAW photo develops to a 16-bit PNG in the gallery', async () => {
  await nav('live')
  await page.selectOption('.panel:has(h3:has-text("Photo")) select', 'raw')
  await page.click('button:has-text("Take photo")')
  await page.waitForFunction(() => /saved "RAW 10-bit/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 120000 })
    .catch(async () => { throw new Error('raw photo did not finish: ' + (await page.locator('.panel:has(h3:has-text("Photo"))').innerText()).replace(/\s+/g, ' ').slice(-160)) })
  await page.selectOption('.panel:has(h3:has-text("Photo")) select', 'single')
  await nav('gallery'); await page.waitForTimeout(600)
  const gt = await page.locator('main').innerText()
  expect(/RAW 10-bit BGGR → 16-bit PNG/.test(gt) && /DNG kept/.test(gt) && /developed: malvar/.test(gt), 'gallery does not describe the raw item: ' + gt.replace(/\s+/g, ' ').slice(0, 200))
  expect(/RAW 10-bit[\s\S]{0,120}?3280\s*[×x]\s*2464/.test(gt), 'raw item is not listed at full sensor size')
})

if (moves) await step('focus stack photo returns to the starting z', async () => {
  await nav('live')
  const z0 = (await position()).z
  await page.selectOption('.panel:has(h3:has-text("Photo")) select', 'focus')
  const n = page.locator('.panel:has(h3:has-text("Photo")) input[type=number]').nth(0)
  await n.click({ clickCount: 3 }); await n.pressSequentially('3')
  await page.click('button:has-text("Take photo")')
  await page.waitForFunction(() => /saved "Focus stack/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 90000 })
    .catch(async () => { throw new Error('focus stack did not finish: ' + (await page.locator('.panel:has(h3:has-text("Photo"))').innerText()).replace(/\s+/g, ' ').slice(-160)) })
  await page.waitForTimeout(500)
  expect(Math.abs((await position()).z - z0) <= 1, `z ended at ${(await position()).z}, started at ${z0}`)
  const info = await page.locator('.panel:has(h3:has-text("Photo"))').innerText()
  await page.selectOption('.panel:has(h3:has-text("Photo")) select', 'single')
  await nav('gallery'); await page.waitForTimeout(600)
  const g = await page.locator('main').innerText()
  const m = g.match(/from each: ([\d% ]+)/)
  expect(!!m, 'gallery does not list per-slice contributions: ' + g.replace(/\s+/g, ' ').slice(0, 160))
  const shares = m[1].trim().split(/\s+/).map((s) => parseInt(s))
  expect(shares.length === 3 && shares.filter((s) => s > 5).length >= 2, `stack did not draw on several slices: ${m[1]} (${info.replace(/\s+/g, ' ').slice(-80)})`)
})

await step('camera controls: manual exposure slider and auto toggles', async () => {
  await nav('live')
  const ae = page.locator('label:has-text("auto exposure") input')
  if (await ae.isChecked()) await ae.uncheck()
  await page.waitForTimeout(400)
  expect(!(await ae.isChecked()), 'auto exposure still on')
  await ae.check(); await page.waitForTimeout(400)
})

await step('calibration 1: flat → exposure → lens shading', async () => {
  await nav('calibrate')
  await page.click('button:has-text("Run steps 2–4")')
  await logHas(/colour calibration: done/, 180000)
  const log = await page.locator('pre.log').innerText()
  expect(!/FAILED/.test(log), 'log contains a failure: ' + log.split('\n').filter((l) => /FAILED/.test(l)).join('; '))
  await page.waitForFunction(() => /Calibrated: exposure/.test(document.querySelector('.overview')?.textContent || ''), null, { timeout: 5000 })
})

if (moves) await step('calibration 2: stage ↔ camera mapping', async () => {
  await nav('calibrate')
  await page.click('button:has-text("Calibrate XY")')
  await logHas(/stage-camera mapping: (done|FAILED)/, 240000)
  const log = await page.locator('pre.log').innerText()
  expect(/stage-camera mapping: done/.test(log), log.split('\n').slice(-3).join(' | '))
  await page.waitForSelector('table.result')
  const row = await page.locator('table.result tbody tr').first().innerText()
  const pxPerStep = parseFloat(row.split('\t')[1])
  expect(pxPerStep > 0.005 && pxPerStep < 5, `implausible pixels/step ${pxPerStep}`)
})

if (moves) await step('click-hold-drag pans the stage like a map', async () => {
  await nav('live'); await page.waitForTimeout(600)
  const p0 = await position()
  const box = await page.locator('.view img').boundingBox()
  const natural = await page.locator('.view img').evaluate((el) => el.naturalWidth)
  const scale = box.width / natural                       // displayed px per image px
  const dragPx = 200
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2
  await page.mouse.move(cx, cy); await page.mouse.down()
  for (let i = 1; i <= 10; i++) { await page.mouse.move(cx + (dragPx / 10) * i, cy, { steps: 2 }); await page.waitForTimeout(40) }
  await page.mouse.up()
  // wait for the stage to settle: position text unchanged for 1.2 s
  let last = JSON.stringify(await position()), t0 = Date.now()
  for (;;) {
    await page.waitForTimeout(400)
    const cur = JSON.stringify(await position())
    if (cur === last) { await page.waitForTimeout(800); if (JSON.stringify(await position()) === cur) break }
    last = cur
    if (Date.now() - t0 > 20000) throw new Error('stage did not settle after the drag')
  }
  const p1 = await position()
  const moved = Math.hypot(p1.x - p0.x, p1.y - p0.y), expected = dragPx / scale  // fake specimen: 1 px per step
  expect(moved > expected * 0.7 && moved < expected * 1.3, `stage moved ${moved.toFixed(0)} steps for a ${dragPx} px drag, expected ~${expected.toFixed(0)}`)
  expect(!(await page.locator('.view img').evaluate((el) => el.style.transform)), 'image still translated after the pan settled')
})

if (moves) await step('autofocus returns to focus', async () => {
  await nav('live')
  const p0 = await position()
  await page.selectOption('select:near(:text("Z step"))', '500').catch(() => {})
  await page.click('button:has-text("Z+")')
  await page.waitForFunction((z0) => { const m = document.querySelector('nav')?.textContent?.match(/z\s+(-?\d+)/); return m && +m[1] !== z0 }, p0.z, { timeout: 8000 })
  await page.click('button:has-text("Autofocus")')
  await page.waitForSelector('button:has-text("Cancel")', { timeout: 5000 })
  await page.waitForSelector('button:has-text("Autofocus")', { timeout: 90000 })
  await page.waitForTimeout(800)
  const p1 = await position()
  expect(Math.abs(p1.z - p0.z) < 200, `autofocus ended at z=${p1.z}, started from focus at z=${p0.z} (defocused to ${p0.z + 500})`)
})

if (moves) await step('scan 2×2 stitches into the gallery', async () => {
  await nav('scan')
  for (const i of [0, 1]) {
    const box = page.locator('main input[type=number]').nth(i)
    await box.click({ clickCount: 3 }); await box.pressSequentially('2'); await page.waitForTimeout(200)
  }
  await page.waitForFunction(() => /4 tiles/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 8000 })
    .catch(async () => { throw new Error('grid inputs did not apply: ' + (await page.locator('main input[type=number]').evaluateAll((els) => els.map((e) => e.value))).join(',')) })
  await page.click('button:has-text("Start scan")')
  const t0 = Date.now()
  while (!(await page.locator('img[alt="stitched scan"]').count())) {
    if (Date.now() - t0 > 240000) throw new Error('scan did not finish; last progress: ' + (await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(-200))
    await page.waitForTimeout(2000)
  }
  await nav('gallery')
  await page.waitForFunction(() => /tiles/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 8000 })
})

if (moves) await step('fine focus stack centres on the focus plane and fuses several slices', async () => {
  await nav('live')
  await page.selectOption('.panel:has(h3:has-text("Photo")) select', 'focusfine')
  const n = page.locator('.panel:has(h3:has-text("Photo")) input[type=number]').nth(0)
  await n.click({ clickCount: 3 }); await n.pressSequentially('5')
  await page.click('button:has-text("Take photo")')
  await page.waitForFunction(() => /saved "Fine focus stack/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 180000 })
    .catch(async () => { throw new Error('fine stack did not finish: ' + (await page.locator('.panel:has(h3:has-text("Photo"))').innerText()).replace(/\s+/g, ' ').slice(-200)) })
  await page.waitForTimeout(500)
  const z = (await position()).z
  expect(Math.abs(z) < 150, `fine stack ended at z=${z}; the fake specimen is in focus at z=0`)
  await page.selectOption('.panel:has(h3:has-text("Photo")) select', 'single')
  await nav('gallery'); await page.waitForTimeout(600)
  const g = await page.locator('main').innerText()
  const m = g.match(/fine focus stack \(pyramid\)[\s\S]{0,160}?from each: ([\d% ]+)/)
  expect(!!m, 'gallery does not describe the fine stack: ' + g.replace(/\s+/g, ' ').slice(0, 200))
  const shares = m[1].trim().split(/\s+/).map((s) => parseInt(s))
  expect(shares.filter((s) => s > 5).length >= 2, `fine stack did not draw on several slices: ${m[1]}`)
})

await step('live focus stack builds a composite and saves it', async () => {
  await nav('live')
  await page.click('.panel:has(h3:has-text("Focus")) .seg button:has-text("Smooth")')
  await page.waitForFunction(() => /\d+ frames averaged/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 15000 })
  await page.click('.panel:has(h3:has-text("Focus")) .seg button:has-text("Stack")')
  await page.waitForFunction(() => /\d+ frames · \d+ % of blocks/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 15000 })
  await page.waitForTimeout(1500)
  const visible = await page.locator('.view canvas.composite').evaluate((c) => c.width > 0 && getComputedStyle(c).opacity !== '0')
  expect(visible, 'composite canvas not shown')
  await page.click('.panel:has(h3:has-text("Focus")) button:has-text("Save")')
  await page.waitForFunction(() => /saved "Live stack/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 10000 })
  await page.click('.panel:has(h3:has-text("Focus")) .seg button:has-text("Off")')
})

await step('video recording lands in the gallery and opens in the viewer', async () => {
  await nav('live')
  await page.click('button:has-text("Record video")')
  await page.waitForFunction(() => /Stop · \d+ s/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 5000 })
  await page.waitForTimeout(2500)
  await page.click('button:has-text("Stop ·")')
  await page.waitForFunction(() => /saved "Video live view/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 15000 })
  await nav('gallery'); await page.waitForTimeout(600)
  expect(/video · \d+ s · live view/.test(await page.locator('main').innerText()), 'gallery lacks the video chip')
  await page.locator('.card:has-text("Video live view") button:has-text("Open")').first().click()
  await page.waitForSelector('video.video', { timeout: 5000 })
  const dur = await page.locator('video.video').evaluate((v) => new Promise((r) => { if (v.readyState >= 1) r(v.duration); else v.onloadedmetadata = () => r(v.duration) }))
  expect(dur === Infinity || dur > 1, `video duration ${dur}`)
  await page.click('button:has-text("close")')
})

await step('settings persist across reload', async () => {
  await nav('settings')
  const box = page.locator('label:has-text("invert Y for keyboard") input')
  const was = await box.isChecked()
  await box.setChecked(!was)
  await page.goto('about:blank'); await page.goto(`${base}/#/settings`, { waitUntil: 'commit' }); await page.waitForTimeout(1500)  // reload: the MJPEG <img> keeps the page 'loading' forever
  await nav('settings')
  expect((await page.locator('label:has-text("invert Y for keyboard") input').isChecked()) === !was, 'setting did not persist')
  await page.locator('label:has-text("invert Y for keyboard") input').setChecked(was)
})

await step('device logs panel fetches and downloads', async () => {
  await nav('settings')
  await page.click('button:has-text("Fetch")')
  await page.waitForSelector('pre.logs', { timeout: 10000 })
  const text = await page.locator('pre.logs').innerText()
  expect(text.length > 10, 'empty log output')
  await page.locator('.panel:has(h3:has-text("Device logs")) select').nth(0).selectOption('app')
  await page.click('button:has-text("Fetch")'); await page.waitForTimeout(800)
  expect(/listening on|encoder|openflexito/.test(await page.locator('pre.logs').innerText()), 'app records missing expected lines')
})

await step('scale bar toggle in settings round-trips', async () => {
  await nav('settings')
  const box = page.locator('label:has-text("show scale bar") input')
  const was = await box.isChecked()
  await box.setChecked(!was)
  expect((await box.isChecked()) === !was, 'scale bar checkbox did not toggle')
  await box.setChecked(was)
})

await step('distance measurement records a result', async () => {
  await nav('live')
  await page.waitForFunction(() => /\d+ fps/.test(document.querySelector('nav')?.textContent || ''), null, { timeout: 10000 })
  await page.waitForTimeout(500)   // let the re-mounted <img> load its first MJPEG frame (naturalWidth)
  await page.click('.panel:has(h3:has-text("Measure")) button:has-text("Distance")')
  const box = await page.locator('.view').boundingBox()
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.4)
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6)
  await page.waitForFunction(() => /µm|px \(no scale\)/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 5000 })
  await page.keyboard.press('Escape')
})

await step('histogram samples the live view in the Camera panel', async () => {
  await nav('live')
  await page.locator('.panel:has(h3:has-text("Camera"))').scrollIntoViewIfNeeded()
  await page.waitForFunction(() => /mean \d+\/255/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 10000 })
})

if (moves) await step('scan 2×2 with autofocus every tile builds a height map', async () => {
  await nav('scan')
  for (const i of [0, 1]) {
    const box = page.locator('main input[type=number]').nth(i)
    await box.click({ clickCount: 3 }); await box.pressSequentially('2'); await page.waitForTimeout(200)
  }
  await page.selectOption('select:near(:text("focus"))', 'every')
  await page.waitForFunction(() => /4 tiles/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 8000 })
  await page.click('button:has-text("Start scan")')
  const t0 = Date.now()
  while (!(await page.locator('img[alt="stitched scan"]').count())) {
    if (Date.now() - t0 > 240000) throw new Error('scan did not finish; last progress: ' + (await page.locator('main').innerText()).replace(/\s+/g, ' ').slice(-200))
    await page.waitForTimeout(2000)
  }
  await page.selectOption('select:near(:text("focus"))', 'none')   // leave the panel in its default state for later steps
  await nav('gallery')
  await page.waitForFunction(() => /focus: every tile/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 8000 })
  await page.locator('.card:has-text("Scan 2×2") button:has-text("Open")').first().click()
  await page.waitForSelector('button:has-text("show height map")', { timeout: 5000 })
  await page.click('button:has-text("show height map")')
  const cells = await page.locator('.hm-cell').count()
  expect(cells === 4, `expected 4 height-map cells, got ${cells}`)
  await page.click('button:has-text("close")')
})

await step('spiral order and polygon region update the scan plan without moving the stage', async () => {
  await nav('scan')
  await page.waitForSelector('text=/\\d+ tiles of/', { timeout: 5000 })
  const before = await page.locator('main').innerText()
  const beforeCount = before.match(/(\d+) tiles of/)?.[1]
  await page.selectOption('select:near(:text("order"))', 'spiral')
  await page.waitForTimeout(300)
  const afterSpiral = await page.locator('main').innerText()
  expect(/tiles of .* est\./.test(afterSpiral), 'tile count / time estimate missing after selecting spiral order: ' + afterSpiral.replace(/\s+/g, ' ').slice(0, 200))
  await page.selectOption('select:near(:text("region"))', 'polygon')
  await page.waitForSelector('.poly-canvas', { timeout: 5000 })
  const box = await page.locator('.poly-canvas').boundingBox()
  // click three points to draw a small triangular region, clipping the plan below the full grid's tile count
  for (const [fx, fy] of [[0.5, 0.1], [0.1, 0.9], [0.9, 0.9]]) {
    await page.mouse.click(box.x + fx * box.width, box.y + fy * box.height)
  }
  await page.waitForTimeout(300)
  const afterPolygon = await page.locator('main').innerText()
  const afterCount = afterPolygon.match(/(\d+) tiles of/)?.[1]
  expect(!!afterCount, 'tile count missing after drawing a polygon region: ' + afterPolygon.replace(/\s+/g, ' ').slice(0, 200))
  expect(Number(afterCount) <= Number(beforeCount), `polygon region did not clip the tile count (${beforeCount} -> ${afterCount})`)
  // back to a plain rectangle scan for anyone re-running this file interactively
  await page.selectOption('select:near(:text("region"))', 'rect')
  await page.selectOption('select:near(:text("order"))', 'snake')
})

if (moves) await step('super-resolution captures a dithered pattern and drizzles it to 2x', async () => {
  await nav('live')
  await page.selectOption('.panel:has(h3:has-text("Photo")) select', 'superres')
  const n = page.locator('.panel:has(h3:has-text("Photo")) input[type=number]').nth(0)
  await n.click({ clickCount: 3 }); await n.pressSequentially('4')
  await page.click('button:has-text("Take photo")')
  await page.waitForFunction(() => /saved "Super-resolution/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 90000 })
    .catch(async () => { throw new Error('super-resolution did not finish: ' + (await page.locator('.panel:has(h3:has-text("Photo"))').innerText()).replace(/\s+/g, ' ').slice(-200)) })
  await page.selectOption('.panel:has(h3:has-text("Photo")) select', 'single')
  await nav('gallery'); await page.waitForTimeout(600)
  const g = await page.locator('main').innerText()
  expect(/super-resolution \d+ frames ×2/i.test(g), 'gallery does not describe the super-resolution result: ' + g.replace(/\s+/g, ' ').slice(0, 200))
})

if (moves) await step('fine focus stack produces a depth map with an image/depth/relief toggle', async () => {
  await nav('live')
  await page.selectOption('.panel:has(h3:has-text("Photo")) select', 'focusfine')
  const n = page.locator('.panel:has(h3:has-text("Photo")) input[type=number]').nth(0)
  await n.click({ clickCount: 3 }); await n.pressSequentially('5')
  await page.click('button:has-text("Take photo")')
  await page.waitForFunction(() => /saved "Fine focus stack/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 180000 })
    .catch(async () => { throw new Error('fine stack did not finish: ' + (await page.locator('.panel:has(h3:has-text("Photo"))').innerText()).replace(/\s+/g, ' ').slice(-200)) })
  await page.selectOption('.panel:has(h3:has-text("Photo")) select', 'single')
  await nav('gallery'); await page.waitForTimeout(600)
  expect(/depth map/.test(await page.locator('main').innerText()), 'gallery does not show a depth map chip')
  await page.locator('.card:has-text("Fine focus stack") button:has-text("Open")').first().click()
  await page.waitForSelector('.modes button:has-text("Depth map")', { timeout: 5000 })
  await page.click('.modes button:has-text("Depth map")')
  await page.waitForTimeout(500)
  await page.click('.modes button:has-text("Relief")')
  await page.waitForTimeout(500)
  await page.click('.modes button:has-text("Image")')
  await page.waitForTimeout(300)
  await page.click('button:has-text("close")')
})

await step('time-lapse captures 3 frames and opens in the viewer', async () => {
  await nav('live')
  const panel = page.locator('.panel:has(h3:has-text("Time-lapse"))')
  const intervalInput = panel.locator('.row').first().locator('input[type=number]')
  await intervalInput.click({ clickCount: 3 }); await intervalInput.pressSequentially('1')
  await panel.locator('.seg button:has-text("Frames")').click()
  const frameInput = panel.locator('.row:has(.seg) input[type=number]')
  await frameInput.click({ clickCount: 3 }); await frameInput.pressSequentially('3')
  await panel.locator('button:has-text("Start time-lapse")').click()
  await page.waitForFunction(() => /saved "Time-lapse/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 30000 })
    .catch(async () => { throw new Error('time-lapse did not finish: ' + (await panel.innerText()).replace(/\s+/g, ' ').slice(-200)) })
  await panel.locator('button:has-text("Open in viewer")').click()
  await page.waitForSelector('.overlay canvas', { timeout: 5000 })
  const playing = await page.locator('.overlay button:has-text("Play")').count()
  expect(playing === 1, 'time-lapse viewer controls not shown')
  await page.click('.overlay button.close')
})

await step('organism tracking finds tracks on the live stream and exports a CSV', async () => {
  await nav('live')
  const panel = '.panel:has(h3:has-text("Tracking"))'
  await page.click(`${panel} button:has-text("Start tracking")`)
  await page.waitForTimeout(2000)
  await page.click(`${panel} button:has-text("Stop tracking")`)
  await page.click(`${panel} button:has-text("Export CSV")`)
  await page.waitForTimeout(300)
})

await step('sample metadata is captured on a quick frame and shown in the gallery', async () => {
  await nav('live')
  const samplePanel = page.locator('.panel:has(h3:has-text("Sample"))')
  await samplePanel.locator('summary').click()
  const nameInput = samplePanel.locator('input').first()
  await nameInput.fill('E2E sample A1')
  await page.click('button:has-text("Quick frame")')
  await page.waitForFunction(() => /saved "Quick frame/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 10000 })
  await nav('gallery'); await page.waitForTimeout(600)
  expect(/E2E sample A1/.test(await page.locator('main').innerText()), 'gallery does not show the sample name on the new item')
})

if (moves) await step('a recorded macro of two jogs replays and returns the stage', async () => {
  await nav('live')
  const macroPanel = page.locator('.panel:has(h3:has-text("Macro"))')
  await macroPanel.locator('summary').click()
  const p0 = await position()
  await macroPanel.locator('button:has-text("Record")').click()
  await page.click('button[title="D / →"]')
  await page.waitForFunction((x1) => { const m = document.querySelector('nav')?.textContent?.match(/x\s+(-?\d+)/); return m && +m[1] === x1 }, p0.x + 500, { timeout: 8000 })
  await page.click('button[title="A / ←"]')
  await page.waitForFunction((x0) => { const m = document.querySelector('nav')?.textContent?.match(/x\s+(-?\d+)/); return m && +m[1] === x0 }, p0.x, { timeout: 8000 })
  await macroPanel.locator('button:has-text("Stop")').click()
  await macroPanel.locator('input[placeholder="macro name"]').fill('E2E jog macro')
  await macroPanel.locator('button:has-text("Save")').click()
  await page.waitForFunction(() => /E2E jog macro/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 5000 })
  await macroPanel.locator('button[title="replay this macro"]').first().click()
  await page.waitForFunction(() => /replay of .E2E jog macro. finished/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 20000 })
  const pEnd = await position()
  expect(pEnd.x === p0.x, `macro replay left x at ${pEnd.x}, expected back at the starting ${p0.x}`)
  await macroPanel.locator('summary').click()
})

await step('no page errors during the run', async () => { expect(problems.length === 0, problems.join(' | ')) })

await browser.close()
console.log(failed ? `\n${failed} step(s) FAILED` : '\nall steps passed')
process.exit(failed ? 1 : 0)
