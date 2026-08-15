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
import { closePools, withTenant } from '@superwork/db'
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
  applyRetention,
  confirmMemory,
  correctMemory,
  deleteDocument,
  documentAudience,
  getRun,
  grantDocumentAccess,
  hybridSearch,
  ingestDocument,
  listHolds,
  listMemories,
  openDocumentToEveryone,
  recallMemories,
  share,
  placeHold,
  previewErasure,
  releaseHold,
  retentionPolicies,
  saveCustomTool,
  scheduleFor,
  previewSchedule,
  setWorkflowSchedule,
  trustLedger,
} from '@superwork/core'
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

  const workflow = await withTenant(session, async (ctx) => getWorkflow(ctx, await loadActor(ctx), workflowId))
  console.log(
    process.exitCode === 1
      ? '\nThe debts loop failed.\n'
      : `\nPassed: “${workflow.name}” was described, read back, dry-run and activated; a real run stopped for a ` +
        'person; a correction was applied and counted; a company’s own tool went through the same gate as ' +
        'everything else; what Superwork keeps has a stated window, a purge that runs, and a way out for one ' +
        'document and one person; a matter can stop all of it, in the open; and the assistant learned one ' +
        'thing, was agreed with, was corrected, and forgot it when its source went; and one document was \n' +
        'taken out of circulation, shared back, and reopened on purpose.\n',
  )
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await closePools()
}
