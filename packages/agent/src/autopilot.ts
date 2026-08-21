import type { TenantContext } from '@superwork/db'
import { notify, recordDisclosure, writeActivity } from '@superwork/core'
import { startOfDay, startOfWeek } from '@superwork/core'

/**
 * Autopilot caps and the weekly digest (§27.6, §24 Phase 3).
 *
 * Unattended execution is only ever allowed inside numbers a person set. The caps are
 * columns on the agent, checked in SQL against what actually happened — not counters held
 * in a process that a restart would forget.
 *
 * Hitting a cap pauses the agent rather than silently dropping the work. An agent that
 * quietly stops halfway through its own plan is worse than one that stops loudly.
 */

export interface CapVerdict {
  allow: boolean
  reason: string
  actionsToday: number
  dailyCap: number
  weekCostCents: number
  weeklyCapCents: number
}

export async function checkAutopilotCaps(
  ctx: TenantContext,
  input: { agentId: string | null; dailyCap: number; weeklyCapCents: number; plannedActions: number },
): Promise<CapVerdict> {
  if (!input.agentId) {
    return {
      allow: true,
      reason: 'Ad-hoc runs are attended by the person who started them.',
      actionsToday: 0,
      dailyCap: input.dailyCap,
      weekCostCents: 0,
      weeklyCapCents: input.weeklyCapCents,
    }
  }

  const dayStart = startOfDay(new Date(), ctx.timezone)
  const weekStart = startOfWeek(new Date(), ctx.timezone)

  const [row] = await ctx.sql<{ actions: string; cost: string }[]>`
    SELECT
      (SELECT count(*) FROM tool_calls t
         JOIN agent_runs r ON r.id = t.run_id
        WHERE t.organization_id = ${ctx.organizationId} AND r.agent_id = ${input.agentId}
          AND t.ok AND t.risk_tier <> 'read' AND t.deleted_at IS NULL
          AND r.mode = 'autopilot' AND t.created_at >= ${dayStart})::text AS actions,
      (SELECT coalesce(sum(r.cost_cents), 0) FROM agent_runs r
        WHERE r.organization_id = ${ctx.organizationId} AND r.agent_id = ${input.agentId}
          AND r.deleted_at IS NULL AND r.created_at >= ${weekStart})::text AS cost`

  const actionsToday = Number(row?.actions ?? 0)
  const weekCostCents = Number(row?.cost ?? 0)

  if (actionsToday + input.plannedActions > input.dailyCap) {
    return {
      allow: false,
      reason:
        `This would be action ${actionsToday + input.plannedActions} today against a cap of ${input.dailyCap}. ` +
        `The run is held for a person instead.`,
      actionsToday,
      dailyCap: input.dailyCap,
      weekCostCents,
      weeklyCapCents: input.weeklyCapCents,
    }
  }

  if (weekCostCents >= input.weeklyCapCents) {
    return {
      allow: false,
      reason:
        `This agent has spent ${(weekCostCents / 100).toFixed(2)} against a weekly cap of ` +
        `${(input.weeklyCapCents / 100).toFixed(2)}. It stops until the cap is raised or the week turns.`,
      actionsToday,
      dailyCap: input.dailyCap,
      weekCostCents,
      weeklyCapCents: input.weeklyCapCents,
    }
  }

  return {
    allow: true,
    reason: `${input.dailyCap - actionsToday - input.plannedActions} unattended actions left today.`,
    actionsToday,
    dailyCap: input.dailyCap,
    weekCostCents,
    weeklyCapCents: input.weeklyCapCents,
  }
}

/** Stops the agent and tells its owner why, rather than failing quietly. */
export async function pauseForCap(
  ctx: TenantContext,
  input: { agentId: string; agentName: string; reason: string; until: Date },
): Promise<void> {
  await ctx.sql`
    UPDATE agents
    SET autopilot_paused_until = ${input.until}, paused_reason = ${input.reason}, status = 'paused'::sw_agent_status
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.agentId}`

  await writeActivity(ctx, {
    actorType: 'system',
    actorUserId: null,
    actorLabel: 'Superwork',
    verb: 'paused',
    entityType: 'agent',
    entityId: input.agentId,
    entityLabel: input.agentName,
    summary: `${input.agentName} hit a cap and stopped. ${input.reason}`,
  })
}

// ---------------------------------------------------------------------------
// Weekly digest
// ---------------------------------------------------------------------------

export interface DigestFacts {
  agentName: string
  runs: number
  actions: number
  byTool: { tool: string; times: number }[]
  approvalsRequested: number
  approvalsApproved: number
  approvalsRejected: number
  runsUndone: number
  failures: number
  costCents: number
  dailyCap: number
  weeklyCapCents: number
  capHits: number
  peopleAffected: { userId: string; name: string; items: number }[]
}

export async function digestFacts(
  ctx: TenantContext,
  agentId: string,
  from: Date,
  to: Date,
): Promise<DigestFacts> {
  const [agent] = await ctx.sql<
    { name: string; daily_cap: number; weekly_cap: number; paused_reason: string | null }[]
  >`
    SELECT name, autopilot_daily_action_cap AS daily_cap,
           autopilot_weekly_cost_cap_cents AS weekly_cap, paused_reason
    FROM agents WHERE organization_id = ${ctx.organizationId} AND id = ${agentId}`

  const [totals] = await ctx.sql<
    { runs: string; undone: string; cost: string; failures: string }[]
  >`
    SELECT count(*)::text AS runs,
           count(*) FILTER (WHERE undone_at IS NOT NULL)::text AS undone,
           coalesce(sum(cost_cents), 0)::text AS cost,
           count(*) FILTER (WHERE status = 'failed')::text AS failures
    FROM agent_runs
    WHERE organization_id = ${ctx.organizationId} AND agent_id = ${agentId} AND deleted_at IS NULL
      AND created_at >= ${from} AND created_at < ${to}`

  const byTool = await ctx.sql<{ tool: string; times: string }[]>`
    SELECT regexp_replace(t.tool_name, '@v\\d+$', '') AS tool, count(*)::text AS times
    FROM tool_calls t
    JOIN agent_runs r ON r.id = t.run_id
    WHERE t.organization_id = ${ctx.organizationId} AND r.agent_id = ${agentId}
      AND t.ok AND t.risk_tier <> 'read' AND t.deleted_at IS NULL
      AND t.created_at >= ${from} AND t.created_at < ${to}
    GROUP BY regexp_replace(t.tool_name, '@v\\d+$', '')
    ORDER BY count(*) DESC`

  const approvals = await ctx.sql<{ status: string; count: string }[]>`
    SELECT a.status::text AS status, count(*)::text AS count
    FROM approvals a
    JOIN agent_runs r ON r.id = a.agent_run_id
    WHERE a.organization_id = ${ctx.organizationId} AND r.agent_id = ${agentId}
      AND a.deleted_at IS NULL AND a.created_at >= ${from} AND a.created_at < ${to}
    GROUP BY a.status`

  // Whose work it touched. This is the part that becomes a disclosure: the owner of the
  // agent is about to read that somebody else has four new tasks.
  const people = await ctx.sql<{ userId: string; name: string; items: string }[]>`
    SELECT t.assignee_id AS "userId", u.name, count(*)::text AS items
    FROM tasks t
    JOIN users u ON u.id = t.assignee_id
    WHERE t.organization_id = ${ctx.organizationId} AND t.deleted_at IS NULL
      AND t.assignee_id IS NOT NULL
      AND t.created_at >= ${from} AND t.created_at < ${to}
      AND t.created_by_agent_run_id IN (
        SELECT id FROM agent_runs
        WHERE organization_id = ${ctx.organizationId} AND agent_id = ${agentId} AND deleted_at IS NULL
      )
    GROUP BY t.assignee_id, u.name
    ORDER BY count(*) DESC`

  const actions = byTool.reduce((sum, row) => sum + Number(row.times), 0)
  const approvalCount = (status: string) => Number(approvals.find((a) => a.status === status)?.count ?? 0)

  return {
    agentName: agent?.name ?? 'This agent',
    runs: Number(totals?.runs ?? 0),
    actions,
    byTool: byTool.map((row) => ({ tool: row.tool, times: Number(row.times) })),
    approvalsRequested: approvals.reduce((sum, row) => sum + Number(row.count), 0),
    approvalsApproved: approvalCount('approved'),
    approvalsRejected: approvalCount('rejected'),
    runsUndone: Number(totals?.undone ?? 0),
    failures: Number(totals?.failures ?? 0),
    costCents: Number(totals?.cost ?? 0),
    dailyCap: agent?.daily_cap ?? 0,
    weeklyCapCents: agent?.weekly_cap ?? 0,
    capHits: agent?.paused_reason?.includes('cap') ? 1 : 0,
    peopleAffected: people.map((row) => ({ userId: row.userId, name: row.name, items: Number(row.items) })),
  }
}

/**
 * The narrative. Every number in it comes from `facts`; the sentences are the only thing
 * composed here, exactly as with the daily briefing (§9.4).
 */
export function digestNarrative(facts: DigestFacts, from: Date, to: Date, timeZone: string): string {
  const range = `${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}`
  if (facts.runs === 0) {
    return `${facts.agentName} did nothing between ${range}. No runs, no actions, no cost.`
  }

  const parts: string[] = []
  parts.push(
    `${facts.agentName} ran ${facts.runs} ${facts.runs === 1 ? 'time' : 'times'} between ${range}, ` +
      `taking ${facts.actions} ${facts.actions === 1 ? 'action' : 'actions'}.`,
  )
  if (facts.byTool.length > 0) {
    parts.push(`That was ${facts.byTool.map((row) => `${row.times} × ${row.tool}`).join(', ')}.`)
  }
  if (facts.approvalsRequested > 0) {
    parts.push(
      `${facts.approvalsRequested} ${facts.approvalsRequested === 1 ? 'plan was' : 'plans were'} put to a person: ` +
        `${facts.approvalsApproved} approved, ${facts.approvalsRejected} rejected.`,
    )
  }
  if (facts.runsUndone > 0) {
    parts.push(`${facts.runsUndone} ${facts.runsUndone === 1 ? 'run was' : 'runs were'} undone afterwards — worth reading.`)
  }
  if (facts.failures > 0) {
    parts.push(`${facts.failures} ${facts.failures === 1 ? 'run' : 'runs'} failed.`)
  }
  if (facts.peopleAffected.length > 0) {
    parts.push(
      `Work landed with ${facts.peopleAffected.map((person) => `${person.name} (${person.items})`).join(', ')}. ` +
        `Each of them can see that this was reported to you.`,
    )
  }
  parts.push(
    `It cost ${(facts.costCents / 100).toFixed(2)}, against a weekly cap of ${(facts.weeklyCapCents / 100).toFixed(2)} ` +
      `and ${facts.dailyCap} unattended actions a day.`,
  )
  parts.push(`All figures computed from the database in ${timeZone}.`)
  return parts.join(' ')
}

export interface DigestView {
  id: string
  agentId: string
  agentName: string
  recipientUserId: string
  periodFrom: Date
  periodTo: Date
  facts: DigestFacts
  narrative: string
  costCents: number
  readAt: Date | null
  createdAt: Date
}

export async function saveDigest(
  ctx: TenantContext,
  input: {
    agentId: string
    recipientUserId: string
    from: Date
    to: Date
    facts: DigestFacts
    narrative: string
  },
): Promise<string | null> {
  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO agent_digests (
      organization_id, agent_id, recipient_user_id, period_from, period_to,
      facts, narrative, cost_cents, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.agentId}, ${input.recipientUserId}, ${input.from}, ${input.to},
      ${ctx.sql.json(input.facts as never)}, ${input.narrative}, ${input.facts.costCents}, ${ctx.userId}
    )
    ON CONFLICT DO NOTHING
    RETURNING id`
  if (!row) return null

  // Everyone named in the digest gets a disclosure, written now, visible to them
  // immediately — the digest is not delivered before the people in it can see it (§29.3).
  for (const person of input.facts.peopleAffected) {
    await recordDisclosure(ctx, {
      subjectUserId: person.userId,
      recipientUserId: input.recipientUserId,
      recipientLabel: `${input.facts.agentName}'s weekly digest`,
      kind: 'weekly_digest',
      summary: `${person.items} ${person.items === 1 ? 'item' : 'items'} assigned to you by ${input.facts.agentName} appeared in its weekly digest.`,
      fields: ['tasks assigned'],
      sourceType: 'agent_digest',
      sourceId: row.id,
    })
  }

  // And tell them. The digest's own header says an agent that acts unattended "has to report,
  // in one place, everything it did" — and until now it reported by writing a row on a settings
  // page three clicks deep. An agent reporting into a void is not reporting (ADR 0070).
  //
  // Routed as a digest rather than an interruption, which is what it is: a weekly summary
  // belongs in the briefing that gathers such things, not in a notification that stops
  // somebody. Muteable, too — an owner who reads these on the agent page is entitled to say so,
  // and the *receipt* is what governance reads, not the notification.
  await notify(ctx, {
    userId: input.recipientUserId,
    type: 'agent_digest',
    title: `${input.facts.agentName} reported on its week`,
    body: input.narrative.slice(0, 240),
    entityType: 'agent',
    entityId: input.agentId,
    url: `/settings/agents/${input.agentId}`,
  })

  return row.id
}

/**
 * The accountable human says they have read it (ADR 0070).
 *
 * Only the recipient. Somebody else marking it read would forge the one fact the governance
 * screen reads to decide whether an agent is overseen at all — and `sw_digest_read_by_recipient`
 * makes the weaker half of that true of every writer.
 *
 * Idempotent by design: the first read is the one recorded, so a second visit does not move the
 * date and "how long that report sat unread" stays answerable.
 */
export async function markDigestRead(
  ctx: TenantContext,
  actor: { userId: string },
  digestId: string,
): Promise<DigestView | null> {
  await ctx.sql`
    UPDATE agent_digests SET read_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${digestId}
      AND recipient_user_id = ${actor.userId} AND read_at IS NULL AND deleted_at IS NULL`
  const [row] = await ctx.sql<DigestView[]>`
    SELECT d.id, d.agent_id AS "agentId", a.name AS "agentName",
           d.recipient_user_id AS "recipientUserId", d.period_from AS "periodFrom",
           d.period_to AS "periodTo", d.facts, d.narrative, d.cost_cents::float8 AS "costCents",
           d.read_at AS "readAt", d.created_at AS "createdAt"
    FROM agent_digests d
    JOIN agents a ON a.id = d.agent_id
    WHERE d.organization_id = ${ctx.organizationId} AND d.id = ${digestId} AND d.deleted_at IS NULL`
  return row ?? null
}

/**
 * How many reports this agent's owner has not read, newest first.
 *
 * Per agent and never per person. "Which agents are overseen" is a fact about the agents; the
 * same rows grouped by who failed to read them would be an individual performance measure, and
 * §29.5 forbids those by construction rather than by policy.
 */
export async function unreadDigests(ctx: TenantContext, agentId: string): Promise<number> {
  const [row] = await ctx.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM agent_digests
    WHERE organization_id = ${ctx.organizationId} AND agent_id = ${agentId}
      AND deleted_at IS NULL AND read_at IS NULL`
  return row?.count ?? 0
}

export async function listDigests(ctx: TenantContext, agentId: string, limit = 8): Promise<DigestView[]> {
  return ctx.sql<DigestView[]>`
    SELECT d.id, d.agent_id AS "agentId", a.name AS "agentName",
           d.recipient_user_id AS "recipientUserId", d.period_from AS "periodFrom",
           d.period_to AS "periodTo", d.facts, d.narrative, d.cost_cents::float8 AS "costCents",
           d.read_at AS "readAt", d.created_at AS "createdAt"
    FROM agent_digests d
    JOIN agents a ON a.id = d.agent_id
    WHERE d.organization_id = ${ctx.organizationId} AND d.agent_id = ${agentId} AND d.deleted_at IS NULL
    ORDER BY d.period_from DESC
    LIMIT ${Math.min(limit, 52)}`
}
