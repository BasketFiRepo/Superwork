/**
 * Phase 4 acceptance loop (§24).
 *
 *   1. a 100,000-user tenant meets the §26.9 budgets under load — measured by
 *      `pnpm loadtest`, which prints what it measured and at what scale;
 *   2. no department can starve another's agent runs;
 *   3. the accountability features pass a works-council-style review in the strictest
 *      configured jurisdiction.
 *
 * This drives 2 and 3 end to end against the demo organization, and reports what 1
 * requires — deliberately, because a loop that claimed a 100,000-user result from a
 * laptop would be the dishonest kind of green tick.
 *
 * Run with:  pnpm loop:phase4
 */
import { closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  claimNextRun,
  createLegalEntity,
  deliverDueNudges,
  nextWorkingDay,
  calendarDate,
  enqueueRun,
  listLegalEntities,
  nudgeBudget,
  placementFor,
  PROFILES,
  queueSnapshot,
  recordConsultation,
  resolveShard,
  SCALE_BUDGETS,
  scheduleLadder,
  setQuota,
  share,
  unshare,
  worksCouncilReview,
} from '@superwork/core'
import { demoSession } from '@superwork/agent/evals/harness'

const ok = (label: string, condition: boolean, detail = '') => {
  console.log(`  ${condition ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!condition) process.exitCode = 1
  return condition
}

try {
  console.log('\nSuperwork — Phase 4 acceptance loop\n')
  const session = await demoSession()

  // ---- 1. Fair scheduling --------------------------------------------------
  console.log('Queuing a bulk job against a small one…\n')
  const { bulk, small } = await withTenant(session, async (ctx) => {
    const departments = await ctx.sql<{ id: string; name: string }[]>`
      SELECT id, name FROM departments WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
      ORDER BY name LIMIT 2`
    if (departments.length < 2) throw new Error('The demo organization needs two departments for this loop.')
    return { bulk: departments[0]!, small: departments[1]! }
  })

  const served = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    await setQuota(ctx, actor, { departmentId: bulk.id, weight: 1, maxConcurrent: 100, runsPerHour: 10_000 })
    await setQuota(ctx, actor, { departmentId: small.id, weight: 1, maxConcurrent: 100, runsPerHour: 10_000 })
    await ctx.sql`UPDATE department_quotas SET deficit = 0 WHERE organization_id = ${ctx.organizationId}`

    const enqueueMany = async (departmentId: string, count: number, queueClass: 'bulk' | 'interactive') => {
      for (let index = 0; index < count; index += 1) {
        const [run] = await ctx.sql<{ id: string }[]>`
          INSERT INTO agent_runs (organization_id, principal_user_id, mode, status, request, trace_id, is_demo, created_by)
          VALUES (${ctx.organizationId}, ${session.userId}, 'ask', 'queued', ${`${queueClass} ${index}`},
                  ${`loop-${queueClass}-${departmentId.slice(0, 6)}-${index}-${Date.now()}`}, true, ${session.userId})
          RETURNING id`
        await enqueueRun(ctx, { runId: run!.id, departmentId, queueClass })
      }
    }

    await enqueueMany(bulk.id, 120, 'bulk')
    await enqueueMany(small.id, 4, 'interactive')

    const order: string[] = []
    for (let index = 0; index < 12; index += 1) {
      const claimed = await claimNextRun(ctx, 'phase4-loop', { maxConcurrentPerDepartment: 1000 })
      if (!claimed) break
      order.push(claimed.departmentId === small.id ? small.name : bulk.name)
      await ctx.sql`
        UPDATE agent_runs SET status = 'succeeded' WHERE organization_id = ${ctx.organizationId} AND id = ${claimed.runId}`
    }
    // Clear the rest so the loop can run again without a growing backlog.
    await ctx.sql`
      DELETE FROM agent_runs WHERE organization_id = ${ctx.organizationId} AND status = 'queued' AND is_demo = true`
    return order
  })

  console.log(`  Order served: ${served.join(', ')}\n`)
  const smallPositions = served.map((name, index) => ({ name, index })).filter((entry) => entry.name === small.name)
  ok(`${small.name} was not queued behind the bulk job`, smallPositions.length > 0 && smallPositions[0]!.index <= 1,
    `first served at position ${smallPositions[0]?.index ?? '—'}`)
  ok('Both departments were served in the first dozen', new Set(served).size === 2)

  await withTenant(session, async (ctx) => {
    const snapshot = await queueSnapshot(ctx, await loadActor(ctx))
    ok('The queue is visible per department', snapshot.length >= 2, `${snapshot.length} departments`)
  })

  // ---- 2. Jurisdiction and the review --------------------------------------
  console.log('\nRunning the works-council review…\n')
  const review = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const entities = await listLegalEntities(ctx, actor)
    if (entities.length === 0) {
      const created = await createLegalEntity(ctx, actor, { name: 'Northwind Logistics GmbH', country: 'DE' })
      await recordConsultation(ctx, actor, {
        legalEntityId: created.id,
        status: 'agreed',
        reference: 'BV-2026-014',
      })
    }
    return worksCouncilReview(ctx, actor)
  })

  for (const finding of review.findings) {
    console.log(`  ${finding.status === 'pass' ? '✓' : '✗'} ${finding.question}`)
    console.log(`      ${finding.evidence}`)
  }
  console.log()
  ok('The review runs against the strictest profile in use', review.profile === 'works_council', review.rules.label)
  ok('Every question is answered', review.findings.length >= 10, `${review.findings.length} questions`)
  ok('Nothing fails', review.failed === 0, review.findings.filter((f) => f.status !== 'pass').map((f) => f.id).join(', '))

  // ---- 3. Contact is rationed ----------------------------------------------
  console.log('\nChasing one person harder than the profile allows…\n')
  const nudges = await withTenant(session, async (ctx) => {
    const [person] = await ctx.sql<{ id: string; name: string }[]>`
      SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ${ctx.organizationId} AND m.role = 'member' AND m.deleted_at IS NULL
      ORDER BY u.name LIMIT 1`
    const due = new Date(Date.now() - 86_400_000)

    for (let index = 0; index < 5; index += 1) {
      const [task] = await ctx.sql<{ id: string }[]>`
        INSERT INTO tasks (organization_id, title, status, priority, assignee_id, due_at, is_demo, created_by)
        VALUES (${ctx.organizationId}, ${`loop chase ${index} ${Date.now()}`}, 'todo', 'medium', ${person!.id}, ${due}, true, ${session.userId})
        RETURNING id`
      await scheduleLadder(ctx, {
        recipientUserId: person!.id,
        subjectType: 'task',
        subjectId: task!.id,
        subjectLabel: 'A late task',
        dueAt: due,
      })
    }

    // Not delivered on a day nobody works (ADR 0039), so the beat names the day it means
    // rather than depending on which day CI happens to run.
    const workingDay = nextWorkingDay('uk-england-wales', calendarDate('Europe/London'))
    const outcome = await deliverDueNudges(ctx, { now: new Date(`${workingDay}T23:59:00Z`) })
    const budget = await nudgeBudget(ctx, person!.id)
    return { person: person!, outcome, budget }
  })

  console.log(
    `  ${nudges.person.name}: ${nudges.outcome.delivered} delivered, ${nudges.outcome.heldByBudget} held back, ` +
      `budget ${nudges.budget.usedToday}/${nudges.budget.perDay}\n`,
  )
  ok('Contact stops at the profile’s daily limit', nudges.outcome.delivered <= nudges.budget.perDay)
  ok('What was held back is reported rather than dropped', nudges.outcome.heldByBudget > 0)
  ok('The budget belongs to the person, not the agent', nudges.budget.perDay === PROFILES[review.profile].maxNudgesPerPersonPerDay)

  // ---- 4. Sharing without role inflation -----------------------------------
  const shared = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const [project] = await ctx.sql<{ id: string }[]>`
      SELECT id FROM projects WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL LIMIT 1`
    const [viewer] = await ctx.sql<{ id: string; name: string }[]>`
      SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ${ctx.organizationId} AND m.role = 'viewer' AND m.deleted_at IS NULL LIMIT 1`
    if (!project || !viewer) return null

    const grant = await share(ctx, actor, {
      subjectType: 'user',
      subjectId: viewer.id,
      relation: 'editor',
      objectType: 'project',
      objectId: project.id,
      reason: 'Covering the account while the owner is away.',
    })

    const after = await loadActor(ctx, viewer.id)
    const { can } = await import('@superwork/auth')
    const decision = can(after, 'project:update', {
      type: 'project',
      id: project.id,
      organizationId: ctx.organizationId,
      riskTier: 'low',
    })

    // Put the demo back. This beat's point is that a share grants one thing; leaving it in
    // place means every later run — and the browser check — reads a demo that somebody
    // silently handed a project to.
    await unshare(ctx, actor, { objectType: 'project', objectId: project.id, tupleId: grant.id })
    return { role: after.role, allowed: decision.allow, reason: decision.reason, name: viewer.name }
  })

  if (shared) {
    ok('A share grants one thing without changing a role', shared.allowed && shared.role === 'viewer',
      `${shared.name} is still a ${shared.role}`)
    ok('The reason names the share', /shared with you as editor/i.test(shared.reason))
  }

  // ---- 5. Placement --------------------------------------------------------
  const placement = await withTenant(session, (ctx) => placementFor(ctx))
  const target = resolveShard(placement)
  ok('The tenant resolves to a configured shard', target.configured, `${target.shard} via ${target.connectionEnvVar}`)

  // ---- 6. What the budgets require -----------------------------------------
  console.log('\n§26.9 budgets — measured by `pnpm loadtest`, not by this loop:\n')
  for (const entry of SCALE_BUDGETS) {
    console.log(`  · ${entry.label}: ${entry.percentile} under ${entry.targetMs.toLocaleString('en-GB')} ms at ${entry.referenceScale}`)
  }

  console.log(
    process.exitCode === 1
      ? '\nPhase 4 loop failed.\n'
      : '\nPhase 4 acceptance loop passed: nobody is starved, the review answers with evidence, and contact is rationed.\n',
  )
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await closePools()
}
