import type { TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { PermissionError, ValidationError } from './errors.js'
import { writeAudit } from './audit.js'

/**
 * Fair-share scheduling for agent runs (§26.6, §24 Phase 4 acceptance).
 *
 * "No department can starve another's agent runs."
 *
 * First-come-first-served fails that on the first bulk job: one department queues two
 * hundred runs at 09:00 and everybody else waits behind them. This is deficit weighted
 * round-robin, held in the database rather than in a process, so several workers agree and
 * a restart does not hand somebody a fresh turn:
 *
 *   • each department has a weight, a concurrency cap and an hourly rate;
 *   • a department accrues deficit while it waits and spends it when it is served;
 *   • the next run comes from the eligible department with the largest deficit, and only
 *     from departments under their own caps;
 *   • claiming happens in one transaction with `FOR UPDATE SKIP LOCKED`, so two workers
 *     never take the same run.
 *
 * Interactive runs are scheduled ahead of background and bulk work of the same weight,
 * because a person waiting at a keyboard is a different thing from a nightly sweep.
 */

export type QueueClass = 'interactive' | 'background' | 'bulk'

const CLASS_PRIORITY: Record<QueueClass, number> = { interactive: 0, background: 1, bulk: 2 }

export interface QuotaView {
  departmentId: string | null
  departmentName: string
  weight: number
  maxConcurrent: number
  runsPerHour: number
  deficit: number
  queued: number
  running: number
  ranLastHour: number
  oldestWaitMs: number
}

export interface ClaimedRun {
  runId: string
  departmentId: string | null
  queueClass: QueueClass
  queueWaitMs: number
}

/** Enqueues a run for the scheduler. Returns the queue position it went in at. */
export async function enqueueRun(
  ctx: TenantContext,
  input: { runId: string; departmentId: string | null; queueClass?: QueueClass },
): Promise<{ position: number }> {
  await ctx.sql`
    UPDATE agent_runs
    SET status = 'queued', queued_at = now(),
        department_id = ${input.departmentId},
        queue_class = ${input.queueClass ?? 'interactive'}
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.runId}`

  const [row] = await ctx.sql<{ position: string }[]>`
    SELECT count(*)::text AS position FROM agent_runs
    WHERE organization_id = ${ctx.organizationId} AND status = 'queued' AND deleted_at IS NULL
      AND queued_at <= (SELECT queued_at FROM agent_runs WHERE id = ${input.runId})`
  return { position: Number(row?.position ?? 1) }
}

/**
 * Claims the next run. One transaction: pick the department, then the run, then charge
 * the deficit. Returns null when nothing is eligible — which includes "everything queued
 * belongs to departments that are already at their concurrency cap".
 */
export async function claimNextRun(
  ctx: TenantContext,
  worker: string,
  options: { maxConcurrentPerDepartment?: number } = {},
): Promise<ClaimedRun | null> {
  const sql = ctx.sql
  const org = ctx.organizationId

  // Departments with queued work, their caps, and what they are already running.
  const candidates = await sql<
    {
      department_id: string | null
      weight: number
      max_concurrent: number
      runs_per_hour: number
      deficit: number
      queued: string
      running: string
      ran_last_hour: string
      best_class: QueueClass
      oldest: Date
    }[]
  >`
    WITH queued AS (
      SELECT r.department_id,
             count(*) AS queued,
             min(r.queued_at) AS oldest,
             min(CASE r.queue_class WHEN 'interactive' THEN 0 WHEN 'background' THEN 1 ELSE 2 END) AS best_class
      FROM agent_runs r
      WHERE r.organization_id = ${org} AND r.deleted_at IS NULL AND r.status = 'queued'
      GROUP BY r.department_id
    ),
    running AS (
      SELECT r.department_id, count(*) AS running
      FROM agent_runs r
      WHERE r.organization_id = ${org} AND r.deleted_at IS NULL
        AND r.status IN ('planning', 'running')
      GROUP BY r.department_id
    ),
    recent AS (
      SELECT r.department_id, count(*) AS ran_last_hour
      FROM agent_runs r
      WHERE r.organization_id = ${org} AND r.deleted_at IS NULL
        AND r.claimed_at > now() - interval '1 hour'
      GROUP BY r.department_id
    )
    SELECT q.department_id,
           coalesce(dq.weight, def.weight, 1) AS weight,
           coalesce(dq.max_concurrent, def.max_concurrent, 4) AS max_concurrent,
           coalesce(dq.runs_per_hour, def.runs_per_hour, 240) AS runs_per_hour,
           coalesce(dq.deficit, 0) AS deficit,
           q.queued::text, coalesce(r.running, 0)::text AS running,
           coalesce(c.ran_last_hour, 0)::text AS ran_last_hour,
           (ARRAY['interactive','background','bulk'])[q.best_class + 1] AS best_class,
           q.oldest
    FROM queued q
    LEFT JOIN running r ON r.department_id IS NOT DISTINCT FROM q.department_id
    LEFT JOIN recent c ON c.department_id IS NOT DISTINCT FROM q.department_id
    LEFT JOIN department_quotas dq
      ON dq.organization_id = ${org} AND dq.deleted_at IS NULL
     AND dq.department_id IS NOT DISTINCT FROM q.department_id
    LEFT JOIN department_quotas def
      ON def.organization_id = ${org} AND def.deleted_at IS NULL AND def.department_id IS NULL`

  const eligible = candidates.filter((row) => {
    const cap = options.maxConcurrentPerDepartment ?? row.max_concurrent
    return Number(row.running) < cap && Number(row.ran_last_hour) < row.runs_per_hour
  })
  if (eligible.length === 0) return null

  // Interactive work first, then the largest deficit, then the oldest wait. Weight enters
  // through the deficit: a department on weight 3 accrues three times as fast.
  eligible.sort((a, b) => {
    const classDelta = CLASS_PRIORITY[a.best_class] - CLASS_PRIORITY[b.best_class]
    if (classDelta !== 0) return classDelta
    const deficitDelta = b.deficit + b.weight - (a.deficit + a.weight)
    if (deficitDelta !== 0) return deficitDelta
    if (b.weight !== a.weight) return b.weight - a.weight
    return a.oldest.getTime() - b.oldest.getTime()
  })

  const chosen = eligible[0]!

  const [claimed] = await sql<{ id: string; queue_class: QueueClass; queued_at: Date }[]>`
    UPDATE agent_runs SET status = 'planning', claimed_at = now(), claimed_by = ${worker},
                          queue_wait_ms = (extract(epoch FROM (now() - queued_at)) * 1000)::int
    WHERE id = (
      SELECT r.id FROM agent_runs r
      WHERE r.organization_id = ${org} AND r.deleted_at IS NULL AND r.status = 'queued'
        AND r.department_id IS NOT DISTINCT FROM ${chosen.department_id}
      ORDER BY CASE r.queue_class WHEN 'interactive' THEN 0 WHEN 'background' THEN 1 ELSE 2 END,
               r.queued_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, queue_class, queued_at`

  if (!claimed) return null

  // Deficit round-robin. Each scheduling decision credits every backlogged department its
  // own weight and charges the served one the total weight of the backlog. Over N
  // decisions a department is served N·wᵢ/Σw times — which is its share, exactly — and
  // the deficits stay bounded rather than inflating.
  const totalWeight = eligible.reduce((sum, row) => sum + row.weight, 0)
  for (const department of eligible) {
    const delta = department.department_id === chosen.department_id
      ? department.weight - totalWeight
      : department.weight
    await sql`
      INSERT INTO department_quotas (organization_id, department_id, deficit, last_served_at, created_by)
      VALUES (
        ${org}, ${department.department_id}, ${delta},
        ${department.department_id === chosen.department_id ? new Date() : null}, ${ctx.userId}
      )
      ON CONFLICT (organization_id, coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid))
        WHERE deleted_at IS NULL
      DO UPDATE SET
        deficit = department_quotas.deficit + ${delta},
        last_served_at = coalesce(EXCLUDED.last_served_at, department_quotas.last_served_at)`
  }

  return {
    runId: claimed.id,
    departmentId: chosen.department_id,
    queueClass: claimed.queue_class,
    queueWaitMs: Date.now() - claimed.queued_at.getTime(),
  }
}

export async function queueSnapshot(ctx: TenantContext, actor: Actor): Promise<QuotaView[]> {
  const decision = can(actor, 'agent_run:read', { type: 'agent_run', organizationId: ctx.organizationId })
  if (!decision.allow) throw new PermissionError(decision.reason)

  return ctx.sql<QuotaView[]>`
    SELECT d.id AS "departmentId", coalesce(d.name, 'No department') AS "departmentName",
           coalesce(dq.weight, def.weight, 1) AS weight,
           coalesce(dq.max_concurrent, def.max_concurrent, 4) AS "maxConcurrent",
           coalesce(dq.runs_per_hour, def.runs_per_hour, 240) AS "runsPerHour",
           coalesce(dq.deficit, 0) AS deficit,
           (SELECT count(*)::int FROM agent_runs r
             WHERE r.organization_id = ${ctx.organizationId} AND r.deleted_at IS NULL
               AND r.status = 'queued' AND r.department_id IS NOT DISTINCT FROM d.id) AS queued,
           (SELECT count(*)::int FROM agent_runs r
             WHERE r.organization_id = ${ctx.organizationId} AND r.deleted_at IS NULL
               AND r.status IN ('planning', 'running')
               AND r.department_id IS NOT DISTINCT FROM d.id) AS running,
           (SELECT count(*)::int FROM agent_runs r
             WHERE r.organization_id = ${ctx.organizationId} AND r.deleted_at IS NULL
               AND r.claimed_at > now() - interval '1 hour'
               AND r.department_id IS NOT DISTINCT FROM d.id) AS "ranLastHour",
           coalesce((SELECT (extract(epoch FROM (now() - min(r.queued_at))) * 1000)::int
                     FROM agent_runs r
                     WHERE r.organization_id = ${ctx.organizationId} AND r.deleted_at IS NULL
                       AND r.status = 'queued' AND r.department_id IS NOT DISTINCT FROM d.id), 0) AS "oldestWaitMs"
    FROM departments d
    LEFT JOIN department_quotas dq
      ON dq.organization_id = ${ctx.organizationId} AND dq.deleted_at IS NULL AND dq.department_id = d.id
    LEFT JOIN department_quotas def
      ON def.organization_id = ${ctx.organizationId} AND def.deleted_at IS NULL AND def.department_id IS NULL
    WHERE d.organization_id = ${ctx.organizationId} AND d.deleted_at IS NULL
    ORDER BY d.name`
}

export async function setQuota(
  ctx: TenantContext,
  actor: Actor,
  input: { departmentId: string | null; weight: number; maxConcurrent: number; runsPerHour: number },
): Promise<void> {
  const decision = can(actor, 'settings:update', {
    type: 'settings',
    organizationId: ctx.organizationId,
    riskTier: 'high',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
  if (input.weight < 1 || input.maxConcurrent < 1 || input.runsPerHour < 1) {
    throw new ValidationError('A quota of zero is a department that never runs. Pause its agents instead.')
  }

  await ctx.sql`
    INSERT INTO department_quotas (
      organization_id, department_id, weight, max_concurrent, runs_per_hour, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.departmentId}, ${input.weight}, ${input.maxConcurrent},
      ${input.runsPerHour}, ${ctx.userId}
    )
    ON CONFLICT (organization_id, coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid))
      WHERE deleted_at IS NULL
    DO UPDATE SET weight = EXCLUDED.weight, max_concurrent = EXCLUDED.max_concurrent,
                  runs_per_hour = EXCLUDED.runs_per_hour`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'scheduler.quota_set',
    entityType: 'department',
    entityId: input.departmentId,
    after: { weight: input.weight, maxConcurrent: input.maxConcurrent, runsPerHour: input.runsPerHour },
  })
}

/** Queue wait percentiles, which is the §26.9 budget the scheduler is measured against. */
export async function queueWaitPercentiles(
  ctx: TenantContext,
  sinceMinutes = 60,
): Promise<{ samples: number; p50Ms: number; p95Ms: number; maxMs: number }> {
  const [row] = await ctx.sql<{ samples: string; p50: string; p95: string; max: string }[]>`
    SELECT count(*)::text AS samples,
           coalesce(percentile_disc(0.5) WITHIN GROUP (ORDER BY queue_wait_ms), 0)::text AS p50,
           coalesce(percentile_disc(0.95) WITHIN GROUP (ORDER BY queue_wait_ms), 0)::text AS p95,
           coalesce(max(queue_wait_ms), 0)::text AS max
    FROM agent_runs
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
      AND queue_wait_ms IS NOT NULL
      AND claimed_at > now() - make_interval(mins => ${sinceMinutes})`
  return {
    samples: Number(row?.samples ?? 0),
    p50Ms: Number(row?.p50 ?? 0),
    p95Ms: Number(row?.p95 ?? 0),
    maxMs: Number(row?.max ?? 0),
  }
}
