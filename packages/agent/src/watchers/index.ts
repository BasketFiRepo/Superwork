import { withTenant, type TenantContext } from '@superwork/db'
import { loadActor, type Actor } from '@superwork/auth'
import { runAggregate } from '@superwork/core'
import type { RunSession } from '../runtime.js'

/**
 * The Watcher framework (§9.1).
 *
 * Watchers are read-only. Each declares its cadence, its detection logic
 * (deterministic first), a dedupe key and — mandatorily — a recommended action with the
 * tool call pre-filled. An insight with no evidence must not render; an insight with no
 * next step is noise and the database rejects it.
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

export const WATCHERS: Watcher[] = [staleThreadWatcher, overdueWatcher, approvalAgingWatcher, knowledgeGapWatcher]

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
          ${draft.body}, ${ctx.sql.json(draft.evidence)}, ${ctx.sql.json(draft.entities)},
          ${ctx.sql.json(draft.recommendedActions)}, ${draft.dedupeKey}, ${draft.assignedTo ?? null}, ${ctx.userId}
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
