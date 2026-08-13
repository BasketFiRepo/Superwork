import type { TenantContext } from '@superwork/db'
import type { Actor } from '@superwork/auth'
import { addDays, asOfLabel, endOfDay, formatInZone, startOfDay } from '../time.js'

/**
 * The daily briefing's factual scaffold (§9.4).
 *
 * Every number here is computed in SQL, in the recipient's timezone. The model is given
 * this structure and asked for connective prose only — it is explicitly forbidden from
 * inventing figures, and the stored `facts` blob makes each briefing reproducible and
 * auditable after the fact.
 */

export type BriefingKind = 'daily' | 'end_of_day'

export interface BriefingFacts {
  kind: BriefingKind
  userId: string
  userName: string
  timezone: string
  localDate: string
  generatedAt: string
  basis: string

  meetings: { id: string; title: string; startsAt: string; localTime: string; minutes: number; participants: number }[]
  dueToday: { id: string; title: string; priority: string; projectName: string | null }[]
  overdue: { id: string; title: string; daysOverdue: number; priority: string }[]
  approvals: { id: string; title: string; riskTier: string; hoursWaiting: number }[]
  commitments: { id: string; obligation: string; dueAt: string | null; companyName: string | null; status: string }[]
  /** Items where *this person* is what everyone else is waiting on. */
  blockingOthers: { id: string; title: string; waitingCount: number; blockedReason: string | null }[]
  insights: { id: string; title: string; severity: string; watcher: string }[]
  staleThreads: { id: string; companyName: string; daysWaiting: number; subject: string }[]

  // End-of-day only.
  completedToday: { id: string; title: string }[]
  slippedToday: { id: string; title: string; daysOverdue: number }[]
  agentActions: { runId: string; summary: string; costCents: number }[]

  counts: {
    meetings: number
    dueToday: number
    overdue: number
    approvals: number
    commitmentsDue: number
    blockingOthers: number
    insights: number
    staleThreads: number
    completedToday: number
    slippedToday: number
    agentActions: number
  }
}

export interface Recommendation {
  headline: string
  why: string
  action: { label: string; kind: 'navigate' | 'agent'; args: Record<string, unknown> } | null
}

export async function composeBriefingFacts(
  ctx: TenantContext,
  actor: Actor,
  kind: BriefingKind,
  now = new Date(),
): Promise<BriefingFacts> {
  const sql = ctx.sql
  const tz = ctx.timezone
  const dayStart = startOfDay(now, tz)
  const dayEnd = endOfDay(now, tz)
  const [userRow] = await sql<{ name: string }[]>`SELECT name FROM users WHERE id = ${actor.userId}`

  const meetings = await sql<{ id: string; title: string; startsAt: Date; minutes: number; participants: number }[]>`
    SELECT m.id, m.title, m.starts_at AS "startsAt",
           (EXTRACT(EPOCH FROM (m.ends_at - m.starts_at)) / 60)::int AS minutes,
           (SELECT count(*)::int FROM meeting_participants mp
             WHERE mp.meeting_id = m.id AND mp.deleted_at IS NULL) AS participants
    FROM meetings m
    WHERE m.organization_id = ${ctx.organizationId} AND m.deleted_at IS NULL
      AND m.status <> 'cancelled'
      AND m.starts_at BETWEEN ${dayStart} AND ${dayEnd}
      AND (m.organizer_id = ${actor.userId}
           OR EXISTS (SELECT 1 FROM meeting_participants mp
                       WHERE mp.meeting_id = m.id AND mp.user_id = ${actor.userId} AND mp.deleted_at IS NULL))
    ORDER BY m.starts_at`

  const dueToday = await sql<{ id: string; title: string; priority: string; projectName: string | null }[]>`
    SELECT t.id, t.title, t.priority::text, p.name AS "projectName"
    FROM tasks t LEFT JOIN projects p ON p.id = t.project_id
    WHERE t.organization_id = ${ctx.organizationId} AND t.deleted_at IS NULL
      AND t.assignee_id = ${actor.userId}
      AND t.status NOT IN ('completed', 'cancelled')
      AND t.due_at BETWEEN ${dayStart} AND ${dayEnd}
    ORDER BY t.priority, t.due_at`

  const overdue = await sql<{ id: string; title: string; daysOverdue: number; priority: string }[]>`
    SELECT t.id, t.title, EXTRACT(DAY FROM (${dayStart}::timestamptz - t.due_at))::int AS "daysOverdue",
           t.priority::text
    FROM tasks t
    WHERE t.organization_id = ${ctx.organizationId} AND t.deleted_at IS NULL
      AND t.assignee_id = ${actor.userId}
      AND t.status NOT IN ('completed', 'cancelled')
      AND t.due_at < ${dayStart}
    ORDER BY t.due_at LIMIT 20`

  const approvals = await sql<{ id: string; title: string; riskTier: string; hoursWaiting: number }[]>`
    SELECT a.id, a.title, a.risk_tier::text AS "riskTier",
           (EXTRACT(EPOCH FROM (now() - a.created_at)) / 3600)::numeric(10,1)::float8 AS "hoursWaiting"
    FROM approvals a
    WHERE a.organization_id = ${ctx.organizationId} AND a.deleted_at IS NULL AND a.status = 'pending'
      AND (a.approver_user_id = ${actor.userId} OR a.approver_user_id IS NULL)
    ORDER BY a.created_at LIMIT 10`

  // Only confirmed commitments count — a detected promise the owner never accepted is
  // not something to brief them about as fact (§29.1).
  const commitments = await sql<
    { id: string; obligation: string; dueAt: Date | null; companyName: string | null; status: string }[]
  >`
    SELECT cm.id, cm.obligation, cm.due_at AS "dueAt", co.name AS "companyName", cm.status::text
    FROM commitments cm LEFT JOIN companies co ON co.id = cm.company_id
    WHERE cm.organization_id = ${ctx.organizationId} AND cm.deleted_at IS NULL
      AND cm.owner_user_id = ${actor.userId}
      AND cm.status = 'confirmed'
      AND cm.due_at IS NOT NULL AND cm.due_at <= ${dayEnd}
    ORDER BY cm.due_at LIMIT 10`

  const blockingOthers = await sql<{ id: string; title: string; waitingCount: number; blockedReason: string | null }[]>`
    SELECT t.id, t.title,
           (SELECT count(*)::int FROM task_dependencies td
             WHERE td.depends_on_task_id = t.id AND td.deleted_at IS NULL) AS "waitingCount",
           t.blocked_reason AS "blockedReason"
    FROM tasks t
    WHERE t.organization_id = ${ctx.organizationId} AND t.deleted_at IS NULL
      AND t.assignee_id = ${actor.userId}
      AND t.status NOT IN ('completed', 'cancelled')
      AND EXISTS (SELECT 1 FROM task_dependencies td
                   WHERE td.depends_on_task_id = t.id AND td.deleted_at IS NULL)
    ORDER BY 3 DESC LIMIT 10`

  const insights = await sql<{ id: string; title: string; severity: string; watcher: string }[]>`
    SELECT id, title, severity, watcher FROM insights
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
      AND status IN ('new', 'acknowledged')
      AND (assigned_to IS NULL OR assigned_to = ${actor.userId})
    ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
             created_at DESC
    LIMIT 3`

  const staleThreads = await sql<{ id: string; companyName: string; daysWaiting: number; subject: string }[]>`
    SELECT conv.id, c.name AS "companyName", conv.subject,
           EXTRACT(DAY FROM (now() - conv.last_message_at))::int AS "daysWaiting"
    FROM conversations conv JOIN companies c ON c.id = conv.company_id
    WHERE conv.organization_id = ${ctx.organizationId} AND conv.deleted_at IS NULL
      AND conv.archived_at IS NULL AND conv.last_direction = 'inbound'
      AND c.type IN ('customer', 'prospect')
      AND conv.last_message_at < now() - make_interval(days => coalesce(c.reply_sla_days, 4))
      AND (c.owner_id = ${actor.userId} OR conv.owner_id = ${actor.userId} OR ${actor.role} IN ('owner', 'admin'))
    ORDER BY conv.last_message_at LIMIT 10`

  const completedToday =
    kind === 'end_of_day'
      ? await sql<{ id: string; title: string }[]>`
          SELECT id, title FROM tasks
          WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
            AND assignee_id = ${actor.userId} AND status = 'completed'
            AND completed_at BETWEEN ${dayStart} AND ${dayEnd}
          ORDER BY completed_at LIMIT 25`
      : []

  const slippedToday =
    kind === 'end_of_day'
      ? await sql<{ id: string; title: string; daysOverdue: number }[]>`
          SELECT id, title, EXTRACT(DAY FROM (${dayStart}::timestamptz - due_at))::int AS "daysOverdue"
          FROM tasks
          WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
            AND assignee_id = ${actor.userId} AND status NOT IN ('completed', 'cancelled')
            AND due_at BETWEEN ${addDays(dayStart, -1, tz)} AND ${dayEnd}
          ORDER BY due_at LIMIT 25`
      : []

  // "What I did today": every agent action taken on this person's behalf (§9.4).
  const agentActions =
    kind === 'end_of_day'
      ? await sql<{ runId: string; summary: string; costCents: number }[]>`
          SELECT id AS "runId", coalesce(summary, request) AS summary, cost_cents::float8 AS "costCents"
          FROM agent_runs
          WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
            AND principal_user_id = ${actor.userId}
            AND created_at BETWEEN ${dayStart} AND ${dayEnd}
            AND status IN ('succeeded', 'undone', 'budget_exceeded')
          ORDER BY created_at LIMIT 25`
      : []

  return {
    kind,
    userId: actor.userId,
    userName: userRow?.name ?? actor.displayName,
    timezone: tz,
    localDate: formatInZone(now, tz, { year: 'numeric', month: '2-digit', day: '2-digit' })
      .split('/')
      .reverse()
      .join('-'),
    generatedAt: now.toISOString(),
    basis: `All figures computed from the database ${asOfLabel(tz, now)}.`,
    meetings: meetings.map((m) => ({
      id: m.id,
      title: m.title,
      startsAt: m.startsAt.toISOString(),
      localTime: formatInZone(m.startsAt, tz, { hour: '2-digit', minute: '2-digit' }),
      minutes: m.minutes,
      participants: m.participants,
    })),
    dueToday,
    overdue,
    approvals,
    commitments: commitments.map((c) => ({ ...c, dueAt: c.dueAt ? c.dueAt.toISOString() : null })),
    blockingOthers,
    insights,
    staleThreads,
    completedToday,
    slippedToday,
    agentActions,
    counts: {
      meetings: meetings.length,
      dueToday: dueToday.length,
      overdue: overdue.length,
      approvals: approvals.length,
      commitmentsDue: commitments.length,
      blockingOthers: blockingOthers.length,
      insights: insights.length,
      staleThreads: staleThreads.length,
      completedToday: completedToday.length,
      slippedToday: slippedToday.length,
      agentActions: agentActions.length,
    },
  }
}

/**
 * The single prioritized recommendation (§9.4). Chosen by a deterministic rule so the
 * same day always produces the same advice — the model does not get to pick.
 */
export function pickRecommendation(facts: BriefingFacts): Recommendation {
  if (facts.blockingOthers.length > 0) {
    const item = facts.blockingOthers[0]!
    return {
      headline: `Unblock "${item.title}"`,
      why: `${item.waitingCount} ${item.waitingCount === 1 ? 'task is' : 'tasks are'} waiting on it. Clearing it moves other people's work, not just yours.`,
      action: { label: 'Open the task', kind: 'navigate', args: { route: `/tasks?filter=mine` } },
    }
  }

  if (facts.approvals.length > 0) {
    const oldest = facts.approvals[0]!
    return {
      headline: `Decide on "${oldest.title}"`,
      why: `It has been waiting ${oldest.hoursWaiting.toFixed(0)} hours, and nothing downstream can move until you do.`,
      action: { label: 'Review approvals', kind: 'navigate', args: { route: '/approvals' } },
    }
  }

  if (facts.staleThreads.length > 0) {
    const worst = facts.staleThreads[0]!
    return {
      headline: `Reply to ${worst.companyName}`,
      why: `They have been waiting ${worst.daysWaiting} days on "${worst.subject}", past their agreed SLA.`,
      action: {
        label: 'Draft follow-ups',
        kind: 'agent',
        args: { request: 'Create follow-up tasks for all overdue customers.', mode: 'execute' },
      },
    }
  }

  if (facts.overdue.length > 0) {
    const worst = facts.overdue[0]!
    return {
      headline: `Give "${worst.title}" a realistic date`,
      why: `It is ${worst.daysOverdue} days past due. Renegotiating in advance is a better outcome than leaving it silently late.`,
      action: {
        label: 'Propose new dates',
        kind: 'agent',
        args: { request: 'Clean up my overdue list and propose realistic new dates.', mode: 'execute' },
      },
    }
  }

  if (facts.dueToday.length > 0) {
    return {
      headline: `Start with "${facts.dueToday[0]!.title}"`,
      why: `${facts.counts.dueToday} ${facts.counts.dueToday === 1 ? 'item is' : 'items are'} due today and nothing is overdue.`,
      action: { label: 'Open my work', kind: 'navigate', args: { route: '/tasks?filter=mine' } },
    }
  }

  return {
    headline: 'Nothing needs you right now',
    why: 'No overdue work, no approvals waiting, no customer past their SLA.',
    action: null,
  }
}
