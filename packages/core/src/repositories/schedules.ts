import type { TenantContext } from '@superwork/db'
import { cronProblem, describeCron, nextOccurrence, normalizeCron, occurrencesBetween } from '../cron.js'
import { ValidationError } from '../errors.js'
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
 *
 * A schedule addresses exactly one thing: a row (`targetId`, for a workflow) or a name
 * (`targetKey`, for a watcher, which is code rather than a row). A constraint enforces the
 * exclusive-or, so a schedule can never point at two things or at none.
 */

export type CatchUpPolicy = 'skip_missed' | 'run_once' | 'run_all'

export interface ScheduleView {
  id: string
  kind: string
  targetId: string | null
  targetKey: string | null
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
  SELECT id, kind, target_id AS "targetId", target_key AS "targetKey", cron, timezone, enabled,
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

/** The same, for the schedules that address code rather than a row. */
export async function scheduleForKey(
  ctx: TenantContext,
  kind: string,
  targetKey: string,
): Promise<ScheduleView | null> {
  const [row] = await ctx.sql<ScheduleView[]>`
    ${SELECT(ctx)}
    WHERE organization_id = ${ctx.organizationId} AND kind = ${kind} AND target_key = ${targetKey}
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
    /** Exactly one of these. A workflow is a row; a watcher is a name. */
    targetId?: string
    targetKey?: string
    cron: string
    timezone: string
    catchUpPolicy?: CatchUpPolicy
    enabled?: boolean
    /** When true an existing row is left exactly as it is. Used for seeding defaults. */
    onlyIfMissing?: boolean
  },
): Promise<ScheduleView | null> {
  if ((input.targetId === undefined) === (input.targetKey === undefined)) {
    throw new ValidationError('A schedule points at exactly one thing — a workflow row or a watcher key.')
  }
  // Aliases are normalized here, so one grammar reaches the database however it was
  // written. A spec that cannot be parsed is refused with the reason rather than stored as
  // a schedule that silently never fires.
  const problem = cronProblem(input.cron)
  if (problem) throw new ValidationError(problem)
  const cron = normalizeCron(input.cron)

  const next = nextOccurrence(cron, input.timezone)
  if (!next) return null

  const sql = ctx.sql
  const update = input.onlyIfMissing
    ? sql`DO NOTHING`
    : sql`DO UPDATE SET cron = EXCLUDED.cron, timezone = EXCLUDED.timezone, enabled = EXCLUDED.enabled,
                        catch_up_policy = EXCLUDED.catch_up_policy, next_run_at = EXCLUDED.next_run_at`
  const conflict = input.targetId
    ? sql`(organization_id, kind, target_id) WHERE deleted_at IS NULL AND target_id IS NOT NULL`
    : sql`(organization_id, kind, target_key) WHERE deleted_at IS NULL AND target_key IS NOT NULL`

  await sql`
    INSERT INTO schedules (
      organization_id, kind, target_id, target_key, cron, timezone, enabled, catch_up_policy,
      next_run_at, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.kind}, ${input.targetId ?? null}, ${input.targetKey ?? null},
      ${cron}, ${input.timezone}, ${input.enabled ?? true}, ${input.catchUpPolicy ?? 'run_once'},
      ${next}, ${ctx.userId}
    )
    ON CONFLICT ${conflict} ${update}`

  const stored = input.targetId
    ? await scheduleFor(ctx, input.kind, input.targetId)
    : await scheduleForKey(ctx, input.kind, input.targetKey!)

  // A seeding call that changed nothing is not a decision worth an audit line.
  if (!input.onlyIfMissing) {
    await writeAudit(ctx, {
      actorType: 'user',
      actorId: ctx.userId,
      action: 'schedule.set',
      entityType: input.kind,
      entityId: input.targetId ?? null,
      after: { target: input.targetId ?? input.targetKey, cron, timezone: input.timezone, nextRunAt: next.toISOString() },
    })
  }
  return stored
}

/**
 * Stops a schedule without forgetting it — pausing and deleting are different decisions.
 * `target` is a workflow's id or a watcher's key; comparing the id as text lets one
 * function serve both without the caller having to say which kind of target it holds.
 */
export async function setScheduleEnabled(
  ctx: TenantContext,
  kind: string,
  target: string,
  enabled: boolean,
): Promise<void> {
  const [updated] = await ctx.sql<{ id: string }[]>`
    UPDATE schedules SET enabled = ${enabled}
    WHERE organization_id = ${ctx.organizationId} AND kind = ${kind}
      AND (target_id::text = ${target} OR target_key = ${target})
      AND deleted_at IS NULL AND enabled <> ${enabled}
    RETURNING id`
  if (!updated) return
  await writeAudit(ctx, {
    actorType: 'user',
    actorId: ctx.userId,
    action: enabled ? 'schedule.enabled' : 'schedule.disabled',
    entityType: kind,
    entityId: null,
    after: { target },
  })
}

export interface ClaimedSchedule {
  scheduleId: string
  targetId: string | null
  targetKey: string | null
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
  const due = await ctx.sql<
    {
      id: string
      target_id: string | null
      target_key: string | null
      cron: string
      timezone: string
      catch_up_policy: CatchUpPolicy
      next_run_at: Date
    }[]
  >`
    SELECT id, target_id, target_key, cron, timezone, catch_up_policy, next_run_at
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
      targetKey: row.target_key,
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

export interface SchedulePreview {
  cron: string
  description: string
  /** The next few firings, as instants. Shown before anything is saved. */
  next: Date[]
}

/**
 * What a schedule would do, before it is one. Somebody about to put an automation on a
 * clock should see the first firings, not a cron string they have to trust — the same
 * reason a workflow cannot be activated without a dry run.
 */
export function previewSchedule(spec: string, timeZone: string, count = 3): SchedulePreview {
  const problem = cronProblem(spec)
  if (problem) throw new ValidationError(problem)
  const cron = normalizeCron(spec)

  const next: Date[] = []
  let cursor = new Date()
  for (let index = 0; index < count; index += 1) {
    const occurrence = nextOccurrence(cron, timeZone, cursor)
    if (!occurrence) break
    next.push(occurrence)
    cursor = occurrence
  }
  return { cron, description: describeCron(cron, timeZone), next }
}
