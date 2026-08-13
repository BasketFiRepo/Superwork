/**
 * Browser check for the Phase 2 and Phase 3 surfaces (§24).
 *
 * Signs in as the demo owner and walks Inbox, Meetings, CRM, the Briefing, the AI ledger,
 * the personal record, the agent studio and the API screen — asserting that each renders
 * real rows rather than an empty shell, that keyboard triage works, and that nothing threw
 * in the console on the way.
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
  console.log('\nSuperwork — browser check\n')

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

  // ---- AI ledger ----------------------------------------------------------
  await page.goto(`${BASE}/analytics`)
  await page.waitForSelector('[data-testid="ledger-totals"]', { timeout: 20_000 })
  const totals = await page.locator('[data-testid="ledger-totals"]').innerText()
  // Labels are upper-cased by the stylesheet, and innerText reflects that.
  ok('The ledger renders totals', /runs/i.test(totals) && /cost/i.test(totals))
  ok('It states the basis of its figures', /agent runs, citations, tool calls/i.test(totals))
  const departments = await page.locator('[data-testid="ledger-department"]').count()
  ok('It breaks down by department', departments > 0, `${departments} departments`)
  ok(
    'Every figure opens the runs behind it',
    (await page.locator('[data-testid="ledger-drilldown"]').count()) > 0,
  )
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ledger.png`, fullPage: true })

  // ---- Personal record ----------------------------------------------------
  await page.goto(`${BASE}/me`)
  await page.waitForSelector('[data-testid="tracked"]', { timeout: 15_000 })
  const trackedRows = await page.locator('[data-testid="tracked-row"]').count()
  ok('The personal record lists what is held', trackedRows > 0, `${trackedRows} categories`)
  ok('It lists disclosures', (await page.locator('[data-testid="disclosures"]').count()) === 1)
  const never = await page.locator('[data-testid="never-collected"]').innerText()
  ok('It states what is never collected', /productivity score/i.test(never) && /keystrokes/i.test(never))

  const disclosuresBefore = await page.locator('[data-testid="disclosure-row"]').count()
  await page.locator('[data-testid="export-record"]').click()
  await page.waitForTimeout(2000)
  await page.reload()
  await page.waitForSelector('[data-testid="tracked"]', { timeout: 15_000 })
  const disclosuresAfter = await page.locator('[data-testid="disclosure-row"]').count()
  ok(
    'Downloading your own record is itself recorded',
    disclosuresAfter > disclosuresBefore,
    `${disclosuresBefore} → ${disclosuresAfter}`,
  )
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/me.png`, fullPage: true })

  // ---- Agent studio -------------------------------------------------------
  await page.goto(`${BASE}/settings/agents`)
  await page.waitForSelector('[data-testid="agent-row"]', { timeout: 15_000 })
  const agents = await page.locator('[data-testid="agent-row"]').count()
  ok('The studio lists personas', agents > 0, `${agents} agents`)
  await page.locator('[data-testid="agent-row"] a').first().click()
  await page.waitForSelector('[data-testid="agent-config"]', { timeout: 15_000 })
  ok('A persona opens with its configuration', (await page.locator('[data-testid="agent-config"]').count()) === 1)
  ok('It shows its history', (await page.locator('[data-testid="agent-history"]').count()) === 1)
  ok('It shows what it reported to its owner', (await page.locator('[data-testid="digests"]').count()) === 1)
  await page.locator('[data-testid="simulate"]').click()
  await page.waitForSelector('[data-testid="simulation"]', { timeout: 60_000 })
  const simulation = await page.locator('[data-testid="simulation"]').innerText()
  ok('Simulating says plainly that nothing was executed', /Nothing was executed/i.test(simulation))
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/studio.png`, fullPage: true })

  // ---- Integrations and API ----------------------------------------------
  await page.goto(`${BASE}/settings/integrations`)
  await page.waitForSelector('[data-testid="connection-row"]', { timeout: 15_000 })
  const capabilities = await page.locator('[data-testid="connection-row"]').count()
  ok('Integrations lists capabilities, not vendors', capabilities >= 5, `${capabilities} capabilities`)

  await page.goto(`${BASE}/settings/api`)
  await page.waitForSelector('[data-testid="issue-key"]', { timeout: 15_000 })
  ok('The API screen offers to issue a key', (await page.locator('[data-testid="issue-key"]').count()) === 1)

  ok('No console errors on any screen', errors.length === 0, errors.slice(0, 3).join(' | '))
} catch (error) {
  failures += 1
  console.error('\n', error)
} finally {
  await browser.close()
}

console.log(failures === 0 ? '\nBrowser check passed.\n' : `\n${failures} browser checks failed.\n`)
process.exitCode = failures === 0 ? 0 : 1
