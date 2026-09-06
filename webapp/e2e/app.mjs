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

await step('snapshot lands in the gallery', async () => {
  await nav('gallery'); await page.waitForTimeout(500)
  const before = await page.locator('.card').count()
  await nav('live')
  await page.click('button:has-text("Snapshot")')
  await page.waitForTimeout(1500)
  await nav('gallery')
  await page.waitForFunction((n) => document.querySelectorAll('.card').length > n, before, { timeout: 8000 })
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

await step('no page errors during the run', async () => { expect(problems.length === 0, problems.join(' | ')) })

await browser.close()
console.log(failed ? `\n${failed} step(s) FAILED` : '\nall steps passed')
process.exit(failed ? 1 : 0)
