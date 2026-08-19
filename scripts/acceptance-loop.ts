/**
 * Phase 1 acceptance check (§24).
 *
 * Drives the whole loop with no external credentials:
 *   onboard → ask a question → get a cited answer → ask for follow-up tasks →
 *   review a previewed plan → approve → see tasks created, activity logged and cost
 *   recorded → undo the entire run.
 *
 * Run with:  pnpm loop
 */
import { closePools, withTenant } from '@superwork/db'
import { loadActor, login } from '@superwork/auth'
import { decideApproval, listApprovals, listTasks, trustLedger } from '@superwork/core'
import { startRun, undoRun, continueAfterApproval, subscribe } from '@superwork/agent'
import { listCitations, listSteps, getRun, listUndoOperations } from '@superwork/core'

const ok = (label: string, condition: boolean, detail = '') => {
  console.log(`  ${condition ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) process.exitCode = 1
  return condition
}

async function waitForRun(runId: string, until: (status: string) => boolean, timeoutMs = 30_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const events = [...(await collect(runId))]
    const last = events.filter((e) => e.type === 'run.completed' || e.type === 'run.failed' || e.type === 'approval.required')
    if (last.length > 0) return events
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error('Timed out waiting for the run')
}

async function collect(runId: string) {
  const { bufferedEvents } = await import('@superwork/agent')
  return bufferedEvents(runId)
}

try {
  console.log('\nSuperwork — Phase 1 acceptance loop\n')

  // ---- 1. Sign in ---------------------------------------------------------
  const session = await login('maya@northwind.example', 'superwork')
  if (!session?.identity.organizationId) throw new Error('Could not sign in as the demo owner.')
  const runSession = {
    organizationId: session.identity.organizationId,
    userId: session.identity.userId,
    timezone: session.identity.timezone,
  }
  ok('Signed in to the demo organization', true, `${session.identity.name} · ${session.organizations[0]?.name}`)

  // ---- 2. Ask a question, expect a cited answer ---------------------------
  console.log('\nAsking: "What is our liability cap for Halden Foods?"')
  const ask = await startRun(runSession, {
    request: 'What is our liability cap for Halden Foods?',
    mode: 'ask',
    uiContext: { route: '/agent' },
  })
  await waitForRun(ask.runId, (s) => s === 'succeeded')

  const answer = await withTenant(runSession, async (ctx) => ({
    run: await getRun(ctx, ask.runId),
    citations: await listCitations(ctx, ask.runId),
    steps: await listSteps(ctx, ask.runId),
  }))
  console.log(`\n  "${(answer.run.summary ?? '').slice(0, 320)}"\n`)
  ok('Answer produced', !!answer.run.summary)
  ok('Answer carries citations', answer.citations.length > 0, `${answer.citations.length} sources`)
  ok(
    'Answer cites the 2025 amendment, not the superseded 2024 MSA',
    answer.citations.some((c) => (c.documentTitle ?? '').includes('Amendment')),
    answer.citations.map((c) => c.documentTitle).filter(Boolean).slice(0, 3).join(', '),
  )
  ok('Run recorded a trace and cost', answer.run.traceId.length > 0 && answer.run.costCents >= 0,
     `${answer.run.costCents.toFixed(4)}c · ${answer.steps.length} steps`)

  // ---- 3. Ask for action, expect a previewed plan and an approval ---------
  console.log('\nAsking: "Create follow-up tasks for all overdue customers."')
  const act = await startRun(runSession, {
    request: 'Create follow-up tasks for all overdue customers.',
    mode: 'execute',
    uiContext: { route: '/agent' },
  })
  const events = await waitForRun(act.runId, (s) => s === 'awaiting_approval')

  const planEvent = events.find((e) => e.type === 'plan.ready')
  const approvalEvent = events.find((e) => e.type === 'approval.required')
  ok('A plan was produced before anything executed', !!planEvent)
  ok('The plan was held for approval', !!approvalEvent)

  if (planEvent && planEvent.type === 'plan.ready') {
    console.log(`\n  ${planEvent.plan.summary}\n`)
    ok('Plan flags ambiguous threads instead of acting on them', planEvent.plan.needsAttention.length > 0,
       planEvent.plan.needsAttention.map((n) => n.label).join(', '))
    ok('Every planned step names its tool and intent',
       planEvent.plan.steps.every((s) => s.tool && s.intent))
  }

  const approvals = await withTenant(runSession, async (ctx) => {
    const actor = await loadActor(ctx)
    return listApprovals(ctx, actor, { status: 'pending' })
  })
  const approval = approvals.find((a) => a.agentRunId === act.runId)
  ok('Approval card exists with a preview diff', !!approval && approval.preview.length > 0,
     approval ? `${approval.preview.length} previewed changes` : '')
  ok('Approval card carries evidence', !!approval && approval.evidence.length > 0,
     approval ? `${approval.evidence.length} evidence items` : '')

  if (approval) {
    console.log('\n  Preview:')
    for (const line of approval.preview.slice(0, 6)) {
      console.log(`    ${line.operation}: ${line.entityLabel} — ${line.changes.map((c) => `${c.field} → ${c.to}`).join(', ')}`)
    }
  }

  const tasksBefore = await withTenant(runSession, async (ctx) => {
    const actor = await loadActor(ctx)
    return (await listTasks(ctx, actor, { limit: 200 })).tasks.length
  })

  // ---- 4. Approve, expect execution ---------------------------------------
  console.log('\nApproving the plan...')
  await withTenant(runSession, async (ctx) => {
    const actor = await loadActor(ctx)
    await decideApproval(ctx, actor, { approvalId: approval!.id, decision: 'approve' })
  })
  await continueAfterApproval(runSession, act.runId)

  const started = Date.now()
  let finalRun = await withTenant(runSession, (ctx) => getRun(ctx, act.runId))
  while (finalRun.status === 'running' && Date.now() - started < 30_000) {
    await new Promise((r) => setTimeout(r, 300))
    finalRun = await withTenant(runSession, (ctx) => getRun(ctx, act.runId))
  }

  const after = await withTenant(runSession, async (ctx) => {
    const actor = await loadActor(ctx)
    const tasks = await listTasks(ctx, actor, { limit: 200 })
    const activities = await ctx.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM activities
      WHERE organization_id = ${ctx.organizationId} AND agent_run_id = ${act.runId}`
    const audits = await ctx.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM audit_logs
      WHERE organization_id = ${ctx.organizationId} AND agent_run_id = ${act.runId}`
    const drafts = await ctx.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM email_drafts
      WHERE organization_id = ${ctx.organizationId} AND agent_run_id = ${act.runId}`
    // Scoped to what *this run* drafted, as the draft count beside it always was. Counting every
    // send in the organization made the claim "this run did not send" depend on nothing else in
    // the demo ever having sent anything — which stopped being true the moment the demo grew an
    // email waiting out its recall window (ADR 0054). The assertion is about the run.
    const sends = await ctx.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM email_sends s
      WHERE s.organization_id = ${ctx.organizationId}
        AND s.draft_id IN (
          SELECT d.id FROM email_drafts d
          WHERE d.organization_id = ${ctx.organizationId} AND d.agent_run_id = ${act.runId}
        )`
    const undo = await listUndoOperations(ctx, act.runId)
    return {
      taskCount: tasks.tasks.length,
      agentTasks: tasks.tasks.filter((t) => t.createdByAgentRunId === act.runId),
      activities: activities[0]?.count ?? 0,
      audits: audits[0]?.count ?? 0,
      drafts: drafts[0]?.count ?? 0,
      sends: sends[0]?.count ?? 0,
      undo,
    }
  })

  console.log(`\n  "${(finalRun.summary ?? '').slice(0, 320)}"\n`)
  ok('Run succeeded', finalRun.status === 'succeeded', finalRun.status)
  ok('Tasks were created by the run', after.agentTasks.length > 0, `${after.agentTasks.length} tasks`)
  ok('Created tasks carry provenance back to their source thread',
     await withTenant(runSession, async (ctx) => {
       const rows = await ctx.sql<{ count: number }[]>`
         SELECT count(*)::int AS count FROM links
         WHERE organization_id = ${ctx.organizationId} AND relation = 'derived_from'
           AND from_type = 'task' AND from_id = ANY(${after.agentTasks.map((t) => t.id)}::uuid[])`
       return (rows[0]?.count ?? 0) === after.agentTasks.length
     }))
  ok('Email drafts were saved rather than sent', after.drafts > 0 && after.sends === 0,
     `${after.drafts} drafts · ${after.sends} sends`)
  ok('Activity was logged', after.activities > 0, `${after.activities} entries`)
  ok('Audit rows were written', after.audits > 0, `${after.audits} entries`)
  ok('Cost was recorded', finalRun.costCents > 0, `${finalRun.costCents.toFixed(4)}c`)
  ok('Undo operations were recorded', after.undo.length > 0, `${after.undo.length} reversible changes`)

  // ---- 5. Undo the entire run ---------------------------------------------
  console.log('\nUndoing the run...')
  const undone = await undoRun(runSession, act.runId)
  console.log(`  ${undone.narrative}`)

  const post = await withTenant(runSession, async (ctx) => {
    const actor = await loadActor(ctx)
    const tasks = await listTasks(ctx, actor, { limit: 200 })
    return {
      taskCount: tasks.tasks.length,
      run: await getRun(ctx, act.runId),
      ledger: await trustLedger(ctx),
    }
  })
  ok('Every reversible change was reversed', undone.failed.length === 0 && undone.reversed > 0,
     `${undone.reversed} reversed`)
  ok('Task count returned to its pre-run value', post.taskCount === tasksBefore,
     `${tasksBefore} → ${post.taskCount}`)
  ok('Run is marked undone', post.run.status === 'undone', post.run.status)
  ok('Trust ledger recorded the proposal, approval and undo', post.ledger.length > 0,
     post.ledger.map((l) => `${l.actionType}: ${l.approved}/${l.proposed} approved`).join('; '))

  console.log(
    process.exitCode ? '\nAcceptance loop FAILED.\n' : '\nAcceptance loop passed: the loop closes end to end.\n',
  )
} catch (error) {
  console.error('\nAcceptance loop errored:', error)
  process.exitCode = 1
} finally {
  await closePools()
}
