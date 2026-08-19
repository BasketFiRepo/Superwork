/**
 * The debts loop.
 *
 * The specification defines Phases 0–4; Phase 4 (enterprise scale) is the last one. What
 * this drives is the list the README calls "what is deliberately not true yet" — the three
 * things the product itself said were missing once Phase 4 was done:
 *
 *   1. natural-language workflow authoring (§10.3) — describe it, read it back, see the
 *      risks, dry-run it, then and only then activate it, and let the worker fire it on a
 *      schedule evaluated in the company's timezone;
 *   2. approve with edits (§11.2) — correct the artifact on the card, have the corrected
 *      plan re-gated, and have the correction recorded as its own signal;
 *   3. admin-authored HTTP tools (§22) — a tenant's own tool, through the same registry,
 *      the same policy engine, the same approval flow and the same audit trail.
 *
 * It also covers the watchers, which now run on the cadence each declares rather than all
 * at once on a fixed timer.
 *
 * Run with:  pnpm loop:phase5
 */
import { adminSql, closePools, withTenant, type TenantContext } from '@superwork/db'
import {
  beginMfaEnrolment,
  completeMfaLogin,
  confirmMfaEnrolment,
  disableMfa,
  login as signIn,
  mfaStatus,
  resolvePendingSession,
  resolveSession,
  stepUp as proveStepUp,
  totpCode,
  totpCounter,
} from '@superwork/auth'
import { asAgent, can, loadActor, login } from '@superwork/auth'
import { compileWorkflow, loadSystemPrompt, renderPrompt } from '@superwork/ai'
import {
  activateCustomTool,
  activateWorkflow,
  createApproval,
  decideApproval,
  describeCron,
  getWorkflow,
  reminderCount,
  notify,
  setNotificationPreferences,
  checkCapacity,
  setWorkflowLimits,
  getCustomTool,
  listCustomTools,
  setCustomToolLimits,
  listWorkflowRuns,
  reviewHost,
  saveCompiled,
  addDependency,
  acceptInvitation,
  addTeamMember,
  clearFlag,
  flagStates,
  applyRetention,
  approvalPolicies,
  evaluateApprovalPolicies,
  archiveTeam,
  composeBriefingFacts,
  confirmMemory,
  checkSpendLimits,
  createTask,
  createLegalEntity,
  createTeam,
  correctMemory,
  deleteDocument,
  deliverDueNudges,
  documentAudience,
  effectiveLimits,
  getDocument,
  getRun,
  getTask,
  grantDocumentAccess,
  hybridSearch,
  ingestDocument,
  invitationOffer,
  inviteMember,
  jurisdictionHistory,
  listHolds,
  listDocuments,
  listMemories,
  listProjects,
  listSpaces,
  listDisclosures,
  listShares,
  listTasks,
  managerOf,
  openDocumentToEveryone,
  orgChart,
  recallMemories,
  share,
  sharedWith,
  unshare,
  placeHold,
  previewErasure,
  relationship360,
  releaseHold,
  retentionPolicies,
  revokeInvitation,
  saveCustomTool,
  scheduleLadder,
  setFlag,
  setJurisdiction,
  setOrganizationCaps,
  subscription,
  setPolicyEnabled,
  updateTask,
  scheduleFor,
  previewSchedule,
  setWorkflowSchedule,
  trustLedger,
  recordInsightFeedback,
  addProjectMember,
  projectRoster,
  removeProjectMember,
  answerReminder,
  listReminders,
  openLaddersForDueWork,
  addTaskComment,
  createFollowUp,
  listFollowUps,
  listNotifications,
  sweepFollowUps,
  agentGrants,
  addMilestone,
  createProject,
  setProjectStatus,
  setMilestoneStatus,
  archiveDepartment,
  archiveSpace,
  computeProjectHealth,
  createDepartment,
  createSpace,
  listDepartments,
  projectMilestones,
  removeMilestone,
  updateDepartment,
  monitoringPolicy,
  nudgeBudget,
  removeAgentGrant,
  saveView,
  listSavedViews,
  documentIngestions,
  setEffectiveDates,
  knowledgeHealth,
  setRecurrence,
  taskRecurrence,
  listRunMessages,
  ledgerReport,
  monthPeriod,
  spendSnapshot,
  holidaysIn,
  workingCalendarFor,
  restDaysAhead,
  nextWorkingDay,
  isWorkingDay,
  addCalendarDays,
  closeDepartmentDay,
  reopenDepartmentDay,
  organizationProfile,
  updateOrganizationProfile,
  organizationCurrency,
  setGlossaryTerm,
  removeGlossaryTerm,
  formatCents,
  calendarDate,
  ingestionBacklog,
  requestReindex,
  runIngestionJobs,
  reclassifyDocument,
  reclassifyAutomatically,
  uploadDocument,
  setEmbeddingProvider,
  HashingEmbeddingProvider,
  EMBEDDING_DIMENSIONS,
  MAX_ATTEMPTS,
  type EmbeddingProvider,
  deleteSavedView,
  watchTask,
  unwatchTask,
  taskWatchers,
  setAgentGrant,
  setMonitoringPolicy,
} from '@superwork/core'
import { strictestProfile, type JurisdictionProfile } from '@superwork/core'
import {
  checkRateLimit,
  getTool, customToolsFor } from '@superwork/tools'
import {
  continueWorkflowAfterApproval,
  runDueWatchers,
  runDueWorkflows,
  runWatchers,
  mutedWatchers,
  runWorkflow,
  simulateWorkflow,
  watcherSchedules,
  WATCHERS,
} from '@superwork/agent'
import { demoSession } from '@superwork/agent/evals/harness'

/**
 * A working day for the demo's people, as an instant.
 *
 * Reminders are no longer delivered on days nobody works (ADR 0039), so a beat asserting that
 * one arrives has to say *which day* it is talking about. These beats were always
 * date-dependent — running them on a Saturday would have been a lie about a weekday — it
 * simply never showed until the product learned what a weekend is.
 */
const onAWorkingDay = (): Date => {
  const day = nextWorkingDay('uk-england-wales', calendarDate('Europe/London'))
  return new Date(`${day}T12:00:00Z`)
}

/**
 * The moment a ladder says its next rung arrives.
 *
 * A rung is scheduled past a weekend, past a public holiday and now past the recipient's own
 * quiet hours (ADR 0039, ADR 0047), so a beat asserting that one *is delivered* cannot pick an
 * hour of its own: at half past nine in the evening the whole ladder is legitimately held, and
 * the beat would be asserting the opposite of what it means. It asks the rows instead.
 */
const whenTheRungArrives = async (ctx: TenantContext, subjectId: string): Promise<Date> => {
  const [row] = await ctx.sql<{ at: Date | null }[]>`
    SELECT min(scheduled_for) AS at FROM nudges
    WHERE organization_id = ${ctx.organizationId} AND subject_id = ${subjectId}
      AND delivered_at IS NULL AND deleted_at IS NULL`
  return new Date((row?.at ?? new Date()).getTime() + 60_000)
}

const ok = (label: string, condition: boolean, detail = '') => {
  console.log(`  ${condition ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) process.exitCode = 1
  return condition
}

try {
  console.log('\nSuperwork — the debts loop (workflow authoring, approve-with-edits, custom tools)\n')
  const session = await demoSession()

  // ---- 1. Authoring --------------------------------------------------------
  const sentence =
    'Every weekday at 9, find customer threads with no reply for 3 days and draft a follow-up, and tell the account owner.'
  console.log(`Describing an automation:\n  “${sentence}”\n`)

  const compiled = compileWorkflow(sentence)
  ok('It compiles', compiled.unsupported === null, compiled.unsupported ?? '')
  console.log(`\n  Readback: ${compiled.readback}\n`)
  for (const risk of compiled.risks) {
    console.log(`  ! ${risk.message}${risk.mitigation ? ` → ${risk.mitigation}` : ''}`)
  }
  console.log()
  ok('An approval step is inserted for anything that leaves the company',
    compiled.graph.nodes.some((node) => node.type === 'approval'))
  ok('The readback says so in plain English', /approve/i.test(compiled.readback))
  ok('A sentence it cannot build is refused rather than guessed at',
    compileWorkflow('Every morning, handle the renewals somehow.').unsupported !== null)

  const workflowId = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    await ctx.sql`
      UPDATE workflows SET deleted_at = now()
      WHERE organization_id = ${ctx.organizationId} AND name LIKE 'Every weekday at 9%' AND deleted_at IS NULL`
    const saved = await saveCompiled(ctx, actor, { description: sentence, compiled })
    return saved.id
  })

  // ---- 2. The gate ---------------------------------------------------------
  const refused = await withTenant(session, async (ctx) =>
    activateWorkflow(ctx, await loadActor(ctx), { workflowId }).then(
      () => null,
      (error: Error) => error.message,
    ),
  )
  ok('Activation is refused before a dry run', Boolean(refused), refused ?? 'it was allowed')

  console.log('\nDry-running against the last 30 days…\n')
  const dry = await simulateWorkflow(session, { workflowId, windowDays: 30 })
  console.log(`  ${dry.note}\n`)
  for (const step of dry.steps) console.log(`    · ${step.label} — ${step.detail}`)
  console.log()
  ok('The dry run reports a counted number of firings', /fired \d+ times/i.test(dry.note))
  ok('It ran the real query', dry.steps.some((step) => step.nodeType === 'query'))
  ok('Nothing was executed', dry.agentRunId === null && dry.status === 'succeeded')

  const activated = await withTenant(session, async (ctx) =>
    activateWorkflow(ctx, await loadActor(ctx), { workflowId }),
  ).catch(() => null)
  ok('Activation is allowed once the dry run has passed', activated?.status === 'active')

  // ---- 3. A real run stops for a person ------------------------------------
  console.log('\nRunning it for real…\n')
  const live = await runWorkflow(session, { workflowId, trigger: 'manual' })
  console.log(`  ${live.note}\n`)
  ok('A real run prepares work and stops for approval',
    live.status === 'awaiting_approval' && live.approvalId !== null,
    live.error ?? `${live.matched} matched`)

  const runs = await withTenant(session, async (ctx) => listWorkflowRuns(ctx, await loadActor(ctx), { workflowId }))
  ok('Every step is on the record', runs.length >= 2 && runs[0]!.steps.length >= 4, `${runs.length} runs`)
  ok('And every step says how long it took, which nothing wrote before',
    runs[0]!.steps.every((step) => step.durationMs !== null),
    `${runs[0]!.steps.map((step) => step.durationMs).join('ms, ')}ms`)

  // ---- A step that stops says which one, and why (ADR 0053) -----------------
  // The executor's `try` sat outside the node loop, so a node that threw left no row at all:
  // the step list ended at the last thing that worked and nothing said which step was the one.
  // Broken on purpose, for real — the query node is pointed at an aggregate that does not
  // exist, which is what `runAggregate` refuses — and then put back.
  const [queryRef] = await withTenant(session, (ctx) => ctx.sql<{ ref: string }[]>`
    SELECT node->>'ref' AS ref
    FROM workflow_versions v, jsonb_array_elements(v.graph->'nodes') AS node
    WHERE v.organization_id = ${ctx.organizationId} AND v.workflow_id = ${workflowId}
      AND node->>'type' = 'query'
    LIMIT 1`)
  const pointQueryAt = async (ref: string): Promise<void> => {
    await withTenant(session, (ctx) => ctx.sql`
      UPDATE workflow_versions
      SET graph = jsonb_set(graph, '{nodes}', (
            SELECT jsonb_agg(CASE WHEN node->>'type' = 'query'
                                  THEN jsonb_set(node, '{ref}', to_jsonb(${ref}::text))
                                  ELSE node END)
            FROM jsonb_array_elements(graph->'nodes') AS node))
      WHERE organization_id = ${ctx.organizationId} AND workflow_id = ${workflowId}`)
  }

  await pointQueryAt('an_aggregate_that_does_not_exist')
  const broken = await simulateWorkflow(session, { workflowId, windowDays: 30 })
  const brokenStep = broken.steps.find((step) => step.status === 'failed')
  const brokenRows = await withTenant(session, (ctx) => ctx.sql<{ status: string; error: string | null }[]>`
    SELECT status, error FROM workflow_step_runs
    WHERE organization_id = ${ctx.organizationId} AND workflow_run_id = ${broken.runId}
    ORDER BY ordinal`)
  await pointQueryAt(queryRef!.ref)
  const mended = await simulateWorkflow(session, { workflowId, windowDays: 30 })

  ok('The step that stopped a run has a row of its own',
    brokenStep !== undefined && brokenRows.some((row) => row.status === 'failed'),
    `${brokenRows.length} steps recorded, ${brokenRows.filter((r) => r.status === 'failed').length} failed`)
  ok('And it says why, where the reader is already looking',
    (brokenStep?.error ?? '').includes('an_aggregate_that_does_not_exist'),
    brokenStep?.error ?? 'nothing')
  ok('The run says which kind of failure it was, taken from the error',
    broken.failureClass === 'validation', broken.failureClass ?? 'nothing')
  ok('The loop puts the workflow back, and it runs clean again',
    mended.status !== 'failed' && mended.steps.every((step) => step.error === undefined))

  // ---- 4. Approve with edits ----------------------------------------------
  if (live.approvalId) {
    console.log('\nApproving it — with a correction…\n')
    const outcome = await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const [approval] = await ctx.sql<{ preview: { stepId?: string; changes: { editable?: { arg: string } }[] }[] }[]>`
        SELECT preview FROM approvals WHERE organization_id = ${ctx.organizationId} AND id = ${live.approvalId}`
      // The wording is the thing people actually correct, so that is the field this drives.
      const line = approval?.preview.find(
        (entry) => entry.stepId && entry.changes.some((change) => change.editable?.arg === 'body'),
      )
      const arg = line?.changes.find((change) => change.editable?.arg === 'body')?.editable?.arg
      if (!line?.stepId || !arg) return { edited: false, ledger: await trustLedger(ctx) }

      const decided = await decideApproval(ctx, actor, {
        approvalId: live.approvalId!,
        decision: 'approve_with_edits',
        reason: 'Softer close — this account prefers it.',
        edits: { steps: { [line.stepId]: { [arg]: 'Hope the rollout went well — anything you need from us?' } } },
      })
      return { edited: decided.status === 'approved_with_edits', ledger: await trustLedger(ctx), arg }
    })
    ok('The card offers an editable field', 'arg' in outcome && Boolean(outcome.arg))
    ok('Approving with edits is recorded as its own status', outcome.edited)
    ok('The trust ledger counts it as an edit, not an approval',
      outcome.ledger.some((row) => row.edited > 0),
      outcome.ledger.map((row) => `${row.actionType}: ${row.edited} edited`).join(', '))

    const blocked = await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const id = await createApproval(ctx, actor, {
        title: 'Loop check',
        kind: 'loop_check',
        riskTier: 'low',
        preview: [
          {
            operation: 'Draft email',
            entityType: 'email_draft',
            entityLabel: 'check',
            changes: [
              { field: 'To', to: 'someone@example.com' },
              { field: 'Body', to: 'text', editable: { arg: 'body' } },
            ],
            riskTier: 'low',
            reversible: true,
            stepId: 'check-1',
          },
        ],
        evidence: [{ claim: 'Loop check.', sourceType: 'aggregate' }],
        requestedByLabel: 'Superwork',
      })
      return decideApproval(ctx, actor, {
        approvalId: id,
        decision: 'approve_with_edits',
        edits: { steps: { 'check-1': { toAddresses: ['attacker@example.com'] } } },
      }).then(
        () => null,
        (error: Error) => error.message,
      )
    })
    ok('An edit cannot reach a field the card did not offer', Boolean(blocked), blocked ?? 'it was allowed')

    // Resuming is what makes the edit real. The API does this the moment a decision is
    // recorded; here it is called directly so the loop can check that what a person typed
    // is what reached the draft — an edit the executor ignored would be a lie told politely.
    const resumed = await continueWorkflowAfterApproval(session, live.runId)
    console.log(`\n  ${resumed.note}\n`)
    ok('The approved work is then applied', resumed.status === 'succeeded', resumed.error ?? '')

    const drafts = await withTenant(session, async (ctx) => {
      const rows = await ctx.sql<{ body_text: string; status: string }[]>`
        SELECT body_text, status FROM email_drafts
        WHERE organization_id = ${ctx.organizationId} AND agent_run_id = ${resumed.agentRunId}`
      return rows
    })
    ok('The drafts exist', drafts.length > 0, `${drafts.length} drafted`)
    ok('The edited wording is what was written, not the proposed wording',
      drafts.some((draft) => draft.body_text.includes('Hope the rollout went well')))
    ok('Nothing was sent', drafts.every((draft) => draft.status === 'draft'))
  }

  // ---- 4b. The clock -------------------------------------------------------
  console.log('\nPutting it on the clock…\n')
  const schedule = await withTenant(session, (ctx) => scheduleFor(ctx, 'workflow', workflowId))
  ok('Activating put it on a schedule', Boolean(schedule?.enabled),
    schedule ? describeCron(schedule.cron, schedule.timezone) : 'no schedule')
  ok('The schedule is in the company’s timezone, not the server’s', schedule?.timezone === session.timezone,
    schedule?.timezone ?? '—')
  ok('It knows when it next fires', Boolean(schedule?.nextRunAt && schedule.nextRunAt.getTime() > Date.now()),
    schedule?.nextRunAt?.toISOString() ?? '—')

  // An alias is a schedule like any other: it is expanded on the way in and the fields it
  // stands for are what the scheduler sees.
  const previewed = previewSchedule('@daily', session.timezone)
  console.log(`  Preview of @daily: ${previewed.description}`)
  for (const instant of previewed.next) console.log(`    · ${instant.toISOString()}`)
  console.log()
  ok('@daily previews before it is committed to anything', previewed.next.length === 3, previewed.cron)

  const rescheduled = await withTenant(session, async (ctx) =>
    setWorkflowSchedule(ctx, await loadActor(ctx), { workflowId, cron: '@daily', catchUpPolicy: 'run_once' }),
  )
  ok('An alias is stored as the fields it stands for', rescheduled?.cron === '0 0 * * *', rescheduled?.cron ?? '—')
  ok('And it is described in the same English as any other schedule',
    describeCron(rescheduled!.cron, rescheduled!.timezone) === 'every day at 00:00 Europe/London',
    describeCron(rescheduled!.cron, rescheduled!.timezone))

  const refusedCron = await withTenant(session, async (ctx) =>
    setWorkflowSchedule(ctx, await loadActor(ctx), { workflowId, cron: '@reboot' }).then(
      () => null,
      (error: Error) => error.message,
    ),
  )
  ok('A spec that is not a promise about a time is refused by name', Boolean(refusedCron), refusedCron ?? 'it was allowed')

  // Put it back on the schedule the sentence asked for.
  await withTenant(session, async (ctx) =>
    setWorkflowSchedule(ctx, await loadActor(ctx), { workflowId, cron: schedule!.cron }),
  )

  // Everything else in the demo organization comes off the clock so this sweep is about
  // one workflow, and this one is made due a minute ago.
  await withTenant(session, async (ctx) => {
    await ctx.sql`
      UPDATE schedules SET enabled = false
      WHERE organization_id = ${ctx.organizationId} AND kind = 'workflow' AND target_id <> ${workflowId}`
    await ctx.sql`
      UPDATE schedules SET next_run_at = now() - interval '1 minute'
      WHERE organization_id = ${ctx.organizationId} AND kind = 'workflow' AND target_id = ${workflowId}`
  })

  const sweep = await runDueWorkflows(session)
  console.log(
    `  Swept: ${sweep.claimed} due · ${sweep.ran} ran · ${sweep.awaitingApproval} waiting for approval · ` +
      `${sweep.skipped} skipped · ${sweep.failed} failed`,
  )
  for (const note of sweep.notes) console.log(`    · ${note}`)
  console.log()
  ok('The worker fires what is due', sweep.claimed === 1)
  ok('And what it did is either a run or a stated reason', sweep.ran + sweep.skipped === 1,
    sweep.notes.join(' | '))

  const idle = await runDueWorkflows(session)
  ok('A second sweep a moment later fires nothing', idle.claimed === 0)

  // A schedule whose last batch is still waiting is held back rather than piling up.
  const held = await withTenant(session, async (ctx) => {
    const workflow = await getWorkflow(ctx, await loadActor(ctx), workflowId)
    return checkCapacity(ctx, workflow)
  })
  ok('A firing is held back while the last batch waits for a person',
    sweep.awaitingApproval === 0 || !held.allow,
    held.reason || 'nothing outstanding')

  // ---- 4b. The throttle somebody can finally set ---------------------------
  console.log('\nThe two numbers the scheduler enforces…\n')

  const throttle = await (async () => {
    const before = await withTenant(session, async (ctx) =>
      getWorkflow(ctx, await loadActor(ctx), workflowId))

    // Raising widens what runs with nobody watching, so it asks for a fresh proof.
    const raising = await withTenant(session, async (ctx) =>
      setWorkflowLimits(ctx, await loadActor(ctx), {
        workflowId,
        maxConcurrentRuns: before.maxConcurrentRuns + 1,
        dailyActionCap: before.dailyActionCap,
        reason: 'Trying to widen it without proving who I am.',
      }).then(() => 'allowed', (error: Error) => error.constructor.name))

    const tightened = await withTenant(session, async (ctx) =>
      setWorkflowLimits(ctx, await loadActor(ctx), {
        workflowId,
        maxConcurrentRuns: 1,
        dailyActionCap: 12,
        reason: 'A dozen drafts a day is as many as anybody will read.',
      }))

    const unlimited = await withTenant({ ...session, steppedUpAt: new Date() }, async (ctx) =>
      setWorkflowLimits(ctx, await loadActor(ctx), {
        workflowId,
        maxConcurrentRuns: 1,
        dailyActionCap: 1_000_000,
        reason: 'Taking the ceiling off altogether.',
      }).then(() => 'allowed', (error: Error) => error.message))

    const raised = await withTenant({ ...session, steppedUpAt: new Date() }, async (ctx) =>
      setWorkflowLimits(ctx, await loadActor(ctx), {
        workflowId,
        maxConcurrentRuns: 2,
        dailyActionCap: 40,
        reason: 'The Monday backlog needs more than a dozen.',
      }))

    const capacity = await withTenant(session, async (ctx) =>
      checkCapacity(ctx, await getWorkflow(ctx, await loadActor(ctx), workflowId)))

    // Put the demo back on the defaults nobody chose, which is where it started.
    await adminSql()`
      UPDATE workflows SET max_concurrent_runs = ${before.maxConcurrentRuns},
        daily_action_cap = ${before.dailyActionCap}, limits_set_by = NULL, limits_set_at = NULL,
        limits_reason = NULL
      WHERE organization_id = ${session.organizationId} AND id = ${workflowId}`
    await adminSql()`
      DELETE FROM activities WHERE organization_id = ${session.organizationId}
        AND entity_id = ${workflowId} AND verb = 'throttled'`

    return { before, raising, tightened, unlimited, raised, capacity }
  })()

  ok('The numbers a workflow runs under started as defaults nobody chose',
    throttle.before.limitsSetByName === null,
    `${throttle.before.maxConcurrentRuns} at once, ${throttle.before.dailyActionCap} a day`)
  ok('Raising one asks for a fresh proof, because it widens what runs unattended',
    throttle.raising === 'StepUpRequiredError', throttle.raising)
  ok('Lowering one does not, and records who decided and why',
    throttle.tightened.dailyActionCap === 12 && !!throttle.tightened.limitsSetByName,
    throttle.tightened.limitsSetByName ?? 'nobody')
  ok('“Unlimited” cannot be spelled at all', /between 1 and 10000/.test(throttle.unlimited),
    throttle.unlimited.slice(0, 60))
  ok('And the raised number is what the scheduler then counts against',
    throttle.raised.dailyActionCap === 40 && throttle.capacity.remaining === 40 - throttle.capacity.usedToday,
    `${throttle.capacity.remaining} left of 40`)

  // ---- 4c. Watchers keep their own time ------------------------------------
  console.log('\nThe watchers, on the cadence each one declares…\n')
  const watchers = await withTenant(session, (ctx) => watcherSchedules(ctx))
  for (const watcher of watchers) {
    console.log(
      `  · ${watcher.title.padEnd(40)} ${watcher.description.padEnd(38)} next ${watcher.nextRunAt?.toISOString() ?? '—'}`,
    )
  }
  console.log()
  ok('Every watcher has a schedule', watchers.length === WATCHERS.length, `${watchers.length}`)
  ok('It is the cadence the watcher declares in its own source',
    watchers.every((watcher) => watcher.cron === watcher.declaredCron))
  ok('They are not all the same cadence', new Set(watchers.map((w) => w.cron)).size > 1,
    `${new Set(watchers.map((w) => w.cron)).size} distinct cadences`)

  const quiet = await runDueWatchers(session)
  ok('Nothing runs when nothing is due', quiet.claimed === 0)

  await withTenant(session, async (ctx) => {
    await ctx.sql`
      UPDATE schedules SET next_run_at = now() - interval '1 minute'
      WHERE organization_id = ${ctx.organizationId} AND kind = 'watcher' AND target_key = 'overdue_slipping'`
  })
  const watched = await runDueWatchers(session)
  console.log(
    `  Swept: ${watched.claimed} due · ran ${watched.ran.join(', ') || 'none'} · ` +
      `${watched.created} new, ${watched.deduped} already known\n`,
  )
  ok('The one that was due is the one that ran', watched.ran.length === 1 && watched.ran[0] === 'overdue_slipping')
  ok('And it is not run twice for the same firing', (await runDueWatchers(session)).ran.length === 0)

  // ---- 5. Custom tools -----------------------------------------------------
  console.log('\nTeaching Superwork to call one of the company’s own systems…\n')
  // Reviewing a host and activating a tool require step-up authentication (§4.1). The loop
  // runs them on a session that has just re-authenticated, and checks below that a session
  // which has not is refused.
  const refusedWithoutProof = await withTenant(session, async (ctx) =>
    reviewHost(ctx, await loadActor(ctx), { host: 'erp.northwind.example', reason: 'No proof of identity.' }).then(
      () => null,
      (error: Error) => error.message,
    ),
  )
  ok('A system nobody re-confirmed their identity for is not added', Boolean(refusedWithoutProof),
    refusedWithoutProof ?? 'it was allowed')

  const tools = await withTenant({ ...session, steppedUpAt: new Date() }, async (ctx) => {
    const actor = await loadActor(ctx)
    await ctx.sql`
      UPDATE custom_tools SET deleted_at = now()
      WHERE organization_id = ${ctx.organizationId} AND name = 'lookup_order@v1' AND deleted_at IS NULL`
    await ctx.sql`
      UPDATE custom_tool_hosts SET deleted_at = now()
      WHERE organization_id = ${ctx.organizationId} AND host = 'erp.northwind.example' AND deleted_at IS NULL`

    const tool = await saveCustomTool(ctx, actor, {
      name: 'lookup_order@v1',
      description: 'Look up an order in the ERP by its order number.',
      method: 'GET',
      urlTemplate: 'https://erp.northwind.example/api/orders/{orderNumber}',
      parameters: [
        { name: 'orderNumber', type: 'string', in: 'path', required: true, description: 'The order number.' },
      ],
      headers: { Authorization: '${ERP_TOKEN}' },
      riskTier: 'read',
      requiredPermissions: ['integration:read:org'],
    })

    const beforeReview = await activateCustomTool(ctx, actor, tool.id).then(
      () => null,
      (error: Error) => error.message,
    )
    await reviewHost(ctx, actor, {
      host: 'erp.northwind.example',
      reason: 'Our order system. Read-only lookups for support.',
    })
    const active = await activateCustomTool(ctx, actor, tool.id)
    const registry = await customToolsFor(ctx)
    const built = registry.get('lookup_order@v1')

    const viewer = await ctx.sql<{ id: string }[]>`
      SELECT u.id FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ${ctx.organizationId} AND m.role = 'viewer' AND m.deleted_at IS NULL LIMIT 1`
    const viewerActor = viewer[0] ? await loadActor(ctx, viewer[0].id) : null
    const viewerAllowed = viewerActor
      ? can(viewerActor, 'integration:read', {
          type: 'integration',
          organizationId: ctx.organizationId,
          riskTier: 'read',
        }).allow
      : false

    const undeclared = built?.inputSchema.safeParse({ orderNumber: 'A-1', callbackUrl: 'https://evil.example' })
    const listed = await listCustomTools(ctx, actor)
    return { beforeReview, active, built, viewerAllowed, undeclared, listed }
  })

  ok('A tool cannot be activated on a host nobody reviewed', Boolean(tools.beforeReview), tools.beforeReview ?? '')
  ok('Once reviewed, activation records who approved it',
    tools.active.status === 'active' && Boolean(tools.active.approvedByName),
    `${tools.active.approvedByName}`)
  ok('It is an ordinary tool in the registry', tools.built?.name === 'lookup_order@v1')
  ok('It is never advertised as reversible', tools.built?.reversible === false)
  ok('It carries a preview, so it can appear on an approval card', typeof tools.built?.preview === 'function')
  ok('The same policy engine decides who may call it', tools.viewerAllowed === false)
  ok('An argument the definition never declared is dropped', tools.undeclared?.success === false)

  const audited = await withTenant(session, async (ctx) => {
    const rows = await ctx.sql<{ action: string }[]>`
      SELECT action FROM audit_logs
      WHERE organization_id = ${ctx.organizationId} AND action LIKE 'custom_tool%'
      ORDER BY occurred_at DESC LIMIT 5`
    return rows.map((row) => row.action)
  })
  ok('Defining, reviewing and activating are all in the audit trail',
    audited.includes('custom_tool.activated') && audited.includes('custom_tool_host.reviewed'),
    audited.join(', '))


  // ---- The budget every tool declared and nothing enforced -----------------
  console.log('\nHow often a tool may be called…\n')

  const budgets = await (async () => {
    const [tool] = await adminSql()<{ id: string; perRunLimit: number; perHourLimit: number }[]>`
      SELECT id, per_run_limit AS "perRunLimit", per_hour_limit AS "perHourLimit"
      FROM custom_tools
      WHERE organization_id = ${session.organizationId} AND name = 'lookup_order@v1'
        AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`

    const before = await withTenant(session, async (ctx) =>
      getCustomTool(ctx, await loadActor(ctx), tool!.id))

    const tightened = await withTenant(session, async (ctx) =>
      setCustomToolLimits(ctx, await loadActor(ctx), {
        id: tool!.id,
        perRunLimit: 2,
        perHourLimit: 20,
        reason: 'The supplier asked us for no more than twenty an hour.',
      }))

    const raising = await withTenant(session, async (ctx) =>
      setCustomToolLimits(ctx, await loadActor(ctx), {
        id: tool!.id,
        perRunLimit: 2,
        perHourLimit: 40,
        reason: 'Trying to widen it without proving who I am.',
      }).then(() => 'allowed', (error: Error) => error.constructor.name))

    const unlimited = await withTenant({ ...session, steppedUpAt: new Date() }, async (ctx) =>
      setCustomToolLimits(ctx, await loadActor(ctx), {
        id: tool!.id,
        perRunLimit: 2,
        perHourLimit: 999_999,
        reason: 'Taking the ceiling off altogether.',
      }).then(() => 'allowed', (error: Error) => error.message))

    const incoherent = await withTenant(session, async (ctx) =>
      setCustomToolLimits(ctx, await loadActor(ctx), {
        id: tool!.id,
        perRunLimit: 10,
        perHourLimit: 4,
        reason: 'An hour smaller than a run.',
      }).then(() => 'allowed', (error: Error) => error.message))

    // The gate, measured against what this loop has already done: the workflow beat above
    // drafted five emails, so `draft_email@v1` has real calls in the last hour.
    const draft = getTool('draft_email@v1')!
    const { withinItsOwn, withATightOne } = await withTenant(session, async (ctx) => ({
      withinItsOwn: await checkRateLimit(ctx, draft, null),
      withATightOne: await checkRateLimit(
        ctx,
        { name: 'draft_email@v1', rateLimit: { perRun: 1, perOrgPerHour: 1 } },
        null,
      ),
    }))

    // Put the demo back on the defaults nobody chose.
    await adminSql()`
      UPDATE custom_tools SET per_run_limit = 5, per_hour_limit = 200, limits_set_by = NULL,
        limits_set_at = NULL, limits_reason = NULL
      WHERE organization_id = ${session.organizationId} AND id = ${tool!.id}`

    return { before, tightened, raising, unlimited, incoherent, withinItsOwn, withATightOne }
  })()

  ok('A tool that reaches an outside system started on budgets nobody chose',
    budgets.before.limitsSetByName === null,
    `${budgets.before.perRunLimit} per run, ${budgets.before.perHourLimit} an hour`)
  ok('Lowering one records who decided and why',
    budgets.tightened.perHourLimit === 20 && !!budgets.tightened.limitsSetByName,
    budgets.tightened.limitsSetByName ?? 'nobody')
  ok('Raising one asks for a fresh proof, because it reaches further out',
    budgets.raising === 'StepUpRequiredError', budgets.raising)
  ok('“Unlimited” cannot be spelled', /between 1 and 5000/.test(budgets.unlimited),
    budgets.unlimited.slice(0, 60))
  ok('And an hour smaller than a run is refused as incoherent',
    /below the 10 one run may use/i.test(budgets.incoherent), budgets.incoherent.slice(0, 60))
  ok('A tool inside its own declared budget is let through',
    budgets.withinItsOwn.allow,
    `${budgets.withinItsOwn.usedThisHour} calls this hour against ${budgets.withinItsOwn.perHour}`)
  ok('And the same counter stops it once the budget is smaller than the hour',
    !budgets.withATightOne.allow && /in the last hour/i.test(budgets.withATightOne.reason),
    budgets.withATightOne.reason.slice(0, 70))

  // ---- 6. What is kept, and what can be removed ----------------------------
  console.log('\nRetention and erasure…\n')
  const policies = await withTenant(session, async (ctx) => retentionPolicies(ctx, await loadActor(ctx)))
  for (const policy of policies) {
    console.log(`  · ${policy.label.padEnd(34)} ${String(policy.keepDays).padStart(4)} days   ${policy.reason}`)
  }
  console.log()
  ok('Every class Superwork keeps has a window', policies.length >= 7)
  ok('The audit trail is kept longest of all',
    policies.every((p) => p.dataClass === 'audit_logs' || p.keepDays < policies.find((a) => a.dataClass === 'audit_logs')!.keepDays))

  const purge = await withTenant(session, (ctx) => applyRetention(ctx))
  ok('The purge runs and reports what it removed per class', purge.length === policies.length,
    `${purge.reduce((sum, p) => sum + p.purged, 0)} rows removed`)

  // Deleting a document must take its passages and derived memories with it (§25.13).
  const deletion = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const [doc] = await ctx.sql<{ id: string }[]>`
      INSERT INTO documents (organization_id, title, doc_type, sensitivity, index_status, is_demo, created_by)
      VALUES (${ctx.organizationId}, ${`Loop policy ${Date.now()}`}, 'policy', 'internal', 'pending', true, ${session.userId})
      RETURNING id`
    await ingestDocument(ctx, {
      documentId: doc!.id,
      title: 'Loop policy',
      docType: 'policy',
      body: '# Cold chain\n\n## Pre-cooling\n\nReefer units are pre-cooled for 90 minutes before loading.\n',
    })
    const [before] = await ctx.sql<{ chunks: number }[]>`
      SELECT count(*)::int AS chunks FROM document_chunks
      WHERE organization_id = ${ctx.organizationId} AND document_id = ${doc!.id}`
    const removed = await deleteDocument(ctx, actor, { documentId: doc!.id, reason: 'Superseded by the loop.' })
    const [after] = await ctx.sql<{ chunks: number; documents: number }[]>`
      SELECT
        (SELECT count(*)::int FROM document_chunks
          WHERE organization_id = ${ctx.organizationId} AND document_id = ${doc!.id}) AS chunks,
        (SELECT count(*)::int FROM documents
          WHERE organization_id = ${ctx.organizationId} AND id = ${doc!.id}) AS documents`
    return { indexed: before!.chunks, removed, after: after! }
  })
  ok('A document is indexed into passages', deletion.indexed > 0, `${deletion.indexed} passages`)
  ok('Deleting it takes every passage with it', deletion.after.chunks === 0 && deletion.after.documents === 0)
  ok('And says how many went', deletion.removed.chunks === deletion.indexed, `${deletion.removed.chunks} reported`)

  // An erasure says what it would do before it will do anything.
  const erasure = await withTenant(session, async (ctx) => {
    const [member] = await ctx.sql<{ id: string }[]>`
      SELECT m.user_id AS id FROM memberships m
      WHERE m.organization_id = ${ctx.organizationId} AND m.role = 'member' AND m.deleted_at IS NULL
      ORDER BY m.created_at LIMIT 1`
    return previewErasure(ctx, await loadActor(ctx), member!.id)
  })
  ok('An erasure is previewed before anything happens', erasure.lines.length >= 8, `${erasure.lines.length} record types`)
  ok('Every line says what becomes of it and why',
    erasure.lines.every((line) => ['delete', 'anonymise', 'keep'].includes(line.disposition) && line.basis.length > 10))
  ok('Something is kept, with the basis stated', erasure.lines.some((line) => line.disposition === 'keep'))
  ok('The label that outlives them is not their name', !/@/.test(erasure.subjectLabel), erasure.subjectLabel)

  const withoutConfirming = await withTenant(session, async (ctx) => {
    const { erasePerson } = await import('@superwork/core')
    return erasePerson(ctx, await loadActor(ctx), {
      subjectUserId: erasure.subjectUserId,
      reason: 'The loop should not be able to do this.',
    }).then(() => null, (error: Error) => error.message)
  })
  ok('Erasing needs the person to re-confirm who they are', /confirm your password/i.test(withoutConfirming ?? ''),
    withoutConfirming ?? 'it was allowed')

  // ---- And what may not be deleted, however old it is -----------------------
  console.log('\nA matter is opened, and the deleting stops…\n')

  const hold = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    // The demo organization is younger than any retention window, so nothing in it is at
    // risk yet. Without something actually past its window there is nothing for a hold to
    // save, and the assertion below would pass by having nothing to measure.
    const [atRisk] = await ctx.sql<{ id: string }[]>`
      INSERT INTO agent_runs (
        organization_id, principal_user_id, mode, status, request, trace_id, created_by,
        finished_at, created_at
      ) VALUES (
        ${ctx.organizationId}, ${erasure.subjectUserId}, 'ask', 'succeeded',
        'A run from long enough ago to be deleted', ${`trace-hold-${Date.now()}`}, ${session.userId},
        ${new Date(Date.now() - 400 * 86_400_000)}, ${new Date(Date.now() - 400 * 86_400_000)}
      ) RETURNING id`

    // Deliberately the plain session: placing a hold asks for no password, because
    // preserving in a hurry is the point.
    const placed = await placeHold(ctx, actor, {
      matter: 'Ahlgren v. Northwind',
      basis: 'Preservation notice received 2026-03-02 from outside counsel.',
      custodianIds: [erasure.subjectUserId],
      coversFrom: new Date(Date.now() - 900 * 86_400_000),
    })
    const swept = await applyRetention(ctx)
    const blocked = await previewErasure(ctx, actor, erasure.subjectUserId)
    const released = await releaseHold(ctx, actor, {
      holdId: placed.id,
      reason: 'The loop is finished with it.',
    }).then(() => null, (error: Error) => error.message)
    const [survived] = await ctx.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM agent_runs
      WHERE organization_id = ${ctx.organizationId} AND id = ${atRisk!.id}`
    return { placed, swept, blocked, released, survived: survived!.count, all: await listHolds(ctx, actor) }
  })

  ok('A hold is placed without anybody being asked for a password', hold.placed.live, hold.placed.matter)
  ok('It names the matter, the basis, and whose records', hold.placed.basis.length >= 12 && hold.placed.custodianNames.length === 1,
    hold.placed.custodianNames.join(', '))
  ok('The custodian is told, in the record they can already read',
    await withTenant({ ...session, userId: erasure.subjectUserId }, async (ctx) => {
      const { listDisclosures } = await import('@superwork/core')
      const seen = await listDisclosures(ctx, await loadActor(ctx), erasure.subjectUserId)
      return seen.some((entry) => entry.kind === 'legal_hold' && /Ahlgren/.test(entry.summary))
    }))
  ok('A record old enough to be deleted survives the sweep', hold.survived === 1)
  ok('And the sweep says so, rather than keeping it silently',
    hold.swept.some((outcome) => outcome.held > 0),
    `${hold.swept.reduce((sum, o) => sum + o.held, 0)} records kept past their window`)
  ok('Erasing somebody the matter covers is refused, and the matter is named',
    hold.blocked.blockers.some((blocker) => /Ahlgren v\. Northwind/.test(blocker)),
    hold.blocked.blockers[0]?.slice(0, 80) ?? 'it was allowed')
  ok('Letting the deleting resume does need a password', /confirm your password/i.test(hold.released ?? ''),
    hold.released ?? 'it was allowed')
  ok('And the hold is on the record while it stands', hold.all.some((entry) => entry.id === hold.placed.id && entry.live))

  // And then it comes off. The beat used to end with the refusal, which meant every run
  // left a live legal hold on the demo — suspending retention and blocking erasure for one
  // person, for good. A loop that leaves the product in a state it would not choose is not
  // a loop that ran.
  const releasedProperly = await withTenant({ ...session, steppedUpAt: new Date() }, async (ctx) =>
    releaseHold(ctx, await loadActor(ctx), {
      holdId: hold.placed.id,
      reason: 'The matter is closed; the loop is finished with it.',
    }),
  )
  ok('And it comes off once somebody confirms who they are', !releasedProperly.live,
    `released by ${releasedProperly.releasedByName ?? 'nobody'}`)

  // ---- What it learns, and who decides ------------------------------------
  console.log('\nThe assistant notices something, and a person decides…\n')

  const askAbout = async (question: string): Promise<string> => {
    const { startRun, bufferedEvents } = await import('@superwork/agent')
    const started = await startRun(session, { request: question, mode: 'ask', uiContext: { route: '/agent' } })
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      if (bufferedEvents(started.runId).some((event) => event.type === 'run.completed')) break
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return withTenant(session, async (ctx) => (await getRun(ctx, started.runId)).summary ?? '')
  }

  const memoryDoc = await withTenant(session, async (ctx) => {
    // Anything this beat left behind on an earlier run, cleared through the product's own
    // delete. Extraction dedupes: ingesting the same standard twice produces no new
    // candidates, so a run that left its document behind starves the next one of anything
    // to agree with. The beat owns this title, so it is safe to own the cleanup too.
    const stale = await ctx.sql<{ id: string }[]>`
      SELECT id FROM documents
      WHERE organization_id = ${ctx.organizationId} AND title = 'Reefer handling standard'
        AND deleted_at IS NULL`
    for (const old of stale) {
      await deleteDocument(ctx, await loadActor(ctx), {
        documentId: old.id,
        reason: 'Left behind by an earlier run of the acceptance loop.',
      })
    }

    const [doc] = await ctx.sql<{ id: string }[]>`
      INSERT INTO documents (organization_id, title, doc_type, sensitivity, index_status, is_demo, created_by)
      VALUES (${ctx.organizationId}, 'Reefer handling standard', 'policy', 'internal', 'pending', true, ${session.userId})
      RETURNING id`
    await ingestDocument(ctx, {
      documentId: doc!.id,
      title: 'Reefer handling standard',
      docType: 'policy',
      body: '# Reefer handling\n\n## Pre-cooling\n\nReefer units are pre-cooled for 90 minutes before loading.\n',
    })
    return doc!.id
  })

  const firstAnswer = await askAbout('How long are reefer units pre-cooled before loading?')
  const noticed = await withTenant(session, async (ctx) => listMemories(ctx, await loadActor(ctx)))
  ok('Answering from a document leaves something it thinks it learned', noticed.candidates.length > 0,
    noticed.candidates[0] ? `${noticed.candidates[0].subject} ${noticed.candidates[0].predicate} ${noticed.candidates[0].object}` : 'nothing')
  ok('Every candidate carries the passage it came from',
    noticed.candidates.every((fact) => Boolean(fact.citation?.documentId && fact.citation.anchor)))
  // The demo organization already has facts somebody agreed with, so the claim is not
  // "nothing is recalled" — it is that none of what was *just noticed* is.
  const inUse = await withTenant(session, async (ctx) => recallMemories(ctx, await loadActor(ctx)))
  ok('Nothing it merely noticed is in use yet',
    noticed.candidates.every((fact) => !inUse.some((recalled) => recalled.id === fact.id)),
    `${inUse.length} already agreed, none of them from this run`)
  ok('The first answer had to read the document to say it', firstAnswer.length > 0)

  // The candidate this beat agrees with has to come from the document this beat just
  // ingested, and has to be one nothing is already agreed for — the demo is seeded with
  // agreed facts about the same subject, and taking whichever candidate happened to sort
  // first made the beat pass or fail on the order of a list.
  const alreadyAgreed = new Set(inUse.map((fact) => `${fact.subject}|${fact.predicate}`))
  const candidate = noticed.candidates.find(
    (fact) =>
      fact.citation?.documentId === memoryDoc && !alreadyAgreed.has(`${fact.subject}|${fact.predicate}`),
  )
  ok('There is something to agree with that nothing is already agreed for', Boolean(candidate),
    candidate ? `${candidate.subject} ${candidate.predicate}` : 'none from this document')
  if (!candidate) throw new Error('The memory beat has nothing it can agree with.')

  const agreed = await withTenant(session, async (ctx) => confirmMemory(ctx, await loadActor(ctx), candidate.id))
  ok('A person agrees, and is named on it', agreed.state === 'confirmed' && Boolean(agreed.confirmedByName),
    agreed.confirmedByName ?? 'nobody')

  const secondAnswer = await askAbout('How long are reefer units pre-cooled before loading?')
  ok('Asking again answers from what was agreed, and says when it was agreed',
    /agreed on \d{4}-\d{2}-\d{2}/i.test(secondAnswer), secondAnswer.slice(0, 110))

  const corrected = await withTenant(session, async (ctx) =>
    correctMemory(ctx, await loadActor(ctx), {
      id: agreed.id,
      object: '20 minutes',
      reason: 'Renegotiated in the 2026 handling standard.',
    }),
  )
  const history = await withTenant(session, async (ctx) => {
    const [row] = await ctx.sql<{ state: string; object: string; valid_to: Date | null }[]>`
      SELECT state, object, valid_to FROM memory_facts
      WHERE organization_id = ${ctx.organizationId} AND id = ${agreed.id}`
    return row!
  })
  ok('Correcting it supersedes the old answer rather than overwriting it',
    history.state === 'superseded' && corrected.supersedesId === agreed.id)
  ok('The old answer is still there, closed off at the moment it stopped being true',
    history.object === agreed.object && history.valid_to !== null,
    `“${history.object}” until ${history.valid_to?.toISOString().slice(0, 10)}`)

  const forgotten = await withTenant(session, async (ctx) => {
    const removed = await deleteDocument(ctx, await loadActor(ctx), {
      documentId: memoryDoc,
      reason: 'Withdrawn from the handbook.',
    })
    return { removed, recalled: await recallMemories(ctx, await loadActor(ctx)) }
  })
  ok('Deleting the source takes what was learned from it', forgotten.removed.memories > 0,
    `${forgotten.removed.memories} forgotten`)
  ok('And it stops being recalled',
    !forgotten.recalled.some((fact) => fact.citation?.documentId === memoryDoc))

  // Put the demo back. The candidate this beat agreed with can cite a *seeded* document
  // rather than the one the beat made, in which case deleting the beat's document leaves a
  // confirmed fact behind — and the next run of the loop cannot agree with anything on the
  // same subject, because something is already agreed for it. The loop failed on its second
  // run for exactly that reason: a beat that only cleans up what it can see is not clean.
  await withTenant(session, async (ctx) => {
    await ctx.sql`
      UPDATE memory_facts SET deleted_at = now()
      WHERE organization_id = ${ctx.organizationId}
        AND id IN (${agreed.id}, ${corrected.id})
        AND deleted_at IS NULL`
  })

  // ---- Who can find a document --------------------------------------------
  console.log('\nOne document is taken out of general circulation…\n')

  const circulation = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const [doc] = await ctx.sql<{ id: string }[]>`
      INSERT INTO documents (organization_id, title, doc_type, sensitivity, index_status, is_demo, created_by)
      VALUES (${ctx.organizationId}, 'Kestrel settlement terms', 'contract', 'internal', 'pending', true, ${session.userId})
      RETURNING id`
    await ingestDocument(ctx, {
      documentId: doc!.id,
      title: 'Kestrel settlement terms',
      docType: 'contract',
      body: '# Settlement\n\n## Terms\n\nThe zolpidine settlement is paid in four quarterly instalments.\n',
      sensitivityHint: 'internal',
    })
    const [other] = await ctx.sql<{ id: string }[]>`
      SELECT m.user_id AS id FROM memberships m
      WHERE m.organization_id = ${ctx.organizationId} AND m.role = 'member' AND m.deleted_at IS NULL
      ORDER BY m.created_at LIMIT 1`
    return { documentId: doc!.id, otherUserId: other!.id, actorId: actor.userId }
  })

  const canFind = async (userId: string) =>
    withTenant({ ...session, userId }, async (ctx) => {
      const result = await hybridSearch(ctx, await loadActor(ctx), 'zolpidine settlement instalments')
      return result.chunks.some((chunk) => chunk.documentId === circulation.documentId)
    })

  ok('Before anything, a colleague can find it', await canFind(circulation.otherUserId))

  const restricted = await withTenant(session, async (ctx) =>
    grantDocumentAccess(ctx, await loadActor(ctx), {
      documentId: circulation.documentId,
      subjectType: 'user',
      subjectId: circulation.actorId,
      reason: 'Handling the settlement personally.',
    }),
  )
  ok('Naming one person restricts it to that person', restricted.restricted && restricted.entries.length === 1)
  ok('And the colleague can no longer find it', !(await canFind(circulation.otherUserId)))
  ok('While the person named still can', await canFind(circulation.actorId))

  const shared = await withTenant(session, async (ctx) => {
    await share(ctx, await loadActor(ctx), {
      subjectType: 'user',
      subjectId: circulation.otherUserId,
      relation: 'viewer',
      objectType: 'document',
      objectId: circulation.documentId,
      reason: 'Covering next week.',
    })
    return documentAudience(ctx, await loadActor(ctx), circulation.documentId)
  })
  ok('Sharing it puts them on the list rather than only saying it did',
    shared.entries.some((entry) => entry.subjectId === circulation.otherUserId))
  ok('So the share actually works', await canFind(circulation.otherUserId))

  const reopened = await withTenant(session, async (ctx) =>
    openDocumentToEveryone(ctx, await loadActor(ctx), {
      documentId: circulation.documentId,
      reason: 'Settlement executed; the terms are internal now.',
    }),
  )
  ok('Removing the restriction is its own decision, not a side effect', !reopened.restricted)

  // ---- Work that waits for other work -------------------------------------
  console.log('\nOne piece of work waits for another…\n')

  const chain = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const [colleague] = await ctx.sql<{ id: string }[]>`
      SELECT m.user_id AS id FROM memberships m
      WHERE m.organization_id = ${ctx.organizationId} AND m.role = 'member' AND m.deleted_at IS NULL
      ORDER BY m.created_at LIMIT 1`
    const pack = await createTask(ctx, actor, { title: 'Pack the Halden pallet', assigneeId: actor.userId })
    const ship = await createTask(ctx, actor, { title: 'Ship the Halden order', assigneeId: colleague!.id })
    const deps = await addDependency(ctx, actor, {
      taskId: ship.id,
      dependsOnTaskId: pack.id,
      reason: 'Nothing leaves the yard unpacked.',
    })
    return { pack: pack.id, ship: ship.id, colleague: colleague!.id, deps }
  })

  ok('A dependency is recorded in both directions from one edge',
    chain.deps.blockedBy.length === 1 && chain.deps.isBlocked)

  // The rejection is caught outside `withTenant`, not inside it. A statement that fails
  // aborts the transaction, so swallowing the error in the callback leaves the commit to
  // raise it again — the refusal has to be allowed to roll the transaction back.
  const loop = await withTenant(session, async (ctx) =>
    addDependency(ctx, await loadActor(ctx), { taskId: chain.pack, dependsOnTaskId: chain.ship }),
  ).then(() => null, (error: Error) => error.message)
  ok('A loop is refused, because neither task could ever be finished', /never be completed|ever be completed/i.test(loop ?? ''),
    (loop ?? 'it was allowed').slice(0, 90))

  const early = await withTenant(session, async (ctx) =>
    updateTask(ctx, await loadActor(ctx), { id: chain.ship, status: 'completed' }),
  ).then(() => null, (error: Error) => error.message)
  ok('Completing it early is refused, and says what it is waiting on', /Pack the Halden pallet/.test(early ?? ''),
    (early ?? 'it was allowed').slice(0, 90))

  const facts = await withTenant(session, async (ctx) =>
    composeBriefingFacts(ctx, await loadActor(ctx), 'daily'),
  )
  ok('The briefing section that was always empty now says who you are holding up',
    facts.blockingOthers.some((entry) => entry.id === chain.pack),
    `${facts.blockingOthers.length} of your ${facts.blockingOthers.length === 1 ? 'tasks is' : 'tasks are'} blocking somebody`)

  const freed = await withTenant(session, async (ctx) => {
    await updateTask(ctx, await loadActor(ctx), { id: chain.pack, status: 'completed' })
    const [note] = await ctx.sql<{ body: string }[]>`
      SELECT body FROM notifications
      WHERE organization_id = ${ctx.organizationId} AND user_id = ${chain.colleague}
        AND type = 'task_unblocked' AND entity_id = ${chain.ship}`
    const done = await updateTask(ctx, await loadActor(ctx), { id: chain.ship, status: 'completed' })
    return { note: note?.body ?? null, status: done.status }
  })
  ok('Finishing it tells the person who was waiting', Boolean(freed.note), freed.note?.slice(0, 80) ?? 'nobody was told')
  ok('And then it can be completed', freed.status === 'completed')

  // ---- The role that could do nothing --------------------------------------
  console.log('\nA contractor is given exactly one team’s work…\n')

  const guest = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const team = await createTeam(ctx, actor, {
      name: `Loop team ${Date.now()}`,
      purpose: 'Proving the scope is live.',
    })
    const scoped = await createTask(ctx, actor, { title: 'Work only this team can see' })
    await ctx.sql`
      UPDATE tasks SET team_id = ${team.id}
      WHERE organization_id = ${ctx.organizationId} AND id = ${scoped.id}`

    return { teamId: team.id, taskId: scoped.id }
  })

  // A guest: every permission this role holds is team-scoped. The `users` table is not a
  // tenant table, so the account is created on the owning connection, as it is everywhere
  // else that makes one.
  const [contractor] = await adminSql()<{ id: string }[]>`
    INSERT INTO users (email, name, timezone, is_demo)
    VALUES (${`loop.guest.${Date.now()}@northwind.example`}, 'Loop Contractor', 'Europe/London', true)
    RETURNING id`
  await adminSql()`
    INSERT INTO memberships (organization_id, user_id, role, is_demo)
    VALUES (${session.organizationId}, ${contractor!.id}, 'guest', true)`

  const asGuest = { ...session, userId: contractor!.id }
  const seenByGuest = async () =>
    withTenant(asGuest, async (ctx) => {
      const actor = await loadActor(ctx)
      return {
        tasks: (await listTasks(ctx, actor, { limit: 200 })).tasks.map((task) => task.id),
        documents: (await listDocuments(ctx, actor)).length,
      }
    })

  const before = await seenByGuest()
  ok('A guest belonging to no team can read nothing at all',
    before.tasks.length === 0 && before.documents === 0,
    `${before.tasks.length} tasks, ${before.documents} documents`)

  await withTenant(session, async (ctx) =>
    addTeamMember(ctx, await loadActor(ctx), {
      teamId: guest.teamId,
      userId: contractor!.id,
      reason: 'On the loop team for the duration.',
    }),
  )

  const after = await seenByGuest()
  ok('Joining a team gives them that team’s work', after.tasks.includes(guest.taskId))
  ok('And only that team’s work', after.tasks.length === 1, `${after.tasks.length} task visible`)

  const disband = await withTenant(session, async (ctx) =>
    archiveTeam(ctx, await loadActor(ctx), { teamId: guest.teamId, reason: 'The loop is finished.' }),
  ).then(() => null, (error: Error) => error.message)
  ok('A team cannot be disbanded out from under the work scoped to it',
    /still scoped to/i.test(disband ?? ''), (disband ?? 'it was allowed').slice(0, 80))

  // ---- What this organization has, and what one person has --------------
  console.log('\nOne feature is turned off, and one person keeps it…\n')

  const flags = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const start = await flagStates(ctx, actor)
    const off = await setFlag(ctx, actor, {
      flag: 'meetings',
      enabled: false,
      scope: 'organization',
      reason: 'Works council has not signed off on transcription.',
    })
    return { start, off }
  })

  ok('Every flag starts at the product default',
    flags.start.every((state) => state.source === 'default'), `${flags.start.length} flags`)
  ok('An organization can turn one off, with the reason on the row',
    flags.off.find((state) => state.flag === 'meetings')?.effective === false)

  const forColleague = await withTenant({ ...session, userId: contractor!.id }, async (ctx) => {
    const actor = await loadActor(ctx)
    const seen = await flagStates(ctx, actor)
    // A person's own choice sits on top of the organization's — which is right for a
    // preference and is exactly why capabilities do not belong here.
    const mine = await setFlag(ctx, actor, { flag: 'meetings', enabled: true, scope: 'user' })
    return { seen, mine }
  })
  ok('Everybody in the organization sees the change',
    forColleague.seen.find((state) => state.flag === 'meetings')?.effective === false)
  ok('And one person can keep it for themselves',
    forColleague.mine.find((state) => state.flag === 'meetings')?.source === 'you')

  const restored = await withTenant(session, async (ctx) =>
    clearFlag(ctx, await loadActor(ctx), { flag: 'meetings', scope: 'organization' }),
  )
  ok('Clearing an override falls back one layer, not to nothing',
    restored.find((state) => state.flag === 'meetings')?.source === 'default')

  // ---- One thing, given to one person ---------------------------------------
  console.log('\nOne task is handed to one colleague, and taken back…\n')

  const handover = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const task = await createTask(ctx, actor, { title: 'The handover task', assigneeId: actor.userId })
    const given = await share(ctx, actor, {
      subjectType: 'user',
      subjectId: contractor!.id,
      relation: 'viewer',
      objectType: 'task',
      objectId: task.id,
      reason: 'Covering while I am away.',
    })
    return { taskId: task.id, given }
  })

  ok('A task can be shared at all — the list has been looking for shared tasks all along',
    handover.given.objectType === 'task')
  ok('And the grant says what it is, not just a pair of ids', handover.given.objectLabel === 'The handover task',
    handover.given.objectLabel ?? 'no label')

  const asContractor = { ...session, userId: contractor!.id }
  const reached = await withTenant(asContractor, async (ctx) => {
    const actor = await loadActor(ctx)
    return {
      listed: (await listTasks(ctx, actor, { limit: 200 })).tasks.some((t) => t.id === handover.taskId),
      given: await sharedWith(ctx, actor, actor.userId),
    }
  })
  ok('It reaches somebody whose role would not have', reached.listed)
  ok('And they can see why they can see it', reached.given.some((entry) => entry.objectId === handover.taskId),
    reached.given[0] ? `${reached.given[0].objectLabel} · via ${reached.given[0].via}` : 'nothing')

  const notMine = await withTenant(asContractor, async (ctx) =>
    sharedWith(ctx, await loadActor(ctx), session.userId),
  ).then(() => null, (error: Error) => error.message)
  ok('But not what somebody else was given', /shared with you/i.test(notMine ?? ''),
    (notMine ?? 'it was allowed').slice(0, 70))

  const revoked = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    await unshare(ctx, actor, { objectType: 'task', objectId: handover.taskId, tupleId: handover.given.id })
    return listShares(ctx, actor, 'task', handover.taskId)
  })
  ok('Revoking takes it back', revoked.length === 0)
  ok('And the contractor loses it again',
    !(await withTenant(asContractor, async (ctx) =>
      (await listTasks(ctx, await loadActor(ctx), { limit: 200 })).tasks.some((t) => t.id === handover.taskId),
    )))

  // ---- A whole project, and the work inside it ------------------------------
  console.log('\nA project is shared, and the work inside it comes with it…\n')

  const project = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const rows = await listProjects(ctx, actor)
    // A contractor reads up to `public`, and the demo's projects are `internal`. Reclassify
    // one rather than pick around it: sharing an internal project with a guest is *supposed*
    // to leave it shut, and a beat that quietly avoided the case would prove nothing.
    const target = rows[0]!
    await ctx.sql`
      UPDATE projects SET sensitivity = 'public'
      WHERE organization_id = ${ctx.organizationId} AND id = ${target.id}`
    return { id: target.id, name: target.name }
  })

  const beforeShare = await withTenant(asContractor, async (ctx) => {
    const actor = await loadActor(ctx)
    return {
      projects: (await listProjects(ctx, actor)).length,
      tasks: (await listTasks(ctx, actor, { projectId: project.id, limit: 200 })).tasks.length,
    }
  })
  ok('A contractor sees no project of ours to begin with', beforeShare.projects === 0)
  ok('And none of the work in this one', beforeShare.tasks === 0)

  const projectShare = await withTenant(session, async (ctx) =>
    share(ctx, await loadActor(ctx), {
      subjectType: 'user',
      subjectId: contractor!.id,
      relation: 'viewer',
      objectType: 'project',
      objectId: project.id,
      reason: 'Reviewing the delivery plan with us this month.',
    }),
  )
  ok('A project can be shared, and the grant names it', projectShare.objectLabel === project.name,
    projectShare.objectLabel ?? 'no label')

  const afterShare = await withTenant(asContractor, async (ctx) => {
    const actor = await loadActor(ctx)
    const inside = (await listTasks(ctx, actor, { projectId: project.id, limit: 200 })).tasks
    const first = inside[0]
    return {
      projects: (await listProjects(ctx, actor)).map((row) => row.id),
      tasks: inside.length,
      // The list and the page have to agree: anything listed has to open.
      opens: first ? await getTask(ctx, actor, first.id).then(() => true, () => false) : null,
      changes: first
        ? await updateTask(ctx, actor, { id: first.id, title: 'Renamed by a contractor' }).then(
            () => true,
            () => false,
          )
        : null,
    }
  })
  ok('Sharing the project opens the project', afterShare.projects.includes(project.id))
  ok('And the work inside it, or the share was a page with nothing on it', afterShare.tasks > 0,
    `${afterShare.tasks} tasks`)
  ok('Anything they can list, they can open', afterShare.opens !== false)
  ok('But a project lends a read, never a say over the work in it', afterShare.changes !== true)

  // Classify it above them and the share stops reaching, without being revoked. This is the
  // check that found the hole: the project itself was already refused on classification
  // while its tasks — which carry no classification of their own — opened anyway.
  await withTenant(session, async (ctx) => {
    await ctx.sql`
      UPDATE projects SET sensitivity = 'confidential'
      WHERE organization_id = ${ctx.organizationId} AND id = ${project.id}`
  })
  // Read in its own transaction: nested inside the writer, this saw the pre-update row and
  // reported the hole as closed while it was still open.
  const classified = await withTenant(asContractor, async (ctx) =>
    (await listTasks(ctx, await loadActor(ctx), { projectId: project.id, limit: 200 })).tasks.length,
  )
  ok('A share cannot reach inside something they are not cleared to open', classified === 0,
    `${classified} tasks still reachable`)
  await withTenant(session, async (ctx) => {
    await ctx.sql`
      UPDATE projects SET sensitivity = 'public'
      WHERE organization_id = ${ctx.organizationId} AND id = ${project.id}`
  })

  const projectRevoked = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    await unshare(ctx, actor, { objectType: 'project', objectId: project.id, tupleId: projectShare.id })
    return listShares(ctx, actor, 'project', project.id)
  })
  // Assert on our own tuple, not on an empty list: the phase 4 loop shares a project too,
  // and asserting a global count against shared demo state is how a check passes on a clean
  // database and fails on a used one.
  ok('Handing a project back takes the work with it',
    !projectRevoked.some((entry) => entry.id === projectShare.id))
  ok('And they are outside again',
    (await withTenant(asContractor, async (ctx) =>
      listTasks(ctx, await loadActor(ctx), { projectId: project.id, limit: 200 }),
    )).tasks.length === 0)

  // ---- Being on it, which is not the same as being given it ----------------
  console.log('\nAnd then they are put on the project rather than shown it…\n')

  const staffed = await withTenant(session, async (ctx) =>
    addProjectMember(ctx, await loadActor(ctx), {
      projectId: project.id,
      userId: contractor!.id,
      role: 'contributor',
      reason: 'Doing the delivery-plan work with us, not just reading it.',
    }),
  )
  ok('The roster says who is on it, and why', staffed.some((row) => row.userId === contractor!.id),
    staffed.map((row) => `${row.name} ${row.role}`).join(', ').slice(0, 70))
  ok('The owner is on it without anybody adding them',
    staffed.some((row) => row.derived && row.role === 'owner'))

  const onIt = await withTenant(asContractor, async (ctx) => {
    const actor = await loadActor(ctx)
    const inside = (await listTasks(ctx, actor, { projectId: project.id, limit: 200 })).tasks
    const first = inside[0]
    return {
      projects: (await listProjects(ctx, actor)).map((row) => row.id),
      tasks: inside.length,
      why: can(actor, 'project:read', {
        type: 'project',
        id: project.id,
        organizationId: ctx.organizationId,
        sensitivity: 'public',
      }).reason,
      changes: first
        ? await updateTask(ctx, actor, { id: first.id, title: 'Renamed by somebody on it' }).then(
            () => true,
            () => false,
          )
        : null,
    }
  })
  ok('Being on a project opens it, with nobody having shared it', onIt.projects.includes(project.id))
  ok('And reaches the work inside it', onIt.tasks > 0, `${onIt.tasks} tasks`)
  ok('The reason says which of the two it was', /you are on this project/i.test(onIt.why), onIt.why)
  ok('It still lends a read, never a say', onIt.changes !== true)

  const ownerMoved = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const [before] = await ctx.sql<{ ownerId: string }[]>`
      SELECT owner_id AS "ownerId" FROM projects WHERE id = ${project.id}`
    await ctx.sql`UPDATE projects SET owner_id = ${contractor!.id} WHERE id = ${project.id}`
    const handed = await projectRoster(ctx, actor, project.id)
    await ctx.sql`UPDATE projects SET owner_id = ${before!.ownerId} WHERE id = ${project.id}`
    return { handed, back: await projectRoster(ctx, actor, project.id), previous: before!.ownerId }
  })
  ok('Handing the project over moves the owner row with it, written by the database',
    ownerMoved.handed.find((row) => row.userId === contractor!.id)?.role === 'owner')
  ok('And leaves the previous owner on the work rather than off it',
    ownerMoved.handed.find((row) => row.userId === ownerMoved.previous)?.role === 'contributor')

  // Put the demo back: the contractor was on this project for one beat.
  await withTenant(session, async (ctx) =>
    removeProjectMember(ctx, await loadActor(ctx), {
      projectId: project.id,
      userId: contractor!.id,
      reason: 'The delivery-plan work is finished.',
    }),
  )
  const offIt = await withTenant(asContractor, async (ctx) =>
    (await listProjects(ctx, await loadActor(ctx))).length,
  )
  ok('Taking them off takes the read with it', offIt === 0, `${offIt} projects still visible`)
  ok('And the owner is back where they were',
    ownerMoved.back.find((row) => row.userId === ownerMoved.previous)?.role === 'owner')

  // ---- A shelf, and the account it is not ----------------------------------
  console.log('\nA knowledge space is shared, and a company is shared differently…\n')

  const space = await withTenant(session, async (ctx) => {
    const spaces = await listSpaces(ctx, await loadActor(ctx))
    return spaces[0] ?? null
  })
  ok('The seeded knowledge space is read by something at last', space !== null,
    space ? `${space.name} · ${space.documentCount} filed` : 'no spaces')
  ok('And the documents in it kept their shelf through indexing', (space?.documentCount ?? 0) > 0,
    `${space?.documentCount ?? 0} filed`)

  if (space) {
    const spaceShare = await withTenant(session, async (ctx) =>
      share(ctx, await loadActor(ctx), {
        subjectType: 'user',
        subjectId: contractor!.id,
        relation: 'viewer',
        objectType: 'knowledge_space',
        objectId: space.id,
        reason: 'Working through the operating procedures with us.',
      }),
    )
    ok('A knowledge space can be shared at all — the permission catalogue spells it differently',
      spaceShare.objectLabel === space.name, spaceShare.objectLabel ?? 'no label')

    // Pick one and put it back to `internal` first, so this beat asserts the transition
    // rather than a count of the whole shelf. It mutates seeded data, and a check that
    // assumes a fresh database passes once and fails on the next run.
    const candidate = await withTenant(session, async (ctx) => {
      const [row] = await ctx.sql<{ id: string; title: string }[]>`
        SELECT id, title FROM documents
        WHERE organization_id = ${ctx.organizationId} AND space_id = ${space.id}
          AND deleted_at IS NULL AND index_status = 'indexed'
        ORDER BY title LIMIT 1`
      await ctx.sql`UPDATE documents SET sensitivity = 'internal' WHERE id = ${row!.id}`
      await ctx.sql`UPDATE document_chunks SET sensitivity = 'internal' WHERE document_id = ${row!.id}`
      return row!
    })

    // A contractor reads up to `public`, so the shelf opens and what is on it stays shut.
    const stillShut = await withTenant(asContractor, async (ctx) => {
      const actor = await loadActor(ctx)
      return {
        spaces: (await listSpaces(ctx, actor)).map((row) => row.id),
        documents: (await listDocuments(ctx, actor, { spaceId: space.id, limit: 200 })).map((row) => row.id),
      }
    })
    ok('It opens the shelf', stillShut.spaces.includes(space.id))
    ok('While something on it classified above them stays shut',
      !stillShut.documents.includes(candidate.id), `“${candidate.title}” is not readable`)

    // Publish that one — chunks carry their own classification, so retrieval needs both
    // moved or search and the page would disagree about the same document.
    const published = await withTenant(session, async (ctx) => {
      await ctx.sql`UPDATE documents SET sensitivity = 'public' WHERE id = ${candidate.id}`
      await ctx.sql`UPDATE document_chunks SET sensitivity = 'public' WHERE document_id = ${candidate.id}`
      return candidate
    })

    const onTheShelf = await withTenant(asContractor, async (ctx) => {
      const actor = await loadActor(ctx)
      const documents = await listDocuments(ctx, actor, { spaceId: space.id, limit: 200 })
      return {
        documents: documents.map((row) => row.id),
        opens: await getDocument(ctx, actor, published.id).then((doc) => doc.spaceName, () => null),
        cited: (await hybridSearch(ctx, actor, published.title)).chunks.some(
          (chunk) => chunk.documentId === published.id,
        ),
      }
    })
    ok('One they are cleared for comes through', onTheShelf.documents.includes(published.id),
      `${onTheShelf.documents.length} readable · “${published.title}”`)
    ok('Anything listed can be opened, and knows its shelf', onTheShelf.opens === space.name,
      onTheShelf.opens ?? 'refused')
    ok('And the assistant can cite it, so search and the page agree', onTheShelf.cited)

    await withTenant(session, async (ctx) =>
      unshare(ctx, await loadActor(ctx), {
        objectType: 'knowledge_space',
        objectId: space.id,
        tupleId: spaceShare.id,
      }),
    )
    ok('Handing the shelf back takes what was on it',
      (await withTenant(asContractor, async (ctx) =>
        listDocuments(ctx, await loadActor(ctx), { spaceId: space.id, limit: 200 }),
      )).length === 0)
  }

  const account = await withTenant(session, async (ctx) => {
    const [row] = await ctx.sql<{ id: string; name: string }[]>`
      SELECT id, name FROM companies
      WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL ORDER BY name LIMIT 1`
    return row!
  })
  const companyShare = await withTenant(session, async (ctx) =>
    share(ctx, await loadActor(ctx), {
      subjectType: 'user',
      subjectId: contractor!.id,
      relation: 'viewer',
      objectType: 'company',
      objectId: account.id,
      reason: 'Covering this account while David is away.',
    }),
  )
  ok('A company can be shared, and the grant names it', companyShare.objectLabel === account.name,
    companyShare.objectLabel ?? 'no label')

  const asAccount = await withTenant(asContractor, async (ctx) =>
    relationship360(ctx, await loadActor(ctx), account.id),
  )
  ok('It hands over the account view', asAccount.company.id === account.id)
  ok('But a company is not a folder — its work is not handed over with it',
    asAccount.openTasks.length === 0, `${asAccount.openTasks.length} tasks`)
  ok('And neither are documents they could not open themselves',
    asAccount.documents.length === 0, `${asAccount.documents.length} documents`)

  await withTenant(session, async (ctx) =>
    unshare(ctx, await loadActor(ctx), {
      objectType: 'company',
      objectId: account.id,
      tupleId: companyShare.id,
    }),
  )

  // ---- The rules that decide what stops for a person ------------------------
  console.log('\nThe approval rules are read by something at last…\n')

  const rules = await withTenant(session, async (ctx) => approvalPolicies(ctx))
  ok('The seeded policies are loaded rather than decorative', rules.length >= 3,
    rules.map((rule) => rule.name).join(' · '))

  const outbound = evaluateApprovalPolicies(rules, {
    tools: ['send_email@v1'],
    writes: 1,
    riskTier: 'high',
    actorType: 'agent',
    mode: 'execute',
  })
  ok('Outbound mail is routed to a manager by the rule, not by a constant',
    outbound.approverRole === 'manager', outbound.reason)

  const bulk = evaluateApprovalPolicies(rules, {
    tools: ['create_task@v1'],
    writes: 25,
    riskTier: 'low',
    actorType: 'agent',
    mode: 'execute',
  })
  ok('The bulk threshold now comes from the row that always stated it',
    bulk.matched.some((entry) => /bulk/i.test(entry.name)), bulk.matched.map((m) => m.name).join(', '))

  const auto = evaluateApprovalPolicies(rules, {
    tools: ['send_email@v1'],
    writes: 1,
    riskTier: 'high',
    actorType: 'agent',
    mode: 'autopilot',
  })
  ok('Autopilot is refused outright rather than given a card somebody can clear',
    auto.denied && !auto.requiresApproval, auto.reason)

  // The property that is not configurable.
  const withEverythingOff = evaluateApprovalPolicies(
    rules.map((rule) => ({ ...rule, enabled: false })),
    { tools: ['send_email@v1'], writes: 1, riskTier: 'high', actorType: 'agent', mode: 'execute' },
  )
  ok('With every rule switched off, a change is still held for a person',
    withEverythingOff.requiresApproval && !withEverythingOff.denied,
    'there is no configuration that lets a write through unattended')

  const disabling = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    return setPolicyEnabled(ctx, actor, {
      policyId: rules[0]!.id,
      enabled: false,
      reason: 'Testing the control.',
    }).then(() => 'allowed', (error: Error) => error.constructor.name)
  })
  ok('Turning a rule off asks for a password first', disabling === 'StepUpRequiredError', disabling)

  // ---- Who is answerable, and what that is allowed to mean ------------------
  console.log('\nThe seeded org chart is read by something at last…\n')

  const chart = await withTenant(session, async (ctx) => orgChart(ctx, await loadActor(ctx)))
  ok('The reporting lines seeded in migration 0001 are loaded', chart.length >= 10, `${chart.length} lines`)
  ok('Including the dotted one, kept separate from the escalation path',
    chart.some((line) => line.type === 'dotted'))

  const subject = await withTenant(session, async (ctx) => {
    const [row] = await ctx.sql<{ personId: string; personName: string; managerId: string; managerName: string }[]>`
      SELECT r.person_id AS "personId", u.name AS "personName",
             r.manager_id AS "managerId", m.name AS "managerName"
      FROM reporting_relationships r
      JOIN users u ON u.id = r.person_id
      JOIN users m ON m.id = r.manager_id
      WHERE r.organization_id = ${ctx.organizationId} AND r.type = 'functional'
        AND r.valid_to IS NULL AND r.deleted_at IS NULL
      ORDER BY u.name LIMIT 1`
    return row!
  })
  ok('And a person’s escalation path resolves to one person',
    (await withTenant(session, async (ctx) => managerOf(ctx, subject.personId))) === subject.managerId,
    `${subject.personName} → ${subject.managerName}`)

  // The demo runs a works-council profile, which forbids manager escalation entirely.
  const lateTaskId = await withTenant(session, async (ctx) => {
    const [row] = await ctx.sql<{ id: string }[]>`
      INSERT INTO tasks (organization_id, title, status, priority, assignee_id, due_at, is_demo, created_by)
      VALUES (${ctx.organizationId}, ${'The escalation subject'}, 'todo', 'high',
              ${subject.personId}, now() - interval '10 days', true, ${session.userId})
      RETURNING id`
    // They have been contacted about it, three days ago.
    await ctx.sql`
      INSERT INTO nudges (organization_id, recipient_user_id, subject_type, subject_id, stage,
                          channel, message, scheduled_for, delivered_at, created_by)
      VALUES (${ctx.organizationId}, ${subject.personId}, 'task', ${row!.id}, 2, 'in_app',
              'Still open — mark it done, or set a new date.', now() - interval '3 days',
              now() - interval '3 days', ${session.userId})`
    return row!.id
  })

  const underWorksCouncil = await withTenant(session, async (ctx) =>
    scheduleLadder(ctx, {
      recipientUserId: subject.personId,
      subjectType: 'task',
      subjectId: lateTaskId,
      subjectLabel: 'The escalation subject',
      dueAt: new Date(Date.now() - 10 * 86_400_000),
      ownerName: subject.personName,
    }),
  )
  // The manager rung is skipped before a recipient is even considered, so the ladder falls
  // to the waiter rung and finds nobody waiting. Nothing reaches a manager either way.
  ok('Under a works-council profile nothing escalates to a manager at all',
    underWorksCouncil.scheduled === 0, underWorksCouncil.skipped ?? 'something was scheduled')

  // Switch to the profile that permits it, and watch the two rules that were never enforced.
  //
  // The effective profile is the *strictest* across every legal entity, so adding a
  // permissive one changes nothing while a works-council entity is present — and whether
  // one is present depends on whether the phase 4 loop has run first. Every entity is
  // relaxed and every one restored to exactly what it was.
  const entitiesBefore = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const rows = await ctx.sql<{ id: string; profile: string }[]>`
      SELECT id, jurisdiction_profile AS profile FROM legal_entities
      WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL`
    if (rows.length === 0) {
      // Created at the strictest default and then loosened through the supported path, so
      // the history is exercised whether or not the phase 4 loop has left entities behind.
      const created = await createLegalEntity(ctx, actor, { name: 'Loop GmbH', country: 'DE' })
      await setJurisdiction(ctx, actor, {
        legalEntityId: created.id,
        profile: 'gdpr',
        justification: 'Exercising the escalation ladder in the acceptance loop.',
        approvedBy: session.userId,
      })
    } else {
      // Through `setJurisdiction`, not a bare UPDATE. This loop *was* the unaccounted path
      // the history now catches: it relaxed the profile with a plain statement, and the
      // review reported an unexplained change — correctly. Loosening needs a named
      // approver as well as a reason, and this is where that is demonstrated.
      for (const entity of rows) {
        await setJurisdiction(ctx, actor, {
          legalEntityId: entity.id,
          profile: 'gdpr',
          justification: 'Exercising the escalation ladder in the acceptance loop.',
          approvedBy: session.userId,
        })
      }
    }
    return rows
  })

  const tooSoonId = await withTenant(session, async (ctx) => {
    const [row] = await ctx.sql<{ id: string }[]>`
      INSERT INTO tasks (organization_id, title, status, priority, assignee_id, due_at, is_demo, created_by)
      VALUES (${ctx.organizationId}, ${'Not seen yet'}, 'todo', 'high',
              ${subject.personId}, now() - interval '10 days', true, ${session.userId})
      RETURNING id`
    return row!.id
  })
  const tooSoon = await withTenant(session, async (ctx) =>
    scheduleLadder(ctx, {
      recipientUserId: subject.personId,
      subjectType: 'task',
      subjectId: tooSoonId,
      subjectLabel: 'Not seen yet',
      dueAt: new Date(Date.now() - 10 * 86_400_000),
      ownerName: subject.personName,
    }),
  )
  // Matched on the specific refusal, not merely on "nothing was scheduled": the waiter rung
  // also schedules nothing when nobody is waiting, and a loose assertion would pass on it.
  ok('Nothing goes past somebody who has not been told first',
    tooSoon.scheduled === 0 && /have not been contacted/i.test(tooSoon.skipped ?? ''),
    tooSoon.skipped ?? 'it was scheduled anyway')

  const escalated = await withTenant(session, async (ctx) =>
    scheduleLadder(ctx, {
      recipientUserId: subject.personId,
      subjectType: 'task',
      subjectId: lateTaskId,
      subjectLabel: 'The escalation subject',
      dueAt: new Date(Date.now() - 10 * 86_400_000),
      ownerName: subject.personName,
    }),
  )
  ok('Once they have been told and given the window, it escalates', escalated.scheduled === 1,
    escalated.skipped ?? '')

  const routed = await withTenant(session, async (ctx) => {
    const [row] = await ctx.sql<{ recipient: string; about: string | null; stage: number }[]>`
      SELECT recipient_user_id AS recipient, about_user_id AS about, stage FROM nudges
      WHERE organization_id = ${ctx.organizationId} AND subject_id = ${lateTaskId}
        AND delivered_at IS NULL ORDER BY created_at DESC LIMIT 1`
    return row
  })
  ok('And it goes to their manager rather than to them about themselves',
    routed?.recipient === subject.managerId && routed?.about === subject.personId,
    `stage ${routed?.stage} → ${subject.managerName}`)

  // Only this subject. The relaxed profile raises the contact budget for *everybody*, and
  // delivering the whole queue under it would push somebody else's held-back reminders
  // through at a limit their organization does not actually run on.
  await withTenant(session, async (ctx) =>
    deliverDueNudges(ctx, { subjectId: lateTaskId, now: await whenTheRungArrives(ctx, lateTaskId) }),
  )
  const told = await withTenant({ ...session, userId: subject.personId }, async (ctx) =>
    listDisclosures(ctx, await loadActor(ctx), subject.personId),
  )
  ok('And the person it was about sees that it happened, on their own record',
    told.some((entry) => entry.kind === 'manager_rollup'),
    told.filter((entry) => entry.kind === 'manager_rollup').length + ' recorded')

  // The history is read before the cleanup: an entity this loop created is deleted at the
  // end, and its history rows cascade away with it, which is right — an entity that never
  // existed has no history — but it means the assertion has to come first.
  const profileHistory = await withTenant(session, async (ctx) =>
    jurisdictionHistory(ctx, await loadActor(ctx), { limit: 20 }),
  )
  ok('Every profile change this loop made is on the record, with a reason',
    profileHistory.length >= 1 && profileHistory.every((change) => change.justified),
    profileHistory.map((change) => `${change.fromState}→${change.toState}`).join(', ') || 'nothing recorded')
  ok('And the loosening one carries a named approver',
    profileHistory.some((change) => change.loosening) &&
      profileHistory.filter((change) => change.loosening).every((change) => change.approvedByName !== null),
    `${profileHistory.filter((change) => change.loosening).length} loosened`)

  // Put the demo back the way it was found. Both halves matter: the entity goes, and so do
  // the escalations this beat manufactured — the compliance review counts a delivered
  // escalation against the profile in force *now*, so leaving them behind would make the
  // works-council review fail for something that was permitted when it happened.
  const profileAfter = await withTenant(session, async (ctx) => {
    await ctx.sql`
      DELETE FROM disclosures
      WHERE organization_id = ${ctx.organizationId} AND source_type = 'task'
        AND source_id IN (${lateTaskId}, ${tooSoonId})`
    await ctx.sql`
      DELETE FROM nudges
      WHERE organization_id = ${ctx.organizationId} AND subject_id IN (${lateTaskId}, ${tooSoonId})`
    await ctx.sql`
      DELETE FROM tasks
      WHERE organization_id = ${ctx.organizationId} AND id IN (${lateTaskId}, ${tooSoonId})`
    const actor = await loadActor(ctx)
    for (const entity of entitiesBefore) {
      await setJurisdiction(ctx, actor, {
        legalEntityId: entity.id,
        profile: entity.profile as JurisdictionProfile,
        justification: 'Restoring the profile the loop found in place.',
      })
    }
    await ctx.sql`
      DELETE FROM legal_entities
      WHERE organization_id = ${ctx.organizationId} AND name = 'Loop GmbH'`
    const rows = await ctx.sql<{ jurisdictionProfile: JurisdictionProfile }[]>`
      SELECT jurisdiction_profile AS "jurisdictionProfile" FROM legal_entities
      WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL`
    return strictestProfile(rows)
  })
  ok('The demo is left on the profile it started on', profileAfter === 'works_council', profileAfter)



  // ---- Somebody joins the company ------------------------------------------
  console.log('\nA person is added to the organization for the first time…\n')

  const joiner = `loop.joiner.${Math.abs(Number(process.hrtime.bigint() % 1000000n))}@northwind.example`

  const escalationAttempt = await withTenant(session, async (ctx) => {
    // The owner *can* invite an owner; an admin cannot. Prove the rule with the role that
    // the rule is for.
    const [admin] = await ctx.sql<{ id: string }[]>`
      SELECT user_id AS id FROM memberships
      WHERE organization_id = ${ctx.organizationId} AND role = 'admin' AND deleted_at IS NULL LIMIT 1`
    if (!admin) return 'no admin seeded'
    return withTenant({ ...session, userId: admin.id }, async (inner) =>
      inviteMember(inner, await loadActor(inner), {
        email: 'escalation@northwind.example',
        role: 'owner',
        reason: 'Attempting to mint an owner from an admin account.',
      }).then(() => 'allowed', (error: Error) => error.message),
    )
  })
  ok('An admin cannot invite somebody above their own role',
    /above your own role/i.test(escalationAttempt), escalationAttempt.slice(0, 60))

  const issued = await withTenant(session, async (ctx) =>
    inviteMember(ctx, await loadActor(ctx), {
      email: joiner,
      role: 'member',
      reason: 'Joining the renewals team on Monday.',
    }),
  )
  ok('An invitation can be created at all — the table was never read or written', Boolean(issued.token))
  ok('And it is stored as a hash, not as the token',
    await withTenant(session, async (ctx) => {
      const [row] = await ctx.sql<{ hash: string }[]>`
        SELECT token_hash AS hash FROM invitations WHERE id = ${issued.invitation.id}`
      return row!.hash.length === 64 && !row!.hash.includes(issued.token)
    }))

  const offer = await invitationOffer(issued.token)
  ok('The link says who invited them, and to what', offer?.role === 'member' && offer?.email === joiner,
    `${offer?.invitedByName ?? 'nobody'} → ${offer?.role ?? 'nothing'}`)

  const accepted = await acceptInvitation(issued.token, { name: 'Loop Joiner', password: 'a-good-password' })
  ok('Accepting it creates the person and their membership', accepted?.email === joiner)
  ok('And they can sign in with what they chose',
    (await login(joiner, 'a-good-password')) !== null)

  ok('The same link does not work twice',
    (await acceptInvitation(issued.token, { name: 'Again', password: 'a-good-password' })) === null)

  const withdrawn = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const second = await inviteMember(ctx, actor, {
      email: `loop.withdrawn.${Math.abs(Number(process.hrtime.bigint() % 1000000n))}@northwind.example`,
      role: 'viewer',
      reason: 'This one will be called off.',
    })
    await revokeInvitation(ctx, actor, {
      invitationId: second.invitation.id,
      reason: 'They are not joining after all.',
    })
    return second.token
  })
  ok('A withdrawn invitation stops working immediately',
    (await invitationOffer(withdrawn)) === null)

  // Leave the demo as it was found — as far as it can be. The membership and the
  // invitations go; the *user* stays, and cannot be removed: accepting wrote an audit row
  // naming them as the principal, `audit_logs` is append-only, and the foreign key has no
  // cascade. That is the design working. A person who has done something in Superwork
  // cannot be erased by deleting a row, which is why erasure is its own subsystem (ADR
  // 0016) rather than a DELETE.
  await withTenant(session, async (ctx) => {
    await ctx.sql`
      DELETE FROM memberships
      WHERE organization_id = ${ctx.organizationId}
        AND user_id IN (SELECT id FROM users WHERE lower(email) = lower(${joiner}))`
    await ctx.sql`
      DELETE FROM invitations
      WHERE organization_id = ${ctx.organizationId} AND email LIKE 'loop.%@northwind.example'`
  })
  const orphaned = await adminSql()<{ count: number }[]>`
    SELECT count(*)::int FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE lower(u.email) = lower(${joiner}) AND m.deleted_at IS NULL`
  ok('The joiner’s membership is cleaned up, and their audit trail is not',
    orphaned[0]!.count === 0)

  // ---- What the company is paying for, and what that actually limits ---------
  console.log('\nThe plan is read from the database, and it stops things…\n')

  const plan = await withTenant(session, async (ctx) => subscription(ctx, await loadActor(ctx)))
  ok('The seeded subscription is read at last', plan.tier === 'business', `${plan.tier} · ${plan.status}`)
  ok('And the limits come from the table rather than a constant',
    plan.limits.source.limits === 'database', plan.limits.source.limits)
  ok('Seats count the people and the invitations nobody has accepted',
    plan.seatsUsed > 0 && plan.seatsRemaining !== null,
    `${plan.seatsUsed} of ${plan.seatsPurchased} used`)

  // A tenant cannot edit the plans themselves — `plan_limits` is not a tenant table and the
  // application role has no write grant on it. Changing what a plan allows is an operator
  // action, which is exactly right: otherwise a limit is a suggestion.
  const tenantEdit = await withTenant(session, async (ctx) =>
    ctx.sql`UPDATE plan_limits SET ai_spend_cap_cents = 9999 WHERE tier = 'business'`.then(
      () => 'allowed',
      (error: Error) => error.message,
    ),
  ).catch((error: Error) => error.message)
  ok('A tenant cannot rewrite the plans themselves',
    /permission denied/i.test(tenantEdit), tenantEdit.slice(0, 50))

  // The claim the config module always made and nothing honoured: an operator moves it and
  // the running system follows, with no deploy.
  await adminSql()`UPDATE plan_limits SET ai_spend_cap_cents = 9999 WHERE tier = 'business'`
  const withoutDeploy = await withTenant(session, async (ctx) => (await effectiveLimits(ctx)).aiSpendCapCents)
  await adminSql()`UPDATE plan_limits SET ai_spend_cap_cents = 250000 WHERE tier = 'business'`
  ok('A limit changes without a deploy, which the comment always promised',
    withoutDeploy === 9999, `${withoutDeploy}`)

  const raised = await withTenant(session, async (ctx) =>
    setOrganizationCaps(ctx, await loadActor(ctx), {
      aiSpendCapCents: 999_999_999,
      perUserDailyCapCents: null,
      reason: 'Trying to buy more with a form.',
    }).then(() => 'allowed', (error: Error) => error.message),
  )
  ok('An organization cannot raise a cap above its plan',
    /cannot be raised above the plan/i.test(raised), raised.slice(0, 60))

  const tightened = await withTenant(session, async (ctx) =>
    setOrganizationCaps(ctx, await loadActor(ctx), {
      aiSpendCapCents: 1_000,
      perUserDailyCapCents: null,
      reason: 'Trialling the agent on a small budget this month.',
    }),
  )
  ok('But it can tighten one, and the record says who and why',
    tightened.limits.aiSpendCapCents === 1_000 && Boolean(tightened.capsSetByName),
    `${tightened.capsSetByName}: ${tightened.capsReason}`)

  const stopped = await withTenant(session, async (ctx) => {
    await ctx.sql`
      INSERT INTO usage_records (organization_id, user_id, unit, quantity, cost_cents, created_by)
      VALUES (${ctx.organizationId}, ${session.userId}, 'ai_tokens', 1, 1200, ${session.userId})`
    return checkSpendLimits(ctx, 'business')
  })
  ok('And the agent stops at the number on the screen, not the plan’s',
    !stopped.allow && /1,?0?0?\.00|10\.00/.test(stopped.reason), stopped.reason.slice(0, 70))
  ok('The refusal points at a screen that now has the control on it',
    /Settings → Billing/.test(stopped.reason))

  // Put the demo back: the cap and the spend this beat invented.
  await withTenant(session, async (ctx) => {
    await setOrganizationCaps(ctx, await loadActor(ctx), {
      aiSpendCapCents: null,
      perUserDailyCapCents: null,
      reason: 'Restoring the plan’s own limits after the loop.',
    })
    await ctx.sql`
      DELETE FROM usage_records
      WHERE organization_id = ${ctx.organizationId} AND unit = 'ai_tokens' AND cost_cents = 1200`
  })
  const restoredPlan = await withTenant(session, async (ctx) => checkSpendLimits(ctx, 'business'))
  ok('The demo is left running again', restoredPlan.allow)

  // ---- What people said when they threw an insight away ---------------------
  console.log('\nThe question the card has always asked is finally read…\n')

  // Twenty-two of one watcher's insights, every one of them dismissed as *already handled*.
  // Under the rule this replaces — dismissals over 70% — that watcher would be switched off
  // for being right. One person can rate twenty-two different insights; the vote that is
  // capped at one is per insight, not per watcher.
  const rateMany = async (watcher: string, reason: string, count: number) =>
    withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      for (let index = 0; index < count; index += 1) {
        const [row] = await ctx.sql<{ id: string }[]>`
          INSERT INTO insights (
            organization_id, watcher, type, severity, title, body, evidence, entities,
            recommended_actions, dedupe_key, assigned_to, created_by
          ) VALUES (
            ${ctx.organizationId}, ${watcher}, 'loop', 'medium', ${`loop feedback ${watcher} ${index}`},
            'Raised by the acceptance loop.', '[{"claim":"the loop made this","sourceType":"company"}]'::jsonb,
            '[]'::jsonb, '[{"label":"Look","tool":"navigate","args":{"route":"/insights"}}]'::jsonb,
            ${`loop-feedback-${watcher}-${index}`}, ${ctx.userId}, ${ctx.userId}
          )
          ON CONFLICT (organization_id, dedupe_key) WHERE deleted_at IS NULL DO NOTHING
          RETURNING id`
        if (!row) continue
        await recordInsightFeedback(ctx, actor, {
          insightId: row.id,
          helpful: false,
          reason: reason as 'already_handled',
          status: 'dismissed',
        })
      }
    })

  await rateMany('knowledge_gap', 'already_handled', 22)
  await rateMany('approval_aging', 'wrong', 22)

  const verdicts = await withTenant(session, async (ctx) => watcherSchedules(ctx))
  const late = verdicts.find((row) => row.key === 'knowledge_gap')
  const bad = verdicts.find((row) => row.key === 'approval_aging')

  ok('A watcher everybody said was right, and late, keeps running',
    late?.quality?.verdict === 'late' && late.muted === false, late?.quality?.reason.slice(0, 64) ?? '')
  ok('A watcher people said was wrong stops',
    bad?.quality?.verdict === 'muted' && bad.muted === true, bad?.quality?.reason.slice(0, 64) ?? '')

  const feedbackSweep = await runWatchers(session, ['knowledge_gap', 'approval_aging'])
  ok('And the sweep skips the muted one by name, not the late one',
    feedbackSweep.muted.includes('approval_aging') && !feedbackSweep.muted.includes('knowledge_gap'),
    feedbackSweep.muted.join(', '))

  // Put the demo back: twenty-two dismissals apiece is the loop's opinion, not the demo's.
  await withTenant(session, async (ctx) => {
    await ctx.sql`
      DELETE FROM insight_feedback
      WHERE organization_id = ${ctx.organizationId}
        AND insight_id IN (
          SELECT id FROM insights
          WHERE organization_id = ${ctx.organizationId} AND dedupe_key LIKE 'loop-feedback-%')`
    await ctx.sql`
      DELETE FROM insights
      WHERE organization_id = ${ctx.organizationId} AND dedupe_key LIKE 'loop-feedback-%'`
  })
  const afterCleanup = await withTenant(session, async (ctx) => mutedWatchers(ctx))
  ok('The demo is left with nothing muted', !afterCleanup.includes('approval_aging'), afterCleanup.join(', '))

  // ---- A reminder that arrives somewhere, and an answer that means something ----
  console.log('\nSomebody is chased, sees it, and answers…\n')

  const chased = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const [person] = await ctx.sql<{ id: string; name: string }[]>`
      SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ${ctx.organizationId} AND m.role = 'member' AND m.deleted_at IS NULL
      ORDER BY u.name LIMIT 1`
    // Age out today's contacts so the beat is not held back by a budget the earlier beats
    // have already spent on this person.
    await ctx.sql`
      UPDATE nudges SET delivered_at = delivered_at - interval '2 days'
      WHERE organization_id = ${ctx.organizationId} AND recipient_user_id = ${person!.id}
        AND delivered_at > date_trunc('day', now())`
    const task = await createTask(ctx, actor, {
      title: 'loop reminder — send the pre-cool logs',
      assigneeId: person!.id,
      dueAt: new Date(Date.now() - 86_400_000),
    })
    return { person: person!, taskId: task.id }
  })

  const remindersBefore = await withTenant(
    { ...session, userId: chased.person.id },
    async (ctx) => (await listReminders(ctx, await loadActor(ctx))).length,
  )

  // The missing link. Nothing in the product ever called `scheduleLadder`, so the delivery
  // pass ran on an empty queue on every tick and the whole of §29.2 was reachable only from
  // these loops.
  const opened = await withTenant(session, async (ctx) => openLaddersForDueWork(ctx))
  ok('Work that is late has a ladder opened for it by the product, not by a test',
    opened.opened > 0, `${opened.opened} of ${opened.considered} considered`)

  const sent = await withTenant(session, async (ctx) =>
    deliverDueNudges(ctx, { subjectId: chased.taskId, now: await whenTheRungArrives(ctx, chased.taskId) }),
  )
  ok('And the rung that was due is delivered', sent.delivered > 0, `${sent.delivered} delivered`)

  const asPerson = { ...session, userId: chased.person.id }
  const arrived = await withTenant(asPerson, async (ctx) => listReminders(ctx, await loadActor(ctx)))
  const mine = arrived.find((row) => row.subjectId === chased.taskId)
  ok('The person can see what they were sent, which they never could before',
    Boolean(mine) && arrived.length > remindersBefore, mine?.message.slice(0, 60) ?? 'nothing arrived')
  ok('It says what it is about, not just that something is late',
    mine?.subjectLabel === 'loop reminder — send the pre-cool logs')

  const refusedRead = await withTenant(session, async (ctx) =>
    listReminders(ctx, await loadActor(ctx), { userId: chased.person.id }).then(
      () => null,
      (error: Error) => error.message,
    ),
  )
  ok('And nobody else can read it, an admin included', /29\.5|record of that person/i.test(refusedRead ?? ''),
    (refusedRead ?? 'it was allowed').slice(0, 60))

  const answered = await withTenant(asPerson, async (ctx) =>
    answerReminder(ctx, await loadActor(ctx), {
      nudgeId: mine!.id,
      action: 'done',
      note: 'Sent them this morning.',
    }),
  )
  ok('Answering does something to the work itself', /marked done/i.test(answered.effect), answered.effect.slice(0, 60))

  const afterAnswer = await withTenant(session, async (ctx) => {
    const [task] = await ctx.sql<{ status: string }[]>`SELECT status FROM tasks WHERE id = ${chased.taskId}`
    const [open] = await ctx.sql<{ count: number }[]>`
      SELECT count(*)::int FROM nudges
      WHERE organization_id = ${ctx.organizationId} AND subject_id = ${chased.taskId}
        AND cancelled_at IS NULL AND responded_at IS NULL AND deleted_at IS NULL`
    return { status: task!.status, open: open!.count }
  })
  ok('The task is closed by the answer', afterAnswer.status === 'completed', afterAnswer.status)
  // Before this, answering did not touch the ladder: you could say "done" three times and
  // still be escalated to your manager on rung five.
  ok('And the rest of the chasing is called off', afterAnswer.open === 0)

  // Put the demo back: this beat opened ladders across the whole organization.
  await withTenant(session, async (ctx) => {
    await ctx.sql`
      DELETE FROM notifications
      WHERE organization_id = ${ctx.organizationId} AND entity_type = 'nudge'
        AND entity_id IN (SELECT id FROM nudges WHERE created_at > ${new Date(Date.now() - 3_600_000)})`
    await ctx.sql`
      DELETE FROM nudges
      WHERE organization_id = ${ctx.organizationId} AND created_at > ${new Date(Date.now() - 3_600_000)}`
    await ctx.sql`
      DELETE FROM tasks
      WHERE organization_id = ${ctx.organizationId} AND title LIKE 'loop reminder —%'`
  })

  // ---- What the assistant said, and a follow-up that comes back --------------
  console.log('\nThe assistant leaves a note, and a follow-up resurfaces…\n')

  const said = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const task = await createTask(ctx, actor, {
      title: 'loop comment — confirm the addendum',
      assigneeId: session.userId,
    })
    // Written exactly as the agent's tool writes it, into a table nothing has ever read.
    await ctx.sql`
      INSERT INTO task_comments (organization_id, task_id, body, actor_type, is_demo, created_by)
      VALUES (${ctx.organizationId}, ${task.id}, 'Their last reply promised it by Friday.', 'agent', true, ${session.userId})`
    const withMention = await addTaskComment(ctx, actor, {
      taskId: task.id,
      body: 'Can you pick this up while I am away?',
      mentions: [chased.person.id],
    })
    return { taskId: task.id, comments: withMention }
  })

  ok('A note the assistant left on a task is finally visible',
    said.comments.some((row) => row.byAgent && /by Friday/.test(row.body)))
  ok('And it is marked as the assistant’s, not as a colleague’s',
    said.comments.find((row) => row.byAgent)?.authorName !== null)

  // Read from the row rather than from the list: a mention is written the moment it happens,
  // and whether it is *visible* yet is the recipient's own quiet hours talking (ADR 0047).
  const mentioned = await withTenant(session, async (ctx) =>
    ctx.sql<{ url: string; delivery: string; held: boolean; deliverAfter: Date }[]>`
      SELECT url, delivery, deliver_after > now() AS held, deliver_after AS "deliverAfter"
      FROM notifications
      WHERE organization_id = ${ctx.organizationId} AND user_id = ${chased.person.id}
        AND type = 'mention' AND deleted_at IS NULL
      ORDER BY created_at DESC LIMIT 1`)
  const mention = mentioned[0]
  ok('Mentioning somebody reaches them, which the array never did before',
    mention?.url === `/tasks/${said.taskId}`,
    mention
      ? mention.held
        ? `held until ${mention.deliverAfter.toISOString().slice(11, 16)} — their quiet hours`
        : 'delivered now'
      : 'nothing written')

  const followed = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const [thread] = await ctx.sql<{ id: string; lastMessageAt: Date }[]>`
      SELECT id, last_message_at AS "lastMessageAt" FROM conversations
      WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL AND last_direction = 'outbound'
      ORDER BY last_message_at DESC LIMIT 1`
    if (!thread) {
      throw new Error(
        'No outbound thread to chase. The demo has one; a previous run turned it inbound and did not put it back.',
      )
    }
    const made = await createFollowUp(ctx, actor, {
      conversationId: thread.id,
      dueAt: new Date(Date.now() - 3_600_000),
      reason: 'Chase the signed addendum if they have not sent it.',
    })
    const swept = await sweepFollowUps(ctx)
    const mine = await ctx.sql<{ delivery: string; held: boolean }[]>`
      SELECT delivery, deliver_after > now() AS held FROM notifications
      WHERE organization_id = ${ctx.organizationId} AND user_id = ${actor.userId}
        AND type = 'follow_up' AND deleted_at IS NULL`
    return { threadId: thread.id, threadLastMessageAt: thread.lastMessageAt, made, swept, mine }
  })
  ok('A follow-up that is due resurfaces, which is what the tool always promised',
    followed.swept.surfaced > 0 && followed.mine.length > 0,
    `${followed.swept.surfaced} surfaced${followed.mine.some((row) => row.held) ? ', held for their quiet hours' : ''}`)

  const replied = await withTenant(session, async (ctx) => {
    await ctx.sql`
      UPDATE conversations SET last_direction = 'inbound', last_message_at = now()
      WHERE organization_id = ${ctx.organizationId} AND id = ${followed.threadId}`
    const swept = await sweepFollowUps(ctx)
    const all = await listFollowUps(ctx, await loadActor(ctx), {
      conversationId: followed.threadId,
      openOnly: false,
    })
    return { swept, all }
  })
  ok('And one whose customer has written back closes itself rather than chasing them',
    replied.swept.closedByReply > 0 &&
      replied.all.some((row) => row.resolution === 'replied'))

  const queuedToSend = await withTenant(session, async (ctx) => {
    const [row] = await ctx.sql<{ count: number }[]>`
      SELECT count(*)::int FROM outbox
      WHERE organization_id = ${ctx.organizationId} AND created_at > ${new Date(Date.now() - 3_600_000)}`
    return row!.count
  })
  ok('None of it sent anything to the customer', queuedToSend === 0, `${queuedToSend} queued to send`)

  // Put the demo back.
  await withTenant(session, async (ctx) => {
    await ctx.sql`
      DELETE FROM notifications
      WHERE organization_id = ${ctx.organizationId} AND entity_type IN ('follow_up', 'task')
        AND created_at > ${new Date(Date.now() - 3_600_000)}`
    await ctx.sql`
      DELETE FROM follow_ups
      WHERE organization_id = ${ctx.organizationId} AND created_at > ${new Date(Date.now() - 3_600_000)}`
    await ctx.sql`
      DELETE FROM task_comments WHERE organization_id = ${ctx.organizationId} AND task_id = ${said.taskId}`
    await ctx.sql`
      DELETE FROM tasks WHERE organization_id = ${ctx.organizationId} AND title LIKE 'loop comment —%'`
    // The thread was turned inbound to prove a follow-up closes itself when the customer
    // writes back. Left that way it is the only outbound thread the demo has, so the next
    // run of this loop had nothing to chase — which is how a loop stops being repeatable.
    await ctx.sql`
      UPDATE conversations
      SET last_direction = 'outbound', last_message_at = ${followed.threadLastMessageAt}
      WHERE organization_id = ${ctx.organizationId} AND id = ${followed.threadId}`
  })

  // ---- The two ceilings an admin could see and not set ----------------------
  console.log('\nAn admin tightens what the system may do…\n')

  const beforeGovernance = await withTenant(session, async (ctx) =>
    monitoringPolicy(ctx, await loadActor(ctx)),
  )
  ok('The monitoring policy resolves against the jurisdiction rather than a stored copy',
    beforeGovernance.ceiling.nudgeBudgetPerPersonPerDay > 0,
    `${beforeGovernance.jurisdictionProfile} · at most ${beforeGovernance.ceiling.nudgeBudgetPerPersonPerDay}/day`)

  const widened = await withTenant(session, async (ctx) =>
    setMonitoringPolicy(ctx, await loadActor(ctx), {
      nudgeBudgetPerPersonPerDay: 20,
      reason: 'Trying to chase people harder than the jurisdiction allows.',
    }).then(() => null, (error: Error) => error.message),
  )
  ok('An organization cannot chase harder than its jurisdiction allows',
    /never more/i.test(widened ?? ''), (widened ?? 'it was allowed').slice(0, 70))

  const quieter = await withTenant(session, async (ctx) =>
    setMonitoringPolicy(ctx, await loadActor(ctx), {
      nudgeBudgetPerPersonPerDay: 1,
      noSurprisesReviewHours: 72,
      reason: 'Works council asked for a quieter cadence and longer to answer.',
    }),
  )
  ok('But it can chase less, and give people longer to answer',
    quieter.nudgeBudgetPerPersonPerDay === 1 && quieter.noSurprisesReviewHours === 72,
    `${quieter.nudgeBudgetPerPersonPerDay}/day · ${quieter.noSurprisesReviewHours}h`)

  const spent = await withTenant(session, async (ctx) => nudgeBudget(ctx, chased.person.id))
  ok('And the number the ladder spends is the one that was set', spent.perDay === 1, `${spent.perDay}/day`)

  const withoutProof = await withTenant(session, async (ctx) =>
    setAgentGrant(ctx, await loadActor(ctx), {
      capability: 'email',
      toolPattern: 'email:send',
      effect: 'deny',
      reason: 'Nothing leaves this company without a person.',
    }).then(() => null, (error: Error) => error.message),
  )
  ok('Changing what agents may do asks who is at the keyboard',
    /confirm your password/i.test(withoutProof ?? ''), (withoutProof ?? 'it was allowed').slice(0, 60))

  await withTenant({ ...session, steppedUpAt: new Date() }, async (ctx) =>
    setAgentGrant(ctx, await loadActor(ctx), {
      capability: 'email',
      toolPattern: 'email:send',
      effect: 'deny',
      reason: 'Nothing leaves this company without a person pressing send.',
    }),
  )

  const refusedByPolicy = await withTenant(session, async (ctx) => {
    const agentActor = await asAgent(ctx, await loadActor(ctx), {
      agentId: '00000000-0000-0000-0000-0000000000ff',
      agentName: 'Loop agent',
      mode: 'execute',
      toolGrants: ['send_email@v1'],
      maxSensitivity: 'confidential',
    })
    return can(agentActor, 'email:send', {
      type: 'email',
      organizationId: ctx.organizationId,
      riskTier: 'high',
    })
  })
  // A deny row had never denied anything: the actor loader filtered for 'allow' and dropped
  // the rest, so the effect column was decoration.
  ok('A deny line actually refuses, which it never did before',
    !refusedByPolicy.allow && /does not let agents do email:send/i.test(refusedByPolicy.reason),
    refusedByPolicy.reason.slice(0, 70))

  // Put the demo back.
  await withTenant({ ...session, steppedUpAt: new Date() }, async (ctx) => {
    const actor = await loadActor(ctx)
    const grants = await agentGrants(ctx, actor)
    const added = grants.find((row) => row.toolPattern === 'email:send' && row.effect === 'deny')
    if (added) await removeAgentGrant(ctx, actor, { id: added.id, reason: 'The loop is finished with it.' })
    await setMonitoringPolicy(ctx, actor, {
      nudgeBudgetPerPersonPerDay: beforeGovernance.nudgeBudgetPerPersonPerDay,
      noSurprisesReviewHours: beforeGovernance.noSurprisesReviewHours,
      reason: 'Restoring what the jurisdiction requires after the loop.',
    })
  })

  // ---- Three things the product showed and could not make -------------------
  console.log('\nThe structure it was governed by can finally be built…\n')

  const structure = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const made = await createDepartment(ctx, actor, { name: 'Loop Customs' })
    const parent = made.find((row) => row.name === 'Loop Customs')!
    const nested = await createDepartment(ctx, actor, { name: 'Brokerage', parentId: parent.id })
    const renamed = await updateDepartment(ctx, actor, { id: parent.id, name: 'Loop Trade' })
    return { parent, nested, renamed }
  })
  ok('A department can be made, and the database writes its path',
    structure.nested.find((row) => row.name === 'Brokerage')?.path === 'Loop Customs / Brokerage')
  ok('Renaming the parent rewrites everything underneath it',
    structure.renamed.find((row) => row.name === 'Brokerage')?.path === 'Loop Trade / Brokerage',
    structure.renamed.find((row) => row.name === 'Brokerage')?.path ?? 'no path')

  const archiveRefused = await withTenant(session, async (ctx) =>
    archiveDepartment(ctx, await loadActor(ctx), {
      id: structure.parent.id,
      reason: 'Trying to archive one with something in it.',
    }).then(() => null, (error: Error) => error.message),
  )
  ok('And one with something still in it cannot be archived',
    /sub-departments/i.test(archiveRefused ?? ''), (archiveRefused ?? 'it was allowed').slice(0, 70))

  const milestoned = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const projects = await listProjects(ctx, actor)
    const target = projects[0]!
    const before = await computeProjectHealth(ctx, target.id)
    const added = await addMilestone(ctx, actor, {
      projectId: target.id,
      name: 'loop milestone — signed off',
      dueOn: new Date(Date.now() - 2 * 86_400_000),
    })
    const after = await computeProjectHealth(ctx, target.id)
    return { projectId: target.id, added, before, after }
  })
  ok('A milestone can be added to a project at last',
    milestoned.added.some((row) => row.name === 'loop milestone — signed off'))
  // The date is a calendar date in the organization's timezone: casting an instant to
  // ::date in a UTC session lands on yesterday anywhere ahead of UTC, and a milestone due
  // yesterday read as not yet late.
  ok('One past its date is counted late, and the score says so',
    milestoned.after.score < milestoned.before.score,
    `${milestoned.before.score} → ${milestoned.after.score}`)

  const shelved = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const made = await createSpace(ctx, actor, {
      name: 'Loop shelf',
      description: 'Made by the acceptance loop.',
    })
    const space = made.find((row) => row.name === 'Loop shelf')!
    const gone = await archiveSpace(ctx, actor, { id: space.id, reason: 'The loop is finished with it.' })
    return { space, gone }
  })
  ok('A knowledge space can be made, with a slug a link can carry',
    shelved.space.slug === 'loop-shelf', shelved.space.slug)
  ok('And an empty one can be put away again',
    !shelved.gone.some((row) => row.name === 'Loop shelf'))

  // ---- Saved views and watchers -------------------------------------------
  //
  // Each actor gets its own `withTenant`: they are separate transactions on separate
  // connections, and a colleague cannot be shown a row that has not been committed yet.
  const [colleagueId, followableId] = await withTenant(session, async (ctx) => {
    const [colleague] = await ctx.sql<{ id: string }[]>`
      SELECT id FROM users WHERE lower(email) = 'david@northwind.example'`
    const [task] = await ctx.sql<{ id: string }[]>`
      SELECT t.id FROM tasks t
      WHERE t.organization_id = ${ctx.organizationId} AND t.deleted_at IS NULL
        AND t.assignee_id = ${colleague!.id} AND t.status NOT IN ('completed', 'cancelled')
      ORDER BY t.created_at LIMIT 1`
    return [colleague!.id, task!.id] as const
  })
  const colleagueSession = { ...session, userId: colleagueId }

  const savedView = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    // Saving the same name twice is a correction, not a second menu entry.
    await saveView(ctx, actor, { name: 'Loop view', entity: 'task', query: { filter: 'mine' } })
    const views = await saveView(ctx, actor, {
      name: 'loop VIEW ',
      entity: 'task',
      query: { filter: 'blocked' },
      shared: true,
    })
    await watchTask(ctx, actor, followableId)
    return views.filter((row) => row.name.toLowerCase().trim() === 'loop view')
  })
  ok('A list screen can be asked a question once and keep it',
    savedView.length === 1 && savedView[0]!.query.filter === 'blocked',
    `${savedView.length} entry named “Loop view”`)

  const theirs = await withTenant(colleagueSession, async (ctx) => {
    const them = await loadActor(ctx)
    const offered = await listSavedViews(ctx, them, 'task')
    const refusal = await deleteSavedView(ctx, them, { id: savedView[0]!.id }).then(
      () => null,
      (error: Error) => error.message,
    )
    // Two changes to work Maya is following: one worth interrupting her for, one not.
    await updateTask(ctx, them, { id: followableId, priority: 'high' })
    await updateTask(ctx, them, { id: followableId, status: 'in_progress' })
    return { offered: offered.some((row) => row.id === savedView[0]!.id), refusal }
  })
  ok('Sharing it offers a colleague the question, not the rows', theirs.offered)
  ok('And the view stays its maker’s to change',
    theirs.refusal !== null && /belongs to somebody else/i.test(theirs.refusal ?? ''))

  const following = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const watchers = await taskWatchers(ctx, actor, followableId)
    const [told] = await ctx.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM notifications
      WHERE organization_id = ${ctx.organizationId} AND user_id = ${actor.userId}
        AND type = 'task_changed' AND entity_id = ${followableId}`

    // Put the demo back.
    await unwatchTask(ctx, actor, followableId)
    await deleteSavedView(ctx, actor, { id: savedView[0]!.id })
    await ctx.sql`
      DELETE FROM notifications
      WHERE organization_id = ${ctx.organizationId} AND user_id = ${actor.userId}
        AND type = 'task_changed' AND entity_id = ${followableId}`
    await ctx.sql`
      UPDATE tasks SET status = 'todo', priority = 'medium'
      WHERE organization_id = ${ctx.organizationId} AND id = ${followableId}`

    return { watching: watchers.some((row) => row.isYou), told: Number(told!.count) }
  })
  ok('Work somebody else is carrying can be followed', following.watching)
  // Two updates, one message: a priority change is not worth interrupting somebody for.
  ok('A follower hears when it moves, once, and not about every edit',
    following.told === 1, `${following.told} notification`)

  // Put the demo back.
  await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const milestones = await projectMilestones(ctx, milestoned.projectId)
    const mine = milestones.find((row) => row.name === 'loop milestone — signed off')
    if (mine) await removeMilestone(ctx, actor, { projectId: milestoned.projectId, milestoneId: mine.id })
    const departments = await listDepartments(ctx, actor)
    for (const name of ['Brokerage', 'Loop Trade']) {
      const row = departments.find((entry) => entry.name === name)
      if (row) await archiveDepartment(ctx, actor, { id: row.id, reason: 'The loop is finished with it.' })
    }
  })


  // ---- The work a milestone is made of -------------------------------------
  console.log('\nA milestone with work underneath it…\n')

  const underneath = await (async () => {
    const projectId = milestoned.projectId
    return withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      // Its own milestone: the one the beat above added has already been put back.
      const added = await addMilestone(ctx, actor, {
        projectId,
        name: 'loop milestone — the work underneath',
        dueOn: new Date(Date.now() + 10 * 86_400_000),
      })
      const target = added.find((row) => row.name === 'loop milestone — the work underneath')!
      const before = target

      // Two pieces of the project's own work, one of them due after the milestone is.
      const onTime = await createTask(ctx, actor, {
        title: 'loop — fit the probes',
        projectId,
        dueAt: new Date(Date.now() - 5 * 86_400_000),
      })
      const late = await createTask(ctx, actor, {
        title: 'loop — sign the pilot off',
        projectId,
        dueAt: new Date(Date.now() + 20 * 86_400_000),
      })
      await updateTask(ctx, actor, { id: onTime.id, milestoneId: target.id })
      await updateTask(ctx, actor, { id: late.id, milestoneId: target.id })
      const withWork = (await projectMilestones(ctx, projectId)).find((row) => row.id === target.id)!

      // A milestone of another project is refused, because a milestone is one project's promise.
      const [otherProject] = await ctx.sql<{ id: string }[]>`
        SELECT id FROM projects
        WHERE organization_id = ${ctx.organizationId} AND id <> ${projectId} AND deleted_at IS NULL
        LIMIT 1`
      const elsewhere = await addMilestone(ctx, actor, {
        projectId: otherProject!.id,
        name: 'loop milestone — somewhere else',
        dueOn: new Date(Date.now() + 30 * 86_400_000),
      })
      const crossed = await updateTask(ctx, actor, {
        id: onTime.id,
        milestoneId: elsewhere.find((row) => row.name === 'loop milestone — somewhere else')!.id,
      }).then(() => 'allowed', (error: Error) => error.message)

      // And "reached" is refused while its work is open.
      const early = await setMilestoneStatus(ctx, actor, {
        projectId,
        milestoneId: target.id,
        status: 'done',
      }).then(() => 'allowed', (error: Error) => error.message)

      await updateTask(ctx, actor, { id: onTime.id, status: 'completed' })
      await updateTask(ctx, actor, { id: late.id, status: 'completed' })
      const reached = await setMilestoneStatus(ctx, actor, {
        projectId,
        milestoneId: target.id,
        status: 'done',
      })

      // Put the demo back: both tasks, both milestones.
      for (const task of [onTime, late]) {
        await ctx.sql`DELETE FROM activities WHERE organization_id = ${ctx.organizationId} AND entity_id = ${task.id}`
        await ctx.sql`DELETE FROM tasks WHERE organization_id = ${ctx.organizationId} AND id = ${task.id}`
      }
      await removeMilestone(ctx, actor, { projectId, milestoneId: target.id })
      await removeMilestone(ctx, actor, {
        projectId: otherProject!.id,
        milestoneId: elsewhere.find((row) => row.name === 'loop milestone — somewhere else')!.id,
      })

      return { before, withWork, crossed, early, reached: reached.find((row) => row.id === target.id)! }
    })
  })()

  ok('A milestone starts as a date with nothing underneath it',
    underneath.before.taskCount === 0)
  ok('Work can be filed against it, and it counts what it is waiting on',
    underneath.withWork.taskCount === 2 && underneath.withWork.openCount === 2,
    `${underneath.withWork.taskCount} filed`)
  ok('It says which of its work is already late, and which lands after the date itself',
    underneath.withWork.overdueCount === 1 && underneath.withWork.dueAfterCount === 1,
    `${underneath.withWork.overdueCount} late, ${underneath.withWork.dueAfterCount} due after it`)
  ok('A milestone of another project is refused, because it is one project’s promise',
    /belongs to another project/i.test(underneath.crossed), underneath.crossed.slice(0, 60))
  ok('“Reached” is refused while its work is still open',
    /still has 2 tasks open/i.test(underneath.early), underneath.early.slice(0, 70))
  ok('And once the work is finished, reaching it is what the word then means',
    underneath.reached.status === 'done' && underneath.reached.openCount === 0)


  // ---- Indexing that survives the request that asked for it ----------------
  console.log('\nA document that will not index…\n')

  /** Fails where a provider outage does: at embed time, after the version row is written. */
  class BrokenEmbedder implements EmbeddingProvider {
    readonly name = 'loop-broken'
    readonly dimensions = EMBEDDING_DIMENSIONS
    async embed(): Promise<number[][]> {
      throw new Error('The embedding provider did not respond.')
    }
  }

  const indexedDoc = await withTenant(session, async (ctx) => {
    const [row] = await ctx.sql<{ id: string; title: string }[]>`
      SELECT id, title FROM documents
      WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
        AND current_version_id IS NOT NULL AND index_status = 'indexed'
      ORDER BY created_at LIMIT 1`
    return row!
  })

  await withTenant(session, async (ctx) => {
    await requestReindex(ctx, await loadActor(ctx), {
      documentId: indexedDoc.id,
      reason: 'The acceptance loop asked.',
    })
  })

  setEmbeddingProvider(new BrokenEmbedder())
  const firstTry = await runIngestionJobs(session)
  const afterOne = await withTenant(session, async (ctx) =>
    documentIngestions(ctx, await loadActor(ctx), indexedDoc.id),
  )
  ok('A failed indexing is recorded rather than lost with the transaction',
    firstTry.failed === 1 && afterOne[0]!.status === 'failed',
    afterOne[0]!.lastError ?? '')
  ok('And it is coming back for it, so nobody is asked to do anything yet',
    afterOne[0]!.nextAttemptAt !== null && !afterOne[0]!.gaveUp)

  // Backoff is real time; the loop pulls each round forward rather than waiting for it, so
  // the claim query under test is the real one.
  for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt++) {
    await withTenant(session, async (ctx) => {
      await ctx.sql`
        UPDATE ingestion_jobs SET next_attempt_at = now() - interval '1 minute'
        WHERE organization_id = ${ctx.organizationId} AND document_id = ${indexedDoc.id}
          AND finished_at IS NULL`
    })
    await runIngestionJobs(session)
  }

  const gaveUp = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    return { history: await documentIngestions(ctx, actor, indexedDoc.id), backlog: await ingestionBacklog(ctx, actor) }
  })
  ok('It stops after five tries instead of retrying for ever in silence',
    gaveUp.history[0]!.gaveUp && gaveUp.history[0]!.attempts === MAX_ATTEMPTS,
    `${gaveUp.history[0]!.attempts} attempts`)
  ok('And it is on the screen somebody looks at, waiting for a person',
    gaveUp.backlog.gaveUp === 1)

  setEmbeddingProvider(new HashingEmbeddingProvider())
  const retried = await withTenant(session, async (ctx) =>
    requestReindex(ctx, await loadActor(ctx), { documentId: indexedDoc.id }),
  )
  ok('A person can try again, and what it already spent stays on the record',
    retried[0]!.status === 'pending' && retried[0]!.attempts === MAX_ATTEMPTS)

  const recovered = await runIngestionJobs(session)
  const settled = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    return { history: await documentIngestions(ctx, actor, indexedDoc.id), backlog: await ingestionBacklog(ctx, actor) }
  })
  ok('And the document goes back into memory, with what the check found',
    recovered.indexed === 1 && settled.history[0]!.status === 'indexed' &&
      (settled.history[0]!.verification?.sampled ?? 0) > 0,
    `${settled.history[0]!.chunksWritten} sections`)
  ok('Nothing is left waiting behind it', settled.backlog.gaveUp === 0 && settled.backlog.waiting === 0)

  // Put the demo back: the loop's own job rows go, the document stays indexed.
  await withTenant(session, async (ctx) => {
    await ctx.sql`
      DELETE FROM ingestion_jobs
      WHERE organization_id = ${ctx.organizationId} AND document_id = ${indexedDoc.id}
        AND reason LIKE '%loop%'`
    await ctx.sql`
      DELETE FROM ingestion_jobs
      WHERE organization_id = ${ctx.organizationId} AND document_id = ${indexedDoc.id}
        AND reason LIKE 'Re-index asked for by%'`
    await ctx.sql`
      DELETE FROM activities
      WHERE organization_id = ${ctx.organizationId} AND entity_id = ${indexedDoc.id} AND verb = 'failed'`
  })


  // ---- The days people do not work ----------------------------------------
  console.log('\nA reminder that comes due on Christmas Day…\n')

  const workingDays = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const departments = await listDepartments(ctx, actor)
    const operations = departments.find((row) => row.name === 'Operations')!

    // A sub-department inherits rather than restating it: a company says where it is once.
    const made = await createDepartment(ctx, actor, { name: 'Loop Customs', parentId: operations.id })
    const child = made.find((row) => row.name === 'Loop Customs')!

    const person = await workingCalendarFor(ctx, actor.userId)

    // A real reminder, dated for a real bank holiday, delivered through the real gate.
    const [task] = await ctx.sql<{ id: string }[]>`
      INSERT INTO tasks (organization_id, title, status, priority, assignee_id, due_at, is_demo, created_by)
      VALUES (${ctx.organizationId}, 'loop working day — pre-cool the trailer', 'todo', 'medium',
              ${actor.userId}, ${new Date('2026-12-25T09:00:00Z')}, true, ${ctx.userId})
      RETURNING id`
    await ctx.sql`
      INSERT INTO nudges (
        organization_id, recipient_user_id, subject_type, subject_id, stage, channel, message,
        actions, scheduled_for, is_demo, created_by
      ) VALUES (
        ${ctx.organizationId}, ${actor.userId}, 'task', ${task!.id}, 2, 'in_app',
        'loop working day — pre-cool the trailer — still open.', '["done"]'::jsonb,
        ${new Date('2026-12-25T09:00:00Z')}, true, ${ctx.userId}
      )`

    const onTheDay = await deliverDueNudges(ctx, {
      now: new Date('2026-12-25T10:00:00Z'),
      subjectId: task!.id,
    })
    const [heldRow] = await ctx.sql<{ heldReason: string | null; deliveredAt: Date | null }[]>`
      SELECT held_reason AS "heldReason", delivered_at AS "deliveredAt" FROM nudges
      WHERE organization_id = ${ctx.organizationId} AND subject_id = ${task!.id}`

    const afterwards = await deliverDueNudges(ctx, {
      now: new Date('2026-12-29T10:00:00Z'),
      subjectId: task!.id,
    })

    // ---- A day this department names for itself (ADR 0051) -------------------
    // The four calendars are national ones. This is the shutdown week, the day the depot
    // moves, the holiday of a country none of them covers. Worked out from today rather than
    // written down, because closing a day that has gone is refused.
    let closedDay = new Date(Date.now() + 50 * 86_400_000).toISOString().slice(0, 10)
    while (!isWorkingDay(person.calendarId, closedDay)) closedDay = addCalendarDays(closedDay, 1)

    const [mine] = await ctx.sql<{ departmentId: string | null }[]>`
      SELECT department_id AS "departmentId" FROM memberships
      WHERE organization_id = ${ctx.organizationId} AND user_id = ${actor.userId}
        AND deleted_at IS NULL AND status = 'active' LIMIT 1`

    const closedList = await closeDepartmentDay(ctx, actor, {
      departmentId: mine!.departmentId!,
      date: closedDay,
      label: 'loop stocktake shutdown',
    })
    const closure = closedList
      .find((row) => row.id === mine!.departmentId)!
      .closures.find((row) => row.date === closedDay)
    const whileClosed = await workingCalendarFor(ctx, actor.userId)

    const [stocktakeTask] = await ctx.sql<{ id: string }[]>`
      INSERT INTO tasks (organization_id, title, status, priority, assignee_id, due_at, is_demo, created_by)
      VALUES (${ctx.organizationId}, 'loop closed day — count the reefers', 'todo', 'medium',
              ${actor.userId}, ${new Date(`${closedDay}T09:00:00Z`)}, true, ${ctx.userId})
      RETURNING id`
    await ctx.sql`
      INSERT INTO nudges (
        organization_id, recipient_user_id, subject_type, subject_id, stage, channel, message,
        actions, scheduled_for, is_demo, created_by
      ) VALUES (
        ${ctx.organizationId}, ${actor.userId}, 'task', ${stocktakeTask!.id}, 2, 'in_app',
        'loop closed day — count the reefers — still open.', '["done"]'::jsonb,
        ${new Date(`${closedDay}T09:00:00Z`)}, true, ${ctx.userId}
      )`

    const onTheClosedDay = await deliverDueNudges(ctx, {
      now: new Date(`${closedDay}T10:00:00Z`),
      subjectId: stocktakeTask!.id,
    })
    const [closedHeld] = await ctx.sql<{ heldReason: string | null; deliveredAt: Date | null }[]>`
      SELECT held_reason AS "heldReason", delivered_at AS "deliveredAt" FROM nudges
      WHERE organization_id = ${ctx.organizationId} AND subject_id = ${stocktakeTask!.id}`

    // Reopening is the widening direction: people are chased on a day the company had said it
    // was shut. The row stays, saying who did it and why.
    await reopenDepartmentDay(ctx, actor, {
      closureId: closure!.id,
      reason: 'The loop is finished with it.',
    })
    const afterReopening = await workingCalendarFor(ctx, actor.userId)
    const onceOpenAgain = await deliverDueNudges(ctx, {
      now: new Date(`${closedDay}T11:00:00Z`),
      subjectId: stocktakeTask!.id,
    })

    await ctx.sql`DELETE FROM notifications WHERE organization_id = ${ctx.organizationId} AND entity_id IN (
      SELECT id FROM nudges WHERE organization_id = ${ctx.organizationId} AND subject_id = ${stocktakeTask!.id})`
    await ctx.sql`DELETE FROM nudges WHERE organization_id = ${ctx.organizationId} AND subject_id = ${stocktakeTask!.id}`
    await ctx.sql`DELETE FROM tasks WHERE organization_id = ${ctx.organizationId} AND id = ${stocktakeTask!.id}`

    // Put the demo back.
    await ctx.sql`DELETE FROM notifications WHERE organization_id = ${ctx.organizationId} AND entity_id IN (
      SELECT id FROM nudges WHERE organization_id = ${ctx.organizationId} AND subject_id = ${task!.id})`
    await ctx.sql`DELETE FROM nudges WHERE organization_id = ${ctx.organizationId} AND subject_id = ${task!.id}`
    await ctx.sql`DELETE FROM tasks WHERE organization_id = ${ctx.organizationId} AND id = ${task!.id}`
    await archiveDepartment(ctx, actor, { id: child.id, reason: 'The loop is finished with it.' })

    return {
      child,
      person,
      onTheDay,
      heldRow: heldRow!,
      afterwards,
      closedDay,
      closure,
      whileClosed,
      onTheClosedDay,
      closedHeld: closedHeld!,
      afterReopening,
      onceOpenAgain,
    }
  })

  ok('A company says where it is once, and everything underneath inherits it',
    workingDays.child.holidayCalendar === null &&
      workingDays.child.effectiveHolidayCalendar === 'uk-england-wales' &&
      workingDays.child.holidayCalendarFrom === 'Operations',
    `${workingDays.child.name} ← ${workingDays.child.holidayCalendarFrom}`)
  ok('The bank holidays are worked out rather than guessed at',
    holidaysIn('uk-england-wales', 2026).get('2026-04-03') === 'Good Friday' &&
      holidaysIn('uk-england-wales', 2027).get('2027-12-27') === 'Christmas Day')
  ok('A person can see which days they will not be chased on',
    workingDays.person.calendarId === 'uk-england-wales' && restDaysAhead(workingDays.person).length > 0)
  ok('A reminder due on a bank holiday is not delivered, and says why',
    workingDays.onTheDay.heldByCalendar === 1 && workingDays.heldRow.deliveredAt === null,
    workingDays.heldRow.heldReason ?? '')
  ok('And it arrives on the next working day rather than being lost',
    workingDays.afterwards.delivered === 1)
  ok('A department can name a day of its own that no calendar knows about',
    workingDays.closure?.label === 'loop stocktake shutdown' &&
      workingDays.closure.own === true &&
      workingDays.whileClosed.closed.get(workingDays.closedDay) === 'loop stocktake shutdown',
    `${workingDays.closedDay} — ${workingDays.closure?.label ?? 'nothing'}`)
  ok('A reminder due on that day is held, and says which day it was',
    workingDays.onTheClosedDay.heldByCalendar === 1 &&
      workingDays.closedHeld.deliveredAt === null &&
      (workingDays.closedHeld.heldReason ?? '').includes('loop stocktake shutdown'),
    workingDays.closedHeld.heldReason ?? '')
  ok('Reopening the day puts it back to being worked, and the reminder goes out',
    workingDays.afterReopening.closed.has(workingDays.closedDay) === false &&
      workingDays.onceOpenAgain.delivered === 1)

  // ---- What the organization says about itself (ADR 0052) -------------------
  // `organizations` was written by the seed and by almost nothing else, so every organization
  // was Northwind Logistics, in Europe/London, that thinks a reefer is a temperature-controlled
  // trailer. Two of these columns were read by nothing at all, which is fixed the other way
  // round: they are given a reader here rather than a settings field that does nothing.
  const orgProfile = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const before = await organizationProfile(ctx, actor)

    const rejectedClock = await organizationProfile(ctx, actor)
      .then(() => updateOrganizationProfile(ctx, actor, { timezone: 'Mars/Olympus' }))
      .then(() => null, (error: Error) => error.message)
    const rejectedMoney = await updateOrganizationProfile(ctx, actor, { currency: 'POUNDS' })
      .then(() => null, (error: Error) => error.message)

    const renamed = await updateOrganizationProfile(ctx, actor, {
      name: 'Northwind Logistics and Cold Chain',
      industry: 'Freight forwarding, third-party logistics and cold chain',
      tone: 'Direct, warm, never breezy. Short sentences.',
      currency: 'USD',
    })
    // The reader that makes the currency a control rather than a stored string: money is
    // written in it, including in the refusal that quotes a budget.
    const money = formatCents(125_00, await organizationCurrency(ctx))
    // And the one that makes the tone a control: it reaches the prompt the model is sent, and
    // does not displace the rules above it.
    const prompt = renderPrompt(loadSystemPrompt(), {
      org: { name: renamed.name, industry: renamed.industry ?? '', tone: `This organization asks to be written to like this: ${renamed.tone}` },
      user: { name: actor.displayName, role: actor.role, department: 'Executive', timezone: 'Europe/London' },
      now: new Date().toISOString(),
      route_context: '/loop',
      mode: 'ask',
      effective_capabilities: 'read only',
    })

    // A word this company says out loud, and the search that then finds what spells it out.
    await setGlossaryTerm(ctx, actor, { term: 'BHX', meaning: 'Birmingham depot' })
    const found = await hybridSearch(ctx, actor, 'BHX handover')
    const doubled = await setGlossaryTerm(ctx, actor, { term: 'bhx', meaning: 'Birmingham depot' })
    const shortTerm = await setGlossaryTerm(ctx, actor, { term: 'x', meaning: 'anything at all' })
      .then(() => null, (error: Error) => error.message)

    // Put the demo back.
    await updateOrganizationProfile(ctx, actor, {
      name: before.name,
      industry: before.industry,
      timezone: before.timezone,
      currency: before.currency,
      tone: before.tone,
    })
    const restored = await organizationProfile(ctx, actor)
    const bhxWasSeeded = before.glossary.some((entry) => entry.term.toLowerCase() === 'bhx')
    if (!bhxWasSeeded) await removeGlossaryTerm(ctx, actor, { term: 'BHX' })
    else await setGlossaryTerm(ctx, actor, { term: 'BHX', meaning: 'Birmingham depot' })

    return { before, rejectedClock, rejectedMoney, renamed, money, prompt, found, doubled, shortTerm, restored }
  })

  ok('An organization can say what it is called and what it does',
    orgProfile.renamed.name === 'Northwind Logistics and Cold Chain' &&
      (orgProfile.renamed.industry ?? '').includes('cold chain'),
    orgProfile.renamed.name)
  ok('A clock this machine cannot work in is refused by name, not stored',
    (orgProfile.rejectedClock ?? '').includes('IANA'),
    orgProfile.rejectedClock ?? 'accepted')
  ok('And money that cannot be written is refused the same way',
    (orgProfile.rejectedMoney ?? '').includes('three-letter'),
    orgProfile.rejectedMoney ?? 'accepted')
  ok('Money is written in the currency the organization keeps its books in',
    orgProfile.money.includes('$'), orgProfile.money)
  ok('The tone it asks for reaches the model, without displacing what is promised anyway',
    orgProfile.prompt.includes('never breezy') && orgProfile.prompt.includes('Hedge honestly'))
  ok('A word this company says out loud finds the document that spells it out',
    orgProfile.found.expandedQuery === 'BHX handover Birmingham depot',
    orgProfile.found.expandedQuery)
  ok('Saying a term twice corrects it rather than expanding a search twice',
    orgProfile.doubled.glossary.filter((entry) => entry.term.toLowerCase() === 'bhx').length === 1)
  ok('A term short enough to match every search is refused',
    (orgProfile.shortTerm ?? '').includes('almost every search'),
    orgProfile.shortTerm ?? 'accepted')
  ok('The loop puts the organization back as it found it',
    orgProfile.restored.name === orgProfile.before.name &&
      orgProfile.restored.currency === orgProfile.before.currency &&
      orgProfile.restored.timezone === orgProfile.before.timezone)


  // ---- What the model was asked, and what it cost -------------------------
  console.log('\nWhere the model spend actually went…\n')

  const spend = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const [run] = await ctx.sql<{ id: string }[]>`
      SELECT r.id FROM agent_runs r
      JOIN agent_messages m ON m.run_id = r.id
      WHERE r.organization_id = ${ctx.organizationId}
      GROUP BY r.id ORDER BY max(m.created_at) DESC LIMIT 1`
    const messages = await listRunMessages(ctx, run!.id)
    const [totals] = await ctx.sql<{ tokensIn: number; cost: number }[]>`
      SELECT tokens_in AS "tokensIn", cost_cents::float8 AS cost FROM agent_runs WHERE id = ${run!.id}`
    const [metered] = await ctx.sql<{ total: string; runCost: string }[]>`
      SELECT coalesce(sum(cost_cents), 0)::text AS total,
             coalesce(sum(cost_cents) FILTER (WHERE unit = 'agent_run'), 0)::text AS "runCost"
      FROM usage_records
      WHERE organization_id = ${ctx.organizationId} AND agent_run_id = ${run!.id}`
    const report = await ledgerReport(ctx, actor, monthPeriod(new Date(), ctx.timezone))
    const snapshot = await spendSnapshot(ctx)
    const [monthly] = await ctx.sql<{ cost: string }[]>`
      SELECT coalesce(sum(cost_cents), 0)::text AS cost FROM agent_messages
      WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
        AND created_at >= date_trunc('month', now())`
    return { messages, totals: totals!, metered: metered!, report, snapshot, monthly: Number(monthly!.cost) }
  })

  ok('A run says which step cost what, which it never could',
    spend.messages.length > 0 && spend.messages.every((m) => m.model !== null && m.taskClass !== null),
    spend.messages.map((m) => `${m.taskClass} ${m.tokensIn}→${m.tokensOut}`).join(', '))
  ok('The run’s totals are the sum of them, kept by the database rather than by a caller',
    Math.abs(spend.totals.cost - spend.messages.reduce((t, m) => t + m.costCents, 0)) < 0.0001,
    `${spend.totals.cost}c`)
  // The bug this found: both run paths also metered the run's whole cost on top of the
  // per-call rows, so month-to-date spend was counted roughly twice.
  ok('The spend is metered once, not once per call and again per run',
    Number(spend.metered.runCost) === 0 &&
      Math.abs(Number(spend.metered.total) - spend.totals.cost) < 0.0001,
    `${spend.metered.total}c metered against ${spend.totals.cost}c spent`)
  ok('So the cap counts what was actually spent',
    Math.abs(spend.snapshot.monthToDateCents - spend.monthly) < 0.0001,
    `${spend.snapshot.monthToDateCents}c month to date`)
  ok('And the ledger can say where it went, by model and by the kind of call',
    spend.report.models.length > 0,
    spend.report.models.map((m) => `${m.taskClass}@${m.model}`).slice(0, 3).join(', '))


  // ---- Work that comes back -----------------------------------------------
  console.log('\nAn obligation that repeats…\n')

  const repeat = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const made = await createTask(ctx, actor, {
      title: 'loop recurring — file the temperature logs',
      assigneeId: actor.userId,
      dueAt: new Date(Date.now() + 2 * 86_400_000),
    })

    const refused = await setRecurrence(ctx, actor, { taskId: made.id, rule: '@reboot' }).then(
      () => null,
      (error: Error) => error.message,
    )
    const set = await setRecurrence(ctx, actor, { taskId: made.id, rule: '0 9 * * 1' })

    await updateTask(ctx, actor, { id: made.id, status: 'completed' })

    const series = await ctx.sql<{ id: string; status: string; dueAt: Date; rule: string | null }[]>`
      SELECT id, status::text AS status, due_at AS "dueAt", recurrence_rule AS rule FROM tasks
      WHERE organization_id = ${ctx.organizationId} AND title = 'loop recurring — file the temperature logs'
        AND deleted_at IS NULL
      ORDER BY due_at`
    const open = series.filter((row) => !['completed', 'cancelled'].includes(row.status))

    const [seriesId] = await ctx.sql<{ sid: string }[]>`
      SELECT recurrence_series_id AS sid FROM tasks WHERE id = ${open[0]!.id}`
    const view = await taskRecurrence(ctx, actor, open[0]!.id)
    return { refused, set, series, open, view, seriesId: seriesId!.sid }
  })

  // Probed on the owner connection rather than inside a transaction: a failed statement puts
  // its transaction into an aborted state, so catching the error would still take the block
  // down at COMMIT — and the claim under test is that the database refuses this to *anybody*,
  // which the owner connection is the strongest form of.
  const doubled = await adminSql()`
    INSERT INTO tasks (organization_id, title, status, priority, due_at,
                       recurrence_rule, recurrence_series_id, is_demo, created_by)
    VALUES (${session.organizationId}, 'loop recurring — a second open one', 'todo', 'medium', now(),
            '@weekly', ${repeat.seriesId}, true, ${session.userId})`.then(
    () => null,
    (error: Error) => error.message,
  )

  // Put the demo back.
  await withTenant(session, async (ctx) => {
    const ids = repeat.series.map((row) => row.id)
    await ctx.sql`
      DELETE FROM links WHERE organization_id = ${ctx.organizationId} AND from_id = ANY(${ids}::uuid[])`
    await ctx.sql`
      DELETE FROM activities WHERE organization_id = ${ctx.organizationId} AND entity_id = ANY(${ids}::uuid[])`
    await ctx.sql`
      DELETE FROM tasks WHERE organization_id = ${ctx.organizationId} AND title LIKE 'loop recurring —%'`
  })

  ok('A repeat is refused in the same words the automations screen uses',
    /not a schedule/i.test(repeat.refused ?? ''), (repeat.refused ?? 'it was allowed').slice(0, 60))
  ok('And a good one is read back in English, with the date it would next fall',
    /monday/i.test(repeat.set?.description ?? '') && repeat.set?.nextDueAt !== null,
    repeat.set?.description ?? '')
  ok('Finishing one makes the next, carrying the same owner rather than inventing one',
    repeat.series.length === 2 && repeat.open.length === 1 && repeat.open[0]!.dueAt.getTime() > Date.now())
  ok('The rule moves to the open occurrence, so a finished one cannot be stopped',
    repeat.series.filter((row) => row.rule !== null).length === 1)
  ok('And the database refuses a second open occurrence, whatever writes it',
    /one_open_occurrence/i.test(doubled ?? ''), (doubled ?? 'it was allowed').slice(0, 50))


  // ---- A contract that has run out -----------------------------------------
  console.log('\nAn agreement whose term has ended…\n')

  const term = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)

    // The case supersession does *not* catch, and the one this exists for: a fixed-term
    // agreement that simply ran out. Nothing replaced it, so `is_superseded` is false and it
    // was retrieved, ranked and cited as current indefinitely.
    const [lapsed] = await ctx.sql<{ id: string; title: string; to: string | null; expired: boolean }[]>`
      SELECT id, title, effective_to::text AS "to",
             (effective_to IS NOT NULL AND effective_to < current_date) AS expired
      FROM documents
      WHERE organization_id = ${ctx.organizationId} AND title = 'Rate Card 2025'`

    const query = 'waiting time surcharge per hour after free hours rate card'
    const asked = await hybridSearch(ctx, actor, query, { topK: 20 })
    const found = asked.chunks.find((chunk) => chunk.documentId === lapsed!.id)
    const currentOnly = await hybridSearch(ctx, actor, query, { topK: 20, currentOnly: true })

    // Superseding something derives the end date of what it replaced, without anybody typing
    // it. The 2024 agreement was already out of default retrieval because its version is
    // superseded; what is new is that its *term* is now stated rather than implied.
    const [closed] = await ctx.sql<{ to: string | null }[]>`
      SELECT effective_to::text AS "to" FROM documents
      WHERE organization_id = ${ctx.organizationId} AND title LIKE '%Master Services Agreement (2024)%'`

    const health = await knowledgeHealth(ctx)

    // A term set by hand takes the passages with it.
    const [policy] = await ctx.sql<{ id: string }[]>`
      SELECT id FROM documents
      WHERE organization_id = ${ctx.organizationId} AND doc_type = 'policy'
        AND current_version_id IS NOT NULL AND effective_to IS NULL
      ORDER BY created_at LIMIT 1`
    await setEffectiveDates(ctx, actor, { documentId: policy!.id, effectiveTo: '2030-12-31' })
    const [chunk] = await ctx.sql<{ to: string | null }[]>`
      SELECT effective_to::text AS "to" FROM document_chunks WHERE document_id = ${policy!.id} LIMIT 1`

    // Put the demo back.
    await ctx.sql`
      UPDATE documents SET effective_to = NULL WHERE organization_id = ${ctx.organizationId} AND id = ${policy!.id}`
    await ctx.sql`
      DELETE FROM ingestion_jobs WHERE organization_id = ${ctx.organizationId} AND document_id = ${policy!.id}
        AND reason LIKE 'Term changed%'`
    await ctx.sql`
      DELETE FROM activities WHERE organization_id = ${ctx.organizationId} AND entity_id = ${policy!.id}
        AND summary LIKE '%in force until%'`

    return { lapsed: lapsed!, found, currentOnly, closed: closed!, health, chunkTerm: chunk!.to }
  })

  ok('A fixed-term agreement that ran out is marked expired rather than treated as current',
    term.lapsed.expired && term.lapsed.to === '2025-12-31', term.lapsed.to ?? 'still open')
  ok('It is still findable — “what did the old one say” is a real question',
    term.found !== undefined)
  ok('And it says when it stopped, so it cannot be quoted as current',
    term.found?.expiredOn === '2025-12-31', term.found?.expiredOn ?? 'no expiry reported')
  ok('A caller that wants only what is in force gets only that',
    !term.currentOnly.chunks.some((chunk) => chunk.documentId === term.lapsed.id))
  ok('Superseding an agreement states the end date of the one it replaced, without typing it',
    term.closed.to === '2024-12-31', term.closed.to ?? 'still open')
  ok('Setting a term takes every passage with it, by trigger rather than by a caller',
    term.chunkTerm === '2030-12-31', term.chunkTerm ?? 'unchanged')
  ok('And the library can say what has run out, which nothing could answer',
    term.health.terms.expired > 0, `${term.health.terms.expired} out of term`)


  // ---- When you are written to ---------------------------------------------
  console.log('\nQuiet hours, and what each kind of thing is worth interrupting for…\n')

  const written = await (async () => {
    const [person] = await adminSql()<{ id: string; name: string; timezone: string }[]>`
      SELECT u.id, u.name, u.timezone FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ${session.organizationId} AND m.role = 'member' AND m.deleted_at IS NULL
      ORDER BY m.created_at LIMIT 1`
    const theirs = { ...session, userId: person!.id }

    // A window around the moment this loop runs, set through the product by the person whose
    // window it is. Named rather than assumed: at four in the afternoon the default evening
    // window would hold nothing and the beat would prove nothing.
    const clock = (offsetHours: number) =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: person!.timezone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(new Date(Date.now() + offsetHours * 3_600_000))

    const saved = await withTenant(theirs, async (ctx) =>
      setNotificationPreferences(ctx, await loadActor(ctx), {
        quietHours: { start: clock(-1), end: clock(2) },
        perType: { task_changed: 'digest', workflow: 'none' },
      }))

    const nobodyElse = await withTenant(session, async (ctx) =>
      setNotificationPreferences(ctx, await loadActor(ctx), { quietHours: { start: '00:00', end: '23:59' } })
        .then(() => 'allowed', (error: Error) => error.message))

    const muting = await withTenant(theirs, async (ctx) =>
      setNotificationPreferences(ctx, await loadActor(ctx), { perType: { disclosure: 'none' } })
        .then(() => 'allowed', (error: Error) => error.message))

    const held = await withTenant(session, (ctx) =>
      notify(ctx, {
        userId: person!.id,
        type: 'mention',
        title: 'Somebody mentioned you',
        body: 'While they had asked not to be interrupted.',
      }))
    const digested = await withTenant(session, (ctx) =>
      notify(ctx, { userId: person!.id, type: 'task_changed', title: '“Pre-cool the trailer” changed' }))
    const muted = await withTenant(session, (ctx) =>
      notify(ctx, { userId: person!.id, type: 'workflow', title: 'An automation of yours ran' }))

    const whileQuiet = await withTenant(theirs, async (ctx) => {
      const actor = await loadActor(ctx)
      return {
        visible: (await listNotifications(ctx, actor, {})).map((row) => row.id),
        muted: (await listNotifications(ctx, actor, { mutedToo: true })).map((row) => row.id),
        badge: await reminderCount(ctx, actor),
      }
    })

    // The window opening is the only thing that changes, and it needs no sweep to run.
    await adminSql()`
      UPDATE notifications SET deliver_after = now() - interval '1 minute' WHERE id = ${held.id}`
    const afterwards = await withTenant(theirs, async (ctx) => {
      const actor = await loadActor(ctx)
      return {
        visible: (await listNotifications(ctx, actor, {})).some((row) => row.id === held.id),
        badge: await reminderCount(ctx, actor),
      }
    })

    // And what was routed to the briefing is what the briefing then carries.
    const briefing = await withTenant(theirs, async (ctx) =>
      composeBriefingFacts(ctx, await loadActor(ctx), 'daily'))

    // A rung is scheduled into the open hours rather than written for a moment nobody can be
    // shown — the ladder says when it will arrive, so the row says the truth.
    const rung = await withTenant(session, async (ctx) => {
      const [task] = await ctx.sql<{ id: string }[]>`
        INSERT INTO tasks (organization_id, title, status, priority, assignee_id, due_at, is_demo, created_by)
        VALUES (${ctx.organizationId}, 'loop quiet-hours subject', 'todo', 'medium', ${person!.id},
                ${new Date(Date.now() - 86_400_000)}, true, ${session.userId})
        RETURNING id`
      await scheduleLadder(ctx, {
        recipientUserId: person!.id,
        subjectType: 'task',
        subjectId: task!.id,
        subjectLabel: 'loop quiet-hours subject',
        dueAt: new Date(Date.now() - 86_400_000),
      })
      const [first] = await ctx.sql<{ at: Date }[]>`
        SELECT min(scheduled_for) AS at FROM nudges
        WHERE organization_id = ${ctx.organizationId} AND subject_id = ${task!.id}`
      await ctx.sql`DELETE FROM nudges WHERE organization_id = ${ctx.organizationId} AND subject_id = ${task!.id}`
      await ctx.sql`DELETE FROM tasks WHERE organization_id = ${ctx.organizationId} AND id = ${task!.id}`
      return first!.at
    })

    // Put the demo back: no preferences row, and none of the notifications this beat wrote.
    await adminSql()`
      DELETE FROM notification_preferences WHERE organization_id = ${session.organizationId}
        AND user_id IN (${person!.id}, ${session.userId})`
    await adminSql()`
      DELETE FROM notifications WHERE organization_id = ${session.organizationId}
        AND id IN (${held.id}, ${digested.id}, ${muted.id})`

    return { person: person!, saved, nobodyElse, muting, held, digested, muted, whileQuiet, afterwards, briefing, rung }
  })()

  ok('A person can say when they are not to be interrupted, and for which kinds',
    written.saved.quietHours.start !== '18:30' && written.saved.perType['task_changed'] === 'digest',
    `${written.saved.quietHours.start}–${written.saved.quietHours.end}`)
  ok('“Never write to me” is not on offer', /at most sixteen hours/.test(written.nobodyElse),
    written.nobodyElse.slice(0, 60))
  ok('And what the product promises you will see cannot be turned off',
    /cannot be turned down/.test(written.muting), written.muting.slice(0, 60))
  ok('An interruption inside the window is held, not dropped',
    written.held.held && written.held.deliverAfter > new Date() &&
      !written.whileQuiet.visible.includes(written.held.id),
    `waits until ${written.held.deliverAfter.toISOString().slice(11, 16)}`)
  ok('A kind they turned down does not interrupt them, and is still there to read',
    written.digested.delivery === 'digest' && written.whileQuiet.visible.includes(written.digested.id))
  ok('A kind they turned off is recorded rather than lost',
    written.muted.delivery === 'none' &&
      !written.whileQuiet.visible.includes(written.muted.id) &&
      written.whileQuiet.muted.includes(written.muted.id))
  ok('And the briefing is where what was held back actually arrives',
    written.briefing.waiting.some((row) => row.id === written.digested.id),
    `${written.briefing.counts.waiting} waiting`)
  ok('When the window opens it appears, with no sweep to run',
    written.afterwards.visible && written.afterwards.badge > written.whileQuiet.badge,
    `badge ${written.whileQuiet.badge} → ${written.afterwards.badge}`)
  ok('And a reminder is scheduled for when they can actually be reached',
    written.rung > new Date(),
    written.rung.toISOString().slice(0, 16).replace('T', ' '))


  // ---- A project somebody started ------------------------------------------
  console.log('\nA project the company started itself…\n')

  const started = await (async () => {
    return withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const [department] = await ctx.sql<{ id: string }[]>`
        SELECT id FROM departments
        WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL ORDER BY path LIMIT 1`

      const project = await createProject(ctx, actor, {
        name: 'loop project — Immingham reefer refit',
        description: 'Started by the acceptance loop.',
        departmentId: department!.id,
        startsOn: calendarDate(ctx.timezone),
        targetDate: new Date(Date.now() + 45 * 86_400_000).toISOString().slice(0, 10),
        status: 'active',
      })

      // The owner is on its roster from the first moment, by trigger (ADR 0032).
      const [onRoster] = await ctx.sql<{ role: string }[]>`
        SELECT role FROM project_members
        WHERE organization_id = ${ctx.organizationId} AND project_id = ${project.id}
          AND user_id = ${actor.userId} AND deleted_at IS NULL`

      const sameName = await createProject(ctx, actor, {
        name: 'loop project — Immingham reefer refit',
      }).then(() => 'allowed', (error: Error) => error.message)

      const backwards = await createProject(ctx, actor, {
        name: 'loop project — backwards',
        startsOn: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10),
        targetDate: calendarDate(ctx.timezone),
      }).then(() => 'allowed', (error: Error) => error.message)

      // A project that cannot be closed is half a feature, so it can be: completing is
      // refused while its work is open, cancelling never is.
      const task = await createTask(ctx, actor, {
        title: 'loop — quote the refit',
        projectId: project.id,
      })
      const early = await setProjectStatus(ctx, actor, {
        projectId: project.id,
        status: 'completed',
        reason: 'Trying to close it with work still open.',
      }).then(() => 'allowed', (error: Error) => error.message)

      await updateTask(ctx, actor, { id: task.id, status: 'completed' })
      const closed = await setProjectStatus(ctx, actor, {
        projectId: project.id,
        status: 'completed',
        reason: 'The refit is quoted and the work is finished.',
      })

      // And the name is free again the moment it closes, which is what the index says.
      const reused = await createProject(ctx, actor, {
        name: 'loop project — Immingham reefer refit',
      })

      // Put the demo back.
      await ctx.sql`DELETE FROM activities WHERE organization_id = ${ctx.organizationId}
        AND entity_id IN (${project.id}, ${reused.id}, ${task.id})`
      await ctx.sql`DELETE FROM tasks WHERE organization_id = ${ctx.organizationId} AND id = ${task.id}`
      await ctx.sql`DELETE FROM project_members WHERE organization_id = ${ctx.organizationId}
        AND project_id IN (${project.id}, ${reused.id})`
      await ctx.sql`DELETE FROM projects WHERE organization_id = ${ctx.organizationId}
        AND id IN (${project.id}, ${reused.id})`

      return { project, onRoster, sameName, backwards, early, closed, reused }
    })
  })()

  ok('A project can be started in the product at last, not only by the seed',
    started.project.status === 'active' && started.project.ownerName !== null,
    `“${started.project.name}”, owned by ${started.project.ownerName}`)
  ok('Its owner is on its roster from the first moment, by trigger',
    started.onRoster?.role === 'owner')
  ok('A second open project cannot take the same name',
    /already open/i.test(started.sameName), started.sameName.slice(0, 60))
  ok('A target before the start is refused with both dates',
    /before the start/i.test(started.backwards), started.backwards.slice(0, 60))
  ok('“Completed” is refused while its work is still open',
    /1 task open/i.test(started.early), started.early.slice(0, 70))
  ok('And once the work is finished it can be closed', started.closed.status === 'completed')
  ok('The name it was using is free again the moment it closes',
    started.reused.name === started.project.name)


  // ---- Adding to company memory, as an ordinary member ----------------------
  console.log('\nA member adds a document…\n')

  const added = await (async () => {
    const [colleague] = await adminSql()<{ id: string; name: string }[]>`
      SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ${session.organizationId} AND m.role = 'member' AND m.deleted_at IS NULL
      ORDER BY m.created_at LIMIT 1`
    const [onlooker] = await adminSql()<{ id: string }[]>`
      SELECT m.user_id AS id FROM memberships m
      WHERE m.organization_id = ${session.organizationId} AND m.role = 'viewer' AND m.deleted_at IS NULL
      ORDER BY m.created_at LIMIT 1`
    const theirs = { ...session, userId: colleague!.id }
    const watching = { ...session, userId: onlooker!.id }

    const body = [
      '# How we run the Monday planning session',
      '',
      'Everybody brings the one thing they most want moved this week, and we sort them together.',
    ].join('\n')

    const created = await withTenant(theirs, async (ctx) =>
      uploadDocument(ctx, await loadActor(ctx), {
        title: 'How we run the Monday planning session',
        body,
        docType: 'policy',
      }))

    const inTheirLibrary = await withTenant(theirs, async (ctx) =>
      listDocuments(ctx, await loadActor(ctx), {}).then((rows) =>
        rows.some((row) => row.id === created.document.id)))

    // A read is not a say: a viewer is refused, and told what they would need.
    const refusedViewer = await withTenant(watching, async (ctx) =>
      uploadDocument(ctx, await loadActor(ctx), { title: 'Not mine to add', body })
        .then(() => 'allowed', (error: Error) => error.message))

    // A member reads up to `internal`, and the classifier reads compensation as `restricted`.
    // Filing it would index it and then refuse the read-back, leaving them an error and a
    // document they could neither open nor remove.
    const outOfReach = await withTenant(theirs, async (ctx) =>
      uploadDocument(ctx, await loadActor(ctx), {
        title: 'Reviewing this year’s bands',
        body: '# Bands\n\nThe salary bands are reviewed each spring, alongside the bonus scheme.',
      }).then(() => 'allowed', (error: Error) => error.message))
    const [stored] = await adminSql()<{ count: string }[]>`
      SELECT count(*)::text AS count FROM documents
      WHERE organization_id = ${session.organizationId} AND title = 'Reviewing this year’s bands'`

    // Put the demo back through the product's own delete, which takes the passages with it.
    await withTenant(session, async (ctx) =>
      deleteDocument(ctx, await loadActor(ctx), {
        documentId: created.document.id,
        reason: 'Added by the loop, removed by the loop.',
      }))
    await adminSql()`
      DELETE FROM documents WHERE organization_id = ${session.organizationId} AND id = ${created.document.id}`
    await adminSql()`
      DELETE FROM activities WHERE organization_id = ${session.organizationId}
        AND entity_id = ${created.document.id}`

    return { colleague: colleague!, created, inTheirLibrary, refusedViewer, outOfReach, stored: stored! }
  })()

  ok('A member can add a document, which the role table has always said they could',
    added.created.ingest.status === 'indexed' && added.created.document.ownerId === added.colleague.id,
    `${added.created.ingest.chunks} passages, owned by ${added.colleague.name}`)
  ok('It is in their own library rather than only in the database', added.inTheirLibrary)
  ok('A viewer is refused, and told what they would need',
    /Member access/i.test(added.refusedViewer), added.refusedViewer.slice(0, 60))
  ok('Content that reads above their own ceiling is refused before anything is stored',
    /out of your own reach/i.test(added.outOfReach) && added.stored.count === '0',
    added.outOfReach.slice(0, 80))

  // ---- Who decided this was confidential ------------------------------------
  console.log('\nA classification somebody weighed…\n')

  const weighed = await (async () => {
    // A document the classifier read as more sensitive than internal, and that nobody has
    // weighed — which, before this, was every document in Superwork.
    const [subject] = await adminSql()<{ id: string; title: string; auto: string | null }[]>`
      SELECT d.id, d.title, d.sensitivity_auto::text AS auto
      FROM documents d
      WHERE d.organization_id = ${session.organizationId} AND d.sensitivity_source = 'auto'
        AND d.sensitivity IN ('confidential', 'restricted') AND d.deleted_at IS NULL
        AND d.current_version_id IS NOT NULL
      ORDER BY d.created_at LIMIT 1`

    const before = await withTenant(session, async (ctx) =>
      getDocument(ctx, await loadActor(ctx), subject!.id))

    // Lowering widens who can retrieve it, so it asks for a fresh proof. Raising never does.
    const askedForProof = await withTenant(session, async (ctx) =>
      reclassifyDocument(ctx, await loadActor(ctx), {
        documentId: subject!.id,
        sensitivity: 'internal',
        reason: 'Reviewed in the loop: nothing in here is commercially sensitive.',
      }).then(() => 'allowed', (error: Error) => error.constructor.name))

    const lowered = await withTenant({ ...session, steppedUpAt: new Date() }, async (ctx) =>
      reclassifyDocument(ctx, await loadActor(ctx), {
        documentId: subject!.id,
        sensitivity: 'internal',
        reason: 'Reviewed in the loop: nothing in here is commercially sensitive.',
      }))

    const [chunk] = await adminSql()<{ sensitivity: string }[]>`
      SELECT sensitivity::text AS sensitivity FROM document_chunks WHERE document_id = ${subject!.id} LIMIT 1`

    // The classifier does not argue with the person afterwards: a re-index leaves the decision
    // alone, and still records what it reads.
    await withTenant({ ...session, steppedUpAt: new Date() }, async (ctx) =>
      requestReindex(ctx, await loadActor(ctx), {
        documentId: subject!.id,
        reason: 'Checking the classifier stays out of a decision somebody made.',
      }))
    await runIngestionJobs(session)
    const reindexed = await withTenant(session, async (ctx) =>
      getDocument(ctx, await loadActor(ctx), subject!.id))

    // Put the demo back: handed to the classifier, which restores what it reads.
    const handedBack = await withTenant(session, async (ctx) =>
      reclassifyAutomatically(ctx, await loadActor(ctx), {
        documentId: subject!.id,
        reason: 'Handed back at the end of the loop.',
      }))
    await adminSql()`
      DELETE FROM activities WHERE organization_id = ${session.organizationId}
        AND entity_id = ${subject!.id} AND summary LIKE '%decided by%'`
    await adminSql()`
      DELETE FROM ingestion_jobs WHERE organization_id = ${session.organizationId}
        AND document_id = ${subject!.id} AND reason LIKE 'Checking the classifier%'`

    return { subject: subject!, before, askedForProof, lowered, chunk: chunk!, reindexed, handedBack }
  })()

  ok('A classification nobody weighed says so, and says what the classifier read',
    weighed.before.sensitivitySource === 'auto' && weighed.before.sensitivityAuto !== null,
    `${weighed.before.sensitivity} read by the classifier`)
  ok('Lowering one asks for a fresh proof, because it widens who can retrieve it',
    weighed.askedForProof === 'StepUpRequiredError', weighed.askedForProof)
  ok('With the proof it is corrected, and names who decided and why',
    weighed.lowered.sensitivity === 'internal' &&
      weighed.lowered.sensitivitySource === 'human' &&
      !!weighed.lowered.sensitivitySetByName && !!weighed.lowered.sensitivityReason,
    weighed.lowered.sensitivitySetByName ?? 'nobody')
  ok('The decision reaches the passages, which is what retrieval actually filters on',
    weighed.chunk.sensitivity === 'internal', weighed.chunk.sensitivity)
  ok('And a re-index leaves it alone, instead of putting the classifier’s reading back',
    weighed.reindexed.sensitivity === 'internal' &&
      weighed.reindexed.sensitivityAuto === weighed.before.sensitivity,
    `classifier still reads ${weighed.reindexed.sensitivityAuto}`)
  ok('Handing it back to the classifier restores what it reads, and forgets the person',
    weighed.handedBack.sensitivity === weighed.before.sensitivity &&
      weighed.handedBack.sensitivitySource === 'auto' &&
      weighed.handedBack.sensitivitySetByName === null)


  // ---- A password is not the only thing that opens the door -----------------
  console.log('\nA second factor…\n')

  const factor = await (async () => {
    const email = 'maya@northwind.example'
    const password = 'superwork'
    const [subject] = await adminSql()<{ id: string }[]>`
      SELECT id FROM users WHERE lower(email) = ${email}`

    // Codes roll every thirty seconds and a used one cannot be reused inside its own window,
    // so the loop names the moment it means rather than waiting for a clock (ADR 0039).
    const period = 30_000
    const at = (step: number) => new Date((totpCounter() + step) * period)
    const codeAt = (secret: string, step: number) => totpCode(secret, totpCounter() + step)!

    const started = await beginMfaEnrolment(subject!.id, { issuer: 'Superwork', account: email })
    const secret = (started as { secret: string }).secret
    const halfWay = await mfaStatus(subject!.id)

    const refused = await confirmMfaEnrolment(subject!.id, '000000', { now: at(0) })
    const turnedOn = await confirmMfaEnrolment(subject!.id, codeAt(secret, 1), { now: at(1) })

    const attempt = await signIn(email, password)
    const beforeCode = await resolveSession(attempt!.token)
    const pending = await resolvePendingSession(attempt!.token)
    const answered = await completeMfaLogin(attempt!.token, codeAt(secret, 2), { now: at(2) })
    const afterCode = await resolveSession(attempt!.token)

    const withPassword = await proveStepUp(attempt!.token, password)
    const withCode = await proveStepUp(attempt!.token, codeAt(secret, 3), { now: at(3) })

    const recovery = turnedOn.recoveryCodes![0]!
    const withRecovery = await signIn(email, password)
    const spent = await completeMfaLogin(withRecovery!.token, recovery)
    const reused = await signIn(email, password)
    const refusedTwice = await completeMfaLogin(reused!.token, recovery)

    const withoutProof = await disableMfa(subject!.id, {})

    // Put the demo back: the demo owner signs in with a password, as the README says.
    const off = await disableMfa(subject!.id, { code: codeAt(secret, 4), now: at(4) })
    await adminSql()`DELETE FROM sessions WHERE user_id = ${subject!.id}`

    return {
      halfWay, refused, turnedOn, beforeCode, pending, answered, afterCode,
      withPassword, withCode, spent, refusedTwice, withoutProof, off,
      stillOn: await mfaStatus(subject!.id),
    }
  })()

  ok('Generating a secret turns nothing on until a code proves it can be read',
    factor.halfWay.pending && !factor.halfWay.enabled && !factor.refused.ok)
  ok('A good code turns it on, and hands over recovery codes once',
    factor.turnedOn.ok && (factor.turnedOn.recoveryCodes?.length ?? 0) > 0,
    `${factor.turnedOn.recoveryCodes?.length ?? 0} codes`)
  ok('A password alone now opens a session that reaches nothing',
    factor.beforeCode === null && factor.pending?.userId !== undefined)
  ok('And the code finishes the sign-in', factor.answered.ok && factor.afterCode !== null)
  ok('Confirming something irreversible asks for the code, not the password again',
    !factor.withPassword.ok && factor.withCode.ok,
    factor.withPassword.ok ? 'the password was accepted' : 'the password was refused')
  ok('A recovery code works, and works once',
    factor.spent.ok && !factor.refusedTwice.ok)
  ok('Turning it off needs the factor rather than just a session',
    !factor.withoutProof.ok && factor.off.ok && !factor.stillOn.enabled)

  const workflow = await withTenant(session, async (ctx) => getWorkflow(ctx, await loadActor(ctx), workflowId))
  console.log(
    process.exitCode === 1
      ? '\nThe debts loop failed.\n'
      : `\nPassed: “${workflow.name}” was described, read back, dry-run and activated; a real run stopped for a ` +
        'person; a correction was applied and counted; a company’s own tool went through the same gate as ' +
        'everything else; what Superwork keeps has a stated window, a purge that runs, and a way out for one ' +
        'document and one person; a matter can stop all of it, in the open; and the assistant learned one ' +
        'thing, was agreed with, was corrected, and forgot it when its source went; and one document was \n' +
        'taken out of circulation, shared back, and reopened on purpose; and one piece of work waited for \n' +
        'another until it was actually done; a contractor saw exactly one team’s work and nothing else; and \n' +
        'one feature was turned off for everybody while one person kept it; and one task was handed to one \n' +
        'colleague and taken back; and a whole project was handed over with the work inside it, which came \n' +
        'back when it did; and a shelf of knowledge was lent with what is on it while an account was lent \n' +
        'without what is filed against it; and the rules that decide what stops for a person are read \n' +
        'from the rows that always stated them, and cannot be configured to let a change through; and an \n' +
        'escalation reached a manager instead of the person it was written about, after they had been \n' +
        'asked themselves and told that it happened; and a person was invited into the company, joined, \n' +
        'and could not be invited above the role of whoever invited them; and the plan a company pays \n' +
        'for became one number, read from the database, that an organization can tighten and never widen; \n' +
        'and what people say when they throw an insight away is read at last, so a watcher they call wrong \n' +
        'stops and one they had already handled keeps running; and a project can finally say who is on it, \n' +
        'which opens its work for them without handing them a say over it; and a reminder is finally \n' +
        'opened by the product, arrives somewhere a person can see it, and closes the work when they \n' +
        'answer it; and the note the assistant leaves on a task can be read at last, a mention \n' +
        'reaches the person named, and a follow-up either comes back or closes itself because \n' +
        'the customer wrote first; and the two ceilings an admin could only see — how hard the \n' +
        'system may chase people, and what an agent may do at all — can be tightened from the \n' +
        'screen the refusals have always pointed at; and the structure the product is governed \n' +
        'by — its departments, its milestones and its shelves — can be built by the people it \n' +
        'governs rather than only by the seed; and a question asked of a list can be kept, \n' +
        'shared as a question rather than as access, and work somebody else is carrying \n' +
        'can be followed without being able to see any more of it than before; and a document \n' +
        'that will not index says so, is retried on a widening delay, gives up out loud rather \n' +
        'than for ever, and can be put back into memory by a person; and nobody is chased on a \n' +
        'day they do not work — not at a weekend, and not on Christmas Day; and what the model \n' +
        'was asked, what it answered and what that cost is on the record, counted once; and work \n' +
        'that comes back does, one occurrence at a time, without anybody retyping it; and a \n' +
        'contract whose term has ended stops being quoted as current while staying findable; and \n' +
        'a password is no longer the only thing between somebody else and every irreversible \n' +
        'action; and a classification a regex guessed at can be weighed by a person, who is \n' +
        'named for it, and is not argued with by the next re-index; and a member can add a \n' +
        'document at last, which is theirs afterwards, unless it reads above what they can \n' +
        'read themselves; and the two numbers an automation runs under are numbers somebody \n' +
        'chose, with a ceiling that cannot be taken off; and a person can finally say when \n' +
        'they are not to be interrupted and what each kind of thing is worth interrupting \n' +
        'for, with nothing dropped and the guarantees not among the things that can be \n' +
        'switched off; and a milestone is no longer a date with nothing underneath it — the \n' +
        'work it is waiting on is filed against it, it says what is late and what lands after \n' +
        'the date itself, and it cannot be called reached while that work is still open; and \n' +
        'a company can start a project of its own at last, and close it again, instead of \n' +
        'working on whatever a demo fixture invented; and the budget every tool has declared \n' +
        'since the first phase now stops something, counted from the calls that really \n' +
        'happened, with the numbers a person can set; and an organization can finally say what \n' +
        'it is called, what it does, what clock it keeps, what money it writes in and what its \n' +
        'own words mean — including the two of those that were read by nothing at all until \n' +
        'something was given to read them; and a workflow step that stopped a run says which \n' +
        'step it was and why, in a row of its own, instead of leaving the list to end at the \n' +
        'last thing that worked.\n',
  )
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await closePools()
}
