import type { TenantContext } from '@superwork/db'
import type { Actor } from '@superwork/auth'
import { detectInjection, hybridSearch, runAggregate, type AggregateQuery } from '@superwork/core'
import type { Grounding } from '@superwork/ai'

/**
 * The Ground phase (§5.1).
 *
 * Structured questions route to SQL, never to the vector index; retrieval fills in what
 * SQL cannot answer. Untrusted external content is scanned before it enters the context
 * and, if it carries instructions, the run is capability-downgraded rather than trusted.
 */

const FOLLOW_UP = /\b(follow[- ]?ups?|chase|chasing|gone quiet|went quiet|no reply|unanswered|stale|overdue customers?)\b/i
const TASK_WORK = /\b(task|todo|overdue|due|slipping|behind|assign|workload|blocked)\b/i
const APPROVAL = /\b(approvals?|waiting on me|to approve)\b/i
const COST = /\b(cost|spend|budget|how much)\b/i
const STATUS = /\b(status|how are we|health|progress)\b/i

export interface GroundResult {
  grounding: Grounding
  containsUntrusted: boolean
  injectionFindings: { sourceId: string; label: string; patterns: string[] }[]
  aggregatesRun: AggregateQuery[]
  retrievalNote: string
}

export async function ground(
  ctx: TenantContext,
  actor: Actor,
  request: string,
  options: { mode: string; canDraft: boolean; canExecuteLow: boolean; canExecuteHigh: boolean },
): Promise<GroundResult> {
  const aggregates: Grounding['aggregates'] = {}
  const ran: AggregateQuery[] = []

  const wanted: AggregateQuery[] = []
  if (FOLLOW_UP.test(request)) wanted.push('stale_customer_threads')
  if (TASK_WORK.test(request)) wanted.push('tasks_overdue')
  if (STATUS.test(request)) wanted.push('tasks_by_status')
  if (APPROVAL.test(request)) wanted.push('approvals_pending')
  if (COST.test(request)) wanted.push('agent_cost_month_to_date')
  if (/\bworkload|capacity|load\b/i.test(request)) wanted.push('workload_by_assignee')
  // No speculative aggregate: pulling an unrelated count into context is how an answer
  // ends up opening with a number nobody asked for.

  for (const query of [...new Set(wanted)]) {
    const result = await runAggregate(ctx, actor, query, { limit: 25 })
    aggregates[query] = { basis: result.basis, rows: result.rows }
    ran.push(query)
  }

  // Retrieval fills in the prose questions SQL cannot answer.
  const search = await hybridSearch(ctx, actor, request, { topK: 8 })

  // Scan the untrusted external content this run will read.
  const injectionFindings: GroundResult['injectionFindings'] = []
  const untrusted: Grounding['untrusted'] = []

  const conversationIds = new Set<string>()
  for (const row of aggregates['stale_customer_threads']?.rows ?? []) {
    const id = row['conversation_id']
    if (typeof id === 'string') conversationIds.add(id)
  }

  if (conversationIds.size > 0) {
    const messages = await ctx.sql<{ id: string; conversation_id: string; body_text: string; from_name: string | null }[]>`
      SELECT id, conversation_id, left(body_text, 4000) AS body_text, from_name
      FROM messages
      WHERE organization_id = ${ctx.organizationId}
        AND conversation_id = ANY(${[...conversationIds]}::uuid[])
        AND direction = 'inbound' AND deleted_at IS NULL`
    for (const message of messages) {
      const findings = detectInjection(message.body_text)
      const label = `Message from ${message.from_name ?? 'external sender'}`
      untrusted.push({
        sourceId: message.id,
        label,
        flagged: findings.length > 0,
        patterns: findings.map((f) => f.pattern),
      })
      if (findings.length > 0) {
        injectionFindings.push({ sourceId: message.id, label, patterns: findings.map((f) => f.pattern) })
        await ctx.sql`
          UPDATE messages SET injection_flagged = true
          WHERE organization_id = ${ctx.organizationId} AND id = ${message.id}`
      }
    }
  }

  const [me] = await ctx.sql<{ name: string }[]>`SELECT name FROM users WHERE id = ${actor.userId}`

  const grounding: Grounding = {
    now: new Date().toISOString(),
    timezone: ctx.timezone,
    me: { name: me?.name ?? actor.displayName, role: actor.role },
    mode: options.mode,
    capabilities: {
      canDraft: options.canDraft,
      canExecuteLow: options.canExecuteLow,
      canExecuteHigh: options.canExecuteHigh,
    },
    aggregates,
    knowledge: search.chunks.map((c) => ({
      documentId: c.documentId,
      documentTitle: c.documentTitle,
      anchor: c.anchor,
      headingPath: c.headingPath,
      content: c.content,
      score: c.rerankScore,
      isSuperseded: c.isSuperseded,
    })),
    noAnswer: search.noAnswer,
    untrusted,
  }

  return {
    grounding,
    containsUntrusted: untrusted.length > 0,
    injectionFindings,
    aggregatesRun: ran,
    retrievalNote: search.noAnswer
      ? 'Nothing in company memory clears the relevance threshold for this question.'
      : `${search.chunks.length} passages retrieved from company memory.`,
  }
}
