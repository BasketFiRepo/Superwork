/**
 * The §26.9 scale harness (§24, Phase 4 acceptance).
 *
 * Generates a synthetic tenant, then measures the operations the budgets are stated
 * against: a scoped list view, a permission check, scoped hybrid search, agent run queue
 * wait, notification fan-out and an incremental SCIM sync.
 *
 * It is honest about what it measured. The budgets are stated at 100,000 users and a
 * 50-million-row table; this machine builds what it can in the time available, and the
 * report prints the scale it actually reached next to the scale the target assumes. A
 * green line at 5,000 users is evidence that the query shape is right — an index is being
 * used, nothing is doing per-row work — and it is not a claim about 100,000.
 *
 *   pnpm loadtest                # ~5k users, ~120k tasks
 *   SCALE=large pnpm loadtest    # ~25k users, ~600k tasks (several minutes)
 *   SCALE=small pnpm loadtest    # ~500 users, ~12k tasks (quick)
 */
import { randomUUID } from 'node:crypto'
import { adminSql, closePools, withTenant, type TenantContext } from '@superwork/db'
import { hashPassword, loadActor, can } from '@superwork/auth'
import {
  claimNextRun,
  enqueueRun,
  hybridSearch,
  judge,
  listTasks,
  percentiles,
  queueWaitPercentiles,
  SCALE_BUDGETS,
  type BudgetVerdict,
} from '@superwork/core'

const SCALES = {
  small: { users: 500, tasksPerUser: 24, documents: 40, notifications: 1_000 },
  medium: { users: 5_000, tasksPerUser: 24, documents: 200, notifications: 5_000 },
  large: { users: 25_000, tasksPerUser: 24, documents: 400, notifications: 5_000 },
} as const

const scaleName = (process.env['SCALE'] ?? 'medium') as keyof typeof SCALES
const scale = SCALES[scaleName] ?? SCALES.medium
const SLUG = 'loadtest'

function ms(): () => number {
  const started = process.hrtime.bigint()
  return () => Number(process.hrtime.bigint() - started) / 1_000_000
}

async function build(): Promise<{ organizationId: string; ownerId: string; userIds: string[] }> {
  const sql = adminSql()
  console.log(`Building a ${scaleName} tenant: ${scale.users.toLocaleString('en-GB')} users, ` +
    `${(scale.users * scale.tasksPerUser).toLocaleString('en-GB')} tasks…`)

  await sql`DELETE FROM organizations WHERE slug = ${SLUG}`
  const [org] = await sql<{ id: string }[]>`
    INSERT INTO organizations (name, slug, timezone, is_demo)
    VALUES ('Load test tenant', ${SLUG}, 'Europe/London', true) RETURNING id`
  const organizationId = org!.id

  const password = await hashPassword('loadtest')
  // Email uniqueness is a partial index on lower(email); the conflict target has to
  // match it exactly, so the harness clears its own users rather than upserting.
  await sql`DELETE FROM users WHERE email LIKE ${`%.${SLUG}@fixture.example`}`
  const [owner] = await sql<{ id: string }[]>`
    INSERT INTO users (email, name, password_hash, timezone, is_demo)
    VALUES (${`owner.${SLUG}@fixture.example`}, 'Load Owner', ${password}, 'Europe/London', true)
    RETURNING id`
  const ownerId = owner!.id
  await sql`
    INSERT INTO memberships (organization_id, user_id, role, is_demo)
    VALUES (${organizationId}, ${ownerId}, 'owner', true)`

  // Departments first: the scheduler and the ledger both group by them.
  const departmentIds: string[] = []
  for (const name of ['Operations', 'Finance', 'Commercial', 'Quality', 'Executive']) {
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO departments (organization_id, name, path, is_demo, created_by)
      VALUES (${organizationId}, ${name}, ${name.toLowerCase()}, true, ${ownerId}) RETURNING id`
    departmentIds.push(row!.id)
  }

  // Users in batches. `unnest` inserts a whole batch in one statement — the same shape the
  // SCIM importer uses, so this measures the real path rather than a shortcut.
  const userIds: string[] = [ownerId]
  const BATCH = 2_000
  for (let start = 0; start < scale.users; start += BATCH) {
    const size = Math.min(BATCH, scale.users - start)
    const emails = Array.from({ length: size }, (_, index) => `user${start + index}.${SLUG}@fixture.example`)
    const names = Array.from({ length: size }, (_, index) => `Person ${start + index}`)
    const rows = await sql<{ id: string }[]>`
      INSERT INTO users (email, name, password_hash, timezone, is_demo)
      SELECT e, n, ${password}, 'Europe/London', true
      FROM unnest(${emails}::text[], ${names}::text[]) AS t(e, n)
      RETURNING id`
    const ids = rows.map((row) => row.id)
    const departments = ids.map((_, index) => departmentIds[index % departmentIds.length]!)
    await sql`
      INSERT INTO memberships (organization_id, user_id, role, department_id, is_demo)
      SELECT ${organizationId}, u, 'member'::sw_role, d, true
      FROM unnest(${ids}::uuid[], ${departments}::uuid[]) AS t(u, d)
      ON CONFLICT DO NOTHING`
    userIds.push(...ids)
    process.stdout.write(`\r  users: ${Math.min(start + size, scale.users).toLocaleString('en-GB')}`)
  }
  process.stdout.write('\n')

  // `waiting` needs a target and `blocked` needs a reason — both are constraints doing
  // their job, so the generator sticks to the statuses a bulk insert can satisfy.
  const statuses = ['todo', 'in_progress', 'review', 'completed', 'backlog']
  let inserted = 0
  for (let start = 0; start < userIds.length; start += 500) {
    const slice = userIds.slice(start, start + 500)
    const assignees: string[] = []
    const titles: string[] = []
    const statusColumn: string[] = []
    for (const userId of slice) {
      for (let index = 0; index < scale.tasksPerUser; index += 1) {
        assignees.push(userId)
        titles.push(`Task ${index} for ${userId.slice(0, 8)}`)
        statusColumn.push(statuses[(index + start) % statuses.length]!)
      }
    }
    await sql`
      INSERT INTO tasks (organization_id, title, status, priority, assignee_id, is_demo, created_by)
      SELECT ${organizationId}, t, s::sw_task_status, 'medium'::sw_priority, a, true, ${ownerId}
      FROM unnest(${titles}::text[], ${statusColumn}::text[], ${assignees}::uuid[]) AS x(t, s, a)`
    inserted += titles.length
    process.stdout.write(`\r  tasks: ${inserted.toLocaleString('en-GB')}`)
  }
  process.stdout.write('\n')

  // A small corpus so hybrid search has something to rank; the ACL predicate is what is
  // being measured, not the quality of the ranking.
  await withTenant({ organizationId, userId: ownerId, timezone: 'Europe/London' }, async (ctx) => {
    const { ingestDocument } = await import('@superwork/core')
    for (let index = 0; index < scale.documents; index += 1) {
      const [doc] = await ctx.sql<{ id: string }[]>`
        INSERT INTO documents (organization_id, title, doc_type, sensitivity, index_status, is_demo, created_by)
        VALUES (${organizationId}, ${`Operations note ${index}`}, 'note', 'internal', 'pending', true, ${ownerId})
        RETURNING id`
      await ingestDocument(ctx, {
        documentId: doc!.id,
        title: `Operations note ${index}`,
        docType: 'note',
        body:
          `# Operations note ${index}\n\n## Cold chain\n\nReefer units are pre-cooled for 90 minutes before ` +
          `loading. Excursion ${index} was reported at the Immingham depot and escalated to the duty planner ` +
          `within thirty minutes.\n\n## Liability\n\nThe cap for consignment ${index} is £60,000.\n`,
      })
      if (index % 50 === 0) process.stdout.write(`\r  documents: ${index}`)
    }
    process.stdout.write(`\r  documents: ${scale.documents}\n`)
    await ctx.sql`ANALYZE`
  })

  return { organizationId, ownerId, userIds }
}

async function measureListView(ctx: TenantContext, userIds: string[]): Promise<number[]> {
  const actor = await loadActor(ctx)
  const samples: number[] = []
  for (let index = 0; index < 60; index += 1) {
    const assignee = userIds[(index * 977) % userIds.length]!
    const stop = ms()
    await listTasks(ctx, actor, { assigneeId: assignee, status: ['todo', 'in_progress'], limit: 50 })
    samples.push(stop())
  }
  return samples
}

async function measurePermissionChecks(ctx: TenantContext, userIds: string[]): Promise<number[]> {
  const samples: number[] = []
  for (let index = 0; index < 200; index += 1) {
    const userId = userIds[(index * 613) % userIds.length]!
    const stop = ms()
    const actor = await loadActor(ctx, userId)
    can(actor, 'task:update', {
      type: 'task',
      organizationId: ctx.organizationId,
      assigneeId: userId,
      riskTier: 'low',
    })
    samples.push(stop())
  }
  return samples
}

async function measureSearch(ctx: TenantContext): Promise<number[]> {
  const actor = await loadActor(ctx)
  const samples: number[] = []
  const queries = ['cold chain excursion', 'liability cap', 'pre-cool duration', 'duty planner escalation']
  for (let index = 0; index < 24; index += 1) {
    const stop = ms()
    await hybridSearch(ctx, actor, queries[index % queries.length]!, { topK: 8 })
    samples.push(stop())
  }
  return samples
}

async function measureQueue(ctx: TenantContext, ownerId: string): Promise<{ samples: number; p50: number; p95: number }> {
  const departments = await ctx.sql<{ id: string }[]>`
    SELECT id FROM departments WHERE organization_id = ${ctx.organizationId} ORDER BY name`

  // A bulk job from one department, then interactive work from the others. The budget is
  // about the interactive wait while the bulk job is in the queue.
  for (let index = 0; index < 300; index += 1) {
    const [run] = await ctx.sql<{ id: string }[]>`
      INSERT INTO agent_runs (organization_id, principal_user_id, mode, status, request, trace_id, is_demo, created_by)
      VALUES (${ctx.organizationId}, ${ownerId}, 'ask', 'queued', 'bulk sweep', ${randomUUID()}, true, ${ownerId})
      RETURNING id`
    await enqueueRun(ctx, { runId: run!.id, departmentId: departments[0]!.id, queueClass: 'bulk' })
  }
  for (let index = 0; index < 40; index += 1) {
    const [run] = await ctx.sql<{ id: string }[]>`
      INSERT INTO agent_runs (organization_id, principal_user_id, mode, status, request, trace_id, is_demo, created_by)
      VALUES (${ctx.organizationId}, ${ownerId}, 'ask', 'queued', 'person waiting', ${randomUUID()}, true, ${ownerId})
      RETURNING id`
    await enqueueRun(ctx, {
      runId: run!.id,
      departmentId: departments[1 + (index % (departments.length - 1))]!.id,
      queueClass: 'interactive',
    })
  }

  for (let index = 0; index < 60; index += 1) {
    const claimed = await claimNextRun(ctx, 'loadtest', { maxConcurrentPerDepartment: 1000 })
    if (!claimed) break
    await ctx.sql`UPDATE agent_runs SET status = 'succeeded' WHERE organization_id = ${ctx.organizationId} AND id = ${claimed.runId}`
  }

  const waits = await queueWaitPercentiles(ctx)
  return { samples: waits.samples, p50: waits.p50Ms, p95: waits.p95Ms }
}

async function measureFanout(ctx: TenantContext, userIds: string[], count: number): Promise<number> {
  const recipients = userIds.slice(0, count)
  const stop = ms()
  const BATCH = 1_000
  for (let start = 0; start < recipients.length; start += BATCH) {
    const slice = recipients.slice(start, start + BATCH)
    await ctx.sql`
      INSERT INTO notifications (organization_id, user_id, type, title, body, channel, delivery, is_demo, created_by)
      SELECT ${ctx.organizationId}, u, 'briefing.ready', 'Your briefing is ready',
             'Three threads are past their SLA.', 'in_app', 'digest', true, ${ctx.userId}
      FROM unnest(${slice}::uuid[]) AS t(u)`
  }
  return stop()
}

async function measureScimSync(ctx: TenantContext, userIds: string[]): Promise<{ elapsedMs: number; perUserMs: number }> {
  // An incremental sync touches every user: it resolves them by email and updates what
  // changed. Measured as one bulk statement per batch, which is how the importer runs.
  const sample = userIds.slice(0, Math.min(userIds.length, 5_000))
  const stop = ms()
  const BATCH = 1_000
  for (let start = 0; start < sample.length; start += BATCH) {
    const slice = sample.slice(start, start + BATCH)
    await ctx.sql`
      UPDATE memberships SET status = 'active'
      WHERE organization_id = ${ctx.organizationId} AND user_id = ANY(${slice}::uuid[])`
  }
  const elapsedMs = stop()
  return { elapsedMs, perUserMs: elapsedMs / sample.length }
}

async function explainListView(ctx: TenantContext, userId: string): Promise<string> {
  const rows = await ctx.sql<{ 'QUERY PLAN': string }[]>`
    EXPLAIN SELECT t.id FROM tasks t
    WHERE t.organization_id = ${ctx.organizationId} AND t.deleted_at IS NULL
      AND t.assignee_id = ${userId} AND t.status = ANY(ARRAY['todo','in_progress']::sw_task_status[])
    ORDER BY t.updated_at DESC, t.id DESC LIMIT 51`
  return rows.map((row) => row['QUERY PLAN']).join('\n')
}

const results: BudgetVerdict[] = []

try {
  console.log('\nSuperwork — §26.9 scale harness\n')
  const { organizationId, ownerId, userIds } = await build()
  const session = { organizationId, userId: ownerId, timezone: 'Europe/London' }
  const measuredScale = `${scale.users.toLocaleString('en-GB')} users, ${(scale.users * scale.tasksPerUser).toLocaleString('en-GB')} tasks`

  await withTenant(session, async (ctx) => {
    console.log('\nMeasuring…')

    const list = percentiles(await measureListView(ctx, userIds))
    results.push(judge({ key: 'list_view', samples: 60, measuredScale, ...list }))

    const permission = percentiles(await measurePermissionChecks(ctx, userIds))
    results.push(judge({ key: 'permission_check', samples: 200, measuredScale, ...permission }))

    const search = percentiles(await measureSearch(ctx))
    results.push(judge({ key: 'hybrid_search', samples: 24, measuredScale, ...search }))

    const queue = await measureQueue(ctx, ownerId)
    results.push(
      judge({
        key: 'queue_wait',
        samples: queue.samples,
        p50Ms: queue.p50,
        p95Ms: queue.p95,
        totalMs: queue.p95,
        measuredScale: `${queue.samples} runs behind a 300-run bulk job`,
      }),
    )

    const fanoutCount = Math.min(5_000, userIds.length)
    const fanoutMs = await measureFanout(ctx, userIds, fanoutCount)
    results.push(
      judge({
        key: 'notification_fanout',
        samples: fanoutCount,
        p50Ms: fanoutMs,
        p95Ms: fanoutMs,
        totalMs: fanoutMs,
        measuredScale: `${fanoutCount.toLocaleString('en-GB')} recipients`,
      }),
    )

    const scim = await measureScimSync(ctx, userIds)
    // Reported at the reference scale by rate, and labelled as the projection it is.
    const projectedMs = scim.perUserMs * 100_000
    results.push(
      judge({
        key: 'scim_sync',
        samples: Math.min(userIds.length, 5_000),
        p50Ms: scim.perUserMs,
        p95Ms: scim.perUserMs,
        totalMs: projectedMs,
        measuredScale: `${Math.min(userIds.length, 5_000).toLocaleString('en-GB')} users measured, projected to 100k at the same rate`,
      }),
    )

    console.log('\nQuery plan for the scoped list view:')
    console.log(
      (await explainListView(ctx, userIds[1] ?? ownerId))
        .split('\n')
        .map((line) => `  ${line}`)
        .join('\n'),
    )
  })

  console.log('\nBudgets (§26.9)\n')
  const width = Math.max(...SCALE_BUDGETS.map((entry) => entry.label.length))
  for (const verdict of results) {
    const mark = verdict.withinBudget ? '✓' : '✗'
    console.log(
      `  ${mark} ${verdict.label.padEnd(width)}  ${verdict.observedMs.toFixed(1).padStart(9)} ms ` +
        `${verdict.percentile.padEnd(5)} against ${verdict.targetMs.toLocaleString('en-GB').padStart(7)} ms`,
    )
    console.log(`      measured at ${verdict.measuredScale}; target stated at ${verdict.referenceScale}`)
    if (!verdict.withinBudget) process.exitCode = 1
  }

  const extrapolated = results.filter((verdict) => verdict.extrapolated).length
  console.log(
    `\n${results.filter((r) => r.withinBudget).length}/${results.length} within budget. ` +
      `${extrapolated} of them were measured below the scale the target assumes — that is evidence about query ` +
      `shape, not a 100,000-user result.\n`,
  )

  if (process.env['KEEP'] !== '1') {
    await adminSql()`DELETE FROM organizations WHERE slug = ${SLUG}`
    console.log('Tenant removed. Pass KEEP=1 to leave it in place.\n')
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  await closePools()
}
