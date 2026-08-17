import { asJson } from '@superwork/db'
import { z } from 'zod'
import {
  notify, link } from '@superwork/core'
import { register, type ToolContext } from '../registry.js'

/** Governance and meta tools (§6.3). */

export const linkEntities = register({
  name: 'link_entities@v1',
  description: 'Create a typed relationship between two records, for example a task derived from an email thread.',
  inputSchema: z.object({
    fromType: z.string(),
    fromId: z.string().uuid(),
    toType: z.string(),
    toId: z.string().uuid(),
    relation: z.enum(['mentions', 'derived_from', 'blocks', 'relates_to', 'attached_to', 'resolves', 'supersedes']),
  }),
  outputSchema: z.object({ linked: z.boolean() }),
  riskTier: 'low' as const,
  requiredPermissions: ['task:update:org'],
  reversible: true,
  inverse: 'unlink_entities@v1',
  rateLimit: { perRun: 50, perOrgPerHour: 5000 },
  timeoutMs: 5000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    await link(ctx.tenantDb, { type: input.fromType, id: input.fromId }, { type: input.toType, id: input.toId }, input.relation)
    return { ok: true as const, value: { linked: true } }
  },
  buildUndo(input) {
    return {
      tool: 'unlink_entities@v1',
      input,
      entityType: input.fromType,
      entityId: input.fromId,
      description: 'Remove the relationship',
    }
  },
})

export const unlinkEntities = register({
  name: 'unlink_entities@v1',
  description: 'Remove a relationship between two records. Inverse of link_entities.',
  inputSchema: z.object({
    fromType: z.string(),
    fromId: z.string().uuid(),
    toType: z.string(),
    toId: z.string().uuid(),
    relation: z.string(),
  }),
  outputSchema: z.object({ unlinked: z.boolean() }),
  riskTier: 'low' as const,
  requiredPermissions: ['task:update:org'],
  reversible: false,
  rateLimit: { perRun: 50, perOrgPerHour: 5000 },
  timeoutMs: 5000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    await ctx.tenantDb.sql`
      UPDATE links SET deleted_at = now()
      WHERE organization_id = ${ctx.organizationId} AND from_type = ${input.fromType} AND from_id = ${input.fromId}
        AND to_type = ${input.toType} AND to_id = ${input.toId}`
    return { ok: true as const, value: { unlinked: true } }
  },
})

export const cite = register({
  name: 'cite@v1',
  description: 'Attach provenance to a specific claim so the reader can open the exact source passage.',
  inputSchema: z.object({
    claim: z.string().min(3),
    sourceType: z.enum(['document_chunk', 'task', 'message', 'company', 'query_aggregate']),
    sourceId: z.string().nullish(),
    documentId: z.string().uuid().nullish(),
    anchor: z.string().nullish(),
    snippet: z.string().max(1000).nullish(),
  }),
  outputSchema: z.object({ id: z.string(), ordinal: z.number() }),
  riskTier: 'low' as const,
  requiredPermissions: ['task:read:org'],
  reversible: true,
  inverse: 'uncite@v1',
  rateLimit: { perRun: 60, perOrgPerHour: 10_000 },
  timeoutMs: 5000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    const sql = ctx.tenantDb.sql
    const [ordinalRow] = await sql<{ next_ordinal: number }[]>`
      SELECT coalesce(max(ordinal), -1) + 1 AS next_ordinal FROM citations
      WHERE organization_id = ${ctx.organizationId} AND run_id = ${ctx.agentRunId}`
    const nextOrdinal = ordinalRow?.next_ordinal ?? 0
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO citations (organization_id, run_id, claim, source_type, source_id, document_id, anchor, snippet, ordinal, created_by)
      VALUES (${ctx.organizationId}, ${ctx.agentRunId}, ${input.claim}, ${input.sourceType},
              ${isUuid(input.sourceId) ? input.sourceId : null}, ${input.documentId ?? null},
              ${input.anchor ?? null}, ${input.snippet ?? null}, ${nextOrdinal}, ${ctx.principalUserId})
      RETURNING id`
    return { ok: true as const, value: { id: row!.id, ordinal: nextOrdinal } }
  },
})

export const uncite = register({
  name: 'uncite@v1',
  description: 'Remove a citation. Inverse of cite.',
  inputSchema: z.object({ id: z.string().uuid() }),
  outputSchema: z.object({ removed: z.boolean() }),
  riskTier: 'low' as const,
  requiredPermissions: ['task:read:org'],
  reversible: false,
  rateLimit: { perRun: 60, perOrgPerHour: 10_000 },
  timeoutMs: 5000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    await ctx.tenantDb.sql`DELETE FROM citations WHERE organization_id = ${ctx.organizationId} AND id = ${input.id}`
    return { ok: true as const, value: { removed: true } }
  },
})

export const askUser = register({
  name: 'ask_user@v1',
  description: 'Ask the person one precise clarifying question with concrete options. Prefer this over guessing between two entities.',
  inputSchema: z.object({
    question: z.string().min(3),
    options: z.array(z.object({ id: z.string(), label: z.string() })).min(2).max(5),
  }),
  outputSchema: z.object({ asked: z.boolean(), question: z.string() }),
  riskTier: 'read' as const,
  requiredPermissions: ['task:read:org'],
  reversible: true,
  rateLimit: { perRun: 3, perOrgPerHour: 500 },
  timeoutMs: 5000,
  idempotent: true,
  redactions: [],
  async execute(input) {
    return { ok: true as const, value: { asked: true, question: input.question } }
  },
})

export const createInsight = register({
  name: 'create_insight@v1',
  description: 'Raise an evidence-backed observation with at least one executable recommended action. An observation with no next step is noise and will be rejected.',
  inputSchema: z.object({
    watcher: z.string(),
    type: z.string(),
    severity: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
    title: z.string().min(3).max(200),
    body: z.string().min(3).max(2000),
    dedupeKey: z.string().min(3),
    evidence: z.array(z.object({ claim: z.string(), sourceType: z.string(), sourceId: z.string().nullish() })).min(1),
    entities: z.array(z.object({ type: z.string(), id: z.string(), label: z.string() })).default([]),
    recommendedActions: z
      .array(z.object({ label: z.string(), tool: z.string(), args: z.record(z.unknown()) }))
      .min(1),
    assignedTo: z.string().uuid().nullish(),
  }),
  outputSchema: z.object({ id: z.string(), deduped: z.boolean() }),
  riskTier: 'low' as const,
  requiredPermissions: ['insight:read:own'],
  reversible: true,
  inverse: 'dismiss_insight@v1',
  rateLimit: { perRun: 20, perOrgPerHour: 500 },
  timeoutMs: 8000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    const sql = ctx.tenantDb.sql
    const rows = await sql<{ id: string }[]>`
      INSERT INTO insights (
        organization_id, watcher, type, severity, title, body, evidence, entities,
        recommended_actions, dedupe_key, assigned_to, agent_run_id, created_by
      ) VALUES (
        ${ctx.organizationId}, ${input.watcher}, ${input.type}, ${input.severity}, ${input.title},
        ${input.body}, ${sql.json(asJson(input.evidence))}, ${sql.json(asJson(input.entities))},
        ${sql.json(asJson(input.recommendedActions))}, ${input.dedupeKey}, ${input.assignedTo ?? null},
        ${ctx.agentRunId}, ${ctx.principalUserId}
      )
      ON CONFLICT (organization_id, dedupe_key) WHERE deleted_at IS NULL DO NOTHING
      RETURNING id`
    if (rows.length === 0) {
      const [existing] = await sql<{ id: string }[]>`
        SELECT id FROM insights WHERE organization_id = ${ctx.organizationId} AND dedupe_key = ${input.dedupeKey}`
      return { ok: true as const, value: { id: existing?.id ?? '', deduped: true } }
    }
    return { ok: true as const, value: { id: rows[0]!.id, deduped: false } }
  },
  buildUndo(_input, output) {
    return {
      tool: 'dismiss_insight@v1',
      input: { id: output.id },
      entityType: 'insight',
      entityId: output.id,
      description: 'Dismiss the insight',
    }
  },
})

export const dismissInsight = register({
  name: 'dismiss_insight@v1',
  description: 'Dismiss an insight. Inverse of create_insight.',
  inputSchema: z.object({ id: z.string().uuid(), reason: z.string().optional() }),
  outputSchema: z.object({ dismissed: z.boolean() }),
  riskTier: 'low' as const,
  requiredPermissions: ['insight:read:own'],
  reversible: false,
  rateLimit: { perRun: 20, perOrgPerHour: 500 },
  timeoutMs: 5000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    await ctx.tenantDb.sql`
      UPDATE insights SET status = 'dismissed', resolved_at = now()
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.id}`
    return { ok: true as const, value: { dismissed: true } }
  },
})

export const escalateToHuman = register({
  name: 'escalate_to_human@v1',
  description: 'Hand the decision to a named person when the agent should not decide. Records why it stopped.',
  inputSchema: z.object({ reason: z.string().min(3), userId: z.string().uuid().nullish(), entityType: z.string().optional(), entityId: z.string().uuid().optional() }),
  outputSchema: z.object({ notified: z.boolean() }),
  riskTier: 'low' as const,
  requiredPermissions: ['task:read:org'],
  reversible: true,
  inverse: 'noop@v1',
  rateLimit: { perRun: 5, perOrgPerHour: 200 },
  timeoutMs: 5000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    // Through the one writer, so the recipient's own routing decides how it reaches them —
    // except that `agent_needs_input` is one of the types nobody may silence (ADR 0047).
    await notify(ctx.tenantDb, {
      userId: input.userId ?? ctx.principalUserId,
      type: 'agent_needs_input',
      title: 'Superwork needs a decision',
      body: input.reason,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
    })
    return { ok: true as const, value: { notified: true } }
  },
})

export const noop = register({
  name: 'noop@v1',
  description: 'Does nothing. Used as the inverse of actions that need no compensation.',
  inputSchema: z.object({}).passthrough(),
  outputSchema: z.object({ ok: z.boolean() }),
  riskTier: 'read' as const,
  requiredPermissions: ['task:read:org'],
  reversible: true,
  rateLimit: { perRun: 50, perOrgPerHour: 10_000 },
  timeoutMs: 1000,
  idempotent: true,
  redactions: [],
  async execute() {
    return { ok: true as const, value: { ok: true } }
  },
})

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}
