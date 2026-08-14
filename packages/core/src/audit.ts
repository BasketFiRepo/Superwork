import { asJson, type ActorType, type TenantContext } from '@superwork/db'
import { SENSITIVE_FIELDS } from '@superwork/auth'

/**
 * `activities` is the human-facing timeline; `audit_logs` is the forensic record.
 * They are deliberately separate tables and must not be merged (§3.6).
 */

export interface ActivityInput {
  actorType: ActorType
  actorUserId?: string | null
  actorAgentId?: string | null
  actorLabel: string
  verb: string
  entityType: string
  entityId: string
  entityLabel: string
  summary: string
  agentRunId?: string | null
  metadata?: Record<string, unknown>
  occurredAt?: Date
}

export async function writeActivity(ctx: TenantContext, input: ActivityInput): Promise<string> {
  const rows = await ctx.sql<{ id: string }[]>`
    INSERT INTO activities (
      organization_id, actor_type, actor_user_id, actor_agent_id, actor_label, verb,
      entity_type, entity_id, entity_label, summary, agent_run_id, metadata, occurred_at, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.actorType}, ${input.actorUserId ?? null}, ${input.actorAgentId ?? null},
      ${input.actorLabel}, ${input.verb}, ${input.entityType}, ${input.entityId}, ${input.entityLabel},
      ${input.summary}, ${input.agentRunId ?? null}, ${ctx.sql.json(asJson(input.metadata ?? {}))},
      ${input.occurredAt ?? new Date()}, ${ctx.userId}
    ) RETURNING id`
  return rows[0]!.id
}

export interface AuditInput {
  actorType: ActorType
  actorId?: string | null
  principalUserId?: string | null
  action: string
  entityType: string
  entityId?: string | null
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  ip?: string | null
  userAgent?: string | null
  agentRunId?: string | null
}

export async function writeAudit(ctx: TenantContext, input: AuditInput): Promise<void> {
  const { diff, redacted } = buildDiff(input.entityType, input.before ?? null, input.after ?? null)
  await ctx.sql`
    INSERT INTO audit_logs (
      organization_id, actor_type, actor_id, principal_user_id, action, entity_type, entity_id,
      diff, redacted_fields, ip, user_agent, request_id, trace_id, agent_run_id, stepped_up_at
    ) VALUES (
      ${ctx.organizationId}, ${input.actorType}, ${input.actorId ?? null},
      ${input.principalUserId ?? ctx.userId}, ${input.action}, ${input.entityType}, ${input.entityId ?? null},
      ${ctx.sql.json(asJson(diff))}, ${redacted}, ${input.ip ?? null}, ${input.userAgent ?? null},
      ${ctx.requestId}, ${ctx.traceId}, ${input.agentRunId ?? null},
      -- Taken from the context, never from the caller: an argument can be forgotten or
      -- fabricated, and this is the field an auditor leans on (§4.1).
      ${ctx.steppedUpAt}
    )`
}

/** Redaction happens at the logging layer, not the call site (§20.1). */
function buildDiff(
  entityType: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): { diff: Record<string, unknown>; redacted: string[] } {
  const sensitive = new Set(SENSITIVE_FIELDS[entityType] ?? [])
  const redacted: string[] = []
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  const changed: Record<string, { from: unknown; to: unknown }> = {}

  for (const key of keys) {
    const from = before?.[key]
    const to = after?.[key]
    if (JSON.stringify(from) === JSON.stringify(to)) continue
    if (sensitive.has(key) || sensitive.has('*')) {
      redacted.push(key)
      changed[key] = { from: '[redacted]', to: '[redacted]' }
    } else {
      changed[key] = { from: from ?? null, to: to ?? null }
    }
  }
  return { diff: changed, redacted }
}
