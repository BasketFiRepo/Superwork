import type { TenantContext } from '@superwork/db'
import { can, readCeiling, type Actor } from '@superwork/auth'
import { PermissionError, ValidationError } from '../errors.js'
import { asOfLabel, startOfDay, endOfDay } from '../time.js'

/**
 * The safe query layer (§7.3, §12.8).
 *
 * "How many tasks are overdue" is a SQL question, not a vector question. Every number
 * Superwork reports comes from here — the model never counts, estimates, or invents a
 * figure, and no model output ever reaches the database as SQL. Callers pick a named
 * query; arguments are typed and bound.
 */

export const AGGREGATE_QUERIES = [
  'tasks_overdue',
  'tasks_due_today',
  'tasks_by_status',
  'stale_customer_threads',
  'workload_by_assignee',
  'approvals_pending',
  'agent_cost_month_to_date',
  'knowledge_health',
] as const

export type AggregateQuery = (typeof AGGREGATE_QUERIES)[number]

export interface AggregateResult {
  query: AggregateQuery
  /** Every figure carries its basis (§16.9). */
  basis: string
  computedAt: Date
  rows: Record<string, unknown>[]
  total: number
}

export interface AggregateArgs {
  assigneeId?: string | 'me'
  companyId?: string
  projectId?: string
  slaDaysOverride?: number
  limit?: number
}

export async function runAggregate(
  ctx: TenantContext,
  actor: Actor,
  query: AggregateQuery,
  args: AggregateArgs = {},
): Promise<AggregateResult> {
  if (!AGGREGATE_QUERIES.includes(query)) {
    throw new ValidationError(`Unknown aggregate "${query}".`, { allowed: AGGREGATE_QUERIES })
  }
  const decision = can(actor, 'task:read', { type: 'task', organizationId: ctx.organizationId })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const now = new Date()
  const limit = Math.min(args.limit ?? 50, 200)
  const sql = ctx.sql
  const org = ctx.organizationId
  const assignee = args.assigneeId === 'me' ? actor.userId : args.assigneeId
  let rows: Record<string, unknown>[] = []
  let basis = ''

  switch (query) {
    case 'tasks_overdue': {
      const cutoff = startOfDay(now, ctx.timezone)
      rows = await sql`
        SELECT t.id, t.title, t.status, t.priority, t.due_at,
               u.name AS assignee_name, t.assignee_id,
               p.name AS project_name, c.name AS company_name,
               EXTRACT(DAY FROM (${cutoff}::timestamptz - t.due_at))::int AS days_overdue
        FROM tasks t
        LEFT JOIN users u ON u.id = t.assignee_id
        LEFT JOIN projects p ON p.id = t.project_id
        LEFT JOIN companies c ON c.id = p.company_id
        WHERE t.organization_id = ${org} AND t.deleted_at IS NULL
          AND t.status NOT IN ('completed', 'cancelled')
          AND t.due_at < ${cutoff}
          ${assignee ? sql`AND t.assignee_id = ${assignee}` : sql``}
        ORDER BY t.due_at ASC
        LIMIT ${limit}`
      basis = `Tasks with a due date before today (${asOfLabel(ctx.timezone, now)}), excluding completed and cancelled.`
      break
    }

    case 'tasks_due_today': {
      rows = await sql`
        SELECT t.id, t.title, t.status, t.priority, t.due_at, u.name AS assignee_name
        FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
        WHERE t.organization_id = ${org} AND t.deleted_at IS NULL
          AND t.status NOT IN ('completed', 'cancelled')
          AND t.due_at BETWEEN ${startOfDay(now, ctx.timezone)} AND ${endOfDay(now, ctx.timezone)}
          ${assignee ? sql`AND t.assignee_id = ${assignee}` : sql``}
        ORDER BY t.priority, t.due_at
        LIMIT ${limit}`
      basis = `Tasks due today in ${ctx.timezone} (${asOfLabel(ctx.timezone, now)}).`
      break
    }

    case 'tasks_by_status': {
      rows = await sql`
        SELECT t.status, count(*)::int AS count
        FROM tasks t
        WHERE t.organization_id = ${org} AND t.deleted_at IS NULL
          ${args.projectId ? sql`AND t.project_id = ${args.projectId}` : sql``}
        GROUP BY t.status ORDER BY count DESC`
      basis = 'Live task counts grouped by status.'
      break
    }

    case 'stale_customer_threads': {
      // A thread is stale when the account's reply SLA has elapsed. Threads where *we*
      // spoke last are returned too, but marked ambiguous: our message may have closed
      // the thread, so chasing it would be noise. The agent flags those rather than
      // acting on them.
      rows = await sql`
        SELECT conv.id AS conversation_id, conv.subject, conv.last_message_at, conv.last_direction,
               (conv.last_direction <> 'inbound') AS ambiguous,
               c.id AS company_id, c.name AS company_name, c.reply_sla_days,
               c.owner_id, u.name AS owner_name,
               EXTRACT(DAY FROM (now() - conv.last_message_at))::int AS days_waiting,
               m.id AS last_message_id, m.from_name AS last_message_from, m.body_text AS last_message_excerpt
        FROM conversations conv
        JOIN companies c ON c.id = conv.company_id
        LEFT JOIN users u ON u.id = c.owner_id
        LEFT JOIN LATERAL (
          SELECT id, from_name, left(body_text, 400) AS body_text
          FROM messages
          WHERE conversation_id = conv.id AND deleted_at IS NULL
          ORDER BY sent_at DESC LIMIT 1
        ) m ON true
        WHERE conv.organization_id = ${org} AND conv.deleted_at IS NULL
          AND conv.status = 'open'
          -- The excerpt below is the last message's body. A watcher that surfaces it to somebody
          -- who could not open the thread would be a way round the classification (ADR 0061).
          AND conv.sensitivity <= ${readCeiling(actor)}::sw_sensitivity
          AND c.deleted_at IS NULL
          AND c.type IN ('customer', 'prospect')
          AND conv.last_message_at < now() - make_interval(days => ${args.slaDaysOverride ?? 0}::int
                                                            + coalesce(c.reply_sla_days, 4))
          ${args.companyId ? sql`AND c.id = ${args.companyId}` : sql``}
        ORDER BY ambiguous ASC, conv.last_message_at ASC
        LIMIT ${limit}`
      basis = `Open customer threads past the account's reply SLA (${asOfLabel(ctx.timezone, now)}). Threads where we sent the last message are marked ambiguous.`
      break
    }

    case 'workload_by_assignee': {
      // Facts about load, never a productivity verdict (§12.9).
      rows = await sql`
        SELECT u.id AS user_id, u.name,
               count(*) FILTER (WHERE t.status NOT IN ('completed', 'cancelled'))::int AS open_tasks,
               count(*) FILTER (WHERE t.due_at < ${startOfDay(now, ctx.timezone)}
                                  AND t.status NOT IN ('completed', 'cancelled'))::int AS overdue_tasks,
               count(*) FILTER (WHERE t.status = 'blocked')::int AS blocked_tasks,
               coalesce(sum(t.estimate_minutes) FILTER (WHERE t.status NOT IN ('completed', 'cancelled')), 0)::int AS estimated_minutes
        FROM memberships mem
        JOIN users u ON u.id = mem.user_id
        LEFT JOIN tasks t ON t.assignee_id = u.id AND t.organization_id = ${org} AND t.deleted_at IS NULL
        WHERE mem.organization_id = ${org} AND mem.deleted_at IS NULL AND mem.status = 'active'
        GROUP BY u.id, u.name
        ORDER BY open_tasks DESC
        LIMIT ${limit}`
      basis = 'Open, overdue and blocked task counts per person. Workload facts only — Superwork does not score or rank people.'
      break
    }

    case 'approvals_pending': {
      rows = await sql`
        SELECT a.id, a.title, a.risk_tier, a.created_at, a.sla_hours, a.expires_at,
               EXTRACT(EPOCH FROM (now() - a.created_at)) / 3600 AS hours_waiting
        FROM approvals a
        WHERE a.organization_id = ${org} AND a.deleted_at IS NULL AND a.status = 'pending'
          AND (a.approver_user_id IS NULL OR a.approver_user_id = ${actor.userId})
        ORDER BY a.created_at ASC
        LIMIT ${limit}`
      basis = 'Approvals currently awaiting your decision.'
      break
    }

    case 'agent_cost_month_to_date': {
      rows = await sql`
        SELECT coalesce(d.name, 'Unassigned') AS department,
               sum(ur.cost_cents)::numeric(12,2) AS cost_cents,
               count(DISTINCT ur.agent_run_id)::int AS runs
        FROM usage_records ur
        LEFT JOIN departments d ON d.id = ur.department_id
        WHERE ur.organization_id = ${org} AND ur.occurred_at >= date_trunc('month', now())
        GROUP BY d.name ORDER BY cost_cents DESC`
      basis = 'AI spend this calendar month, grouped by department.'
      break
    }

    case 'knowledge_health': {
      rows = await sql`
        SELECT index_status AS status, count(*)::int AS count,
               round(avg(EXTRACT(EPOCH FROM (now() - created_at)) / 86400)::numeric, 1) AS avg_age_days
        FROM documents
        WHERE organization_id = ${org} AND deleted_at IS NULL
        GROUP BY index_status ORDER BY count DESC`
      basis = 'Document index status across company memory.'
      break
    }
  }

  return { query, basis, computedAt: now, rows, total: rows.length }
}
