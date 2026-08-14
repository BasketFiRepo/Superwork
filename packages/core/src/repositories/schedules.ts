import type { TenantContext } from '@superwork/db'
import { nextOccurrence, occurrencesBetween } from '../cron.js'
import { writeAudit } from '../audit.js'

/**
 * Schedules (§10.2, §26.5).
 *
 * A schedule is a row with a cron expression, a timezone and a catch-up policy. The
 * catch-up policy is the part that matters: a worker that was down overnight must not wake
 * up and fire twelve hours of missed runs at somebody. What it skips is counted and
 * reported rather than quietly dropped.
 *
 * Claiming is `FOR UPDATE SKIP LOCKED` and advances `next_run_at` in the same transaction,
 * so two workers cannot both decide it is their turn.
 */

export type CatchUpPolicy = 'skip_missed' | 'run_once' | 'run_all'

export interface ScheduleView {
  id: string
  kind: string
  targetId: string | null
  cron: string
  timezone: string
  enabled: boolean
  catchUpPolicy: CatchUpPolicy
  lastRunAt: Date | null
  nextRunAt: Date | null
  lastSkippedAt: Date | null
  lastSkippedReason: string | null
  skippedTotal: number
}

/** How late a `skip_missed` firing may be and still run. Beyond this it is a missed firing. */
const GRACE_MS = 10 * 60_000

/** Even `run_all` will not fire more than this in one sweep; the rest are reported as dropped. */
const MAX_CATCH_UP = 5

const SELECT = (ctx: TenantContext) => ctx.sql`
  SELECT id, kind, target_id AS "targetId", cron, timezone, enabled,
         catch_up_policy AS "catchUpPolicy", last_run_at AS "lastRunAt", next_run_at AS "nextRunAt",
         last_skipped_at AS "lastSkippedAt", last_skipped_reason AS "lastSkippedReason",
         skipped_total AS "skippedTotal"
  FROM schedules`

export async function scheduleFor(
  ctx: TenantContext,
  kind: string,
  targetId: string,
): Promise<ScheduleView | null> {
  const [row] = await ctx.sql<ScheduleView[]>`
    ${SELECT(ctx)}
    WHERE organization_id = ${ctx.organizationId} AND kind = ${kind} AND target_id = ${targetId}
      AND deleted_at IS NULL`
  return row ?? null
}

export async function listSchedules(ctx: TenantContext, kind: string): Promise<ScheduleView[]> {
  return ctx.sql<ScheduleView[]>`
    ${SELECT(ctx)}
    WHERE organization_id = ${ctx.organizationId} AND kind = ${kind} AND deleted_at IS NULL
    ORDER BY next_run_at NULLS LAST`
}

/**
 * Creates or re-points a schedule and computes its next firing. Called when a workflow is
 * activated — never when it is merely saved, because a draft that fires is not a draft.
 */
export async function upsertSchedule(
  ctx: TenantContext,
  input: {
    kind: string
    targetId: string
    cron: string
    timezone: string
    catchUpPolicy?: CatchUpPolicy
    enabled?: boolean
  },
): Promise<ScheduleView | null> {
  const next = nextOccurrence(input.cron, input.timezone)
  if (!next) return null

  await ctx.sql`
    INSERT INTO schedules (
      organization_id, kind, target_id, cron, timezone, enabled, catch_up_policy, next_run_at, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.kind}, ${input.targetId}, ${input.cron}, ${input.timezone},
      ${input.enabled ?? true}, ${input.catchUpPolicy ?? 'run_once'}, ${next}, ${ctx.userId}
    )
    ON CONFLICT (organization_id, kind, target_id) WHERE deleted_at IS NULL AND target_id IS NOT NULL
    DO UPDATE SET cron = EXCLUDED.cron, timezone = EXCLUDED.timezone, enabled = EXCLUDED.enabled,
                  catch_up_policy = EXCLUDED.catch_up_policy, next_run_at = EXCLUDED.next_run_at`

  await writeAudit(ctx, {
    actorType: 'user',
    actorId: ctx.userId,
    action: 'schedule.set',
    entityType: input.kind,
    entityId: input.targetId,
    after: { cron: input.cron, timezone: input.timezone, nextRunAt: next.toISOString() },
  })
  return scheduleFor(ctx, input.kind, input.targetId)
}

/** Stops a schedule without forgetting it — pausing and deleting are different decisions. */
export async function setScheduleEnabled(
  ctx: TenantContext,
  kind: string,
  targetId: string,
  enabled: boolean,
): Promise<void> {
  const [updated] = await ctx.sql<{ id: string }[]>`
    UPDATE schedules SET enabled = ${enabled}
    WHERE organization_id = ${ctx.organizationId} AND kind = ${kind} AND target_id = ${targetId}
      AND deleted_at IS NULL AND enabled <> ${enabled}
    RETURNING id`
  if (!updated) return
  await writeAudit(ctx, {
    actorType: 'user',
    actorId: ctx.userId,
    action: enabled ? 'schedule.enabled' : 'schedule.disabled',
    entityType: kind,
    entityId: targetId,
  })
}

export interface ClaimedSchedule {
  scheduleId: string
  targetId: string
  cron: string
  timezone: string
  /** How many times to run now: 1 normally, more only under `run_all`. */
  runs: number
  /** Firings that were due but will not happen, and why. Never silently dropped. */
  skipped: number
  skippedReason: string | null
  dueAt: Date
  nextRunAt: Date | null
}

/**
 * Claims every schedule of `kind` that is due, advancing each one's next firing in the same
 * transaction. Two workers running this concurrently divide the work between them; neither
 * sees the other's rows.
 */
export async function claimDueSchedules(
  ctx: TenantContext,
  kind: string,
  limit = 20,
  now = new Date(),
): Promise<ClaimedSchedule[]> {
  const due = await ctx.sql<{ id: string; target_id: string; cron: string; timezone: string; catch_up_policy: CatchUpPolicy; next_run_at: Date }[]>`
    SELECT id, target_id, cron, timezone, catch_up_policy, next_run_at
    FROM schedules
    WHERE organization_id = ${ctx.organizationId} AND kind = ${kind}
      AND deleted_at IS NULL AND enabled = true
      AND next_run_at IS NOT NULL AND next_run_at <= ${now}
    ORDER BY next_run_at
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED`

  const claimed: ClaimedSchedule[] = []
  for (const row of due) {
    // Everything due between the firing we are acting on and now, inclusive of that one.
    const missed = occurrencesBetween(row.cron, row.timezone, new Date(row.next_run_at.getTime() - 1), now).length || 1
    const lateBy = now.getTime() - row.next_run_at.getTime()

    let runs = 1
    let skipped = 0
    let reason: string | null = null

    if (row.catch_up_policy === 'skip_missed') {
      if (lateBy > GRACE_MS) {
        runs = 0
        skipped = missed
        reason = `Set to skip missed runs, and this one was ${Math.round(lateBy / 60_000)} minutes late.`
      }
    } else if (row.catch_up_policy === 'run_all') {
      runs = Math.min(missed, MAX_CATCH_UP)
      skipped = missed - runs
      if (skipped > 0) reason = `${missed} firings were missed; ${MAX_CATCH_UP} is the most one sweep will catch up.`
    } else {
      skipped = missed - 1
      if (skipped > 0) reason = `${missed} firings were missed while nothing was running; this catches up once.`
    }

    const next = nextOccurrence(row.cron, row.timezone, now)
    await ctx.sql`
      UPDATE schedules SET
        -- coalesce, not assignment: a skipped firing must not erase when it last ran,
        -- and a clean firing must not erase what it last skipped.
        last_run_at = coalesce(${runs > 0 ? now : null}, last_run_at),
        next_run_at = ${next},
        last_skipped_at = coalesce(${skipped > 0 ? now : null}, last_skipped_at),
        last_skipped_reason = coalesce(${reason}, last_skipped_reason),
        skipped_total = skipped_total + ${skipped}
      WHERE organization_id = ${ctx.organizationId} AND id = ${row.id}`

    claimed.push({
      scheduleId: row.id,
      targetId: row.target_id,
      cron: row.cron,
      timezone: row.timezone,
      runs,
      skipped,
      skippedReason: reason,
      dueAt: row.next_run_at,
      nextRunAt: next,
    })
  }
  return claimed
}
