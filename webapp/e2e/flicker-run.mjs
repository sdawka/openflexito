import { chromium } from 'playwright'
const base = process.argv[2] ?? 'http://microscope.local'
const browser = await chromium.launch({ channel: 'chrome', headless: false })
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } })
await page.goto(base, { waitUntil: 'networkidle' }); await page.waitForTimeout(2500)
await page.locator('details.help summary', { hasText: 'Flicker check' }).click()
await page.getByRole('button', { name: /Check for flicker/ }).click()
await page.waitForSelector('ul.res li', { timeout: 15000 }); await page.waitForTimeout(500)
console.log((await page.locator('ul.res li').allTextContents()).join('\n'))
await browser.close()
