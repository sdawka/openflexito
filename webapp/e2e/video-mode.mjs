// Records one video mode against a running device and prints its live status, the saved gallery
// item's video metadata and what the <video> element makes of the file:
//   node e2e/video-mode.mjs <modeId> [baseUrl]      (modeId from services/video/videoModes.ts, e.g. edof)
// A debugging aid for a single mode; the full suite is e2e/app.mjs.
import { chromium } from 'playwright'
const base = process.argv[3] || 'http://127.0.0.1:8099'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 300)))
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.text().slice(0, 300)) })
await page.goto(`${base}/#/live`, { waitUntil: 'load' })
await page.waitForFunction(() => /\d+ fps/.test(document.querySelector('nav')?.textContent || ''), null, { timeout: 15000 })
if (['hdr', 'illum'].includes(process.argv[2] || '')) {
  await page.locator('.tool-rail button[data-tool="camera"]').click()
  await page.locator('.panel:has(h3:has-text("Illumination")) button:has-text("32 %")').click()
  await page.waitForTimeout(500)
}
const btn = page.locator('.tool-rail button[data-tool="photo"]'); await btn.click()
const panel = page.locator('.panel:has(h3:has-text("Photo"))')
const stab = panel.locator('label:has-text("Stabilise") input'); if (await stab.isChecked()) await stab.uncheck()
const mode = process.argv[2] || 'edof'
await panel.locator('select[aria-label="video mode"]').selectOption(mode)
if (mode === 'servo') { const every = panel.locator('label:has-text("Every (s)") input'); await every.click({ clickCount: 3 }); await every.pressSequentially('3'); await every.dispatchEvent('change') }
await page.click('button:has-text("Record video")')
await page.waitForFunction(() => /Stop · \d+ s/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 8000 })
const secs = +(process.env.SECS || 5)
for (let i = 0; i < secs; i++) { await page.waitForTimeout(1000); console.log('status:', (await panel.innerText()).match(/recording[^\n]*/)?.[0]) }
await page.click('button:has-text("Stop ·")')
await page.waitForFunction(() => /saved "Video/.test(document.querySelector('main')?.textContent || ''), null, { timeout: 20000 })
console.log('saved:', (await panel.innerText()).match(/saved[^\n]*/)?.[0])
const item = await page.evaluate(() => new Promise((res) => {
  const req = indexedDB.open('openflexito')
  req.onsuccess = () => { const db = req.result; const t = db.transaction('items').objectStore('items').getAll(); t.onsuccess = () => { const items = t.result.filter((i) => i.kind === 'video').sort((a, b) => a.when < b.when ? 1 : -1); res(items[0]) } }
  req.onerror = () => res({ error: String(req.error) })
}))
console.log(JSON.stringify({ name: item?.name, w: item?.width, h: item?.height, video: item?.video, error: item?.error }, null, 1))
await page.click('nav a[href="#/gallery"]'); await page.waitForTimeout(600)
await page.locator(`.card:has-text("${item.name.slice(0, 20)}") button:has-text("Open")`).first().click()
try {
  await page.waitForSelector('video.video', { timeout: 5000 })
  const info = await page.locator('video.video').evaluate((v) => new Promise((r) => { const done = () => r({ w: v.videoWidth, h: v.videoHeight, d: v.duration, err: v.error?.message }); if (v.readyState >= 1) done(); else { v.onloadedmetadata = done; v.onerror = () => r({ err: v.error?.message ?? 'error' }) } }))
  console.log('video el:', JSON.stringify(info))
} catch (e) { console.log('viewer:', e.message.split('\n')[0]); console.log((await page.locator('.overlay').innerText().catch(() => 'no overlay')).slice(0, 300)) }
await browser.close()
