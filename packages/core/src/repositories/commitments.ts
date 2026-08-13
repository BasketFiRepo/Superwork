import type { TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeActivity, writeAudit } from '../audit.js'
import { link } from '../links.js'

/**
 * The commitment ledger (§29.1).
 *
 * An agent-detected commitment is a *suggestion* until the named owner accepts it. That
 * one rule prevents the most damaging failure mode in the product: being chased for
 * something you never agreed to. The ledger also distinguishes kept, renegotiated in
 * advance, and silently missed — and only the third is worth escalating.
 */

export type CommitmentDirection = 'we_owe' | 'they_owe'
export type CommitmentStatus =
  | 'proposed' | 'confirmed' | 'kept' | 'renegotiated' | 'slipped' | 'cancelled' | 'disputed'

export interface CommitmentView {
  id: string
  obligation: string
  direction: CommitmentDirection
  status: CommitmentStatus
  ownerUserId: string | null
  ownerName: string | null
  companyId: string | null
  companyName: string | null
  contactName: string | null
  dueAt: Date | null
  confidence: number | null
  sourceMessageId: string | null
  sourceExcerpt: string | null
  sourceSegmentId: string | null
  detectedByAgentRunId: string | null
  confirmedAt: Date | null
  ownerNote: string | null
  disputedReason: string | null
  taskId: string | null
  renegotiationHistory: { at: string; from: string | null; to: string; reason: string | null }[]
  createdAt: Date
}

const SELECT_COMMITMENT = (ctx: TenantContext) => ctx.sql`
  SELECT cm.id, cm.obligation, cm.direction, cm.status,
         cm.owner_user_id AS "ownerUserId", u.name AS "ownerName",
         cm.company_id AS "companyId", co.name AS "companyName", ct.name AS "contactName",
         cm.due_at AS "dueAt", cm.confidence,
         cm.source_message_id AS "sourceMessageId", cm.source_excerpt AS "sourceExcerpt",
         cm.source_segment_id AS "sourceSegmentId",
         cm.detected_by_agent_run_id AS "detectedByAgentRunId",
         cm.confirmed_at AS "confirmedAt", cm.owner_note AS "ownerNote",
         cm.disputed_reason AS "disputedReason", cm.task_id AS "taskId",
         cm.renegotiation_history AS "renegotiationHistory", cm.created_at AS "createdAt"
  FROM commitments cm
  LEFT JOIN users u ON u.id = cm.owner_user_id
  LEFT JOIN companies co ON co.id = cm.company_id
  LEFT JOIN contacts ct ON ct.id = cm.counterparty_contact_id`

export interface ProposeCommitmentInput {
  obligation: string
  direction: CommitmentDirection
  ownerUserId?: string | null
  companyId?: string | null
  counterpartyContactId?: string | null
  dueAt?: Date | null
  confidence?: number
  sourceMessageId?: string | null
  sourceSegmentId?: string | null
  sourceExcerpt?: string | null
  agentRunId?: string | null
}

/**
 * Records a detected commitment as `proposed`. It does not count, does not appear in a
 * rollup and does not trigger a nudge until its owner confirms it.
 */
export async function proposeCommitment(
  ctx: TenantContext,
  actor: Actor,
  input: ProposeCommitmentInput,
): Promise<CommitmentView> {
  const decision = can(actor, 'conversation:read', {
    type: 'conversation',
    organizationId: ctx.organizationId,
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
  if (!input.obligation.trim()) throw new ValidationError('A commitment needs an obligation.')

  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO commitments (
      organization_id, owner_user_id, counterparty_contact_id, company_id, obligation,
      direction, due_at, status, confidence, source_message_id, source_segment_id,
      source_excerpt, detected_by_agent_run_id, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.ownerUserId ?? null}, ${input.counterpartyContactId ?? null},
      ${input.companyId ?? null}, ${input.obligation.trim()}, ${input.direction},
      ${input.dueAt ?? null}, 'proposed', ${input.confidence ?? 0.6},
      ${input.sourceMessageId ?? null}, ${input.sourceSegmentId ?? null},
      ${input.sourceExcerpt ?? null}, ${input.agentRunId ?? null}, ${ctx.userId}
    ) RETURNING id`

  const id = row!.id

  // Provenance: the commitment points back at the sentence it came from.
  if (input.sourceMessageId) {
    await link(ctx, { type: 'commitment', id }, { type: 'message', id: input.sourceMessageId }, 'derived_from')
  }
  if (input.sourceSegmentId) {
    await link(ctx, { type: 'commitment', id }, { type: 'transcript_segment', id: input.sourceSegmentId }, 'derived_from')
  }

  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.agent?.agentName ?? actor.displayName,
    verb: 'detected a commitment',
    entityType: 'commitment',
    entityId: id,
    entityLabel: input.obligation.slice(0, 80),
    summary: `Detected a possible commitment: "${input.obligation.slice(0, 120)}". It counts only once its owner confirms it.`,
    agentRunId: input.agentRunId ?? null,
  })

  return getCommitment(ctx, actor, id)
}

export async function getCommitment(ctx: TenantContext, actor: Actor, id: string): Promise<CommitmentView> {
  const [row] = await ctx.sql<CommitmentView[]>`
    ${SELECT_COMMITMENT(ctx)}
    WHERE cm.organization_id = ${ctx.organizationId} AND cm.id = ${id} AND cm.deleted_at IS NULL`
  if (!row) throw new NotFoundError()
  return row
}

export async function listCommitments(
  ctx: TenantContext,
  actor: Actor,
  filter: { ownerUserId?: string | 'me'; status?: CommitmentStatus[]; companyId?: string; dueBefore?: Date; limit?: number } = {},
): Promise<CommitmentView[]> {
  const decision = can(actor, 'conversation:read', { type: 'conversation', organizationId: ctx.organizationId })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const sql = ctx.sql
  const owner = filter.ownerUserId === 'me' ? actor.userId : filter.ownerUserId

  return sql<CommitmentView[]>`
    ${SELECT_COMMITMENT(ctx)}
    WHERE cm.organization_id = ${ctx.organizationId} AND cm.deleted_at IS NULL
      ${owner ? sql`AND cm.owner_user_id = ${owner}` : sql``}
      ${filter.status?.length ? sql`AND cm.status = ANY(${filter.status}::sw_commitment_status[])` : sql``}
      ${filter.companyId ? sql`AND cm.company_id = ${filter.companyId}` : sql``}
      ${filter.dueBefore ? sql`AND cm.due_at < ${filter.dueBefore}` : sql``}
    ORDER BY cm.status = 'proposed' DESC, cm.due_at NULLS LAST, cm.created_at DESC
    LIMIT ${Math.min(filter.limit ?? 50, 200)}`
}

export type OwnerResponse = 'confirm' | 'dispute' | 'renegotiate' | 'complete' | 'cancel'

export interface RespondInput {
  commitmentId: string
  response: OwnerResponse
  newDueAt?: Date
  reason?: string
  note?: string
}

/**
 * The owner's reply. "I need more time", "this is blocked" and "this isn't mine" are all
 * first-class, non-penalized answers that update the record and stop the chasing (§29.2).
 */
export async function respondToCommitment(
  ctx: TenantContext,
  actor: Actor,
  input: RespondInput,
): Promise<CommitmentView> {
  const before = await getCommitment(ctx, actor, input.commitmentId)

  // Only the named owner, or a manager above them, may answer on their behalf.
  const isOwner = before.ownerUserId === actor.userId
  if (!isOwner) {
    const decision = can(actor, 'conversation:update', {
      type: 'conversation',
      organizationId: ctx.organizationId,
      ownerId: before.ownerUserId,
      riskTier: 'low',
    })
    if (!decision.allow) {
      throw new PermissionError(
        'Only the person who owns this commitment can answer for it. Ask them, or a manager in their department.',
      )
    }
  }

  if (input.response === 'renegotiate' && !input.newDueAt) {
    throw new ValidationError('Renegotiating needs a new date — that is the point of it.')
  }
  if (input.response === 'dispute' && !input.reason?.trim()) {
    throw new ValidationError('A dispute needs a reason, so it can travel with the item rather than being dropped.')
  }

  const status: CommitmentStatus =
    input.response === 'confirm'
      ? 'confirmed'
      : input.response === 'dispute'
        ? 'disputed'
        : input.response === 'renegotiate'
          ? 'renegotiated'
          : input.response === 'complete'
            ? 'kept'
            : 'cancelled'

  const history = [
    ...before.renegotiationHistory,
    ...(input.response === 'renegotiate'
      ? [
          {
            at: new Date().toISOString(),
            from: before.dueAt ? before.dueAt.toISOString() : null,
            to: input.newDueAt!.toISOString(),
            reason: input.reason ?? null,
          },
        ]
      : []),
  ]

  await ctx.sql`
    UPDATE commitments SET
      status = ${status}::sw_commitment_status,
      due_at = ${input.newDueAt ?? before.dueAt},
      confirmed_at = ${input.response === 'confirm' ? new Date() : before.confirmedAt},
      confirmed_by = ${input.response === 'confirm' ? actor.userId : null},
      owner_note = ${input.note ?? before.ownerNote},
      disputed_reason = ${input.response === 'dispute' ? input.reason ?? null : before.disputedReason},
      renegotiation_history = ${ctx.sql.json(history as never)}
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.commitmentId}`

  const verb =
    input.response === 'confirm'
      ? 'confirmed'
      : input.response === 'dispute'
        ? 'disputed'
        : input.response === 'renegotiate'
          ? 'renegotiated'
          : input.response === 'complete'
            ? 'completed'
            : 'cancelled'

  await writeActivity(ctx, {
    actorType: 'user',
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb,
    entityType: 'commitment',
    entityId: before.id,
    entityLabel: before.obligation.slice(0, 80),
    summary:
      input.response === 'renegotiate'
        ? `${actor.displayName} moved "${before.obligation.slice(0, 80)}" to a new date in advance — recorded as renegotiated, not missed.`
        : `${actor.displayName} ${verb} "${before.obligation.slice(0, 80)}"`,
  })
  await writeAudit(ctx, {
    actorType: 'user',
    actorId: actor.userId,
    action: `commitment.${input.response}`,
    entityType: 'commitment',
    entityId: before.id,
    before: { status: before.status, due_at: before.dueAt },
    after: { status, due_at: input.newDueAt ?? before.dueAt, reason: input.reason ?? null },
  })

  return getCommitment(ctx, actor, input.commitmentId)
}

export interface CommitmentLedgerSummary {
  kept: number
  renegotiated: number
  slipped: number
  confirmed: number
  proposed: number
  disputed: number
}

/**
 * The distinction that matters: renegotiating in advance is a success, and only a silent
 * miss is worth escalating (§29.2).
 */
export async function ledgerSummary(
  ctx: TenantContext,
  filter: { ownerUserId?: string } = {},
): Promise<CommitmentLedgerSummary> {
  const sql = ctx.sql
  const [row] = await sql<CommitmentLedgerSummary[]>`
    SELECT
      count(*) FILTER (WHERE status = 'kept')::int AS kept,
      count(*) FILTER (WHERE status = 'renegotiated')::int AS renegotiated,
      count(*) FILTER (WHERE status = 'confirmed' AND due_at < now())::int AS slipped,
      count(*) FILTER (WHERE status = 'confirmed' AND (due_at IS NULL OR due_at >= now()))::int AS confirmed,
      count(*) FILTER (WHERE status = 'proposed')::int AS proposed,
      count(*) FILTER (WHERE status = 'disputed')::int AS disputed
    FROM commitments
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
      ${filter.ownerUserId ? sql`AND owner_user_id = ${filter.ownerUserId}` : sql``}`
  return row ?? { kept: 0, renegotiated: 0, slipped: 0, confirmed: 0, proposed: 0, disputed: 0 }
}
