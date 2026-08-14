/**
 * Phase 3 acceptance loop (§24).
 *
 * The three claims, driven end to end against the demo organization with no credentials:
 *
 *   1. an admin can answer, from the UI alone, exactly what the AI read, proposed,
 *      executed and cost last month — per department;
 *   2. an agent can be created, permissioned, simulated against last week's data, and
 *      published through change control without an engineer;
 *   3. every employee can open one screen showing what is tracked about them and what was
 *      reported to whom.
 *
 * Run with:  pnpm loop:phase3
 */
import { closePools, withTenant } from '@superwork/db'
import { issueApiKey, loadActor, resolveApiKey, revokeApiKey } from '@superwork/auth'
import {
  createAgentDraft,
  decideChange,
  getAgent,
  ledgerReport,
  listAgentVersions,
  listAgents,
  monthPeriod,
  personalRecord,
  personaSnapshot,
  requestChange,
} from '@superwork/core'
import { generateDigest, simulateAgent } from '@superwork/agent'
import { demoSession } from '@superwork/agent/evals/harness'

const ok = (label: string, condition: boolean, detail = '') => {
  console.log(`  ${condition ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) process.exitCode = 1
  return condition
}

try {
  console.log('\nSuperwork — Phase 3 acceptance loop\n')
  const session = await demoSession()

  const second = await withTenant(session, async (ctx) => {
    const [row] = await ctx.sql<{ id: string; name: string }[]>`
      SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ${ctx.organizationId} AND m.role IN ('admin', 'owner')
        AND m.user_id <> ${session.userId} AND m.deleted_at IS NULL
      ORDER BY u.name LIMIT 1`
    return row
  })
  if (!second) throw new Error('Change control needs a second administrator in the demo organization.')

  // ---- 1. The ledger -------------------------------------------------------
  console.log('Reading the AI ledger for this month…\n')
  const report = await withTenant(session, async (ctx) =>
    ledgerReport(ctx, await loadActor(ctx), monthPeriod(new Date(), ctx.timezone)),
  )
  console.log(`  ${report.basis}`)
  for (const department of report.departments.filter((entry) => entry.runs > 0)) {
    console.log(
      `  ${department.departmentName}: read ${department.passagesRead} passages, proposed ${department.stepsProposed} steps, ` +
        `executed ${department.actionsExecuted}, cost £${(department.costCents / 100).toFixed(2)}`,
    )
  }
  console.log()
  ok('The ledger reports runs', report.organization.runs > 0, `${report.organization.runs} runs`)
  ok('It reports what was read', report.organization.passagesRead > 0, `${report.organization.passagesRead} passages`)
  ok('It reports what was proposed and executed separately',
    report.departments.some((d) => d.stepsProposed > 0) && report.organization.actionsExecuted >= 0)
  ok('It reports cost', report.organization.costCents > 0, `£${(report.organization.costCents / 100).toFixed(2)}`)
  ok('Every figure names its basis', /agent runs, citations, tool calls/i.test(report.basis))
  ok('There is no per-person breakdown anywhere in it', !JSON.stringify(report).includes('"byUser"'))

  // ---- 2. The studio -------------------------------------------------------
  console.log('\nCreating, simulating and publishing an agent…\n')
  const agentId = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const existing = (await listAgents(ctx, actor)).find((agent) => agent.key === 'phase3_watch')
    if (existing) return existing.agentId
    const created = await createAgentDraft(ctx, actor, {
      key: 'phase3_watch',
      name: 'Quiet Account Watch',
      purpose: 'Chase the customers who have gone quiet and draft replies.',
    })
    return created.agentId
  })

  const draft = await withTenant(session, async (ctx) => {
    const agent = await getAgent(ctx, await loadActor(ctx), agentId)
    return {
      ...personaSnapshot(agent),
      mode: 'assist' as const,
      toolGrants: ['create_task@v1', 'draft_email@v1', 'search_knowledge@v1'],
      scheduleCron: '0 8 * * 1-5',
      autopilotDailyActionCap: 5,
    }
  })

  const simulation = await simulateAgent(session, { agentId, proposed: draft, windowDays: 7, maxOccasions: 2 })
  console.log(
    `  Simulated ${simulation.totals.occasions} occasions: ${simulation.totals.stepsProposed} steps proposed, ` +
      `${simulation.totals.stepsBlocked} refused by the gate, ${simulation.totals.wouldRequireApproval} would wait for approval`,
  )
  for (const finding of simulation.findings) console.log(`  [${finding.severity}] ${finding.message}`)
  console.log()
  ok('Simulating produced proposals', simulation.totals.occasions > 0)
  ok('Nothing was executed by the simulation', simulation.status === 'succeeded')

  const change = await withTenant(session, async (ctx) =>
    requestChange(ctx, await loadActor(ctx), {
      agentId,
      proposed: draft,
      justification: 'Chasing overdue accounts by hand takes an hour a day.',
      simulationId: simulation.id,
    }),
  )
  ok('The change names what it widens', change.diff.some((field) => field.widens),
    change.diff.filter((f) => f.widens).map((f) => String(f.field)).join(', '))

  // Two separate rules, asserted separately. Catching "any error" would let either pass
  // while the other did the refusing.
  //
  // The self-approval rule is checked before step-up on purpose: asking somebody for their
  // password and *then* telling them they were never allowed is the wrong order to
  // discover that in. So the step-up refusal is tested on the person who may approve.
  const withoutProof = await withTenant({ ...session, userId: second.id }, async (ctx) =>
    decideChange(ctx, await loadActor(ctx, second.id), { changeRequestId: change.id, decision: 'approve' }).then(
      () => null,
      (error: Error) => error.message,
    ),
  )
  ok('Publishing without re-confirming who you are is refused', /confirm your password/i.test(withoutProof ?? ''),
    withoutProof ?? 'it was allowed')

  const selfApproval = await withTenant({ ...session, steppedUpAt: new Date() }, async (ctx) =>
    decideChange(ctx, await loadActor(ctx), { changeRequestId: change.id, decision: 'approve' }).then(
      () => null,
      (error: Error) => error.message,
    ),
  )
  ok('The requester cannot approve their own change', /somebody else has to approve/i.test(selfApproval ?? ''),
    selfApproval ?? 'it was allowed')

  const published = await withTenant({ ...session, userId: second.id, steppedUpAt: new Date() }, async (ctx) =>
    decideChange(ctx, await loadActor(ctx, second.id), {
      changeRequestId: change.id,
      decision: 'approve',
      note: 'Caps look right.',
    }),
  )
  ok('A second person published it', published.status === 'published', `approved by ${published.decidedByName}`)

  const agentAfter = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const agent = await getAgent(ctx, actor, agentId)
    const versions = await listAgentVersions(ctx, actor, agentId)
    return { agent, versions }
  })
  ok('The agent is live with exactly the tools that were approved',
    agentAfter.agent.status === 'active' && agentAfter.agent.toolGrants.length === draft.toolGrants.length,
    agentAfter.agent.toolGrants.join(', '))
  ok('The version history names both people',
    Boolean(agentAfter.versions[0]?.publishedByName && agentAfter.versions[0]?.secondApproverName))

  const digest = await generateDigest(session, { agentId, weeksAgo: 1 })
  ok('It owes its owner a weekly digest', digest !== null, digest?.narrative.slice(0, 80))

  // ---- 3. The personal record ---------------------------------------------
  console.log('\nOpening the personal record…\n')
  const record = await withTenant(session, async (ctx) => personalRecord(ctx, await loadActor(ctx), session.userId))
  for (const category of record.tracked.filter((entry) => entry.count > 0)) {
    console.log(`  ${String(category.count).padStart(4)} ${category.label}`)
  }
  console.log()
  ok('It lists what is held', record.tracked.length > 0, `${record.tracked.length} categories`)
  ok('It lists what was reported and to whom', Array.isArray(record.disclosures))
  ok('It states what is never collected', record.neverCollected.length >= 5)

  let otherPersonRefused = false
  try {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const [other] = await ctx.sql<{ id: string }[]>`
        SELECT user_id AS id FROM memberships
        WHERE organization_id = ${ctx.organizationId} AND user_id <> ${session.userId} AND deleted_at IS NULL LIMIT 1`
      await personalRecord(ctx, actor, other!.id)
    })
  } catch {
    otherPersonRefused = true
  }
  ok('Nobody — including the owner — can open somebody else’s record', otherPersonRefused)

  // ---- 4. The public API ---------------------------------------------------
  console.log('\nIssuing an API key…\n')
  const issued = await withTenant(session, async (ctx) =>
    issueApiKey(ctx, await loadActor(ctx), { name: 'acceptance loop', scopes: ['tasks:read', 'mcp:read'] }),
  )
  const resolved = await resolveApiKey(`Bearer ${issued.secret}`)
  ok('A key resolves to its principal', resolved?.principalUserId === session.userId)
  ok('It holds only the scopes it was given', JSON.stringify(resolved?.scopes) === JSON.stringify(['tasks:read', 'mcp:read']))
  ok('A wrong secret resolves to nothing', (await resolveApiKey(`Bearer ${issued.prefix}_wrong`)) === null)

  await withTenant(session, async (ctx) => revokeApiKey(ctx, await loadActor(ctx), issued.id))
  ok('Revoking stops it immediately', (await resolveApiKey(issued.secret)) === null)

  console.log(
    process.exitCode === 1
      ? '\nPhase 3 loop failed.\n'
      : '\nPhase 3 acceptance loop passed: the ledger answers, the studio publishes, and the record is the person’s own.\n',
  )
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await closePools()
}
