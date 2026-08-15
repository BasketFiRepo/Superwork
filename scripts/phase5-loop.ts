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
import { adminSql, closePools, withTenant } from '@superwork/db'
import { can, loadActor } from '@superwork/auth'
import { compileWorkflow } from '@superwork/ai'
import {
  activateCustomTool,
  activateWorkflow,
  createApproval,
  decideApproval,
  describeCron,
  getWorkflow,
  listCustomTools,
  listWorkflowRuns,
  reviewHost,
  saveCompiled,
  addDependency,
  addTeamMember,
  clearFlag,
  flagStates,
  applyRetention,
  approvalPolicies,
  evaluateApprovalPolicies,
  archiveTeam,
  composeBriefingFacts,
  confirmMemory,
  createTask,
  createTeam,
  correctMemory,
  deleteDocument,
  deliverDueNudges,
  documentAudience,
  getDocument,
  getRun,
  getTask,
  grantDocumentAccess,
  hybridSearch,
  ingestDocument,
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
  saveCustomTool,
  scheduleLadder,
  setFlag,
  setPolicyEnabled,
  updateTask,
  scheduleFor,
  previewSchedule,
  setWorkflowSchedule,
  trustLedger,
} from '@superwork/core'
import { strictestProfile, type JurisdictionProfile } from '@superwork/core'
import { customToolsFor } from '@superwork/tools'
import {
  checkCapacity,
  continueWorkflowAfterApproval,
  runDueWatchers,
  runDueWorkflows,
  runWorkflow,
  simulateWorkflow,
  watcherSchedules,
  WATCHERS,
} from '@superwork/agent'
import { demoSession } from '@superwork/agent/evals/harness'

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

  const candidate = noticed.candidates[0]!
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
    const rows = await ctx.sql<{ id: string; profile: string }[]>`
      SELECT id, jurisdiction_profile AS profile FROM legal_entities
      WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL`
    if (rows.length === 0) {
      await ctx.sql`
        INSERT INTO legal_entities (organization_id, name, country, jurisdiction_profile, is_demo, created_by)
        VALUES (${ctx.organizationId}, 'Loop GmbH', 'DE', 'gdpr', true, ${session.userId})`
    } else {
      await ctx.sql`
        UPDATE legal_entities SET jurisdiction_profile = 'gdpr'
        WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL`
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
  await withTenant(session, async (ctx) => deliverDueNudges(ctx, { subjectId: lateTaskId }))
  const told = await withTenant({ ...session, userId: subject.personId }, async (ctx) =>
    listDisclosures(ctx, await loadActor(ctx), subject.personId),
  )
  ok('And the person it was about sees that it happened, on their own record',
    told.some((entry) => entry.kind === 'manager_rollup'),
    told.filter((entry) => entry.kind === 'manager_rollup').length + ' recorded')

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
    for (const entity of entitiesBefore) {
      await ctx.sql`
        UPDATE legal_entities SET jurisdiction_profile = ${entity.profile}
        WHERE organization_id = ${ctx.organizationId} AND id = ${entity.id}`
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
        'asked themselves and told that it happened.\n',
  )
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await closePools()
}
