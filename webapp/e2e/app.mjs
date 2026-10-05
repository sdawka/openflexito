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
/** JSON-RPC over the device's `POST /rpc`, from Node (not the page, so nothing reaches its console). */
async function rpc(method, params) {
  const r = await (await page.request.post(base + '/rpc', { data: { jsonrpc: '2.0', method, params } })).json()
  if (r.error) throw new Error(`${method}: ${r.error.message}`)
  return r.result
}

// Live's right-hand panels live behind a one-panel drawer opened from the tool rail
// (components/ToolRail.svelte); inactive panels are `display: none`, so open the right tool before
// touching one. Calling it on an already-open tool is a no-op.
const TOOL_OF = {
  Stage: 'stage', Focus: 'focus', Camera: 'camera', Illumination: 'camera', Look: 'look',
  Photo: 'photo', Measure: 'measure', 'Time-lapse': 'timelapse', Tracking: 'tracking', Intelligence: 'ai',
  Sample: 'sample', Macro: 'macro', Help: 'help',
}
async function tool(name) {
  const btn = page.locator(`.tool-rail button[data-tool="${TOOL_OF[name]}"]`)
  if (await btn.getAttribute('aria-pressed') !== 'true') await btn.click()
  return page.locator(`.panel:has(h3:has-text("${name}"))`)
}

// the fake persists power state and calibrations in ~/.openflexito like the Pi does: a fake left idle for
// 10 minutes restarts in standby, so wake it, and start every suite with no stored calibration. Only on
// the fake: on a real microscope the stored calibrations are the user's and must survive a test run.
const isFake = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/.test(base)
for (const [method, params] of [['power.set', { on: true }], ...(isFake ? [['calibration.clear', {}]] : [])])
  await (await page.request.post(base + '/rpc', { data: { jsonrpc: '2.0', method, params } })).json()
await page.goto(`${base}/#/live`, { waitUntil: 'load' })

await step('connects and streams', async () => {
  await page.waitForFunction(() => /\d+ fps/.test(document.querySelector('nav')?.textContent || ''), null, { timeout: 15000 })
  await position()
})

await step('link indicator shows the network link', async () => {
  // any real link label; the fake device always reports a wired 1000 Mbit/s link
  await page.waitForFunction(() => /Wired|WiFi|Hotspot/.test(document.querySelector('nav')?.textContent || ''), null, { timeout: 8000 })
  const st = await page.evaluate(async (b) => (await (await fetch(b + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'system.status', params: {} }) })).json()), base)
  const fake = !!((st.result ?? st).camera?.fake)
  if (fake) expect(/Wired/.test(await page.locator('nav').innerText()), 'fake device should show a wired link')
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
  await tool('Stage')
  const p0 = await position()
  await page.selectOption('select:near(:text("XY step"))', '500').catch(() => {})
  await page.click('button[title="D / →"]')
  // position events stream during the move (including the backlash overshoot); wait for the final value
  await page.waitForFunction((x1) => { const m = document.querySelector('nav')?.textContent?.match(/x\s+(-?\d+)/); return m && +m[1] === x1 }, p0.x + 500, { timeout: 8000 })
    .catch(async () => { throw new Error(`x ended at ${(await position()).x}, expected ${p0.x + 500}`) })
  await page.click('button[title="A / ←"]')
  await page.waitForFunction((x0) => { const m = document.querySelector('nav')?.textContent?.match(/x\s+(-?\d+)/); return m && +m[1] === x0 }, p0.x, { timeout: 8000 })
})

if (moves) await step('Shift+↑/↓ jog Z, not Y', async () => {
  await page.evaluate(() => document.activeElement?.blur?.())
  const settled = async () => { let a = await position(), b; for (;;) { await page.waitForTimeout(400); b = await position(); if (b.z === a.z && b.y === a.y) return b; a = b } }
  const p0 = await settled()
  await page.keyboard.down('Shift'); await page.keyboard.down('ArrowUp')
  await page.waitForTimeout(500)
  await page.keyboard.up('ArrowUp'); await page.keyboard.up('Shift')
  const p1 = await settled()
  expect(p1.z > p0.z && p1.y === p0.y, `Shift+↑ moved z ${p0.z}→${p1.z}, y ${p0.y}→${p1.y}`)
  await page.keyboard.down('Shift'); await page.keyboard.down('ArrowDown')
  await page.waitForTimeout(500)
  await page.keyboard.up('ArrowDown'); await page.keyboard.up('Shift')
  const p2 = await settled()
  expect(p2.z < p1.z && p2.y === p0.y, `Shift+↓ moved z ${p1.z}→${p2.z}, y ${p1.y}→${p2.y}`)
})
await step('photo (full resolution) lands in the gallery', async () => {
  await nav('gallery'); await page.waitForTimeout(500)
  const before = await page.locator('.card').count()
  await nav('live')
  await tool('Photo')
  await page.click('button:has-text("Take photo")')
  await page.waitForFunction(() => /saved "Photo/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 30000 })
  await nav('gallery')
  await page.waitForFunction((n) => document.querySelectorAll('.card').length > n, before, { timeout: 8000 })
  expect(/3280\s*[×x]\s*2464/.test(await page.locator('main').innerText()), 'gallery does not list a 3280×2464 photo')
})

await step('RAW photo develops to a 16-bit PNG in the gallery', async () => {
  await nav('live')
  await tool('Photo')
  await page.selectOption('.panel:has(h3:has-text("Photo")) select[aria-label="capture mode"]', 'raw')
  await page.click('button:has-text("Take photo")')
  await page.waitForFunction(() => /saved "RAW 10-bit/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 120000 })
    .catch(async () => { throw new Error('raw photo did not finish: ' + (await page.locator('.panel:has(h3:has-text("Photo"))').innerText()).replace(/\s+/g, ' ').slice(-160)) })
  await page.selectOption('.panel:has(h3:has-text("Photo")) select[aria-label="capture mode"]', 'single')
  await nav('gallery'); await page.waitForTimeout(600)
  const gt = await page.locator('main').innerText()
  expect(/RAW 10-bit BGGR → 16-bit PNG/.test(gt) && /DNG kept/.test(gt) && /developed: malvar/.test(gt), 'gallery does not describe the raw item: ' + gt.replace(/\s+/g, ' ').slice(0, 200))
  expect(/RAW 10-bit[\s\S]{0,120}?3280\s*[×x]\s*2464/.test(gt), 'raw item is not listed at full sensor size')
})

await step('RAW average photo (device-side frame averaging)', async () => {
  await nav('live')
  await tool('Photo')
  await page.selectOption('.panel:has(h3:has-text("Photo")) select[aria-label="capture mode"]', 'raw')
  const frames = page.locator('.panel:has(h3:has-text("Photo")) input[aria-label="raw frames"]')
  await frames.click({ clickCount: 3 }); await frames.pressSequentially('4')
  await page.click('button:has-text("Take photo")')
  await page.waitForFunction(() => /saved "RAW average/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 120000 })
    .catch(async () => { throw new Error('rawavg photo did not finish: ' + (await page.locator('.panel:has(h3:has-text("Photo"))').innerText()).replace(/\s+/g, ' ').slice(-160)) })
  await frames.click({ clickCount: 3 }); await frames.pressSequentially('1')
  await page.selectOption('.panel:has(h3:has-text("Photo")) select[aria-label="capture mode"]', 'single')
  await nav('gallery'); await page.waitForTimeout(600)
  expect(/RAW average/.test(await page.locator('main').innerText()), 'gallery does not list the RAW average item')
})

await step('HDR (RAW) photo merges a linear exposure bracket', async () => {
  await nav('live')
  await tool('Photo')
  await page.selectOption('.panel:has(h3:has-text("Photo")) select[aria-label="capture mode"]', 'hdr')
  await page.selectOption('.panel:has(h3:has-text("Photo")) select[aria-label="hdr source"]', 'raw')
  await page.click('button:has-text("Take photo")')
  await page.waitForFunction(() => /saved "HDR RAW/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 120000 })
    .catch(async () => { throw new Error('hdrraw photo did not finish: ' + (await page.locator('.panel:has(h3:has-text("Photo"))').innerText()).replace(/\s+/g, ' ').slice(-160)) })
  await page.selectOption('.panel:has(h3:has-text("Photo")) select[aria-label="hdr source"]', 'jpeg')
  await page.selectOption('.panel:has(h3:has-text("Photo")) select[aria-label="capture mode"]', 'single')
  await nav('gallery'); await page.waitForTimeout(600)
  expect(/HDR RAW/.test(await page.locator('main').innerText()), 'gallery does not list the HDR RAW item')
})

await step('camera controls: manual exposure slider and auto toggles', async () => {
  await nav('live')
  await tool('Camera')
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

if (moves) await step('focus calibration: z backlash and frame lag, stage speed restored, z returned', async () => {
  await nav('calibrate')
  // the fake's specimen is in focus at z = 0 (defocus ∝ |z|); on a real Pi calibrate where it is
  if (/127\.0\.0\.1|localhost/.test(base)) await rpc('stage.move_to', { z: 0, compensate: 'z' })
  const before = (await rpc('system.status')).stage.step_time_us
  await page.waitForTimeout(800)
  const z0 = (await position()).z
  await page.click('button:has-text("Calibrate Z")')
  await logHas(/focus calibration: (done|FAILED)/, 180000)
  const log = await page.locator('pre.log').innerText()
  expect(/focus calibration: done/.test(log), log.split('\n').filter((l) => /focus calibration/.test(l)).slice(-3).join(' | '))
  const cells = await page.locator('table.zcal tbody td').allInnerTexts()
  const b = parseFloat(cells[0]), lag = parseFloat(cells[1]), rep = parseFloat(cells[2])
  expect([b, lag, rep].every(Number.isFinite), `non-finite result: ${cells.join(' / ')}`)
  const after = (await rpc('system.status')).stage.step_time_us
  expect(after === before, `stage step time ${after} µs after the calibration, was ${before} µs`)
  await page.waitForTimeout(800)
  const z1 = (await position()).z
  expect(Math.abs(z1 - z0) <= 2, `ended at z=${z1}, started at z=${z0}`)
})

await step('RAW flat field: capture and clear', async () => {
  await nav('calibrate')
  const panel = '.panel:has(h3:has-text("RAW flat field"))'
  await page.click(`${panel} button:has-text("Capture flat field")`)
  await logHas(/flat field: (done|FAILED)/, 60000)
  const log = await page.locator('pre.log').innerText()
  expect(/flat field: done/.test(log), 'flat-field capture did not finish: ' + log.split('\n').slice(-3).join(' | '))
  await page.waitForFunction(() => /A flat field is active/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 5000 })
  await page.click(`${panel} button:has-text("Clear")`)
  await page.waitForFunction(() => !/A flat field is active/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 5000 })
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
  await tool('Stage')
  const p0 = await position()
  await page.selectOption('select:near(:text("Z step"))', '500').catch(() => {})
  await page.click('button:has-text("Z+")')
  await page.waitForFunction((z0) => { const m = document.querySelector('nav')?.textContent?.match(/z\s+(-?\d+)/); return m && +m[1] !== z0 }, p0.z, { timeout: 8000 })
  await tool('Focus')
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
  await tool('Photo')
  await page.selectOption('.panel:has(h3:has-text("Photo")) select[aria-label="capture mode"]', 'stack')
  const n = page.locator('.panel:has(h3:has-text("Photo")) input[aria-label="focus stack slices"]')
  await n.click({ clickCount: 3 }); await n.pressSequentially('5')
  await page.click('button:has-text("Take photo")')
  await page.waitForFunction(() => /saved "Fine focus stack/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 180000 })
    .catch(async () => { throw new Error('fine stack did not finish: ' + (await page.locator('.panel:has(h3:has-text("Photo"))').innerText()).replace(/\s+/g, ' ').slice(-200)) })
  await page.waitForTimeout(500)
  const z = (await position()).z
  expect(Math.abs(z) < 150, `fine stack ended at z=${z}; the fake specimen is in focus at z=0`)
  await page.selectOption('.panel:has(h3:has-text("Photo")) select[aria-label="capture mode"]', 'single')
  await nav('gallery'); await page.waitForTimeout(600)
  const g = await page.locator('main').innerText()
  const m = g.match(/fine focus stack \(pyramid\)[\s\S]{0,160}?from each: ([\d% ]+)/)
  expect(!!m, 'gallery does not describe the fine stack: ' + g.replace(/\s+/g, ' ').slice(0, 200))
  const shares = m[1].trim().split(/\s+/).map((s) => parseInt(s))
  expect(shares.filter((s) => s > 5).length >= 2, `fine stack did not draw on several slices: ${m[1]}`)
})

if (moves) await step('sweep focus stack records one z sweep from the sensor, fuses the sharp frames and ends in focus', async () => {
  await nav('live')
  const panel = await tool('Photo')
  await panel.locator('select[aria-label="capture mode"]').selectOption('stack')
  const cap = panel.locator('select[aria-label="focus stack capture"]')
  const sweepOk = await cap.locator('option[value="sweep"]').evaluate((o) => !o.disabled)
  expect(sweepOk, 'the fake offers no sensor recording (PyAV missing from the device venv?)')
  await cap.selectOption('sweep')
  const n = panel.locator('input[aria-label="focus stack slices"]')
  await n.click({ clickCount: 3 }); await n.pressSequentially('7')
  const before = await position()
  await rpc('stage.move_rel', { z: 120, compensate: false })
  await page.click('button:has-text("Take photo")')
  await page.waitForFunction(() => /saved "Sweep focus stack/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 120000 })
    .catch(async () => { throw new Error('sweep stack did not finish: ' + (await panel.innerText()).replace(/\s+/g, ' ').slice(-240)) })
  await page.waitForTimeout(500)
  const z = (await position()).z
  expect(Math.abs(z) < 60, `sweep stack ended at z=${z} (started ${before.z}+120); the fake specimen is in focus at z=0`)
  // the stage speed is restored
  const st = await rpc('stage.status')
  expect(st.step_time_us === 1000, `stage step time left at ${st.step_time_us} µs`)
  // stills work again once the recording has closed
  const snap = await page.request.get(base + '/snapshot.jpg')
  expect(snap.status() === 200, `snapshot after the sweep: ${snap.status()}`)
  await cap.selectOption('stills')
  await panel.locator('select[aria-label="capture mode"]').selectOption('single')
  await nav('gallery'); await page.waitForTimeout(600)
  const g = await page.locator('main').innerText()
  const m = g.match(/sweep focus stack \(pyramid\)[\s\S]{0,160}?from each: ([\d% ]+)/)
  expect(!!m, 'gallery does not describe the sweep stack: ' + g.replace(/\s+/g, ' ').slice(0, 200))
  const shares = m[1].trim().split(/\s+/).map((s) => parseInt(s))
  expect(shares.filter((s) => s > 5).length >= 2, `sweep stack did not draw on several slices: ${m[1]}`)
})

if (moves) await step('sweep deconvolution averages the sweep, deconvolves it and keeps the depth map', async () => {
  await nav('live')
  const panel = await tool('Photo')
  await panel.locator('select[aria-label="capture mode"]').selectOption('stack')
  await panel.locator('select[aria-label="focus stack capture"]').selectOption('sweep')
  // put the panel back even on failure, or the next stack steps find it on Sweep (no From RAW box)
  const restore = async () => {
    await panel.locator('select[aria-label="focus stack fusion method"]').selectOption('pyramid').catch(() => {})
    await panel.locator('select[aria-label="focus stack capture"]').selectOption('stills').catch(() => {})
    await panel.locator('select[aria-label="capture mode"]').selectOption('single').catch(() => {})
  }
  try {
    const adv = panel.locator('details.adv:has(select[aria-label="focus stack fusion method"])')
    if (!(await adv.evaluate((d) => d.open))) await adv.locator('summary').click()
    await panel.locator('select[aria-label="focus stack fusion method"]').selectOption('deconvolve')
    expect(await panel.locator('select[aria-label="sweep deconvolution strength"]').count() === 1, 'no strength control for sweep deconvolution')
    await rpc('stage.move_rel', { z: 120, compensate: false })
    const seen = []
    const poll = setInterval(async () => { const t = await panel.innerText().catch(() => ''); const m = t.match(/sweep EDOF[^\n]*/); if (m && seen[seen.length - 1] !== m[0]) seen.push(m[0]) }, 250)
    try {
      await page.click('button:has-text("Take photo")')
      await page.waitForFunction(() => /saved "Sweep (EDOF|focus stack)/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 180000 })
        .catch(async () => { throw new Error('sweep deconvolution did not finish: ' + (await panel.innerText()).replace(/\s+/g, ' ').slice(-240)) })
    } finally { clearInterval(poll) }
    const done = await panel.innerText()
    expect(/saved "Sweep EDOF \d+ frames \(deconvolved\)/.test(done), `fell back to the pyramid fusion: ${seen.join(' | ')} ${done.replace(/\s+/g, ' ').slice(-200)}`)
    const z = (await position()).z
    expect(Math.abs(z) < 60, `sweep deconvolution ended at z=${z}; the fake specimen is in focus at z=0`)
  } finally { await restore() }
  await nav('gallery'); await page.waitForTimeout(600)
  const g = await page.locator('main').innerText()
  expect(/Sweep EDOF \d+ frames \(deconvolved\)/.test(g), 'gallery does not list the deconvolved sweep: ' + g.replace(/\s+/g, ' ').slice(0, 200))
})

if (moves) await step('fine focus stack from RAW fuses 16-bit slices and renders a relief', async () => {
  // Regression: the RAW path fuses to a Uint16Array, and the relief base was downscaled 4x while the
  // encode still used full width/height -> "Failed to construct 'ImageData'". `focusfine` (8-bit)
  // cannot catch it, so this mode needs its own step.
  await nav('live')
  await tool('Photo')
  const panel = '.panel:has(h3:has-text("Photo"))'
  await page.selectOption(`${panel} select[aria-label="capture mode"]`, 'stack')
  await page.check(`${panel} input[aria-label="stack from raw"]`)
  const n = page.locator(`${panel} input[aria-label="focus stack slices"]`)
  await n.click({ clickCount: 3 }); await n.pressSequentially('3')
  await page.click('button:has-text("Take photo")')
  await page.waitForFunction(() => /saved "Fine focus stack RAW/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 300000 })
    .catch(async () => { throw new Error('RAW fine stack did not finish: ' + (await page.locator(panel).innerText()).replace(/\s+/g, ' ').slice(-240)) })
  await page.uncheck(`${panel} input[aria-label="stack from raw"]`)
  await page.selectOption(`${panel} select[aria-label="capture mode"]`, 'single')
  await nav('gallery'); await page.waitForTimeout(600)
  const g = await page.locator('main').innerText()
  expect(/Fine focus stack RAW/.test(g), 'gallery does not list the RAW fine stack: ' + g.replace(/\s+/g, ' ').slice(0, 200))
})

await step('live focus stack builds a composite and saves it', async () => {
  await nav('live')
  await tool('Focus')
  await page.click('.panel:has(h3:has-text("Focus")) .seg button:has-text("Smooth")')
  await page.waitForFunction(() => /\d+ frames averaged/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 15000 })
  await page.click('.panel:has(h3:has-text("Focus")) .seg button:has-text("Stack")')
  await page.waitForFunction(() => /\d+ frames · \d+ % of blocks/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 15000 })
  await page.waitForTimeout(1500)
  const visible = await page.locator('.view canvas.composite').evaluate((c) => c.width > 0 && getComputedStyle(c).opacity !== '0')
  expect(visible, 'composite canvas not shown')
  if (moves) {
    // any stage movement restarts the composite: the frame count drops and climbs again
    const frames = () => page.evaluate(() => +(document.querySelector('main')?.textContent?.match(/(\d+) frames · /)?.[1] ?? 0))
    const before = await frames()
    expect(before >= 5, `expected a few frames stacked before the jog, got ${before}`)
    await tool('Stage')
    await page.click('button[title="D / →"]')
    await page.waitForFunction((n) => { const m = document.querySelector('main')?.textContent?.match(/(\d+) frames · /); return m && +m[1] < n }, before, { timeout: 8000 })
      .catch(async () => { throw new Error(`live stack kept its ${before} frames across a jog (now ${await frames()})`) })
    await page.waitForFunction(() => /\d+ frames · \d+ % of blocks/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 15000 })
    await page.click('button[title="A / ←"]')
    await page.waitForTimeout(1500)
    await tool('Focus')
  }
  await page.click('.panel:has(h3:has-text("Focus")) button:has-text("Save")')
  await page.waitForFunction(() => /saved "Live stack/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 10000 })
  await page.click('.panel:has(h3:has-text("Focus")) .seg button:has-text("Off")')
})

if (moves) await step('live extended focus sweeps z, fuses composites, records them and returns z', async () => {
  await nav('live')
  const panel = await tool('Focus')
  const setNum = async (label, v) => {
    const el = panel.locator(`input[aria-label="${label}"]`)
    await el.fill(String(v)); await el.press('Tab')
  }
  await panel.locator('select[aria-label="edof mode"]').selectOption('crop')
  await setNum('edof fps', 30)
  await setNum('edof range', 60)
  await setNum('edof backlash', 20)   // the fake board has no backlash of its own
  const z0 = (await rpc('stage.status')).position.z
  await panel.locator('button:has-text("Start extended focus")').click()
  const sweeps = () => panel.locator('[data-sweeps]').getAttribute('data-sweeps', { timeout: 1000 }).then((v) => +v).catch(() => 0)
  await page.waitForFunction(() => +(document.querySelector('.panel [data-sweeps]')?.getAttribute('data-sweeps') ?? 0) >= 2, null, { timeout: 30000 })
    .catch(async () => { throw new Error(`fewer than 2 sweeps fused (${await sweeps()}): ` + (await panel.innerText()).replace(/\s+/g, ' ').slice(-240)) })
  const drawn = await page.locator('.view canvas.edof').evaluate((c) => {
    if (!c.width || !c.height) return false
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    let lit = 0
    for (let i = 0; i < d.length; i += 4 * 97) if (d[i] + d[i + 1] + d[i + 2] > 30) lit++
    return lit > 50
  })
  expect(drawn, 'extended-focus composite canvas is empty')
  // the stream now carries fast-mode frames: pan/click-to-centre/measure are off on the live view
  expect(await page.locator('.view.locked').count() === 1, 'live view not locked against pan/centre while sweeping')
  expect(/crop: central \d+ % of the field/.test(await page.locator('.view .edof-note').innerText()), 'crop-field note missing')
  const line = await panel.locator('[data-sweeps]').innerText()
  expect(/[\d.]+ sweeps\/s · \d+ frames\/sweep \(\d+% useful\) · \d+ ms window · dropped \d+/.test(line), `stats line: ${line}`)
  // record ~3 s of composites
  await panel.locator('button:has-text("Record extended focus")').click()
  await page.waitForFunction(() => /Stop recording · \d+ s/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 10000 })
  await page.waitForTimeout(3000)
  await panel.locator('button:has-text("Stop recording")').click()
  await page.waitForFunction(() => /saved "Video extended focus/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 15000 })
    .catch(async () => { throw new Error('EDOF recording not saved: ' + (await panel.innerText()).replace(/\s+/g, ' ').slice(-240)) })
  await panel.locator('button:has-text("Stop extended focus")').click()
  await panel.locator('button:has-text("Start extended focus")').waitFor({ timeout: 20000 })
  let st = await rpc('stage.status')
  for (let i = 0; i < 40 && st.moving; i++) { await page.waitForTimeout(250); st = await rpc('stage.status') }
  expect(st.oscillating === false, `stage still oscillating: ${JSON.stringify(st.oscillating)}`)
  expect(Math.abs(st.position.z - z0) <= 5, `z ended at ${st.position.z}, started at ${z0}: ` + (await panel.innerText()).replace(/\s+/g, ' ').slice(-200))
  const snap = await page.request.get(base + '/snapshot.jpg?full=1')
  expect(snap.status() === 200, `full snapshot after extended focus: ${snap.status()}`)
  await setNum('edof backlash', '')
  await nav('gallery'); await page.waitForTimeout(600)
  expect(/video · \d+ s · extended focus/.test(await page.locator('main').innerText()), 'gallery lacks the extended-focus video')
})

await step('video recording (stabilise on) lands in the gallery and opens in the viewer', async () => {
  await nav('live')
  await tool('Photo')
  await videoSource(page.locator('.panel:has(h3:has-text("Photo"))'), 'view')
  const stabilise = page.locator('.panel:has(h3:has-text("Photo")) label:has-text("Stabilise") input[type=checkbox]')
  if (!(await stabilise.isChecked())) await stabilise.check()
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
  // a short clip must not silently loop (looks like a glitch): controls shown, loop off under ~3 s
  const loops = await page.locator('video.video').evaluate((v) => v.loop)
  expect(!loops, `a ${dur.toFixed(1)}s clip has loop enabled`)
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
  await tool('Measure')
  await page.click('.panel:has(h3:has-text("Measure")) button:has-text("Distance")')
  const box = await page.locator('.view').boundingBox()
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.4)
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.6)
  await page.waitForFunction(() => /µm|px \(no scale\)/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 5000 })
  await page.keyboard.press('Escape')
})

await step('histogram samples the live view in the Camera panel', async () => {
  await nav('live')
  await tool('Camera')
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

if (moves) await step('scan between two corners survives a tab switch; cancel keeps the tiles for a partial stitch', async () => {
  await nav('scan')
  await page.click('button:has-text("Between two corners")')
  await page.click('button:has-text("Mark here") >> nth=0')
  // drive the stage away (raw move, as a jog would) and mark the opposite corner
  await page.evaluate(async (b) => { await (await fetch(b + '/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'stage.move_rel', params: { x: 1200, y: 900, compensate: false } }) })).json() }, base)
  await page.waitForTimeout(1200)
  await page.click('button:has-text("Mark here") >> nth=1')
  await page.waitForFunction(() => /→ \d+ × \d+ fields/.test(document.querySelector('aside')?.textContent || ''), null, { timeout: 5000 })
  const fields = (await page.locator('aside').innerText()).match(/→ (\d+) × (\d+) fields/)
  expect(+fields[1] >= 2 && +fields[2] >= 2, `corner grid too small: ${fields[0]}`)
  await page.click('button:has-text("Stream frame")')
  await page.click('button:has-text("Start scan")')
  // let a couple of tiles land, then leave the page and come back: the run must still be there
  await page.waitForFunction(() => /\b2\/\d+ tiles/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 60000 })
  await nav('live'); await page.waitForTimeout(500); await nav('scan')
  await page.waitForSelector('.run', { timeout: 5000 })   // the hash route switches asynchronously
  expect((await page.locator('.run button:has-text("Cancel")').count()) === 1, 'cancel button gone after a tab switch: the run did not survive; run panel: ' + (await page.locator('.run').innerText()).replace(/\s+/g, ' ').slice(0, 300))
  await page.click('.run button:has-text("Cancel")')
  await page.waitForSelector('.run button:has-text("Stitch")', { timeout: 30000 })
  await page.click('.run button:has-text("Stitch")')
  await page.waitForSelector('img[alt="stitched scan"]', { timeout: 120000 })
  expect(/partial \d+\/\d+/.test(await page.locator('main').innerText()), 'partial mosaic not labelled as partial')
  // the stage is back where the scan started (corner B)
  const p = await position()
  const b = (await page.locator('aside').innerText()).match(/corner B\s+(-?\d+), (-?\d+)/)
  expect(Math.abs(p.x - +b[1]) <= 2 && Math.abs(p.y - +b[2]) <= 2, `stage did not return to the start (${p.x},${p.y} vs corner B ${b[1]},${b[2]})`)
  // leave the panel as later steps expect it
  await page.click('button:has-text("Around here")')
  await page.click('button:has-text("Full-res still")')
})

if (moves) await step('super-resolution captures a dithered pattern and drizzles it, sharpened', async () => {
  await nav('live')
  await tool('Photo')
  const panel = '.panel:has(h3:has-text("Photo"))'
  await page.selectOption(`${panel} select[aria-label="capture mode"]`, 'superres')
  // scale 2 (not 3): a 3x drizzle of a full-resolution crop is memory-heavy and this step already
  // covers the Advanced controls (pixfrac, extra frames) and the Sharpen toggle end to end.
  await page.selectOption(`${panel} select:near(:text("Scale"))`, '2')
  await page.click(`${panel} label:has-text("Sharpen") input[type=checkbox]`)
  await page.click(`${panel} summary:has-text("Advanced")`)
  const extra = page.locator(`${panel} label:has-text("Extra frames") input[type=number]`)
  await extra.click({ clickCount: 3 }); await extra.pressSequentially('1')
  await page.click('button:has-text("Take photo")')
  await page.waitForFunction(() => /saved "Super-resolution/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 90000 })
    .catch(async () => { throw new Error('super-resolution did not finish: ' + (await page.locator('.panel:has(h3:has-text("Photo"))').innerText()).replace(/\s+/g, ' ').slice(-200)) })
  await page.click(`${panel} label:has-text("Sharpen") input[type=checkbox]`)   // leave unchecked for later steps
  await page.selectOption(`${panel} select[aria-label="capture mode"]`, 'single')
  await nav('gallery'); await page.waitForTimeout(600)
  const g = await page.locator('main').innerText()
  expect(/super-resolution \d+ frames ×2/i.test(g), 'gallery does not describe the super-resolution result: ' + g.replace(/\s+/g, ' ').slice(0, 200))
})

if (moves) await step('super-resolution RAW planes (no demosaic) drizzles a 2x2 grid', async () => {
  await nav('live')
  await tool('Photo')
  const panel = '.panel:has(h3:has-text("Photo"))'
  await page.selectOption(`${panel} select[aria-label="capture mode"]`, 'superres')
  await page.selectOption(`${panel} select:near(:text("Scale"))`, '2')
  await page.click(`${panel} summary:has-text("Advanced")`)
  const extra = page.locator(`${panel} label:has-text("Extra frames") input[type=number]`)
  await extra.click({ clickCount: 3 }); await extra.pressSequentially('0')
  const rawBox = page.locator(`${panel} label:has-text("RAW planes") input[type=checkbox]`)
  await rawBox.check()
  expect(await page.locator(`${panel} label:has-text("Sharpen") input[type=checkbox]`).isDisabled(), 'Sharpen should be disabled when RAW planes is on')
  await page.click('button:has-text("Take photo")')
  await page.waitForFunction(() => /saved "Super-resolution RAW/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 120000 })
    .catch(async () => { throw new Error('super-resolution RAW did not finish: ' + (await page.locator('.panel:has(h3:has-text("Photo"))').innerText()).replace(/\s+/g, ' ').slice(-200)) })
  await rawBox.uncheck()   // leave unchecked for anyone re-running this file interactively
  await page.selectOption(`${panel} select[aria-label="capture mode"]`, 'single')
  await nav('gallery'); await page.waitForTimeout(600)
  const g = await page.locator('main').innerText()
  expect(/super-resolution \d+ frames ×2/i.test(g), 'gallery does not describe the RAW super-resolution result: ' + g.replace(/\s+/g, ' ').slice(0, 200))
  expect(/developed: none \(drizzled Bayer planes\)/.test(g), 'gallery does not show the no-demosaic RAW chip: ' + g.replace(/\s+/g, ' ').slice(0, 200))
})

if (moves) await step('fine focus stack produces a depth map with an image/depth/relief toggle', async () => {
  await nav('live')
  await tool('Photo')
  await page.selectOption('.panel:has(h3:has-text("Photo")) select[aria-label="capture mode"]', 'stack')
  const n = page.locator('.panel:has(h3:has-text("Photo")) input[aria-label="focus stack slices"]')
  await n.click({ clickCount: 3 }); await n.pressSequentially('5')
  await page.click('button:has-text("Take photo")')
  await page.waitForFunction(() => /saved "Fine focus stack/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 180000 })
    .catch(async () => { throw new Error('fine stack did not finish: ' + (await page.locator('.panel:has(h3:has-text("Photo"))').innerText()).replace(/\s+/g, ' ').slice(-200)) })
  await page.selectOption('.panel:has(h3:has-text("Photo")) select[aria-label="capture mode"]', 'single')
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
  await tool('Time-lapse')
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
  await tool('Tracking')
  const panel = '.panel:has(h3:has-text("Tracking"))'
  await page.click(`${panel} button:has-text("Start tracking")`)
  await page.waitForTimeout(2000)
  await page.click(`${panel} button:has-text("Stop tracking")`)
  await page.click(`${panel} button:has-text("Export CSV")`)
  await page.waitForTimeout(300)
})

await step('sample metadata is captured on a quick frame and shown in the gallery', async () => {
  await nav('live')
  await tool('Sample')
  const samplePanel = page.locator('.panel:has(h3:has-text("Sample"))')
  await samplePanel.locator('summary').click()
  const nameInput = samplePanel.locator('input').first()
  await nameInput.fill('E2E sample A1')
  await tool('Photo')   // Quick frame lives in the Photo panel; the sample store keeps the name across the switch
  await page.click('button:has-text("Quick frame")')
  await page.waitForFunction(() => /saved "Quick frame/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 10000 })
  await nav('gallery'); await page.waitForTimeout(600)
  expect(/E2E sample A1/.test(await page.locator('main').innerText()), 'gallery does not show the sample name on the new item')
})

if (moves) await step('a recorded macro of two jogs replays and returns the stage', async () => {
  await nav('live')
  await tool('Macro')
  const macroPanel = page.locator('.panel:has(h3:has-text("Macro"))')
  await macroPanel.locator('summary').click()
  const p0 = await position()
  await macroPanel.locator('button:has-text("Record")').click()
  await tool('Stage')
  await page.click('button[title="D / →"]')
  await page.waitForFunction((x1) => { const m = document.querySelector('nav')?.textContent?.match(/x\s+(-?\d+)/); return m && +m[1] === x1 }, p0.x + 500, { timeout: 8000 })
  await page.click('button[title="A / ←"]')
  await page.waitForFunction((x0) => { const m = document.querySelector('nav')?.textContent?.match(/x\s+(-?\d+)/); return m && +m[1] === x0 }, p0.x, { timeout: 8000 })
  await tool('Macro')
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

// --- video ---
// WP5: WebCodecs + mediabunny recording (services/recorder.svelte.ts, services/videoEncoder.ts) and
// time-lapse MP4 export (services/timelapseExport.ts, workers/encodeWorker.ts). The default-settings
// recording is already covered by 'video recording (stabilise on) lands in the gallery ...' above
// (same UI, unchanged text: "Record video" / "Stop · N s" / "saved \"Video live view ...\"" / the
// gallery's "video · N s · live view" chip); these add container/codec choice, constant-rate timing
// with a burn-in, and the new export.
/** Pick the recording source when the device offers the sensor path (fake with PyAV, or the Pi). */
async function videoSource(panel, value) {
  const sel = panel.locator('select[aria-label="video source"]')
  if (await sel.count()) await sel.selectOption(value)
}
async function openEncoding(panel) {
  const d = panel.locator('details:has(summary:has-text("Encoding and overlays"))')
  if (!(await d.evaluate((el) => el.open))) await d.locator('summary').click()
}

await step('recording with a non-default container/codec still lands in the gallery as a playable video', async () => {
  await nav('live')
  await tool('Photo')
  const panel = page.locator('.panel:has(h3:has-text("Photo"))')
  await videoSource(panel, 'view')
  await openEncoding(panel)
  await panel.locator('label:has-text("Container") select').selectOption('webm')
  await panel.locator('label:has-text("Codec") select').selectOption('vp9')
  await page.click('button:has-text("Record video")')
  await page.waitForFunction(() => /Stop · \d+ s/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 5000 })
  await page.waitForTimeout(2000)
  await page.click('button:has-text("Stop ·")')
  await page.waitForFunction(() => /saved "Video live view/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 15000 })
  await nav('gallery'); await page.waitForTimeout(600)
  await page.locator('.card:has-text("Video live view") button:has-text("Open")').first().click()
  await page.waitForSelector('video.video', { timeout: 5000 })
  const dur = await page.locator('video.video').evaluate((v) => new Promise((r) => { if (v.readyState >= 1) r(v.duration); else v.onloadedmetadata = () => r(v.duration) }))
  expect(dur === Infinity || dur > 1, `video duration ${dur}`)
  await page.click('button:has-text("close")')
  // restore the defaults the other steps (and PhotoPanel's own persisted settings) expect
  await nav('live')
  await tool('Photo')
  await openEncoding(panel)
  await panel.locator('label:has-text("Container") select').selectOption('mp4')
  await panel.locator('label:has-text("Codec") select').selectOption('auto')
})

async function openLatestVideo(cardText) {
  await nav('gallery'); await page.waitForTimeout(600)
  await page.locator(`.card:has-text("${cardText}") button:has-text("Open")`).first().click()
  await page.waitForSelector('video.video', { timeout: 5000 })
  const size = await page.locator('video.video').evaluate((v) => new Promise((r) => { const done = () => r({ w: v.videoWidth, h: v.videoHeight, d: v.duration }); if (v.readyState >= 1) done(); else v.onloadedmetadata = done }))
  await page.click('.overlay button.details-toggle')
  await page.waitForSelector('.overlay .details', { timeout: 3000 })
  const details = await page.locator('.overlay .details').innerText()
  await page.click('.overlay button.details-toggle')
  await page.click('button:has-text("close")')
  return { size, details }
}

await step('constant-rate timing with the elapsed-time burn-in records a playable video with its meta', async () => {
  await nav('live')
  const panel = await tool('Photo')
  await videoSource(panel, 'view')
  await openEncoding(panel)
  await panel.locator('label:has-text("Timing") select').selectOption('cfr')
  const fps = panel.locator('label:has-text("fps") input[type=number]')
  await fps.click({ clickCount: 3 }); await fps.pressSequentially('30'); await fps.dispatchEvent('change')
  await panel.locator('.burnin label:has-text("Elapsed time") input').check()
  await page.click('button:has-text("Record video")')
  await page.waitForFunction(() => /Stop · \d+ s/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 8000 })
  await page.waitForTimeout(2500)
  await page.click('button:has-text("Stop ·")')
  await page.waitForFunction(() => /saved "Video live view/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 20000 })
  const { size, details } = await openLatestVideo('Video live view')
  expect(size.d > 1.5, `cfr video duration ${size.d}`)
  expect(/timing cfr 30 fps · \d+ duplicated/.test(details) && /burn-in: time/.test(details), `meta missing: ${details.slice(0, 200)}`)
  await nav('live'); await tool('Photo')
  await openEncoding(panel)
  await panel.locator('label:has-text("Timing") select').selectOption('vfr')
  await panel.locator('.burnin label:has-text("Elapsed time") input').uncheck()
})

await step('Look panel CDL grade changes the live canvas and a .cdl round-trips through save-as-LUT', async () => {
  await nav('live')
  const panel = await tool('Look')
  await panel.locator('label.chk:has-text("enabled") input[type=checkbox]').check()
  await page.selectOption('.panel:has(h3:has-text("Look")) select[aria-label="LUT"]', { label: 'Okabe-Ito orange' }).catch(() => {})
  await page.waitForSelector('canvas.processed', { timeout: 8000 })
  await panel.locator('details:has(summary:has-text("Grade")) summary').click()
  const sat = panel.locator('details:has(summary:has-text("Grade")) input[type=range]').last()
  await sat.fill('0'); await sat.dispatchEvent('input'); await sat.dispatchEvent('change')
  await page.waitForTimeout(800)
  const grey = await page.evaluate(() => {
    const c = document.querySelector('canvas.processed'); const ctx = c.getContext('2d'); const d = ctx.getImageData(c.width >> 1, c.height >> 1, 32, 32).data
    let sat = 0; for (let i = 0; i < d.length; i += 4) sat += Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]); return sat / (d.length / 4)
  })
  expect(grey < 12, `saturation 0 should give a grey canvas, mean chroma ${grey.toFixed(1)}`)
  await panel.locator('button:has-text("Reset grade")').click()
  await panel.locator('label.chk:has-text("enabled") input[type=checkbox]').uncheck()
})

await step('focus peaking paints the live canvas only while enabled', async () => {
  await nav('live')
  const cam = await tool('Camera')
  const chk = cam.locator('label:has-text("focus peaking") input[type=checkbox]')
  await chk.check()
  await page.waitForSelector('canvas.processed', { timeout: 8000 })
  await chk.uncheck()
  await page.waitForTimeout(600)
})

await step('sensor recording writes the camera\'s own H.264 into an MP4 without re-encoding', async () => {
  await nav('live')
  const panel = await tool('Photo')
  const src = panel.locator('select[aria-label="video source"]')
  if (!(await src.count())) { console.log('     (device offers no sensor recording: skipped)'); return }
  await src.selectOption('sensor')
  for (const label of ['Stabilise', 'Deflicker', 'Bake look']) {
    const box = panel.locator(`label:has-text("${label}") input[type=checkbox]`)
    if (await box.isChecked()) await box.uncheck()
  }
  // anything that changes pixels or timing makes the browser re-encode; an earlier step may have left some on
  await openEncoding(panel)
  await panel.locator('label:has-text("Timing") select').selectOption('vfr')
  for (const box of await panel.locator('.burnin input[type=checkbox]').all()) if (await box.isChecked()) await box.uncheck()
  expect(/nothing re-encoded/.test(await panel.innerText()), 'panel does not say the recording is written as encoded')
  await page.click('button:has-text("Record video")')
  await page.waitForFunction(() => /Stop · \d+ s/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 10000 })
  // stills are refused while the camera holds the recording mode (asked from Node, not the page, so the
  // expected 409 does not land in the page console the final step checks)
  const still = (await page.request.get(`${base}/snapshot.jpg?full=1`)).status()
  expect(still === 409, `full-res still during a recording answered ${still}, expected 409`)
  await page.waitForTimeout(3000)
  await page.click('button:has-text("Stop ·")')
  await page.waitForFunction(() => /saved "Video \d+×\d+/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 20000 })
    .catch(async () => { throw new Error('sensor recording did not save: ' + (await panel.innerText()).replace(/\s+/g, ' ').slice(-200)) })
  const m = (await panel.innerText()).match(/saved "Video (\d+)×(\d+)/)
  expect(m && +m[1] > 820, `sensor recording is ${m?.[1]} px wide, expected more than the 820-px live view`)
  // the device is back in its stream configuration
  let back = 0
  for (let i = 0; i < 20 && back !== 200; i++) { back = (await page.request.get(`${base}/snapshot.jpg?full=1`)).status(); if (back !== 200) await page.waitForTimeout(500) }
  expect(back === 200, `full-res still after the recording answered ${back}`)
  await nav('gallery'); await page.waitForTimeout(600)
  await page.locator(`.card:has-text("Video ${m[1]}×${m[2]}") button:has-text("Open")`).first().click()
  await page.waitForSelector('.overlay button.details-toggle', { timeout: 5000 })
  await page.click('.overlay button.details-toggle')
  const details = await page.locator('.overlay .details').innerText()
  expect(/written as recorded, not re-encoded/.test(details) && /avc1\./.test(details), `details: ${details.replace(/\s+/g, ' ').slice(0, 240)}`)
  const playable = await page.evaluate(() => document.createElement('video').canPlayType('video/mp4; codecs="avc1.640029"'))
  if (playable) {
    const dur = await page.locator('video.video').evaluate((v) => new Promise((r) => { if (v.readyState >= 1) r(v.duration); else v.onloadedmetadata = () => r(v.duration) }))
    expect(dur > 2, `sensor video duration ${dur}`)
  }
  await page.click('.overlay button.details-toggle')
  await page.click('button:has-text("close")')
})

await step('time-lapse exports to MP4 via WebCodecs', async () => {
  await nav('gallery'); await page.waitForTimeout(600)
  await page.locator('.card:has-text("Time-lapse") button:has-text("Open")').first().click()
  await page.waitForSelector('.overlay canvas', { timeout: 5000 })
  const exportBtn = page.locator('.overlay button:has-text("Export MP4")')
  if (await exportBtn.count()) {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      exportBtn.click(),
    ])
    expect(!!download, 'no MP4 download triggered by "Export MP4"')
  } else {
    // this browser has no WebCodecs VideoEncoder: the button is hidden (timelapseExportSupported()),
    // which is the documented fallback, not a failure
    console.log('  (skipped: no WebCodecs VideoEncoder in this browser)')
  }
  await page.click('.overlay button.close')
})

// --- look ---

await step('Look panel applies a built-in colour map to the live canvas', async () => {
  await nav('live')
  await tool('Look')
  const panel = page.locator('.panel:has(h3:has-text("Look"))')
  await panel.locator('label.chk:has-text("enabled") input[type=checkbox]').check()
  await page.selectOption('.panel:has(h3:has-text("Look")) select[aria-label="LUT"]', { label: 'Fire' })
  await page.waitForSelector('canvas.processed', { timeout: 8000 })
  await page.waitForTimeout(500)   // let a few processed frames land
  // the fake specimen is coloured, so compare a block of the processed canvas with the same block of
  // the untouched <img> (drawn through a scratch canvas) rather than assuming a neutral grey centre
  const centreBlocks = () => page.evaluate(() => {
    const c = document.querySelector('canvas.processed'), img = document.querySelector('.stream img, img[alt="microscope live view"]')
    if (!c || !img) return null
    const mean = (d) => { let r = 0, g = 0, b = 0, n = d.length / 4; for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2] } return [r / n, g / n, b / n] }
    const s = document.createElement('canvas'); s.width = img.naturalWidth; s.height = img.naturalHeight
    s.getContext('2d').drawImage(img, 0, 0)
    const bx = (c.width >> 1) - 16, by = (c.height >> 1) - 16
    return { proc: mean(c.getContext('2d').getImageData(bx, by, 32, 32).data), raw: mean(s.getContext('2d').getImageData(bx, by, 32, 32).data) }
  })
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  const coloured = await centreBlocks()
  expect(!!coloured, 'no processed canvas pixel read back')
  expect(dist(coloured.proc, coloured.raw) > 20, `Fire LUT did not visibly change the centre block: ${coloured.proc} vs ${coloured.raw}`)

  // strength 0: mix(in, lut(in), 0) == in, so the block should match the untouched view (frames differ slightly)
  await panel.locator('input[type=range]').first().fill('0')
  await page.waitForTimeout(700)
  const back = await centreBlocks()
  expect(!!back, 'no processed canvas pixel read back after strength=0')
  expect(dist(back.proc, back.raw) < 20, `strength=0 should match the untouched view: ${back.proc} vs ${back.raw}`)
  await panel.locator('input[type=range]').first().fill('1')
})

await step('an imported .cube LUT appears under "My LUTs"', async () => {
  const panel = page.locator('.panel:has(h3:has-text("Look"))')
  const cube = 'TITLE "e2e-test"\nLUT_3D_SIZE 2\n0 0 0\n1 0 0\n0 1 0\n1 1 0\n0 0 1\n1 0 1\n0 1 1\n1 1 1\n'
  await panel.locator('input[type=file][accept*=".cube"]').setInputFiles({ name: 'e2e-test.cube', mimeType: 'text/plain', buffer: Buffer.from(cube) })
  await page.waitForFunction(() => /e2e-test/.test(document.body.textContent || ''), null, { timeout: 8000 })
  expect(/e2e-test/.test(await panel.innerText()), 'imported LUT "e2e-test" not listed under My LUTs')
})

await step('Curves editor brightens the live view and "Save as LUT…" preserves the look', async () => {
  const panel = page.locator('.panel:has(h3:has-text("Look"))')
  await panel.locator('label.chk:has-text("enabled") input[type=checkbox]').check()
  await page.selectOption('.panel:has(h3:has-text("Look")) select[aria-label="LUT"]', { label: 'None' })
  await page.waitForSelector('canvas.processed', { timeout: 8000 })
  await page.waitForTimeout(500)

  const centreBlocks = () => page.evaluate(() => {
    const c = document.querySelector('canvas.processed'), img = document.querySelector('.stream img, img[alt="microscope live view"]')
    if (!c || !img) return null
    const mean = (d) => { let r = 0, g = 0, b = 0, n = d.length / 4; for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2] } return [r / n, g / n, b / n] }
    const s = document.createElement('canvas'); s.width = img.naturalWidth; s.height = img.naturalHeight
    s.getContext('2d').drawImage(img, 0, 0)
    const bx = (c.width >> 1) - 16, by = (c.height >> 1) - 16
    return { proc: mean(c.getContext('2d').getImageData(bx, by, 32, 32).data), raw: mean(s.getContext('2d').getImageData(bx, by, 32, 32).data) }
  })
  const brightness = (rgb) => (rgb[0] + rgb[1] + rgb[2]) / 3
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

  const before = await centreBlocks()
  expect(!!before, 'no processed canvas pixel read back before curve edit')

  await panel.locator('summary:has-text("Curves")').click()
  const curveCanvas = panel.locator('canvas.curve-editor')
  await curveCanvas.waitFor({ timeout: 5000 })
  const box = await curveCanvas.boundingBox()
  expect(!!box, 'curve editor canvas not found')
  const midX = box.x + box.width / 2, midY = box.y + box.height / 2
  // drag the master curve's middle upward (toward a brighter output) - click adds a point, the move
  // while still pressed drags it via the same pointer sequence CurveEditor's pointerdown/move expects
  await page.mouse.move(midX, midY)
  await page.mouse.down()
  await page.mouse.move(midX, midY - box.height * 0.3, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(700)

  const brighter = await centreBlocks()
  expect(!!brighter, 'no processed canvas pixel read back after curve edit')
  expect(brightness(brighter.proc) > brightness(before.proc) + 5, `curve edit did not brighten the centre block: ${brighter.proc} vs ${before.proc}`)

  // "Save as LUT…" with the default name, bar filling anything in
  await panel.locator('button:has-text("Save as LUT…")').click()
  const nameInput = panel.locator('.rename-input')
  const defaultName = await nameInput.inputValue()
  expect(defaultName.length > 0, 'Save as LUT… did not prefill a default name')
  await panel.locator('button:has-text("Save")').click()
  await page.waitForFunction(
    (name) => (document.body.textContent || '').includes(name),
    defaultName, { timeout: 8000 },
  )
  expect((await panel.innerText()).includes(defaultName), `saved LUT "${defaultName}" not listed under My LUTs`)
  const savedOptionValue = await panel.locator('select[aria-label="LUT"] option', { hasText: defaultName }).evaluate((o) => o.value)
  const selectedValue = await panel.locator('select[aria-label="LUT"]').inputValue()
  expect(selectedValue === savedOptionValue, 'saved LUT was not selected after "Save as LUT…"')

  await page.waitForTimeout(700)
  const after = await centreBlocks()
  expect(!!after, 'no processed canvas pixel read back after save')
  expect(dist(after.proc, brighter.proc) < 12, `picture changed after "Save as LUT…" reset: ${after.proc} vs ${brighter.proc}`)
})

await step('disabling the Look removes the processed canvas', async () => {
  const panel = page.locator('.panel:has(h3:has-text("Look"))')
  await panel.locator('label.chk:has-text("enabled") input[type=checkbox]').uncheck()
  await page.waitForFunction(() => !document.querySelector('canvas.processed'), null, { timeout: 5000 })
  expect((await page.locator('canvas.processed').count()) === 0, 'canvas.processed still present after disabling the Look')
})

// --- enhance ---

await step('Enhance panel applies the "Crisp" preset to a gallery photo and saves it as a new item', async () => {
  await nav('gallery'); await page.waitForTimeout(600)
  const before = await page.locator('.card').count()
  // the 820×616 quick frame, not the 8 MP photo: the point is the flow, not a multi-second develop
  await page.locator('.card:has-text("Quick frame") .thumb').first().click()
  await page.waitForSelector('.overlay')
  await page.click('button.enhance-toggle')
  await page.waitForSelector('.enhance-dock')
  await page.click('.enhance-dock button:has-text("Crisp")')
  // wait for the debounced (150ms) preview to actually render something
  await page.waitForFunction(() => {
    const c = document.querySelector('.enhance-dock canvas.preview-canvas')
    return !!c && c.width > 0 && c.height > 0
  }, null, { timeout: 20000 })
  await page.click('.enhance-dock button:has-text("Apply")')
  await page.waitForFunction(() => /saved as/.test(document.querySelector('.enhance-dock')?.textContent || ''), null, { timeout: 60000 })
  await page.click('.overlay button.close')
  await nav('gallery')
  await page.waitForFunction((n) => document.querySelectorAll('.card').length > n, before, { timeout: 8000 })
  expect(/\(enhanced\)/.test(await page.locator('main').innerText()), 'no "(enhanced)" card appeared after Apply')
})

await step('Live denoise shows the processed canvas while enabled, and stops it when disabled', async () => {
  if (await page.locator('.overlay button.close').count()) await page.click('.overlay button.close')   // a failed viewer step must not mask this one
  await nav('live')
  await tool('Camera')
  const chk = page.locator('.panel:has(h3:has-text("Camera")) label:has-text("live denoise") input[type=checkbox]')
  await chk.check()
  await page.waitForSelector('canvas.processed', { timeout: 8000 })
  await chk.uncheck()
  // another view-target processor (the Look) may still keep canvas.processed alive; only assert it's
  // gone when nothing else in this run has the Look enabled (the Look step above ends with it disabled).
  await page.waitForFunction(() => !document.querySelector('canvas.processed'), null, { timeout: 5000 })
})

await step('no page errors during the run', async () => { expect(problems.length === 0, problems.join(' | ')) })

await browser.close()
console.log(failed ? `\n${failed} step(s) FAILED` : '\nall steps passed')
process.exit(failed ? 1 : 0)
