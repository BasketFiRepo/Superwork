/**
 * Browser check for the Phase 2 surfaces (§24).
 *
 * Signs in as the demo owner and walks Inbox, Meetings, CRM and the Briefing, asserting
 * that each screen renders real rows rather than an empty shell, that keyboard triage
 * works, and that nothing threw in the console on the way.
 *
 * Run against a started app:  BASE_URL=http://localhost:3000 node --import tsx scripts/browser-check.ts
 */
import { chromium, type ConsoleMessage } from 'playwright'

const BASE = process.env['BASE_URL'] ?? 'http://localhost:3000'
const SHOTS = process.env['SHOT_DIR'] ?? null

let failures = 0
const ok = (label: string, condition: boolean, detail = '') => {
  console.log(`  ${condition ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) failures += 1
}

// The pinned Playwright build may not match the browser on this machine; CHROMIUM_PATH
// points the check at whatever Chromium is actually installed.
const executablePath = process.env['CHROMIUM_PATH']
const browser = await chromium.launch(executablePath ? { executablePath } : {})
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })

const errors: string[] = []
// "Failed to load resource" on its own is useless; record what actually failed.
page.on('console', (message: ConsoleMessage) => {
  if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(message.text())
})
page.on('pageerror', (error) => errors.push(String(error)))
page.on('response', (response) => {
  if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`)
})

try {
  console.log('\nSuperwork — Phase 2 browser check\n')

  await page.goto(`${BASE}/login`)
  await page.fill('input[name="email"]', 'maya@northwind.example')
  await page.fill('input[name="password"]', 'superwork')
  await page.click('button[type="submit"]')
  await page.waitForURL(/\/(today|briefing|agent)?$/, { timeout: 15_000 }).catch(() => undefined)
  ok('Signed in', !page.url().includes('/login'), page.url())

  // ---- Inbox --------------------------------------------------------------
  await page.goto(`${BASE}/inbox`)
  await page.waitForSelector('[data-testid="inbox-row"]', { timeout: 15_000 })
  const rows = await page.locator('[data-testid="inbox-row"]').count()
  ok('Inbox renders the triage queue', rows > 0, `${rows} threads`)

  await page.keyboard.press('j')
  const selected = page.locator('[data-testid="inbox-row"][data-selected="true"]')
  ok('Keyboard moves the selection', (await selected.count()) === 1)
  const selectedSubject = (await selected.first().innerText()).split('\n')[1] ?? ''

  await page.keyboard.press('?')
  ok('The shortcut sheet opens', await page.locator('[data-testid="shortcut-help"]').isVisible())
  await page.keyboard.press('Escape')

  await page.keyboard.press('e')
  await page.waitForTimeout(800)
  const afterArchive = await page.locator('[data-testid="inbox-row"]').count()
  ok('Archiving removes the row optimistically', afterArchive === rows - 1, `${rows} → ${afterArchive}`)
  const remaining = await page.locator('[data-testid="inbox-row"]').allInnerTexts()
  ok(
    'The row that left the queue is the one that was selected',
    selectedSubject.length > 0 && !remaining.some((text) => text.includes(selectedSubject)),
    selectedSubject,
  )
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/inbox.png`, fullPage: true })

  // Put it back, so running the check twice does not quietly drain the demo queue.
  await page.goto(`${BASE}/inbox?view=archived`)
  await page.waitForSelector('[data-testid="inbox-row"]', { timeout: 15_000 })
  const archivedRow = page.locator('[data-testid="inbox-row"]', { hasText: selectedSubject }).first()
  ok('The archived thread is in the archive', (await archivedRow.count()) > 0)
  await archivedRow.click()
  await page.keyboard.press('e')
  await page.waitForTimeout(800)
  await page.goto(`${BASE}/inbox`)
  await page.waitForSelector('[data-testid="inbox-row"]', { timeout: 15_000 })
  ok(
    'Unarchiving returns it to the queue',
    (await page.locator('[data-testid="inbox-row"]').count()) === rows,
    `${afterArchive} → ${await page.locator('[data-testid="inbox-row"]').count()}`,
  )

  // ---- Meetings -----------------------------------------------------------
  await page.goto(`${BASE}/meetings`)
  await page.waitForSelector('[data-testid="meeting-row"]', { timeout: 15_000 })
  ok('Meetings list renders', (await page.locator('[data-testid="meeting-row"]').count()) > 0)
  const recorded = page.locator('[data-testid="meeting-row"]', { hasText: 'attached' }).first()
  ok('At least one meeting has a transcript', (await recorded.count()) > 0)
  await recorded.locator('a').first().click()
  await page.waitForSelector('[data-testid="transcript-segment"]', { timeout: 15_000 })
  const anchors = await page.locator('[data-testid="segment-anchor"]').count()
  ok('The transcript renders with timestamp anchors', anchors > 0, `${anchors} anchors`)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/meeting.png`, fullPage: true })

  // ---- CRM ----------------------------------------------------------------
  await page.goto(`${BASE}/companies`)
  await page.waitForSelector('[data-testid="company-row"]', { timeout: 15_000 })
  ok('Companies list renders', (await page.locator('[data-testid="company-row"]').count()) > 0)
  await page.locator('[data-testid="company-row"] a').first().click()
  await page.getByRole('button', { name: 'Summarize' }).first().click()
  await page.waitForSelector('[data-testid="relationship-fact"]', { state: 'attached', timeout: 20_000 })
  const facts = await page.locator('[data-testid="relationship-fact"]').count()
  const cited = await page.locator('[data-testid="relationship-fact"] [data-testid="fact-source"]').count()
  ok('The 360° view renders facts', facts > 0, `${facts} facts`)
  ok('Every fact carries its source', cited === facts, `${cited}/${facts} cited`)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/company.png`, fullPage: true })

  // ---- Briefing -----------------------------------------------------------
  await page.goto(`${BASE}/briefing`)
  // On a freshly seeded org the worker has not run yet, so the empty state offers to
  // compute it now — that path is part of what is being checked.
  const generate = page.getByRole('button', { name: 'Generate it now' })
  if (await generate.count()) {
    await generate.click()
    await page.waitForTimeout(2500)
  }
  await page.waitForSelector('[data-testid="briefing"]', { timeout: 20_000 })
  const briefing = await page.locator('[data-testid="briefing"]').innerText()
  ok('The briefing renders', briefing.length > 40)
  ok('The briefing states the basis of its figures', /as of/i.test(briefing))
  ok('The briefing recommends one action', (await page.locator('[data-testid="briefing-action"]').count()) > 0)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/briefing.png`, fullPage: true })

  ok('No console errors on any screen', errors.length === 0, errors.slice(0, 3).join(' | '))
} catch (error) {
  failures += 1
  console.error('\n', error)
} finally {
  await browser.close()
}

console.log(failures === 0 ? '\nBrowser check passed.\n' : `\n${failures} browser checks failed.\n`)
process.exitCode = failures === 0 ? 0 : 1
