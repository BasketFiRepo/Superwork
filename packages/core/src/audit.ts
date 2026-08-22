import { asJson, type ActorType, type TenantContext } from '@superwork/db'
import { can, SENSITIVE_FIELDS, type Actor } from '@superwork/auth'
import { PermissionError } from './errors.js'

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

// ---------------------------------------------------------------------------
// Reading it (ADR 0079)
// ---------------------------------------------------------------------------

/**
 * One line of the forensic record.
 *
 * `diff` is already redacted — `buildDiff` replaces a sensitive field's value with `[redacted]`
 * at write time and names the field in `redactedFields`, so the trail says a password changed
 * without ever having held one. The reader surfaces the list rather than dropping it: "three
 * fields not recorded" is a fact an auditor needs, and silence is not.
 */
export interface AuditEntry {
  id: string
  occurredAt: Date
  actorType: ActorType
  /** Who is answerable. An agent's run is attributed to the person it ran for. */
  actorName: string | null
  agentName: string | null
  action: string
  entityType: string
  entityId: string | null
  diff: Record<string, { from: unknown; to: unknown }>
  redactedFields: string[]
  /** Whether a password was re-entered within the five minutes before this (§4.1). */
  steppedUp: boolean
  agentRunId: string | null
}

export interface AuditFilter {
  entityType?: string
  entityId?: string
  action?: string
  /** One person's actions. The investigative axis, and the one §29.5 constrains — see below. */
  principalUserId?: string
  since?: Date
  limit?: number
}

const SELECT_AUDIT = (ctx: TenantContext) => ctx.sql`
  SELECT a.id, a.occurred_at AS "occurredAt", a.actor_type AS "actorType",
         u.name AS "actorName", ag.name AS "agentName",
         a.action, a.entity_type AS "entityType", a.entity_id AS "entityId",
         a.diff, a.redacted_fields AS "redactedFields",
         (a.stepped_up_at IS NOT NULL) AS "steppedUp",
         a.agent_run_id AS "agentRunId"
  FROM audit_logs a
  LEFT JOIN users u ON u.id = a.principal_user_id
  LEFT JOIN agents ag ON ag.id = a.actor_id AND a.actor_type = 'agent'`

/**
 * The forensic record, for somebody entitled to read it (§3.6, ADR 0079).
 *
 * `writeAudit` has been called from all over this product since Phase 0 and nothing has ever
 * read the table. `audit:read:org` has been in the administrator's grant list just as long. An
 * audit trail nobody can look at is not an audit trail; it is a table that grows.
 *
 * **It returns rows, and never a total.** Grouping these by person is one query away from a
 * productivity measure, which §29.5 forbids by construction rather than by policy — so there is
 * no aggregate keyed on the principal anywhere in this file, and
 * `tests/security/audit-read.test.ts` reads the source and requires none. Filtering to one
 * person is offered, because an account thought to be compromised cannot be investigated
 * without it; counting what they did is a different question, and nobody has written it.
 */
export async function readAuditLog(
  ctx: TenantContext,
  actor: Actor,
  filter: AuditFilter = {},
): Promise<AuditEntry[]> {
  const decision = can(actor, 'audit:read', { type: 'audit', organizationId: ctx.organizationId })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const sql = ctx.sql
  return sql<AuditEntry[]>`
    ${SELECT_AUDIT(ctx)}
    WHERE a.organization_id = ${ctx.organizationId}
      ${filter.entityType ? sql`AND a.entity_type = ${filter.entityType}` : sql``}
      ${filter.entityId ? sql`AND a.entity_id = ${filter.entityId}` : sql``}
      ${filter.action ? sql`AND a.action = ${filter.action}` : sql``}
      ${filter.principalUserId ? sql`AND a.principal_user_id = ${filter.principalUserId}` : sql``}
      ${filter.since ? sql`AND a.occurred_at >= ${filter.since}` : sql``}
    ORDER BY a.occurred_at DESC
    LIMIT ${Math.min(filter.limit ?? 100, 500)}`
}

/**
 * Your own trail, on your own record (§29.3).
 *
 * The rule is that nothing about a person reaches their manager that the person has not already
 * seen. An administrator can now read what you did, so this is what makes that true rather than
 * a promise: the same rows, from the same table, on the screen that already answers "what is
 * known about me".
 *
 * Self only, like `personalRecord` — the parameter is the caller's own id and there is no
 * supported way to ask for somebody else's. Reading your own trail needs no permission, because
 * `audit:read` is the right to read *everybody's*, and requiring it here would mean a member
 * could never see what the product had recorded about them.
 */
export async function myAuditTrail(ctx: TenantContext, actor: Actor, limit = 50): Promise<AuditEntry[]> {
  return ctx.sql<AuditEntry[]>`
    ${SELECT_AUDIT(ctx)}
    WHERE a.organization_id = ${ctx.organizationId} AND a.principal_user_id = ${actor.userId}
    ORDER BY a.occurred_at DESC
    LIMIT ${Math.min(limit, 200)}`
}
