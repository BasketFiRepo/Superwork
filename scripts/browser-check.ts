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
// "Failed to load resource" on its own is useless; record what actually failed.
page.on('console', (message: ConsoleMessage) => {
  if (message.type() === 'error' && !/Failed to load resource/.test(message.text())) errors.push(message.text())
})
page.on('pageerror', (error) => errors.push(String(error)))
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
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/watchers.png`, fullPage: true })

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

  // ---- Deleting a document, and everything derived from it ----------------
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
