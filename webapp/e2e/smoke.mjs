import { chromium } from 'playwright'
const base = process.argv[2] || 'http://microscope.local'
const out = '/private/tmp/claude-501/-Users-sdawka-Code-openflexito/425cadeb-e094-4199-9803-73bfbf77df7a/scratchpad/shots'
const browser = await chromium.launch(process.env.CHROME_EXE ? { executablePath: process.env.CHROME_EXE, headless: true } : { channel: 'chrome', headless: true })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
const errors = []
let total = 0
page.on('console', m => { if (['error','warning'].includes(m.type())) errors.push(`[console.${m.type()}] ${m.text().slice(0,300)}`) })
page.on('pageerror', e => errors.push(`[pageerror] ${e.message.slice(0,300)}`))
page.on('requestfailed', r => errors.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`))
for (const tab of ['live','calibrate','scan','gallery','settings']) {
  await page.goto(`${base}/#/${tab}`, { waitUntil: 'load' })
  await page.waitForTimeout(3500)
  await page.screenshot({ path: `${out}/${tab}.png` })
  const text = await page.evaluate(() => document.querySelector('main')?.innerText?.slice(0, 600) || '(no main)')
  console.log(`\n===== ${tab} =====\n${text}`)
  total += errors.length; console.log('errors so far:', errors.length); for (const e of errors.splice(0)) console.log('  ', e)
}
await browser.close()
if (total) { console.log(`\n${total} problem(s)`); process.exit(1) }
