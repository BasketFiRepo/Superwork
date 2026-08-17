/**
 * Browser check for the Phase 2, Phase 3 and Phase 4 surfaces, plus workflow authoring,
 * approve-with-edits and custom tools (§24).
 *
 * Signs in as the demo owner and walks Inbox, Meetings, CRM, the Briefing, the AI ledger,
 * the personal record, the agent studio, the API screen and the retention screen —
 * asserting that each renders real rows rather than an empty shell, that keyboard triage
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
// "Failed to load resource" on its own is useless; record what actually failed. The screen
// goes on the record too: a minified React error with no location is not something anybody
// can act on, and this walks thirty of them.
const where = () => page.url().replace(BASE, '') || '/'
page.on('console', (message: ConsoleMessage) => {
  if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) {
    errors.push(`${message.text()} (on ${where()})`)
  }
})
page.on('pageerror', (error) => errors.push(`${String(error)} (on ${where()})`))
// A check that deliberately exercises a refusal will see the 4xx that proves it worked.
// Those are announced rather than counted as breakage.
let expectingRefusal = false
page.on('response', (response) => {
  // While a check is deliberately exercising a refusal, any 4xx is the proof it worked.
  if (response.status() >= 400 && !(expectingRefusal && response.status() < 500)) {
    errors.push(`${response.status()} ${response.url()}`)
  }
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

  // ---- A follow-up on a thread --------------------------------------------
  // `create_follow_up@v1` promised one "resurfaces if no reply arrives" and nothing read
  // the table, so every follow-up the agent ever recorded was still open and invisible.
  // A queue row opens on double-click, the way it does for somebody triaging by keyboard.
  await page.locator('[data-testid="inbox-row"]').first().dblclick()
  await page.waitForSelector('[data-testid="follow-ups"]', { timeout: 15_000 })
  const followUpText = await page.locator('[data-testid="follow-ups"]').innerText()
  ok('A thread can carry a follow-up, and says what one does',
    /closes itself if they write back/i.test(followUpText) || /Nothing is sent to the customer/i.test(followUpText))
  await page.locator('[data-testid="follow-up-add"]').click()
  await page.waitForSelector('[data-testid="follow-up-editor"]', { timeout: 15_000 })
  ok('Nothing is recorded without a date and a reason',
    await page.locator('[data-testid="follow-up-confirm"]').isDisabled())
  await page.fill('#follow-up-due', '2026-09-01')
  await page.fill('#follow-up-reason', 'Chase the signed addendum if they have not sent it.')
  await page.locator('[data-testid="follow-up-confirm"]').click()
  const followUpLanded = await page
    .waitForFunction(
      () => /signed addendum/i.test(document.querySelector('[data-testid="follow-ups"]')?.textContent ?? ''),
      undefined,
      { timeout: 20_000 },
    )
    .then(() => true, () => false)
  ok('A follow-up lands on the thread with what it is for', followUpLanded)
  await page.locator('[data-testid="follow-up-done"]').first().click()
  const followUpClosed = await page
    .waitForFunction(
      () => /dealt with/i.test(document.querySelector('[data-testid="follow-ups"]')?.textContent ?? ''),
      undefined,
      { timeout: 20_000 },
    )
    .then(() => true, () => false)
  ok('And closing one says how it ended, rather than removing the row', followUpClosed)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/follow-ups.png`, fullPage: true })

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

  // ---- Watchers on their own cadences -------------------------------------
  await page.goto(`${BASE}/insights`)
  await page.waitForSelector('[data-testid="watcher-schedules"]', { timeout: 15_000 })
  const watcherRows = await page.locator('[data-testid="watcher-row"]').count()
  ok('Every watcher shows the cadence it runs on', watcherRows >= 6, `${watcherRows} watchers`)
  const watcherText = await page.locator('[data-testid="watcher-schedules"]').innerText()
  ok('The cadences differ from one another', /every weekday at 08:00/i.test(watcherText) && /every Monday/i.test(watcherText))
  ok('An interval reads as an interval rather than a truncated list', /every 4 hours/i.test(watcherText))

  await page.locator('[data-testid="watcher-row"] button', { hasText: 'Re-time' }).first().click()
  await page.waitForSelector('[data-testid="watcher-editor"]', { timeout: 15_000 })
  await page.fill('#watcher-cron', '@daily')
  await page.getByRole('button', { name: 'Show me the next three' }).click()
  await page.waitForSelector('[data-testid="watcher-preview"]', { timeout: 15_000 })
  ok('Re-timing one previews before it saves',
    /every day at 00:00/i.test(await page.locator('[data-testid="watcher-preview"]').innerText()))
  await page.getByRole('button', { name: 'Cancel' }).first().click()

  // A watcher with nothing to judge says so rather than showing a rate over no ratings.
  ok('A watcher that has found nothing yet says so, rather than scoring itself',
    /Nothing found yet/.test(watcherText))

  // Dismissing asks why, and says what each answer will do — the card used to ask into a
  // table nothing read. The watchers are run first so this is asserted against a real card
  // rather than skipped on a demo that happens to have no insights open.
  await page.getByRole('button', { name: 'Check for new insights' }).click()
  const raised = await page
    .waitForSelector('button:has-text("Dismiss")', { timeout: 30_000 })
    .then(() => true, () => false)
  ok('Running the watchers raises something to act on', raised)
  if (raised) {
    await page.locator('button', { hasText: 'Dismiss' }).first().click()
    const reasons = await page.locator('main').innerText()
    ok('Dismissing asks why, and says what each answer changes',
      /Why are you dismissing this\?/i.test(reasons) && /already handled/i.test(reasons))
    await page.getByRole('button', { name: 'Cancel' }).first().click()

    // And now that a watcher has found something, its row carries a verdict from what
    // people have said about it — "not enough ratings to judge" until they have.
    await page.reload()
    await page.waitForSelector('[data-testid="watcher-verdict"]', { timeout: 15_000 })
    const judged = await page.locator('[data-testid="watcher-verdict"]').first().innerText()
    ok('A watcher that has found something carries a verdict from what people said',
      /not enough ratings to judge|worth having|muted|late|wrong people/i.test(judged),
      judged.split('\n')[0] ?? '')
  }
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/watchers.png`, fullPage: true })

  // ---- Reminders ----------------------------------------------------------
  // The ladder's last two rungs are declared in-app and there was no in-app anything; every
  // delivery wrote a notification nothing read. This is where they arrive now.
  await page.goto(`${BASE}/reminders`)
  await page.waitForSelector('[data-testid="reminders-open"]', { timeout: 15_000 })
  const remindersText = await page.locator('main').innerText()
  ok('Reminders says how often you can be contacted at all',
    /times a day in total/i.test(remindersText) && /cannot be raised by configuration/i.test(remindersText))
  ok('And that nobody else can read the page',
    /Nobody but you can read this page/i.test(remindersText))
  ok('Notifications have somewhere to arrive',
    (await page.locator('[data-testid="notifications"]').count()) === 1)

  // The preferences the briefing scheduler has read since Phase 2, which nothing could set.
  await page.waitForSelector('[data-testid="notification-preferences"]', { timeout: 15_000 })
  await page.selectOption('#briefing-hour', '6')
  await page.locator('[data-testid="preferences-save"]').click()
  const prefsSaved = await page
    .waitForFunction(
      () => /the next briefing follows this/i.test(document.querySelector('main')?.textContent ?? ''),
      undefined,
      { timeout: 20_000 },
    )
    .then(() => true, () => false)
  ok('When you hear from it is something you can set', prefsSaved)
  ok('And what is stored but not yet honoured says so rather than pretending',
    /Coming soon/i.test(await page.locator('[data-testid="notification-preferences"]').innerText()))
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/reminders.png`, fullPage: true })

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

  // ---- Agent queue --------------------------------------------------------
  await page.goto(`${BASE}/settings/queue`)
  await page.waitForSelector('[data-testid="quotas"]', { timeout: 15_000 })
  const quotaRows = await page.locator('[data-testid="quota-row"]').count()
  ok('The queue screen lists every department', quotaRows > 0, `${quotaRows} departments`)
  const health = await page.locator('[data-testid="queue-health"]').innerText()
  ok('It measures the wait against the budget', /p95/i.test(health) && /2000 ms/.test(health))

  // ---- Jurisdiction review ------------------------------------------------
  await page.goto(`${BASE}/settings/compliance`)
  await page.waitForSelector('[data-testid="review"]', { timeout: 15_000 })
  const findings = await page.locator('[data-testid="finding"]').count()
  ok('The works-council review answers every question', findings >= 10, `${findings} findings`)
  const reviewText = await page.locator('[data-testid="review"]').innerText()
  ok('Each answer carries evidence', /constraint/i.test(reviewText))
  ok('It names the profile it reviewed against', /works council/i.test(reviewText))
  ok('It can answer who changed a jurisdiction profile and why',
    /every change to a jurisdiction profile/i.test(reviewText))

  await page.waitForSelector('[data-testid="jurisdiction-history"]', { timeout: 15_000 })
  ok('And the history is on the screen, not just in the answer',
    /written by the database/i.test(await page.locator('[data-testid="history-note"]').innerText()))
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/compliance.png`, fullPage: true })

  // ---- Workflow authoring -------------------------------------------------
  await page.goto(`${BASE}/workflows`)
  await page.waitForSelector('[data-testid="workflow-composer"]', { timeout: 15_000 })
  await page.fill(
    '#workflow-description',
    'Every weekday at 9, find customer threads with no reply for 3 days and draft a follow-up.',
  )
  await page.locator('[data-testid="workflow-compile"]').click()
  await page.waitForSelector('[data-testid="workflow-readback"]', { timeout: 20_000 })
  const readback = await page.locator('[data-testid="workflow-readback"]').innerText()
  ok('A sentence compiles to a graph', (await page.locator('[data-testid="workflow-node"]').count()) >= 4)
  ok('It reads the graph back in plain English', /every weekday/i.test(readback) && /approve/i.test(readback))
  ok('It shows the risk it found', (await page.locator('[data-testid="workflow-risk"]').count()) > 0)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/workflow-compose.png`, fullPage: true })

  await page.locator('[data-testid="workflow-save"]').click()
  await page.waitForURL(/\/workflows\/[0-9a-f-]{36}/, { timeout: 20_000 })
  await page.waitForSelector('[data-testid="workflow-activate"]', { timeout: 15_000 })
  ok('Activation is disabled until a dry run has passed',
    await page.locator('[data-testid="workflow-activate"]').isDisabled())

  await page.locator('[data-testid="workflow-dry-run"]').click()
  await page.waitForSelector('[data-testid="workflow-outcome"]', { timeout: 60_000 })
  const outcome = await page.locator('[data-testid="workflow-outcome"]').innerText()
  ok('The dry run says how often it would have fired', /would have fired \d+ times/i.test(outcome))
  ok('And that nothing happened', /nothing was created, drafted or sent/i.test(outcome))
  await page.waitForSelector('[data-testid="workflow-activate"]:not([disabled])', { timeout: 15_000 })
  ok('Activation opens once it has passed', true)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/workflow-dryrun.png`, fullPage: true })

  // Activating and running it is what produces something to approve, so the next check
  // has a real card in front of it rather than a fixture.
  await page.locator('[data-testid="workflow-activate"]').click()
  await page.getByRole('button', { name: 'Run it now' }).waitFor({ timeout: 20_000 })
  await page.waitForSelector('[data-testid="workflow-schedule"]', { timeout: 15_000 })
  const scheduleText = await page.locator('[data-testid="workflow-schedule"]').innerText()
  ok('Activating puts it on the clock', /every weekday at 09:00/i.test(scheduleText), scheduleText.split('\n')[0])
  ok('The schedule names the timezone it is evaluated in', /Europe\/London|UTC/.test(scheduleText))

  // An alias, typed by a person, through the same rules as anything else.
  await page.locator('[data-testid="change-schedule"]').click()
  await page.waitForSelector('[data-testid="schedule-editor"]', { timeout: 15_000 })
  expectingRefusal = true
  await page.fill('#schedule-cron', '@reboot')
  await page.getByRole('button', { name: 'Show me the next three' }).click()
  const refusal = page.locator('[data-testid="schedule-editor"] [role="alert"]')
  await refusal.waitFor({ timeout: 15_000 }).catch(() => undefined)
  const refusalText = (await refusal.count()) ? await refusal.innerText() : '(no message shown)'
  ok('A schedule that is not a promise about a time is refused with the reason',
    /not a schedule/i.test(refusalText), refusalText.slice(0, 90))
  expectingRefusal = false

  await page.fill('#schedule-cron', '@daily')
  await page.getByRole('button', { name: 'Show me the next three' }).click()
  await page.waitForSelector('[data-testid="schedule-preview"]', { timeout: 15_000 })
  const previewText = await page.locator('[data-testid="schedule-preview"]').innerText()
  ok('@daily previews as three real dates before anything is saved',
    /every day at 00:00/i.test(previewText) && previewText.split('\n').length >= 4, previewText.split('\n')[0])

  await page.locator('[data-testid="save-schedule"]').click()
  await page.waitForSelector('[data-testid="schedule-editor"]', { state: 'detached', timeout: 15_000 })
  await page.waitForFunction(
    () => /every day at 00:00/i.test(document.querySelector('[data-testid="workflow-schedule"]')?.textContent ?? ''),
    undefined,
    { timeout: 15_000 },
  )
  ok('Saving an alias stores a schedule described the same way as any other', true)
  await page.getByRole('button', { name: 'Run it now' }).click()
  // The panel already holds the dry-run result, so wait for the text to change rather
  // than for the element to appear.
  await page
    .locator('[data-testid="workflow-outcome"]')
    .getByText(/stopped for approval|applied \d+ change/i)
    .waitFor({ timeout: 60_000 })
    .catch(() => undefined)
  const ranText = await page.locator('[data-testid="workflow-outcome"]').innerText()
  ok('A real run stops for a person', /stopped for approval/i.test(ranText), ranText.slice(0, 160))

  // ---- Approve with edits -------------------------------------------------
  await page.goto(`${BASE}/approvals`)
  const editButton = page.locator('[data-testid="approve-with-edits"]').first()
  if (await editButton.count()) {
    await editButton.click()
    await page.waitForSelector('[data-testid="editable-field"]', { timeout: 15_000 })
    ok('An approval can be corrected in place', (await page.locator('[data-testid="editable-field"]').count()) > 0)
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/approval-edit.png`, fullPage: true })
  } else {
    ok('An approval can be corrected in place', false, 'no pending approval offered an editable field')
  }

  // ---- Custom tools, and step-up ------------------------------------------
  await page.goto(`${BASE}/settings/tools`)
  await page.waitForSelector('[data-testid="reviewed-hosts"]', { timeout: 15_000 })
  const toolsText = await page.locator('main').innerText()
  ok('Custom tools explains the rule it enforces', /same permission check/i.test(toolsText))
  ok('It says outbound HTTP is simulated here', /simulated/i.test(toolsText))
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/custom-tools.png`, fullPage: true })

  // Reviewing a host is irreversible enough to need fresh proof of identity (§4.1). The
  // 401 that triggers the prompt is expected, not breakage.
  expectingRefusal = true
  await page.fill('input[placeholder="erp.example.com"]', 'erp.northwind.example')
  await page.fill('input[placeholder^="Our order system"]', 'Order system, read-only.')
  await page.getByRole('button', { name: 'Review this host' }).click()
  await page.waitForSelector('[data-testid="step-up"]', { timeout: 15_000 })
  const stepUpText = await page.locator('[data-testid="step-up"]').innerText()
  ok('An irreversible change asks you to confirm it is still you', /confirm your password/i.test(stepUpText))
  ok('And says why, and for how long', /cannot be undone/i.test(stepUpText) && /five minutes/i.test(stepUpText))

  await page.fill('#step-up-password', 'not-the-password')
  await page.locator('[data-testid="step-up-confirm"]').click()
  await page.waitForSelector('[data-testid="step-up"] [role="alert"]', { timeout: 15_000 })
  ok('A wrong password is refused',
    /not right/i.test(await page.locator('[data-testid="step-up"] [role="alert"]').innerText()))

  await page.fill('#step-up-password', 'superwork')
  await page.locator('[data-testid="step-up-confirm"]').click()
  expectingRefusal = false
  // Confirming replays the held action, so the host appears without pressing again.
  await page
    .locator('[data-testid="reviewed-hosts"]')
    .getByText('erp.northwind.example')
    .first()
    .waitFor({ timeout: 20_000 })
    .catch(() => undefined)
  const hostsText = await page.locator('[data-testid="reviewed-hosts"]').innerText()
  ok('Confirming carries out the action you asked for, without asking again',
    /erp\.northwind\.example/.test(hostsText))
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/step-up.png`, fullPage: true })

  // ---- AI governance: the two ceilings the refusals point at ---------------
  // The agent's own denial says "An admin can add it in Settings → AI governance", and that
  // screen listed the grants with no control on it.
  //
  // Deliberately after the custom-tools section: step-up lasts five minutes, so a beat that
  // confirms a password earlier would leave the next one with nothing to prove.
  await page.goto(`${BASE}/settings/ai-governance`)
  await page.waitForSelector('[data-testid="monitoring-policy"]', { timeout: 15_000 })
  const governanceText = await page.locator('[data-testid="monitoring-policy"]').innerText()
  ok('The monitoring policy says what it may only tighten',
    /can only be tightened/i.test(governanceText) && /never the other way round/i.test(governanceText))
  ok('And states what no setting can turn on',
    /Refused by the database, not by a setting/i.test(governanceText) &&
      /productivity scoring/i.test(governanceText))

  await page.fill('#nudge-budget', '1')
  await page.fill('#monitoring-reason', 'Works council asked for a quieter cadence.')
  await page.locator('[data-testid="monitoring-save"]').click()
  const tightened = await page
    .waitForFunction(
      () =>
        /quieter cadence/i.test(document.querySelector('[data-testid="monitoring-policy"]')?.textContent ?? ''),
      undefined,
      { timeout: 20_000 },
    )
    .then(() => true, () => false)
  ok('Tightening it lands, and says who set it and why', tightened)

  // A grant is the other ceiling, and changing it asks for the password again.
  await page.locator('[data-testid="grant-add"]').click()
  await page.waitForSelector('[data-testid="grant-editor"]', { timeout: 15_000 })
  ok('Nothing is granted without a reason',
    await page.locator('[data-testid="grant-confirm"]').isDisabled())
  await page.fill('#grant-capability', 'email')
  await page.fill('#grant-pattern', 'email:send')
  await page.selectOption('#grant-effect', 'deny')
  await page.fill('#grant-reason', 'Nothing leaves this company without a person pressing send.')
  await page.locator('[data-testid="grant-confirm"]').click()
  // Whether the password is asked for again depends on how recently it was: the custom-tools
  // beat above confirms one, and a confirmation lasts five minutes. That the change *needs*
  // one is asserted in tests/security/governance-controls.test.ts, where the clock is ours.
  const grantStepUp = page.locator('[data-testid="step-up"]')
  if (await grantStepUp.waitFor({ timeout: 5_000 }).then(() => true, () => false)) {
    await page.fill('#step-up-password', 'superwork')
    await page.locator('[data-testid="step-up-confirm"]').click()
  }
  const granted = await page
    .waitForFunction(
      () => /email:send/i.test(document.querySelector('[data-testid="agent-grants"]')?.textContent ?? ''),
      undefined,
      { timeout: 20_000 },
    )
    .then(() => true, () => false)
  ok('And the line lands once they confirm', granted)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/ai-governance.png`, fullPage: true })

  // ---- Retention and erasure ----------------------------------------------
  await page.goto(`${BASE}/settings/retention`)
  await page.waitForSelector('[data-testid="retention"]', { timeout: 15_000 })
  const retentionRows = await page.locator('[data-testid="retention-row"]').count()
  ok('Every class of data Superwork keeps has a stated window', retentionRows >= 7, `${retentionRows} classes`)
  const retentionText = await page.locator('[data-testid="retention"]').innerText()
  ok('Each window says where the number came from', /works council|GDPR|standard/i.test(retentionText))

  // Shortening a window deletes things on a schedule, so it wants fresh proof of identity.
  // The confirmation given on the tools screen may still be inside its five minutes, so
  // this accepts either outcome — the point is that the change lands either way.
  await page.locator('[data-testid="retention-row"] button', { hasText: 'Change' }).first().click()
  await page.waitForSelector('[data-testid="retention-editor"]', { timeout: 15_000 })
  const saveWindow = page.getByRole('button', { name: 'Save this window' })
  await page.fill('#retention-days', '365')
  ok('A window will not be changed without a reason', await saveWindow.isDisabled())
  await page.fill('#retention-reason', 'Our DPIA sets a year for anything naming a person.')
  expectingRefusal = true
  await saveWindow.click()
  const retentionStepUp = page.locator('[data-testid="step-up"]')
  await retentionStepUp.waitFor({ timeout: 5_000 }).catch(() => undefined)
  if (await retentionStepUp.count()) {
    await page.fill('#step-up-password', 'superwork')
    await page.locator('[data-testid="step-up-confirm"]').click()
  }
  expectingRefusal = false
  await page.waitForSelector('[data-testid="retention-editor"]', { state: 'detached', timeout: 20_000 })
  await page.waitForFunction(
    () => /365 days/.test(document.querySelector('[data-testid="retention"]')?.textContent ?? ''),
    undefined,
    { timeout: 20_000 },
  )
  const changedText = await page.locator('[data-testid="retention"]').innerText()
  ok('A changed window is stored with the reason and who set it',
    /365 days/.test(changedText) && /DPIA/.test(changedText) && /Set by/.test(changedText))

  // Preview only. Erasure has no undo, so the check reads the list and stops — proving the
  // list is real is the whole point, and carrying it out would prove nothing extra.
  await page.locator('[data-testid="erasure-preview"]').click()
  await page.waitForSelector('[data-testid="erasure-preview-result"]', { timeout: 20_000 })
  const previewRows = await page.locator('[data-testid="erasure-preview-result"] tbody tr').count()
  ok('An erasure is shown in full before anybody confirms it', previewRows >= 8, `${previewRows} record types`)
  const erasureText = await page.locator('[data-testid="erasure-preview-result"]').innerText()
  ok('It says what is deleted, what is anonymised and what is kept',
    /deleted/.test(erasureText) && /anonymised/.test(erasureText) && /kept/.test(erasureText))
  ok('Nothing is erased until a reason is given',
    await page.locator('[data-testid="erasure-execute"]').isDisabled())
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/retention.png`, fullPage: true })

  // ---- What the assistant remembers ---------------------------------------
  // The demo seed has answered questions from documents, so there is something waiting.
  await page.goto(`${BASE}/knowledge/memory`)
  await page.waitForSelector('[data-testid="memory-candidates"]', { timeout: 15_000 })
  const memoryIntro = await page.locator('main').innerText()
  ok('Memory explains the arrangement it enforces',
    /Nothing is used until a person agrees/i.test(memoryIntro) && /supersed/i.test(memoryIntro))

  const candidates = await page.locator('[data-testid="memory-candidate"]').count()
  ok('It lists what the assistant noticed', candidates > 0, `${candidates} waiting`)
  const firstCandidate = await page.locator('[data-testid="memory-candidate"]').first().innerText()
  ok('Every proposal shows the passage it came from and is not in use yet',
    /›|Freight|policy|Amendment|MSA|handbook|standard/i.test(firstCandidate))

  await page.locator('[data-testid="memory-confirm"]').first().click()
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="memory-fact"]').length > 0,
    undefined,
    { timeout: 20_000 },
  )
  const confirmedText = await page.locator('[data-testid="memory-confirmed"]').innerText()
  ok('Agreeing moves it into what the organization takes to be true', /agreed fact/i.test(confirmedText))
  ok('And records who agreed and when', /\d{4}-\d{2}-\d{2}/.test(confirmedText))
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/memory.png`, fullPage: true })

  // Correcting keeps the old answer. The control refuses until it is told why.
  const confirmedPanel = page.locator('[data-testid="memory-confirmed"]')
  await confirmedPanel.locator('[data-testid="memory-fact-correct"]').first().click()
  await confirmedPanel.locator('[data-testid="memory-editor"]').waitFor({ timeout: 15_000 })
  ok('A correction will not be saved without a reason',
    await confirmedPanel.locator('[data-testid="memory-correct-confirm"]').isDisabled())
  await page.fill('#memory-object', 'twenty minutes')
  await page.fill('#memory-reason', 'Renegotiated in the 2026 handling standard.')
  await confirmedPanel.locator('[data-testid="memory-correct-confirm"]').click()
  await page.waitForFunction(
    () => /twenty minutes/.test(document.querySelector('[data-testid="memory-confirmed"]')?.textContent ?? ''),
    undefined,
    { timeout: 20_000 },
  )
  ok('The correction replaces what is recalled, without deleting the old answer', true)

  // ---- Legal holds --------------------------------------------------------
  await page.goto(`${BASE}/settings/holds`)
  await page.waitForSelector('[data-testid="holds"]', { timeout: 15_000 })
  const holdsIntro = await page.locator('main').innerText()
  ok('Holds explains what it stops', /erased on request/i.test(holdsIntro) && /retention window/i.test(holdsIntro))

  await page.locator('[data-testid="hold-place-open"]').click()
  await page.waitForSelector('[data-testid="hold-place"]', { timeout: 15_000 })
  ok('A hold will not be placed without a matter and a basis',
    await page.locator('[data-testid="hold-place"]').isDisabled())
  await page.fill('#hold-matter', 'Ahlgren v. Northwind')
  await page.fill('#hold-basis', 'Preservation notice received 2026-03-02 from outside counsel.')
  await page.fill('#hold-from', '2024-01-01')
  await page.locator('[data-testid="hold-custodian"]').first().click()
  // No step-up here on purpose: preserving in a hurry is the point, and this is the one
  // admin action of this weight that does not ask.
  await page.locator('[data-testid="hold-place"]').click()
  await page.waitForSelector('[data-testid="hold-row"]', { timeout: 20_000 })
  const holdText = await page.locator('[data-testid="holds"]').innerText()
  ok('Placing one asks for no password', (await page.locator('[data-testid="step-up"]').count()) === 0)
  ok('It lists the matter, whose records, and the period',
    /Ahlgren v\. Northwind/.test(holdText) && /2024-01-01/.test(holdText) && /ongoing/.test(holdText))
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/legal-hold.png`, fullPage: true })

  // The retention screen says the windows are suspended from the moment the hold exists,
  // not from the next sweep. A window that looks unenforced is a support call.
  await page.goto(`${BASE}/settings/retention`)
  await page.waitForSelector('[data-testid="retention-holds"]', { timeout: 15_000 })
  const suspended = await page.locator('[data-testid="retention-holds"]').innerText()
  ok('The retention screen says which matter is suspending it',
    /legal hold is in force/i.test(suspended) && /Ahlgren v\. Northwind/.test(suspended))

  // Releasing is the irreversible half and goes through the step-up path. Whether the
  // prompt appears here depends on how long ago the custom-tools screen confirmed, and this
  // whole check runs inside the five-minute window — so the *requirement* is asserted where
  // it can be made deterministic (the test pack and the Phase 5 loop), and what is checked
  // here is that the release lands and is recorded.
  await page.goto(`${BASE}/settings/holds`)
  await page.waitForSelector('[data-testid="hold-row"]', { timeout: 15_000 })
  await page.locator('[data-testid="hold-release"]').first().click()
  await page.waitForSelector('[data-testid="hold-release-editor"]', { timeout: 15_000 })
  ok('A hold will not be released without a reason',
    await page.locator('[data-testid="hold-release-confirm"]').isDisabled())
  await page.fill('#hold-release-reason', 'Settled 2026-05-04; counsel withdrew the notice.')
  expectingRefusal = true
  await page.locator('[data-testid="hold-release-confirm"]').click()
  const holdStepUp = page.locator('[data-testid="step-up"]')
  await holdStepUp.waitFor({ timeout: 5_000 }).catch(() => undefined)
  if (await holdStepUp.count()) {
    await page.fill('#step-up-password', 'superwork')
    await page.locator('[data-testid="step-up-confirm"]').click()
  }
  expectingRefusal = false
  await page.waitForSelector('[data-testid="holds-released"]', { timeout: 20_000 })
  const releasedText = await page.locator('[data-testid="holds-released"]').innerText()
  ok('A released hold stays on the record with who released it and why',
    /Ahlgren v\. Northwind/.test(releasedText) && /counsel withdrew/i.test(releasedText))

  // ---- Feature flags --------------------------------------------------------
  await page.goto(`${BASE}/settings/features`)
  await page.waitForSelector('[data-testid="flags"]', { timeout: 15_000 })
  const flagRows = await page.locator('[data-testid="flag-row"]').count()
  ok('Features lists what each flag actually changes', flagRows > 0, `${flagRows} live flags`)
  const flagsText = await page.locator('main').innerText()
  ok('It explains the three layers', /product default.*organization.*yourself/is.test(flagsText))
  ok('Flags that control nothing are listed without a switch',
    (await page.locator('[data-testid="flag-inert"]').count()) > 0)

  // Turning one off for everybody is the half that needs a reason.
  await page.locator('[data-testid="flag-set-org"]').first().click()
  await page.waitForSelector('[data-testid="flag-editor"]', { timeout: 15_000 })
  ok('An organization-wide change will not save without a reason',
    await page.locator('[data-testid="flag-org-confirm"]').isDisabled())
  ok('And it says what a personal override will do to it',
    /keeps their own choice/i.test(await page.locator('[data-testid="flag-editor"]').innerText()))
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/features.png`, fullPage: true })

  // A personal preference takes effect immediately and needs nothing.
  const densityRow = page.locator('[data-testid="flag-row"]', { hasText: 'Compact rows' })
  await densityRow.locator('[data-testid="flag-set-me"]').click()
  await page.waitForFunction(
    () => document.querySelector('.shell')?.getAttribute('data-density') === 'comfortable',
    undefined,
    { timeout: 20_000 },
  )
  ok('A personal preference changes the interface straight away', true)
  await densityRow.locator('[data-testid="flag-clear-me"]').click()
  await page.waitForFunction(
    () => document.querySelector('.shell')?.getAttribute('data-density') === 'compact',
    undefined,
    { timeout: 20_000 },
  )
  ok('And resetting it falls back to what the organization has', true)

  // ---- Teams ---------------------------------------------------------------
  await page.goto(`${BASE}/settings/teams`)
  await page.waitForSelector('[data-testid="teams"]', { timeout: 15_000 })
  const teamsText = await page.locator('main').innerText()
  ok('Teams explains what the scope reaches', /every permission it holds is\s+team-scoped|team-scoped/i.test(teamsText))
  const teamRows = await page.locator('[data-testid="team-row"]').count()
  ok('The seeded team is there with its work counted', teamRows > 0, `${teamRows} teams`)
  ok('It says how much is scoped to it', /tasks · \d+ projects · \d+ documents scoped to it/i.test(teamsText))

  // Departments: read everywhere, written by the seed alone until now.
  const departmentText = await page.locator('[data-testid="departments"]').innerText()
  ok('The same screen can make a department, and says how it differs from a team',
    /where somebody sits/i.test(departmentText) && /what somebody is working on/i.test(departmentText))
  await page.locator('[data-testid="department-add"]').click()
  await page.waitForSelector('[data-testid="department-editor"]', { timeout: 15_000 })
  await page.fill('#department-name', 'Customs')
  await page.selectOption('#department-parent', { label: 'Operations' })
  await page.locator('[data-testid="department-confirm"]').click()
  const nested = await page
    .waitForFunction(
      () =>
        /Operations \/ Customs/i.test(document.querySelector('[data-testid="departments"]')?.textContent ?? ''),
      undefined,
      { timeout: 20_000 },
    )
    .then(() => true, () => false)
  ok('A nested department lands with the path the database wrote', nested)

  await page.locator('[data-testid="team-add-member"]').first().click()
  await page.waitForSelector('[data-testid="team-member-editor"]', { timeout: 15_000 })
  ok('Nobody joins without a reason',
    await page.locator('[data-testid="team-member-confirm"]').isDisabled())
  ok('And it says what joining actually grants',
    /becomes readable by them on their next request/i.test(
      await page.locator('[data-testid="team-member-editor"]').innerText(),
    ))

  await page.locator('[data-testid="team-archive"]').first().click()
  await page.waitForSelector('[data-testid="team-archive-editor"]', { timeout: 15_000 })
  await page.fill('#team-archive-reason', 'Renewal closed; the work moved to Commercial.')
  expectingRefusal = true
  await page.locator('[data-testid="team-archive-confirm"]').click()
  // Matched on text unique to the refusal. "still scoped to" also appears in the editor's
  // own explanatory copy, so waiting for that resolved instantly against static text — the
  // assertion passed without the request having happened, and dropped the refusal
  // exemption early, which is what surfaced the stray 400.
  const disbandError = page.getByText(/Move them first/i).first()
  await disbandError.waitFor({ timeout: 20_000 }).catch(() => undefined)
  ok('Disbanding is refused while work is still scoped to it', (await disbandError.count()) > 0,
    ((await disbandError.count()) ? await disbandError.innerText() : 'it was allowed').slice(0, 80))
  expectingRefusal = false
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/teams.png`, fullPage: true })

  // ---- Work that waits for other work -------------------------------------
  // Filtered to Maya's own work, which the seed gives the blocking task to. The unfiltered
  // list is 116 open tasks against a page size of 100, ordered by recency — the blocking
  // one sat around row 83 and fell off the page in CI depending on timestamp ordering.
  // Asserting against a page whose contents depend on a race is not an assertion.
  await page.goto(`${BASE}/tasks?filter=mine`)
  await page.waitForSelector('[data-testid="task-row"]', { timeout: 15_000 })
  const blockingChips = await page.locator('[data-testid="task-blocking-chip"]').count()
  ok('The task list says which work is holding other work up', blockingChips > 0, `${blockingChips} blocking`)

  await page.locator('[data-testid="task-blocking-chip"]').first().click({ trial: true }).catch(() => undefined)
  const blockingRow = page.locator('[data-testid="task-row"]', { has: page.locator('[data-testid="task-blocking-chip"]') })
  await blockingRow.first().locator('a').first().click()
  await page.waitForSelector('[data-testid="task-dependencies"]', { timeout: 15_000 })
  const depsText = await page.locator('[data-testid="task-dependencies"]').innerText()
  const blockingRows = await page.locator('[data-testid="blocking-row"]').count()
  ok('Opening it names who is waiting, not just how many', blockingRows > 0, `${blockingRows} waiting`)
  ok('It says what finishing it will do', /tells whoever it was the last thing standing in the way of/i.test(depsText))

  await page.locator('[data-testid="dependency-add"]').click()
  await page.waitForSelector('[data-testid="dependency-editor"]', { timeout: 15_000 })
  ok('Nothing is recorded until a task is chosen',
    await page.locator('[data-testid="dependency-add-confirm"]').isDisabled())
  ok('The editor says what a dependency will do, and what a loop does',
    /completing it is refused rather than warned about/i.test(
      await page.locator('[data-testid="dependency-editor"]').innerText(),
    ))
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/task-dependencies.png`, fullPage: true })

  // Comments: the agent has been writing here since Phase 0 into a table nothing read, and
  // no person could add one at all.
  const commentsText = await page.locator('[data-testid="task-comments"]').innerText()
  ok('A task has somewhere to say something',
    /Say something/i.test(commentsText) && /lands on their reminders, not their email/i.test(commentsText))
  await page.fill('#comment-body', 'Asked them again this morning; nothing back yet.')
  await page.locator('[data-testid="comment-send"]').click()
  const commented = await page
    .waitForFunction(
      () =>
        /nothing back yet/i.test(document.querySelector('[data-testid="task-comments"]')?.textContent ?? ''),
      undefined,
      { timeout: 20_000 },
    )
    .then(() => true, () => false)
  ok('A person can comment, and it lands on the task', commented)
  ok('And can take their own words back again',
    await page.locator('[data-testid="comment-remove"]').first().isEnabled())

  // Following: the task told nobody but its assignee anything until now.
  const watchText = await page.locator('[data-testid="task-watchers"]').innerText()
  ok('A task can be followed by somebody who is not doing it',
    /Follow this task/i.test(watchText) && /changes hands, changes status, is renamed/i.test(watchText))
  await page.locator('[data-testid="task-watch"]').click()
  const followedOn = await page
    .waitForSelector('[data-testid="task-unwatch"]', { timeout: 20_000 })
    .then(() => true, () => false)
  ok('Following it says so, and offers the way back out', followedOn)
  await page.locator('[data-testid="task-unwatch"]').click()
  const unfollowed = await page
    .waitForSelector('[data-testid="task-watch"]', { timeout: 20_000 })
    .then(() => true, () => false)
  ok('And stopping is one press, on the same button', unfollowed)

  // ---- Sharing one thing with one person ------------------------------------
  // Stays on the task opened above, which has the share panel beside its dependencies.
  await page.locator('[data-testid="share-add"]').click()
  await page.waitForSelector('[data-testid="share-editor"]', { timeout: 15_000 })
  ok('Nothing is shared until somebody is chosen',
    await page.locator('[data-testid="share-confirm"]').isDisabled())
  const shareText = await page.locator('[data-testid="share-object"]').innerText()
  ok('It says a share only ever adds, and cannot exceed what you hold',
    /only ever adds/i.test(shareText) && /share what you can already do yourself/i.test(shareText))

  await page.selectOption('#share-subject', { index: 1 })
  await page.fill('#share-reason', 'Covering the renewal while I am away.')
  await page.locator('[data-testid="share-confirm"]').click()
  await page.waitForSelector('[data-testid="share-row"]', { timeout: 20_000 })
  const shared = await page.locator('[data-testid="share-object"]').innerText()
  ok('A share lands, naming who, what they may do, and why',
    /can read it/i.test(shared) && /Covering the renewal/i.test(shared))

  // The other end of the same question: the person can see why they can see it.
  await page.goto(`${BASE}/me`)
  await page.waitForSelector('[data-testid="shared-with-you"]', { timeout: 15_000 })
  ok('The personal record answers “why can I see that?”',
    /A share adds access to one specific thing/i.test(
      await page.locator('[data-testid="shared-with-you"]').innerText(),
    ))
  // Being on a project is the other half of that answer: it lends a read the share list
  // knows nothing about, so leaving it out would make the record quietly incomplete.
  const onProjects = await page.locator('[data-testid="on-projects"]').innerText()
  ok('And says which projects you are on, and what that lends you',
    /Being on a project lets you read it/i.test(onProjects))
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sharing.png`, fullPage: true })

  // ---- A question asked of a list, kept ------------------------------------
  // `saved_views` was written by nothing, so every person retyped their own question daily.
  await page.goto(`${BASE}/tasks?filter=blocked`)
  await page.waitForSelector('[data-testid="saved-views"]', { timeout: 15_000 })
  const seeded = await page.locator('[data-testid="saved-view"]').count()
  ok('The list offers the questions somebody already saved', seeded > 0, `${seeded} views`)

  await page.locator('[data-testid="saved-view-add"]').click()
  await page.waitForSelector('[data-testid="saved-view-editor"]', { timeout: 15_000 })
  ok('Nothing is saved until it has a name',
    await page.locator('[data-testid="saved-view-confirm"]').isDisabled())
  ok('It says a shared view hands over the question and not the rows',
    /saved question, not access/i.test(await page.locator('[data-testid="saved-views"]').innerText()))
  await page.fill('#saved-view-name', 'Browser check view')
  await page.locator('[data-testid="saved-view-confirm"]').click()
  const savedView = await page
    .waitForFunction(
      () =>
        /Browser check view/.test(document.querySelector('[data-testid="saved-views"]')?.textContent ?? ''),
      undefined,
      { timeout: 20_000 },
    )
    .then(() => true, () => false)
  ok('What is on screen can be kept and pressed again tomorrow', savedView)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/saved-views.png`, fullPage: true })

  // Put the demo back: the check leaves no view of its own behind.
  await page.locator('[aria-label="Delete the view Browser check view"]').click()
  const removedView = await page
    .waitForFunction(
      () =>
        !/Browser check view/.test(document.querySelector('[data-testid="saved-views"]')?.textContent ?? ''),
      undefined,
      { timeout: 20_000 },
    )
    .then(() => true, () => false)
  ok('And taken off the list again by whoever made it', removedView)

  // ---- Who can find a document --------------------------------------------
  // The seed restricts the Coldstore agreement, so the populated state is on screen.
  await page.goto(`${BASE}/knowledge`)
  await page.waitForSelector('[data-testid="document-row"]', { timeout: 15_000 })
  await page.locator('[data-testid="document-row"] a', { hasText: 'Coldstore Nordics' }).first().click()
  await page.waitForSelector('[data-testid="document-audience"]', { timeout: 15_000 })
  const audienceText = await page.locator('[data-testid="document-audience"]').innerText()
  const audienceRows = await page.locator('[data-testid="audience-row"]').count()
  ok('A restricted document lists who can find it', audienceRows >= 3, `${audienceRows} on the list`)
  ok('It says administrators are not exempt', /including administrators/i.test(audienceText))
  ok('Every entry says why they are on it', /Signs the storage agreements/i.test(audienceText))

  // Reopening is its own control, not the side effect of removing the last name.
  await page.locator('[data-testid="audience-open"]').click()
  await page.waitForSelector('[data-testid="audience-open-editor"]', { timeout: 15_000 })
  ok('Reopening will not happen without a reason',
    await page.locator('[data-testid="audience-open-confirm"]').isDisabled())
  await page.fill('#audience-open-reason', 'Agreement executed; the terms are internal now.')
  await page.locator('[data-testid="audience-open-confirm"]').click()
  await page.waitForFunction(
    () =>
      /Anybody whose classification allows it/i.test(
        document.querySelector('[data-testid="document-audience"]')?.textContent ?? '',
      ),
    undefined,
    { timeout: 20_000 },
  )
  ok('Removing the restriction says what it did', true)

  // And restricting again warns before the first name, because that is the moment
  // everybody else loses it.
  await page.locator('[data-testid="audience-add"]').click()
  await page.waitForSelector('[data-testid="audience-editor"]', { timeout: 15_000 })
  const firstGrant = await page.locator('[data-testid="audience-editor"]').innerText()
  ok('The first name on a new list warns that everybody else loses it',
    /everybody else loses the ability to find this document/i.test(firstGrant))
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/document-audience.png`, fullPage: true })

  // ---- A project, and handing the whole of it to somebody -----------------
  await page.goto(`${BASE}/projects`)
  await page.waitForSelector('.panel h2 a', { timeout: 15_000 })
  const projectName = await page.locator('.panel h2 a').first().innerText()
  await page.locator('.panel h2 a').first().click()
  await page.waitForSelector('[data-testid="project-tasks"]', { timeout: 15_000 })

  ok('A project opens on a page of its own', (await page.locator('h1').innerText()) === projectName, projectName)
  ok('The health band is on it, with the number beside it',
    /\d/.test(await page.locator('[data-testid="project-health-band"]').innerText()))
  ok('And the arithmetic behind the number, not just the number',
    /Overdue work/.test(await page.locator('.panel', { hasText: 'Why the score is what it is' }).first().innerText()))

  // Who is on it, which is a different question from who it has been shared with — and the
  // one the page could not answer at all until the roster was read (ADR 0032).
  const rosterText = await page.locator('[data-testid="project-roster"]').innerText()
  const rosterRows = await page.locator('[data-testid="roster-row"]').count()
  ok('A project says who is on it', rosterRows > 0, `${rosterRows} people`)
  ok('And that being on it lends a read, not a say',
    /lends a read, never a say/i.test(rosterText) && /different from sharing it/i.test(rosterText))
  ok('The owner cannot be taken off their own project',
    await page.locator('[data-testid="roster-remove"]').first().isDisabled())

  await page.locator('[data-testid="roster-add"]').click()
  await page.waitForSelector('[data-testid="roster-editor"]', { timeout: 15_000 })
  ok('Nobody is put on a project without saying why',
    await page.locator('[data-testid="roster-confirm"]').isDisabled())
  await page.selectOption('#roster-subject', { index: 1 })
  await page.selectOption('#roster-role', 'reviewer')
  await page.fill('#roster-reason', 'Reviewing the customs paperwork this month.')
  await page.locator('[data-testid="roster-confirm"]').click()
  const rosterLanded = await page
    .waitForFunction(
      () =>
        /Reviewing the customs paperwork/i.test(
          document.querySelector('[data-testid="project-roster"]')?.textContent ?? '',
        ),
      undefined,
      { timeout: 20_000 },
    )
    .then(() => true, () => false)
  ok('Putting somebody on it lands, with the reason on the row', rosterLanded)

  // Milestones: on every project page since Phase 1, and until now written by the seed alone.
  const milestoneText = await page.locator('[data-testid="milestones"]').innerText()
  ok('A project can gain a milestone at last',
    /Add a milestone/i.test(milestoneText) || /Milestone/i.test(milestoneText))
  await page.locator('[data-testid="milestone-add"]').click()
  await page.waitForSelector('[data-testid="milestone-editor"]', { timeout: 15_000 })
  ok('Nothing is added without something to call it',
    await page.locator('[data-testid="milestone-confirm"]').isDisabled())
  await page.fill('#milestone-name', 'Broker consolidation signed off')
  await page.fill('#milestone-date', '2026-09-30')
  await page.locator('[data-testid="milestone-confirm"]').click()
  const milestoneLanded = await page
    .waitForFunction(
      () =>
        /Broker consolidation signed off/i.test(
          document.querySelector('[data-testid="milestones"]')?.textContent ?? '',
        ),
      undefined,
      { timeout: 20_000 },
    )
    .then(() => true, () => false)
  ok('It lands on the project with its date', milestoneLanded)

  const projectShareText = await page.locator('[data-testid="share-object"]').innerText()
  ok('Sharing a project says it reaches the work inside it',
    /read the work inside it/i.test(projectShareText))
  ok('And that it lends a read, not a say',
    /lends a read, never a say/i.test(projectShareText))

  await page.locator('[data-testid="share-add"]').click()
  await page.waitForSelector('[data-testid="share-editor"]', { timeout: 15_000 })
  await page.selectOption('#share-subject', { index: 1 })
  await page.fill('#share-reason', 'Reviewing the delivery plan with us this month.')
  await page.locator('[data-testid="share-confirm"]').click()
  // Wait for *this* share, not for any row: the project may already be shared with somebody
  // else, in which case a row exists before the click and the panel is read mid-refresh.
  const shareLanded = await page
    .waitForFunction(
      () =>
        /Reviewing the delivery plan/i.test(
          document.querySelector('[data-testid="share-object"]')?.textContent ?? '',
        ),
      undefined,
      { timeout: 20_000 },
    )
    .then(() => true, () => false)
  ok('A project share lands, with its reason on the row', shareLanded)
  ok('And the owner can take it back again',
    await page.locator('[data-testid="share-revoke"]').first().isEnabled())
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/project.png`, fullPage: true })

  // ---- What the company pays for, and what it limits ----------------------
  await page.goto(`${BASE}/settings/billing`)
  await page.waitForSelector('[data-testid="plan"]', { timeout: 15_000 })
  const planText = await page.locator('[data-testid="plan"]').innerText()
  ok('The billing screen states the plan and its limits', /Seats/.test(planText) && /Monthly AI spend/.test(planText))
  ok('And seats count what is actually in use',
    /\d+ \/ \d+/.test(planText), planText.split('\n').find((line) => /\d+ \/ \d+/.test(line)) ?? '')

  await page.locator('[data-testid="plan-edit"]').click()
  await page.waitForSelector('[data-testid="plan-editor"]', { timeout: 15_000 })
  ok('A limit is not changed without a reason',
    await page.locator('[data-testid="plan-save"]').isDisabled())
  ok('And the screen says it can tighten but never widen',
    /never above/i.test(await page.locator('[data-testid="plan-tighten-only"]').innerText()))

  // The control the refusal message has always pointed at.
  await page.fill('#cap-monthly', '25')
  await page.fill('#cap-reason', 'Trialling the agent on a small budget this month.')
  await page.locator('[data-testid="plan-save"]').click()
  await page.waitForTimeout(1500)
  ok('Tightening a cap lands, and says who set it and why',
    /small budget/i.test(await page.locator('[data-testid="plan"]').innerText()))
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/plan.png`, fullPage: true })

  // Put the demo back through the same control, which is the one that clears an
  // organization's own cap. Leaving £25 in place caps the whole demo at a quarter of its
  // plan, and the phase 5 loop — which asserts that a *plan* limit reaches the runtime —
  // then reads this number instead and fails somewhere else entirely.
  await page.locator('[data-testid="plan-edit"]').click()
  await page.waitForSelector('[data-testid="plan-editor"]', { timeout: 15_000 })
  await page.fill('#cap-monthly', '')
  await page.fill('#cap-reason', 'The walkthrough is finished with it.')
  await page.locator('[data-testid="plan-save"]').click()
  const capCleared = await page
    .waitForFunction(
      () => /finished with it/i.test(document.querySelector('[data-testid="plan"]')?.textContent ?? ''),
      undefined,
      { timeout: 20_000 },
    )
    .then(() => true, () => false)
  ok('And clearing it puts the plan’s own limit back', capCleared)

  // ---- Adding a person to the organization --------------------------------
  await page.goto(`${BASE}/settings/members`)
  await page.waitForSelector('[data-testid="members"]', { timeout: 15_000 })
  const memberRows = await page.locator('[data-testid="member-row"]').count()
  ok('The members screen lists who is here', memberRows > 0, `${memberRows} members`)

  await page.locator('[data-testid="invitation-add"]').click()
  await page.waitForSelector('[data-testid="invitation-editor"]', { timeout: 15_000 })
  ok('Nothing is invited without a reason',
    await page.locator('[data-testid="invitation-send"]').isDisabled())

  const invitee = `browser.check.${Date.now()}@northwind.example`
  await page.fill('#invite-email', invitee)
  await page.fill('#invite-reason', 'Joining the renewals team on Monday.')
  await page.locator('[data-testid="invitation-send"]').click()
  await page.waitForSelector('[data-testid="invitation-link"]', { timeout: 20_000 })
  const linkPanel = await page.locator('[data-testid="invitation-link"]').innerText()
  ok('The link is shown once, and says so', /shown once/i.test(linkPanel))
  ok('And it says plainly that nothing was emailed', /Nothing was emailed/i.test(linkPanel))

  const inviteUrl = (linkPanel.match(/https?:\/\/\S+\/invite\/\S+/) ?? [])[0] ?? ''
  ok('The link is a real one', inviteUrl.includes('/invite/'), inviteUrl.slice(0, 48))
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/invitations.png`, fullPage: true })

  // The other half of the journey, on a page nobody is signed in to.
  const guest = await browser.newPage()
  await guest.goto(inviteUrl)
  await guest.waitForSelector('[data-testid="invite-form"]', { timeout: 15_000 })
  ok('The invitee is told who invited them, and to what',
    /invited/i.test(await guest.locator('[data-testid="invite-offer"]').innerText()))
  await guest.fill('#name', 'Browser Check')
  await guest.fill('#password', 'a-good-password')
  await guest.locator('[data-testid="invite-accept"]').click()
  await guest.waitForURL((url) => !url.pathname.startsWith('/invite'), { timeout: 20_000 })
  ok('Accepting signs them straight in rather than sending them to a login form',
    !guest.url().includes('/login') && !guest.url().includes('/invite'), guest.url())

  // The same link a second time is dead.
  await guest.goto(inviteUrl)
  await guest.waitForSelector('[data-testid="invite-dead"]', { timeout: 15_000 })
  ok('And the same link does not work twice',
    /does not work/i.test(await guest.locator('h1').innerText()))
  await guest.close()

  // ---- Who is answerable for whom -----------------------------------------
  await page.goto(`${BASE}/settings/reporting`)
  await page.waitForSelector('[data-testid="org-chart"]', { timeout: 15_000 })
  const chartRows = await page.locator('[data-testid="org-chart-row"]').count()
  ok('The org chart seeded in migration 0001 is on a screen at last', chartRows >= 10, `${chartRows} lines`)
  ok('It says what a reporting line is for, and what it is not',
    /not.*a view onto/i.test(await page.locator('[data-testid="org-chart-purpose"]').innerText()))
  ok('A dotted line is shown as distinct from the escalation path',
    (await page.locator('[data-testid="org-chart-row"]', { hasText: 'dotted' }).count()) > 0)

  await page.locator('[data-testid="org-chart-add"]').click()
  await page.waitForSelector('[data-testid="org-chart-editor"]', { timeout: 15_000 })
  ok('Nothing is recorded without a reason',
    await page.locator('[data-testid="org-chart-save"]').isDisabled())
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/reporting-lines.png`, fullPage: true })

  await page.goto(`${BASE}/me`)
  await page.waitForSelector('[data-testid="reporting-line"]', { timeout: 15_000 })
  const lineText = await page.locator('[data-testid="reporting-line"]').innerText()
  ok('A person can see their own line on their own record', /You report to/i.test(lineText))
  ok('And is told it is not a window onto their work', /not a window onto your work/i.test(lineText))

  // ---- The rules that decide what stops for a person ----------------------
  await page.goto(`${BASE}/settings/approvals`)
  await page.waitForSelector('[data-testid="approval-policies"]', { timeout: 15_000 })
  const policyRows = await page.locator('[data-testid="policy-row"]').count()
  ok('The seeded approval rules are on a screen at last', policyRows >= 3, `${policyRows} rules`)
  ok('And each says what it catches in plain English, not JSON',
    /changes 20 or more things/i.test(await page.locator('[data-testid="approval-policies"]').innerText()))
  ok('The screen says a rule can only tighten, never switch an approval off',
    /only ever tighten/i.test(await page.locator('[data-testid="policy-floor"]').innerText()))

  const workedRows = await page.locator('[data-testid="policy-worked-row"]').count()
  const workedText = await page.locator('[data-testid="policy-worked"]').innerText()
  ok('It works the current rules through cases people actually run', workedRows >= 3, `${workedRows} cases`)
  ok('Outbound mail routes to a manager by the rule', /a manager decides/i.test(workedText))
  ok('And autopilot is refused outright rather than given a card', /refused/i.test(workedText))

  await page.locator('[data-testid="policy-toggle"]').first().click()
  await page.waitForSelector('[data-testid="policy-toggle-editor"]', { timeout: 15_000 })
  ok('Switching a rule off will not happen without a reason',
    await page.locator('[data-testid="policy-toggle-confirm"]').isDisabled())
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/approval-policies.png`, fullPage: true })

  // ---- A shelf of knowledge, and an account -------------------------------
  await page.goto(`${BASE}/knowledge`)
  await page.waitForSelector('[data-testid="spaces"]', { timeout: 15_000 })
  const spacesText = await page.locator('[data-testid="spaces"]').innerText()
  ok('The library lists its shelves, with what is filed on each',
    /Filed here/i.test(spacesText) && /New documents/i.test(spacesText))

  // ADR 0025 said spaces were "read, shared and filed into; not yet authored". Now they are.
  await page.locator('[data-testid="space-add"]').click()
  await page.waitForSelector('[data-testid="space-editor"]', { timeout: 15_000 })
  ok('Making one says what a shelf does and does not lend',
    /never a say/i.test(await page.locator('[data-testid="space-editor"]').innerText()))
  await page.fill('#space-name', 'Customs procedures')
  await page.fill('#space-description', 'Everything the broker asks for.')
  await page.locator('[data-testid="space-confirm"]').click()
  const shelfMade = await page
    .waitForFunction(
      () => /Customs procedures/i.test(document.querySelector('[data-testid="spaces"]')?.textContent ?? ''),
      undefined,
      { timeout: 20_000 },
    )
    .then(() => true, () => false)
  ok('A new shelf lands in the library', shelfMade)

  // The shelf with documents on it, not the empty one this walk just made.
  await page
    .locator('[data-testid="space-row"]', { hasNotText: 'Customs procedures' })
    .first()
    .locator('a')
    .first()
    .click()
  await page.waitForSelector('[data-testid="space-documents"]', { timeout: 15_000 })

  const spaceRows = await page.locator('[data-testid="space-document-row"]').count()
  ok('A space lists what is filed on it — the column was written and read by nothing until now',
    spaceRows > 0, `${spaceRows} documents`)
  const spaceShareText = await page.locator('[data-testid="share-object"]').innerText()
  ok('Sharing a space says it reaches the documents in it',
    /read the documents filed in it/i.test(spaceShareText))
  ok('And that it does not lift a document’s own classification',
    /does not lift a document/i.test(spaceShareText))

  await page.locator('[data-testid="share-add"]').click()
  await page.waitForSelector('[data-testid="share-editor"]', { timeout: 15_000 })
  await page.selectOption('#share-subject', { index: 1 })
  await page.fill('#share-reason', 'Working through the operating procedures with us.')
  await page.locator('[data-testid="share-confirm"]').click()
  await page.waitForSelector('[data-testid="share-row"]', { timeout: 20_000 })
  ok('A space share lands',
    /Working through the operating procedures/i.test(
      await page.locator('[data-testid="share-object"]').innerText(),
    ))
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/knowledge-space.png`, fullPage: true })

  await page.goto(`${BASE}/companies`)
  await page.waitForSelector('a[href^="/companies/"]', { timeout: 15_000 })
  await page.locator('a[href^="/companies/"]').first().click()
  await page.waitForSelector('[data-testid="share-object"]', { timeout: 15_000 })
  const companyShareText = await page.locator('[data-testid="share-object"]').innerText()
  ok('Sharing a company says it hands over the account view',
    /hands over the account view/i.test(companyShareText))
  ok('And says plainly what it does not reach',
    /does not reach the documents or work filed against it/i.test(companyShareText))
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/company-share.png`, fullPage: true })

  // ---- Indexing, and a document that can be put back into memory -----------
  // `ingestion_jobs` was written by nothing: indexing ran inline, so a failure rolled back
  // with the transaction it happened in and there was no way to ask for another attempt.
  await page.goto(`${BASE}/knowledge`)
  await page.waitForSelector('[data-testid="ingestion-queue"]', { timeout: 15_000 })
  const queueText = await page.locator('[data-testid="ingestion-queue"]').innerText()
  ok('The library says what is waiting to be indexed, and what gave up',
    /Indexing/.test(queueText) &&
      /retried on a widening delay|waiting|gave up|running|retrying/i.test(queueText))

  await page.locator('[data-testid="document-row"] a').first().click()
  await page.waitForSelector('[data-testid="document-indexing"]', { timeout: 15_000 })
  const indexingText = await page.locator('[data-testid="document-indexing"]').innerText()
  ok('A document says how it got into company memory, and how many sections',
    /attempt/i.test(indexingText) && /Checked \d+, found \d+/.test(indexingText))
  ok('It says re-indexing needs a say over the document, not a read of it',
    /needs a say over\s+the document rather than a read of it/i.test(indexingText))

  await page.locator('[data-testid="reindex-ask"]').click()
  await page.waitForSelector('[data-testid="reindex-editor"]', { timeout: 15_000 })
  await page.fill('#reindex-reason', 'Browser check asked for it.')
  await page.locator('[data-testid="reindex-confirm"]').click()
  const queued = await page
    .waitForFunction(
      () =>
        /Browser check asked for it/.test(
          document.querySelector('[data-testid="document-indexing"]')?.textContent ?? '',
        ),
      undefined,
      { timeout: 20_000 },
    )
    .then(() => true, () => false)
  ok('Asking for it again queues the work rather than doing it in the request', queued)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/indexing.png`, fullPage: true })

  // ---- The days people do not work ----------------------------------------
  // `departments.holiday_calendar` was written by nothing, so the ladder chased people on
  // Saturdays and on Christmas Day.
  await page.goto(`${BASE}/settings/teams`)
  await page.waitForSelector('[data-testid="department-row"]', { timeout: 15_000 })
  const calendarText = await page.locator('[data-testid="calendar-explainer"]').innerText()
  ok('The department screen says what a working calendar decides',
    /which days the system will not chase these people on/i.test(calendarText))
  ok('And that it can only ever quieten the reminders',
    /only ever quieten|never|not make the product chase anybody\s+harder/i.test(calendarText))
  const chosen = await page.locator('[data-testid="department-calendar"]').first().inputValue()
  ok('A department carries the calendar it is set to', chosen === 'uk-england-wales', chosen || 'unset')
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/working-days.png`, fullPage: true })

  // The other end of the same fact: the person is told which days they are safe on.
  await page.goto(`${BASE}/reminders`)
  await page.waitForSelector('[data-testid="working-calendar"]', { timeout: 15_000 })
  const mine = await page.locator('[data-testid="working-calendar"]').innerText()
  ok('A person is told which days they will not be chased on',
    /not chased on days you do not work/i.test(mine) && /England & Wales/i.test(mine))
  ok('And it names the next one rather than only the rule', /Next: .+\(\d{4}-\d{2}-\d{2}\)/.test(mine))

  // ---- What the model was asked, and what it cost -------------------------
  // `agent_messages` was written by nothing, so a run could say it cost four cents and not
  // which step, which model, or how long any of it took.
  await page.goto(`${BASE}/activity`)
  await page.waitForSelector('[data-testid="activity-row"], [data-testid="run-row"]', { timeout: 15_000 }).catch(() => undefined)
  // Not every run calls a model — a workflow run that only executes tools makes none — so
  // the walk looks for one that did rather than assuming the newest one qualifies.
  const runHrefs = await page.locator('a[href*="/activity?run="]').evaluateAll((links) =>
    Array.from(new Set(links.map((link) => (link as HTMLAnchorElement).getAttribute('href') ?? ''))).filter(Boolean),
  )
  ok('The run list has a run to open', runHrefs.length > 0, `${runHrefs.length} runs`)

  let messages = ''
  let messageRows = 0
  for (const href of runHrefs.slice(0, 8)) {
    await page.goto(`${BASE}${href}`)
    const found = await page
      .waitForSelector('[data-testid="run-messages"]', { timeout: 5_000 })
      .then(() => true, () => false)
    if (!found) continue
    await page.locator('[data-testid="run-messages"] summary').click()
    messages = await page.locator('[data-testid="run-messages"]').innerText()
    messageRows = await page.locator('[data-testid="run-message-row"]').count()
    break
  }

  ok('A run says which model it called, what for, and what that cost',
    /agent\.plan|agent\.answer|briefing\.narrative|inbox\.classify/.test(messages) && /mock/i.test(messages),
    messages.slice(0, 60).replace(/\n/g, ' '))
  ok('And says the totals above are the sum of those rows, kept by the database',
    /sum of these rows/i.test(messages))
  ok('Every model call is on the record', messageRows > 0, `${messageRows} calls`)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/run-messages.png`, fullPage: true })

  await page.goto(`${BASE}/analytics`)
  await page.waitForSelector('[data-testid="ledger-models"]', { timeout: 15_000 })
  const models = await page.locator('[data-testid="ledger-models"]').innerText()
  ok('The ledger says where the spend went, by model and by the kind of call',
    /Where the spend went/i.test(models) && /one number, not two/i.test(models))
  const modelRows = await page.locator('[data-testid="ledger-model-row"]').count()
  ok('With a row per model and task class', modelRows > 0, `${modelRows} rows`)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/model-spend.png`, fullPage: true })

  // ---- Work that comes back -----------------------------------------------
  // `tasks.recurrence_rule` was written by nothing, so every recurring obligation was retyped
  // by a person each time or forgotten.
  await page.goto(`${BASE}/tasks?filter=all`)
  await page.waitForSelector('[data-testid="task-row"]', { timeout: 15_000 })
  const repeatChips = await page.locator('[data-testid="task-repeats-chip"]').count()
  ok('The list marks work that repeats, so it is not read as a one-off', repeatChips > 0, `${repeatChips} repeating`)

  const repeatingRow = page.locator('[data-testid="task-row"]', {
    has: page.locator('[data-testid="task-repeats-chip"]'),
  })
  await repeatingRow.first().locator('a').first().click()
  await page.waitForSelector('[data-testid="task-recurrence"]', { timeout: 15_000 })
  const recurrence = await page.locator('[data-testid="task-recurrence"]').innerText()
  // Scoped to the summary: the editor's input holds the raw expression, and the point of the
  // assertion is that the sentence a person reads carries no cron in it.
  const summary = await page.locator('[data-testid="recurrence-summary"]').innerText()
  ok('The task says how often it repeats, in English rather than in cron',
    // Only the wildcard: the timezone name legitimately contains a slash.
    /This repeats /i.test(summary) && !summary.split('Finishing')[0]!.includes('*'),
    summary.slice(0, 70).replace(/\n/g, ' '))
  ok('And that finishing it is what makes the next one, one at a time',
    /Finishing it will make the next one/i.test(recurrence) && /Only one is ever open at a time/i.test(recurrence))
  ok('It says cancelling one occurrence does not stop the series',
    /is not\s+“stop doing this”/i.test(recurrence))

  await page.locator('[data-testid="recurrence-edit"]').click()
  await page.waitForSelector('[data-testid="recurrence-editor"]', { timeout: 15_000 })
  ok('The presets are the same schedules the automations screen accepts',
    /automations screen accepts/i.test(await page.locator('[data-testid="task-recurrence"]').innerText()))
  await page.fill('#recurrence-rule', '@reboot')
  expectingRefusal = true
  await page.locator('[data-testid="recurrence-confirm"]').click()
  const refused = await page
    .waitForFunction(
      () => /not a schedule/i.test(document.querySelector('[data-testid="task-recurrence"]')?.textContent ?? ''),
      undefined,
      { timeout: 20_000 },
    )
    .then(() => true, () => false)
  expectingRefusal = false
  ok('A schedule it cannot honour is refused by name, not stored', refused)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/recurring-tasks.png`, fullPage: true })

  // ---- A document whose term has ended -------------------------------------
  // `effective_to` was written by nothing, so a fixed-term document that simply ran out —
  // nothing supersedes it — went on being retrieved and cited as current.
  await page.goto(`${BASE}/knowledge`)
  await page.waitForSelector('[data-testid="document-row"]', { timeout: 15_000 })
  const terms = await page.locator('[data-testid="knowledge-terms"]').innerText()
  ok('The library says what has run out of term',
    /out of term/i.test(terms) && /no longer quoted as current/i.test(terms), terms.replace(/\n/g, ' ').slice(0, 80))

  await page.locator('[data-testid="document-row"] a', { hasText: 'Rate Card 2025' }).first().click()
  await page.waitForSelector('[data-testid="document-term"]', { timeout: 15_000 })
  const termPanel = await page.locator('[data-testid="document-term"]').innerText()
  ok('An expired document says when it stopped applying',
    /stopped applying on 2025-12-31/i.test(termPanel), termPanel.replace(/\n/g, ' ').slice(0, 90))
  ok('And that it is still searchable rather than deleted',
    /still searchable and still citable/i.test(termPanel))
  ok('It says the term reaches the passages without a re-index',
    /Nothing needs\s+re-indexing/i.test(termPanel))

  await page.locator('[data-testid="term-edit"]').click()
  await page.waitForSelector('[data-testid="term-editor"]', { timeout: 15_000 })
  await page.fill('#term-to', '2027-12-31')
  await page.locator('[data-testid="term-confirm"]').click()
  const reopened = await page
    .waitForFunction(
      () => /Until 2027-12-31/i.test(document.querySelector('[data-testid="document-term"]')?.textContent ?? ''),
      undefined,
      { timeout: 20_000 },
    )
    .then(() => true, () => false)
  ok('A term can be extended, and the panel says the new one', reopened)
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/document-term.png`, fullPage: true })

  // ---- A second factor -----------------------------------------------------
  // `users.mfa_enabled` was written by nothing, so there was no second factor anywhere and
  // step-up re-asked for the same password the session was opened with.
  await page.goto(`${BASE}/me`)
  await page.waitForSelector('[data-testid="second-factor"]', { timeout: 15_000 })
  const factorText = await page.locator('[data-testid="second-factor"]').innerText()
  ok('The personal record offers a second factor, and says what it is for',
    /Two-factor sign-in/i.test(factorText) && /stolen session useless/i.test(factorText))
  ok('And says the codes are verified here rather than with anybody else',
    /nothing is sent anywhere/i.test(factorText))

  await page.locator('[data-testid="factor-begin"]').click()
  await page.waitForSelector('[data-testid="factor-enrolment"]', { timeout: 15_000 })
  const secret = (await page.locator('[data-testid="factor-secret"]').innerText()).trim()
  ok('Setting it up shows a secret to add to an authenticator app', secret.length >= 16, `${secret.length} chars`)
  ok('And says nothing is on until a code proves it can be read',
    /Nothing is turned on\s+until a code proves/i.test(
      await page.locator('[data-testid="factor-enrolment"]').innerText(),
    ))

  // A wrong code must not turn it on. The right code is not available to a browser — the
  // arithmetic is exercised against the RFC vectors in the test pack and end to end in the
  // phase-5 loop; what this walk proves is that the screen refuses and stays off.
  await page.fill('#factor-confirm-code', '000000')
  expectingRefusal = true
  await page.locator('[data-testid="factor-confirm"]').click()
  const stayedOff = await page
    .waitForFunction(
      () => /not right/i.test(document.querySelector('[data-testid="second-factor"]')?.textContent ?? ''),
      undefined,
      { timeout: 20_000 },
    )
    .then(() => true, () => false)
  expectingRefusal = false
  ok('A wrong code is refused and leaves it off', stayedOff)
  ok('The account is still reachable, so a failed enrolment is not a lockout',
    !(await page.locator('[data-testid="factor-on"]').count()))
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/second-factor.png`, fullPage: true })

  // Put the demo back. Cancelling is what clears the unproved secret — reloading would leave
  // it behind, and the next run would find a half-finished enrolment it did not start.
  await page.locator('[data-testid="factor-enrolment"] button', { hasText: 'Cancel' }).click()
  const cleared = await page
    .waitForSelector('[data-testid="factor-begin"]', { timeout: 20_000 })
    .then(() => true, () => false)
  ok('An abandoned enrolment can be cancelled, leaving no secret behind', cleared)

  // ---- Deleting a document, and everything derived from it ----------------
  // This is destructive on purpose: it deletes a *seeded* document to exercise the real
  // cascade. The check therefore expects a fresh demo — CI bootstraps the database before
  // it runs — and locally the evals should run before this, not after, because two golden
  // fixtures cite the document this removes.
  await page.goto(`${BASE}/knowledge`)
  await page.waitForSelector('[data-testid="document-row"]', { timeout: 15_000 })
  const documentsBefore = await page.locator('[data-testid="document-row"]').count()
  await page.locator('[data-testid="document-row"] a').first().click()
  await page.waitForSelector('[data-testid="delete-document"]', { timeout: 15_000 })
  await page.locator('[data-testid="delete-document"]').click()
  await page.waitForSelector('[data-testid="delete-document-panel"]', { timeout: 15_000 })
  const deleteText = await page.locator('[data-testid="delete-document-panel"]').innerText()
  ok('Deleting a document says what goes with it',
    /indexed passages/.test(deleteText) && /citations/.test(deleteText) && /memories/.test(deleteText))
  ok('It will not delete without a reason',
    await page.locator('[data-testid="delete-document-confirm"]').isDisabled())
  await page.fill('#delete-reason', 'Superseded by the 2026 policy.')
  await page.locator('[data-testid="delete-document-confirm"]').click()
  await page.waitForURL(/\/knowledge$/, { timeout: 20_000 })
  await page.waitForSelector('[data-testid="document-row"]', { timeout: 15_000 })
  const documentsAfter = await page.locator('[data-testid="document-row"]').count()
  ok('And it is gone from the library', documentsAfter === documentsBefore - 1,
    `${documentsBefore} → ${documentsAfter}`)

  ok('No console errors on any screen', errors.length === 0, errors.slice(0, 3).join(' | '))
} catch (error) {
  failures += 1
  console.error('\n', error)
} finally {
  await browser.close()
}

console.log(failures === 0 ? '\nBrowser check passed.\n' : `\n${failures} browser checks failed.\n`)
process.exitCode = failures === 0 ? 0 : 1
