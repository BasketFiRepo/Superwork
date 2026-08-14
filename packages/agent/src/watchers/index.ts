import { randomUUID } from 'node:crypto'
import { withTenant, type TenantContext, asJson } from '@superwork/db'
import { loadActor, type Actor } from '@superwork/auth'
import {
  claimDueSchedules,
  describeCron,
  listSchedules,
  runAggregate,
  scheduleForKey,
  setScheduleEnabled,
  upsertSchedule,
  type ScheduleView,
} from '@superwork/core'
import type { RunSession } from '../runtime.js'

/**
 * The Watcher framework (§9.1).
 *
 * Watchers are read-only. Each declares its cadence, its detection logic
 * (deterministic first), a dedupe key and — mandatorily — a recommended action with the
 * tool call pre-filled. An insight with no evidence must not render; an insight with no
 * next step is noise and the database rejects it.
 *
 * The cadence is the schedule. A watcher that says it looks at 08:00 on weekdays is run at
 * 08:00 on weekdays — the declaration and the behaviour are the same fact, evaluated in the
 * organization's timezone, and an admin can re-time one without a deploy.
 */

export interface InsightDraft {
  watcher: string
  type: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  title: string
  body: string
  dedupeKey: string
  evidence: { claim: string; sourceType: string; sourceId?: string | null }[]
  entities: { type: string; id: string; label: string }[]
  recommendedActions: { label: string; tool: string; args: Record<string, unknown> }[]
  assignedTo?: string | null
}

export interface Watcher {
  key: string
  title: string
  cadence: string
  detect(ctx: TenantContext, actor: Actor): Promise<InsightDraft[]>
}

/** Per-user daily insight cap, ranked by severity × actionability (§9.3). */
export const DAILY_INSIGHT_CAP = 7

const SEVERITY_RANK: Record<InsightDraft['severity'], number> = { critical: 3, high: 2, medium: 1, low: 0 }

export const staleThreadWatcher: Watcher = {
  key: 'stale_thread',
  title: 'Stale customer threads',
  cadence: '0 8 * * 1-5',
  async detect(ctx, actor) {
    const result = await runAggregate(ctx, actor, 'stale_customer_threads', { limit: 50 })
    const actionable = result.rows.filter((r) => r['ambiguous'] !== true)
    if (actionable.length === 0) return []

    // Grouped, not one insight per customer: "4 customers have gone quiet" is one item (§9.3).
    return [
      {
        watcher: 'stale_thread',
        type: 'customer_awaiting_reply',
        severity: actionable.length >= 5 ? 'high' : 'medium',
        title: `${actionable.length} ${actionable.length === 1 ? 'customer is' : 'customers are'} waiting on a reply`,
        body: actionable
          .map((r) => `${r['company_name']} — ${r['days_waiting']} days on "${r['subject']}"`)
          .join('\n'),
        dedupeKey: `stale_thread:${actionable.map((r) => r['conversation_id']).sort().join(',')}`,
        evidence: actionable.map((r) => ({
          claim: `${r['company_name']} last wrote ${r['days_waiting']} days ago and the account SLA is ${r['reply_sla_days']} days.`,
          sourceType: 'conversation',
          sourceId: String(r['conversation_id']),
        })),
        entities: actionable.map((r) => ({
          type: 'company',
          id: String(r['company_id']),
          label: String(r['company_name']),
        })),
        recommendedActions: [
          {
            label: `Draft follow-ups for all ${actionable.length}`,
            tool: 'agent.run',
            args: { request: 'Create follow-up tasks and draft replies for all overdue customers.', mode: 'execute' },
          },
        ],
      },
    ]
  },
}

export const overdueWatcher: Watcher = {
  key: 'overdue_slipping',
  title: 'Overdue and slipping work',
  cadence: '0 8 * * 1-5',
  async detect(ctx, actor) {
    const result = await runAggregate(ctx, actor, 'tasks_overdue', { limit: 50 })
    if (result.rows.length === 0) return []
    const worst = result.rows.slice(0, 5)
    return [
      {
        watcher: 'overdue_slipping',
        type: 'tasks_overdue',
        severity: result.rows.length >= 10 ? 'high' : 'medium',
        title: `${result.rows.length} tasks are past their due date`,
        body: worst.map((r) => `${r['title']} — ${r['days_overdue']} days late (${r['assignee_name'] ?? 'unassigned'})`).join('\n'),
        dedupeKey: `overdue:${new Date().toISOString().slice(0, 10)}`,
        evidence: [{ claim: result.basis, sourceType: 'query_aggregate', sourceId: 'tasks_overdue' }],
        entities: worst.map((r) => ({ type: 'task', id: String(r['id']), label: String(r['title']) })),
        recommendedActions: [
          {
            label: 'Propose new dates',
            tool: 'agent.run',
            args: { request: 'Clean up my overdue list and propose realistic new dates.', mode: 'execute' },
          },
        ],
      },
    ]
  },
}

export const approvalAgingWatcher: Watcher = {
  key: 'approval_aging',
  title: 'Approvals past their SLA',
  cadence: '0 */4 * * *',
  async detect(ctx, actor) {
    const result = await runAggregate(ctx, actor, 'approvals_pending', { limit: 25 })
    const breached = result.rows.filter((r) => Number(r['hours_waiting']) > Number(r['sla_hours'] ?? 4))
    if (breached.length === 0) return []
    return [
      {
        watcher: 'approval_aging',
        type: 'approval_sla_breach',
        severity: 'high',
        title: `${breached.length} ${breached.length === 1 ? 'approval is' : 'approvals are'} past their SLA`,
        body: breached.map((r) => `${r['title']} — waiting ${Math.round(Number(r['hours_waiting']))}h`).join('\n'),
        dedupeKey: `approval_aging:${breached.map((r) => r['id']).sort().join(',')}`,
        evidence: breached.map((r) => ({
          claim: `"${r['title']}" has been pending for ${Math.round(Number(r['hours_waiting']))} hours against a ${r['sla_hours']}h SLA.`,
          sourceType: 'approval',
          sourceId: String(r['id']),
        })),
        entities: breached.map((r) => ({ type: 'approval', id: String(r['id']), label: String(r['title']) })),
        recommendedActions: [{ label: 'Review approvals', tool: 'navigate', args: { route: '/approvals' } }],
      },
    ]
  },
}

export const knowledgeGapWatcher: Watcher = {
  key: 'knowledge_gap',
  title: 'Questions company memory cannot answer',
  cadence: '0 9 * * 1',
  async detect(ctx) {
    const rows = await ctx.sql<{ query: string; occurrences: number }[]>`
      SELECT query, occurrences FROM unanswered_queries
      WHERE organization_id = ${ctx.organizationId} AND occurrences >= 2
      ORDER BY occurrences DESC LIMIT 5`
    if (rows.length === 0) return []
    return [
      {
        watcher: 'knowledge_gap',
        type: 'documentation_missing',
        severity: 'low',
        title: `${rows.length} recurring questions have no answer in company memory`,
        body: rows.map((r) => `"${r.query}" — asked ${r.occurrences} times`).join('\n'),
        dedupeKey: `knowledge_gap:${rows.map((r) => r.query).sort().join('|')}`,
        evidence: rows.map((r) => ({
          claim: `"${r.query}" was asked ${r.occurrences} times and retrieval found nothing above threshold.`,
          sourceType: 'query_aggregate',
          sourceId: 'unanswered_queries',
        })),
        entities: [],
        recommendedActions: [{ label: 'Add the missing document', tool: 'navigate', args: { route: '/knowledge' } }],
      },
    ]
  },
}

/**
 * Commitment tracker (§9.1). Only *confirmed* commitments are chased — a detection the
 * owner never accepted is not a promise. Before surfacing anything it reports the load
 * the owner is carrying, so the item reads as a fact about work rather than about a
 * person (§29.3).
 */
export const commitmentTrackerWatcher: Watcher = {
  key: 'commitment_tracker',
  title: 'Confirmed commitments past their date',
  cadence: '0 9 * * 1-5',
  async detect(ctx) {
    const rows = await ctx.sql<
      {
        id: string
        obligation: string
        owner_name: string | null
        owner_id: string | null
        company_name: string | null
        days_late: number
        open_tasks: number
        blocked_tasks: number
        team_median: number
      }[]
    >`
      WITH load AS (
        SELECT assignee_id,
               count(*) FILTER (WHERE status NOT IN ('completed','cancelled'))::int AS open_tasks,
               count(*) FILTER (WHERE status = 'blocked')::int AS blocked_tasks
        FROM tasks
        WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
        GROUP BY assignee_id
      )
      SELECT cm.id, cm.obligation, u.name AS owner_name, cm.owner_user_id AS owner_id,
             co.name AS company_name,
             EXTRACT(DAY FROM (now() - cm.due_at))::int AS days_late,
             coalesce(l.open_tasks, 0) AS open_tasks,
             coalesce(l.blocked_tasks, 0) AS blocked_tasks,
             (SELECT coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY open_tasks), 0)::int FROM load) AS team_median
      FROM commitments cm
      LEFT JOIN users u ON u.id = cm.owner_user_id
      LEFT JOIN companies co ON co.id = cm.company_id
      LEFT JOIN load l ON l.assignee_id = cm.owner_user_id
      WHERE cm.organization_id = ${ctx.organizationId} AND cm.deleted_at IS NULL
        AND cm.status = 'confirmed'
        AND cm.due_at IS NOT NULL AND cm.due_at < now()
      ORDER BY cm.due_at
      LIMIT 20`

    if (rows.length === 0) return []

    return [
      {
        watcher: 'commitment_tracker',
        type: 'commitment_past_due',
        severity: rows.some((r) => r.days_late > 7) ? 'high' : 'medium',
        title: `${rows.length} confirmed ${rows.length === 1 ? 'commitment is' : 'commitments are'} past their date`,
        body: rows
          .map(
            (r) =>
              `${r.obligation.slice(0, 100)} — ${r.days_late} days late${r.owner_name ? ` (${r.owner_name})` : ''}` +
              (r.open_tasks > r.team_median * 1.5
                ? `. They are carrying ${(r.open_tasks / Math.max(1, r.team_median)).toFixed(1)}× the team median load`
                : '') +
              (r.blocked_tasks > 0 ? `, with ${r.blocked_tasks} blocked items` : ''),
          )
          .join('\n'),
        dedupeKey: `commitment_tracker:${rows.map((r) => r.id).sort().join(',')}`,
        evidence: rows.map((r) => ({
          claim: `"${r.obligation.slice(0, 120)}" was confirmed by ${r.owner_name ?? 'its owner'} and is ${r.days_late} days past its date.`,
          sourceType: 'commitment',
          sourceId: r.id,
        })),
        entities: rows.map((r) => ({ type: 'commitment', id: r.id, label: r.obligation.slice(0, 60) })),
        recommendedActions: [{ label: 'Open the ledger', tool: 'navigate', args: { route: '/commitments' } }],
      },
    ]
  },
}

/** Silent customer (§9.1): an active account with no interaction inside its cadence. */
export const silentCustomerWatcher: Watcher = {
  key: 'silent_customer',
  title: 'Accounts that have gone quiet',
  cadence: '0 9 * * 1',
  async detect(ctx) {
    const rows = await ctx.sql<{ id: string; name: string; days: number; owner: string | null; cadence: number }[]>`
      SELECT c.id, c.name, c.check_in_days AS cadence, u.name AS owner,
             EXTRACT(DAY FROM (now() - c.last_interaction_at))::int AS days
      FROM companies c
      LEFT JOIN users u ON u.id = c.owner_id
      WHERE c.organization_id = ${ctx.organizationId} AND c.deleted_at IS NULL
        AND c.type IN ('customer', 'prospect')
        AND c.last_interaction_at IS NOT NULL
        AND c.last_interaction_at < now() - make_interval(days => c.check_in_days)
      ORDER BY c.last_interaction_at
      LIMIT 10`

    if (rows.length === 0) return []

    return [
      {
        watcher: 'silent_customer',
        type: 'account_gone_quiet',
        severity: 'low',
        title: `${rows.length} ${rows.length === 1 ? 'account has' : 'accounts have'} gone quiet`,
        body: rows.map((r) => `${r.name} — ${r.days} days since any interaction (cadence ${r.cadence} days)`).join('\n'),
        dedupeKey: `silent_customer:${rows.map((r) => r.id).sort().join(',')}`,
        evidence: rows.map((r) => ({
          claim: `${r.name} has had no recorded interaction for ${r.days} days against a ${r.cadence}-day check-in cadence.`,
          sourceType: 'company',
          sourceId: r.id,
        })),
        entities: rows.map((r) => ({ type: 'company', id: r.id, label: r.name })),
        recommendedActions: [{ label: 'Open companies', tool: 'navigate', args: { route: '/companies' } }],
      },
    ]
  },
}

export const WATCHERS: Watcher[] = [
  staleThreadWatcher,
  overdueWatcher,
  approvalAgingWatcher,
  knowledgeGapWatcher,
  commitmentTrackerWatcher,
  silentCustomerWatcher,
]

export interface WatcherRunResult {
  created: number
  deduped: number
  suppressed: number
  muted: string[]
}

export async function runWatchers(session: RunSession, keys?: string[]): Promise<WatcherRunResult> {
  return withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const muted = await mutedWatchers(ctx)
    const selected = WATCHERS.filter((w) => (!keys || keys.includes(w.key)) && !muted.includes(w.key))

    const drafts: InsightDraft[] = []
    for (const watcher of selected) {
      drafts.push(...(await watcher.detect(ctx, actor)))
    }

    drafts.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity])
    const capped = drafts.slice(0, DAILY_INSIGHT_CAP)
    const suppressed = drafts.length - capped.length

    let created = 0
    let deduped = 0
    for (const draft of capped) {
      const rows = await ctx.sql<{ id: string }[]>`
        INSERT INTO insights (
          organization_id, watcher, type, severity, title, body, evidence, entities,
          recommended_actions, dedupe_key, assigned_to, created_by
        ) VALUES (
          ${ctx.organizationId}, ${draft.watcher}, ${draft.type}, ${draft.severity}, ${draft.title},
          ${draft.body}, ${ctx.sql.json(asJson(draft.evidence))}, ${ctx.sql.json(asJson(draft.entities))},
          ${ctx.sql.json(asJson(draft.recommendedActions))}, ${draft.dedupeKey}, ${draft.assignedTo ?? null}, ${ctx.userId}
        )
        ON CONFLICT (organization_id, dedupe_key) WHERE deleted_at IS NULL DO NOTHING
        RETURNING id`
      if (rows.length > 0) created += 1
      else deduped += 1
    }

    return { created, deduped, suppressed, muted }
  })
}

/**
 * Auto-mute any watcher whose dismissal rate exceeds 70% over 20 insights, and say why
 * (§9.2). A watcher nobody acts on is worse than no watcher at all.
 */
export async function mutedWatchers(ctx: TenantContext): Promise<string[]> {
  const rows = await ctx.sql<{ watcher: string; total: number; dismissed: number }[]>`
    SELECT watcher, count(*)::int AS total,
           count(*) FILTER (WHERE status = 'dismissed')::int AS dismissed
    FROM insights
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
    GROUP BY watcher HAVING count(*) >= 20`
  return rows.filter((r) => r.dismissed / r.total > 0.7).map((r) => r.watcher)
}

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

export interface WatcherScheduleView extends ScheduleView {
  key: string
  title: string
  /** The cadence declared in code, for comparison with what is actually stored. */
  declaredCron: string
  description: string
  muted: boolean
}

/**
 * Gives every watcher a schedule row from the cadence it declares, once. An existing row is
 * left alone — the declared cadence is a default, not an override, so an admin who re-times
 * a watcher does not have it silently reset on the next deploy.
 */
export async function ensureWatcherSchedules(ctx: TenantContext): Promise<number> {
  let created = 0
  for (const watcher of WATCHERS) {
    const before = await scheduleForKey(ctx, 'watcher', watcher.key)
    if (before) continue
    await upsertSchedule(ctx, {
      kind: 'watcher',
      targetKey: watcher.key,
      cron: watcher.cadence,
      timezone: ctx.timezone,
      // A watcher is a read: missing one is not an event worth replaying five times, and
      // the next firing sees the same world anyway.
      catchUpPolicy: 'skip_missed',
      onlyIfMissing: true,
    })
    created += 1
  }
  return created
}

/** Every watcher with its schedule, for the screen that shows what is watching. */
export async function watcherSchedules(ctx: TenantContext): Promise<WatcherScheduleView[]> {
  await ensureWatcherSchedules(ctx)
  const rows = await listSchedules(ctx, 'watcher')
  const muted = await mutedWatchers(ctx)
  const byKey = new Map(rows.map((row) => [row.targetKey, row]))

  return WATCHERS.map((watcher) => {
    const schedule = byKey.get(watcher.key)!
    return {
      ...schedule,
      key: watcher.key,
      title: watcher.title,
      declaredCron: watcher.cadence,
      description: describeCron(schedule.cron, schedule.timezone),
      muted: muted.includes(watcher.key),
    }
  })
}

export interface WatcherSweep {
  claimed: number
  ran: string[]
  created: number
  deduped: number
  suppressed: number
  skipped: string[]
}

/**
 * Runs the watchers whose cadence is due (§9.1). Called by the worker.
 *
 * A muted watcher keeps its schedule but is not run, and says so — muting is a statement
 * about noise, not an instruction to forget the watcher exists.
 */
export async function runDueWatchers(session: RunSession, now = new Date()): Promise<WatcherSweep> {
  const traceId = randomUUID()
  const sweep: WatcherSweep = { claimed: 0, ran: [], created: 0, deduped: 0, suppressed: 0, skipped: [] }

  const { claimed, muted } = await withTenant({ ...session, traceId }, async (ctx) => {
    await ensureWatcherSchedules(ctx)
    return { claimed: await claimDueSchedules(ctx, 'watcher', 20, now), muted: await mutedWatchers(ctx) }
  })
  sweep.claimed = claimed.length

  const keys: string[] = []
  for (const schedule of claimed) {
    if (!schedule.targetKey) continue
    if (schedule.skipped > 0 && schedule.skippedReason) {
      sweep.skipped.push(`${schedule.targetKey}: ${schedule.skippedReason}`)
    }
    if (schedule.runs === 0) continue
    if (muted.includes(schedule.targetKey)) {
      sweep.skipped.push(`${schedule.targetKey}: muted — more than 70% of its insights were dismissed.`)
      continue
    }
    keys.push(schedule.targetKey)
  }

  if (keys.length === 0) return sweep

  // One pass over the due watchers, so the daily insight cap is applied across them
  // together rather than once per watcher.
  const result = await runWatchers(session, keys)
  sweep.ran = keys
  sweep.created = result.created
  sweep.deduped = result.deduped
  sweep.suppressed = result.suppressed
  return sweep
}

/** Re-times a watcher, or stops it. Admin-only; the caller checks that. */
export async function setWatcherSchedule(
  ctx: TenantContext,
  input: { key: string; cron?: string; enabled?: boolean },
): Promise<ScheduleView | null> {
  const watcher = WATCHERS.find((entry) => entry.key === input.key)
  if (!watcher) throw new Error(`No watcher named "${input.key}".`)
  await ensureWatcherSchedules(ctx)

  if (input.enabled !== undefined && input.cron === undefined) {
    await setScheduleEnabled(ctx, 'watcher', input.key, input.enabled)
    return scheduleForKey(ctx, 'watcher', input.key)
  }
  const current = await scheduleForKey(ctx, 'watcher', input.key)
  return upsertSchedule(ctx, {
    kind: 'watcher',
    targetKey: input.key,
    cron: input.cron ?? watcher.cadence,
    timezone: current?.timezone ?? ctx.timezone,
    enabled: input.enabled ?? current?.enabled ?? true,
    catchUpPolicy: current?.catchUpPolicy ?? 'skip_missed',
  })
}
