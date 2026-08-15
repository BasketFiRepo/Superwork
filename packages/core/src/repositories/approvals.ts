import { asJson, type ApprovalStatus, type RiskTier, type Role, type TenantContext } from '@superwork/db'
import { can, grantedScope, type Actor } from '@superwork/auth'
import { DEFAULT_SLA_HOURS, roleAtLeast } from '../approval-policy.js'

const ROLES: Role[] = ['owner', 'admin', 'manager', 'member', 'viewer', 'guest', 'service']
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeActivity, writeAudit } from '../audit.js'

/**
 * Approvals (§11). An approval card must show, without a click: what will happen
 * (the rendered preview diff), why (evidence + citations), what it affects, who
 * proposed it, the risk tier, and the expiry. All of that is stored on the row.
 */

/**
 * A change an approver may correct in place (§11.2). `arg` names the tool argument the
 * line describes; only arguments named here can be edited, so an edit can never reach a
 * field the tool did not offer — a recipient, an identifier, a permission.
 */
export interface EditableField {
  arg: string
  multiline?: boolean
  help?: string
}

export interface PreviewLine {
  /** e.g. "Create task" / "Send email" */
  operation: string
  entityType: string
  entityLabel: string
  /** Field-level description of the change, rendered as a diff. */
  changes: { field: string; from?: string | null; to: string | null; editable?: EditableField }[]
  riskTier: RiskTier
  reversible: boolean
  /** Set by the runtime when the line is attached to an approval: the plan step it came from. */
  stepId?: string
}

/**
 * The allow-list an edit is checked against: which arguments of which step a person may
 * change. Derived from the stored preview, so it cannot drift from what was shown.
 */
export function editableArgs(preview: PreviewLine[]): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const line of preview) {
    if (!line.stepId) continue
    for (const change of line.changes) {
      if (!change.editable) continue
      const args = (out[line.stepId] ??= [])
      if (!args.includes(change.editable.arg)) args.push(change.editable.arg)
    }
  }
  return out
}

export interface EvidenceItem {
  claim: string
  sourceType: string
  sourceId?: string | null
  documentId?: string | null
  anchor?: string | null
  snippet?: string | null
}

export interface ApprovalView {
  id: string
  title: string
  kind: string
  status: ApprovalStatus
  riskTier: RiskTier
  agentRunId: string | null
  requestedByLabel: string
  requestedByUserId: string | null
  requestedByActorType: string
  approverUserId: string | null
  /** Set when a policy named a role rather than a person: anybody holding it may decide. */
  approverRole: Role | null
  policyId: string | null
  policyName: string | null
  /** Why this is being asked at all — the policy's own words, or the product's default. */
  policyReason: string | null
  slaHours: number
  expiresAt: Date | null
  preview: PreviewLine[]
  evidence: EvidenceItem[]
  edits: Record<string, unknown> | null
  decisionReason: string | null
  decidedAt: Date | null
  createdAt: Date
  hoursWaiting: number
}

export interface CreateApprovalInput {
  title: string
  kind?: string
  riskTier: RiskTier
  agentRunId?: string | null
  approverUserId?: string | null
  slaHours?: number
  preview: PreviewLine[]
  evidence: EvidenceItem[]
  policyReason?: string
  requestedByLabel: string
  /** What the policy set decided about this plan (§11.1). */
  policyId?: string | null
  approverRole?: Role | null
}

export async function createApproval(
  ctx: TenantContext,
  actor: Actor,
  input: CreateApprovalInput,
): Promise<string> {
  if (input.preview.length === 0) {
    // Building the approval UI without preview() diffs means people approve blindly (§25.14).
    throw new ValidationError('An approval must carry a preview of what will happen.')
  }
  const slaHours = input.slaHours ?? DEFAULT_SLA_HOURS

  // A policy that names a role names it instead of a person when the obvious person does
  // not hold it. Defaulting the approver to the requester and leaving `approver_role` NULL
  // is how "external mail needs a manager" became "the member who asked may approve it".
  const approverRole = input.approverRole ?? null
  const explicit = input.approverUserId ?? null
  const approverUserId =
    explicit ?? (approverRole && !roleAtLeast(actor.role, approverRole) ? null : actor.userId)

  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO approvals (
      organization_id, title, kind, status, risk_tier, requested_by_actor_type,
      requested_by_user_id, agent_run_id, approver_user_id, approver_role, policy_id,
      sla_hours, expires_at, preview, evidence, policy_reason, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.title}, ${input.kind ?? 'agent_plan'}, 'pending',
      ${input.riskTier}, ${actor.type}, ${actor.userId}, ${input.agentRunId ?? null},
      ${approverUserId}, ${approverRole}, ${input.policyId ?? null}, ${slaHours},
      -- The deadline is the deadline. This used to be the SLA times six, which made every
      -- "4 hours" card expire in a day and the number on the screen a decoration.
      ${new Date(Date.now() + slaHours * 3600_000)},
      ${ctx.sql.json(asJson(input.preview))}, ${ctx.sql.json(asJson(input.evidence))},
      ${input.policyReason ?? null}, ${ctx.userId}
    ) RETURNING id`

  const id = row!.id
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorAgentId: actor.agent?.agentId ?? null,
    actorLabel: input.requestedByLabel,
    verb: 'requested approval for',
    entityType: 'approval',
    entityId: id,
    entityLabel: input.title,
    summary: `${input.requestedByLabel} requested approval: ${input.title}`,
    agentRunId: input.agentRunId ?? null,
  })
  await recordTrust(ctx, input.kind ?? 'agent_plan', 'proposed', input.agentRunId ?? null, id)
  return id
}

const SELECT_APPROVAL = (ctx: TenantContext) => ctx.sql`
  SELECT a.id, a.title, a.kind, a.status, a.risk_tier AS "riskTier",
         a.agent_run_id AS "agentRunId",
         coalesce(ag.name, u.name, 'Superwork') AS "requestedByLabel",
         a.requested_by_user_id AS "requestedByUserId",
         a.requested_by_actor_type AS "requestedByActorType",
         a.approver_user_id AS "approverUserId", a.approver_role AS "approverRole",
         a.policy_id AS "policyId", p.name AS "policyName",
         a.policy_reason AS "policyReason", a.sla_hours AS "slaHours",
         a.expires_at AS "expiresAt", a.preview, a.evidence, a.edits,
         a.decision_reason AS "decisionReason", a.decided_at AS "decidedAt",
         a.created_at AS "createdAt",
         (EXTRACT(EPOCH FROM (now() - a.created_at)) / 3600)::numeric(10,2)::float8 AS "hoursWaiting"
  FROM approvals a
  LEFT JOIN users u ON u.id = a.requested_by_user_id
  LEFT JOIN agent_runs r ON r.id = a.agent_run_id
  LEFT JOIN agents ag ON ag.id = r.agent_id
  LEFT JOIN approval_policies p ON p.id = a.policy_id`

/**
 * Who may see an approval at all.
 *
 * This took no notice of the actor whatsoever: `listApprovals` and `getApproval` accepted
 * one and never used it, so anybody signed in — down to a `guest` — could read every
 * approval in the organization, and an approval's preview is the draft itself: recipients,
 * subject lines, message bodies, amounts.
 *
 * Three ways in, and no fourth: you asked for it, you are the one being asked, or you may
 * decide approvals of this kind. It is written as a predicate rather than a `can()` call
 * because "may decide *this* one" depends on the row, and a list cannot ask about a row it
 * has not fetched (ADR 0021).
 */
const VISIBLE_TO = (ctx: TenantContext, actor: Actor) => {
  // `grantedScope`, not `can()`: an approval carries no department, so a manager holding
  // `approval:decide:department` can never satisfy an organization-level resource and would
  // have been shut out of the queue entirely. Ask whether they may decide approvals at all,
  // and let the row-level rules below decide which ones they may act on (ADR 0021).
  const decider = grantedScope(actor, 'approval:decide', 'approval') !== null
  // Which named roles this actor satisfies is knowable without the row, so it goes in as a
  // list rather than as a rank comparison the database would have to be taught.
  const satisfies = ROLES.filter((role) => roleAtLeast(actor.role, role))
  return ctx.sql`(
    a.requested_by_user_id = ${actor.userId}
    OR a.approver_user_id = ${actor.userId}
    OR (a.approver_role IS NOT NULL AND a.approver_role = ANY(${satisfies}::sw_role[]))
    ${decider ? ctx.sql`OR true` : ctx.sql``}
  )`
}

export async function listApprovals(
  ctx: TenantContext,
  actor: Actor,
  filter: { status?: ApprovalStatus; limit?: number } = {},
): Promise<ApprovalView[]> {
  const sql = ctx.sql
  return sql<ApprovalView[]>`
    ${SELECT_APPROVAL(ctx)}
    WHERE a.organization_id = ${ctx.organizationId} AND a.deleted_at IS NULL
      AND ${VISIBLE_TO(ctx, actor)}
      ${filter.status ? sql`AND a.status = ${filter.status}` : sql``}
    ORDER BY a.created_at DESC
    LIMIT ${Math.min(filter.limit ?? 50, 200)}`
}

export async function getApproval(ctx: TenantContext, actor: Actor, id: string): Promise<ApprovalView> {
  const [row] = await ctx.sql<ApprovalView[]>`
    ${SELECT_APPROVAL(ctx)}
    WHERE a.organization_id = ${ctx.organizationId} AND a.id = ${id} AND a.deleted_at IS NULL
      AND ${VISIBLE_TO(ctx, actor)}`
  // An approval somebody may not see reports absence, not denial (§3.2).
  if (!row) throw new NotFoundError()
  return row
}

export type Decision = 'approve' | 'approve_with_edits' | 'reject'

export interface DecideInput {
  approvalId: string
  decision: Decision
  reason?: string
  edits?: Record<string, unknown>
}

export async function decideApproval(ctx: TenantContext, actor: Actor, input: DecideInput): Promise<ApprovalView> {
  const approval = await getApproval(ctx, actor, input.approvalId)
  if (approval.status !== 'pending') {
    throw new ValidationError(`This approval was already ${approval.status.replace(/_/g, ' ')}.`)
  }

  // An approval carries no department, so `approval:decide:department` — the manager's
  // grant, and the only decide grant below admin — could never be satisfied by this
  // resource. A manager has therefore never been able to decide anything, which makes
  // "a manager decides this" routing meaningless. Ask whether they may decide approvals at
  // all; the row's own `approverRole` below does the narrowing that matters (ADR 0021).
  if (grantedScope(actor, 'approval:decide', 'approval') === null) {
    const decision = can(actor, 'approval:decide', {
      type: 'approval',
      id: approval.id,
      organizationId: ctx.organizationId,
      ownerId: approval.approverUserId,
    })
    throw new PermissionError(decision.reason)
  }

  // A policy that names a role is the whole point of naming one. Without this the column
  // was written and never consulted, so "external mail needs a manager" produced a card any
  // member could clear.
  if (approval.approverRole && !roleAtLeast(actor.role, approval.approverRole)) {
    throw new PermissionError(
      `${approval.policyName ? `The “${approval.policyName}” policy` : 'This organization'} requires a ${approval.approverRole} to decide this. Yours is ${actor.role}.`,
    )
  }

  // Nothing is self-approved above the configured threshold (§11.3).
  //
  // Two corrections. It only bound `member`, so a manager could approve their own
  // high-risk request and an admin certainly could — the comment said "the configured
  // threshold" and the code said "one role". And it keyed on `approverUserId`, which
  // defaults to the requester, rather than on who actually asked.
  //
  // An agent's proposal is deliberately not self-approval. The person did not propose it;
  // their agent did, and a human deciding what their agent suggested is the entire design
  // (§5.1). Self-approval is a *person* proposing and clearing their own action.
  const isOwnRequest = approval.requestedByActorType === 'user' && approval.requestedByUserId === actor.userId
  if (isOwnRequest && approval.riskTier === 'high') {
    throw new PermissionError(
      'You proposed this yourself, and high-risk actions are not self-approved. Somebody else has to decide it.',
    )
  }
  if (input.decision === 'reject' && !input.reason?.trim()) {
    throw new ValidationError('A rejection needs a reason — it is the signal that improves future proposals.')
  }
  if (input.decision === 'approve_with_edits') {
    assertEditsAreOffered(approval.preview, input.edits)
  }

  const status: ApprovalStatus =
    input.decision === 'approve' ? 'approved' : input.decision === 'approve_with_edits' ? 'approved_with_edits' : 'rejected'

  await ctx.sql`
    UPDATE approvals
    SET status = ${status}, decided_by = ${actor.userId}, decided_at = now(),
        decision_reason = ${input.reason ?? null},
        edits = ${input.edits ? ctx.sql.json(asJson(input.edits)) : null}
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.approvalId}`

  await writeActivity(ctx, {
    actorType: 'user',
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: input.decision === 'reject' ? 'rejected' : 'approved',
    entityType: 'approval',
    entityId: approval.id,
    entityLabel: approval.title,
    summary: `${actor.displayName} ${input.decision === 'reject' ? 'rejected' : 'approved'}: ${approval.title}`,
    agentRunId: approval.agentRunId,
  })
  await writeAudit(ctx, {
    actorType: 'user',
    actorId: actor.userId,
    action: `approval.${input.decision}`,
    entityType: 'approval',
    entityId: approval.id,
    before: { status: 'pending' },
    after: { status, reason: input.reason ?? null },
    agentRunId: approval.agentRunId,
  })
  await recordTrust(
    ctx,
    approval.kind,
    input.decision === 'approve' ? 'approved' : input.decision === 'approve_with_edits' ? 'edited' : 'rejected',
    approval.agentRunId,
    approval.id,
  )

  return getApproval(ctx, actor, input.approvalId)
}

/**
 * Edits are checked against what the card actually offered. Anything else — a step that
 * was not previewed, an argument that was not editable — is refused rather than merged,
 * because an approval that can rewrite an arbitrary argument is a permission bypass with
 * a friendly button on it.
 */
export function assertEditsAreOffered(preview: PreviewLine[], edits: Record<string, unknown> | undefined): void {
  const steps = (edits?.['steps'] ?? {}) as Record<string, Record<string, unknown>>
  const entries = Object.entries(steps)
  if (entries.length === 0) {
    throw new ValidationError('Approving with edits needs an edit. Approve it as proposed if nothing should change.')
  }
  const allowed = editableArgs(preview)
  for (const [stepId, args] of entries) {
    const offered = allowed[stepId]
    if (!offered) {
      throw new ValidationError(`This approval has nothing editable in step "${stepId}".`)
    }
    for (const arg of Object.keys(args)) {
      if (!offered.includes(arg)) {
        throw new ValidationError(
          `"${arg}" is not editable on this card. Only the fields shown as editable can be changed; ` +
            'reject with a reason if something else is wrong.',
        )
      }
    }
  }
}

async function recordTrust(
  ctx: TenantContext,
  actionType: string,
  outcome: string,
  agentRunId: string | null,
  approvalId: string | null,
): Promise<void> {
  await ctx.sql`
    INSERT INTO trust_ledger_entries (organization_id, action_type, outcome, agent_run_id, approval_id, created_by)
    VALUES (${ctx.organizationId}, ${actionType}, ${outcome}, ${agentRunId}, ${approvalId}, ${ctx.userId})`
}

export interface TrustSummary {
  actionType: string
  proposed: number
  approved: number
  edited: number
  rejected: number
  approvalRate: number
  editRate: number
}

/** §11.4 — "Your team approves 94% of drafted follow-ups unedited." */
export async function trustLedger(ctx: TenantContext): Promise<TrustSummary[]> {
  const rows = await ctx.sql<
    { action_type: string; proposed: number; approved: number; edited: number; rejected: number }[]
  >`
    SELECT action_type,
           count(*) FILTER (WHERE outcome = 'proposed')::int AS proposed,
           count(*) FILTER (WHERE outcome = 'approved')::int AS approved,
           count(*) FILTER (WHERE outcome = 'edited')::int AS edited,
           count(*) FILTER (WHERE outcome = 'rejected')::int AS rejected
    FROM trust_ledger_entries
    WHERE organization_id = ${ctx.organizationId}
    GROUP BY action_type ORDER BY proposed DESC`

  return rows.map((r) => {
    const decided = r.approved + r.edited + r.rejected
    return {
      actionType: r.action_type,
      proposed: r.proposed,
      approved: r.approved,
      edited: r.edited,
      rejected: r.rejected,
      approvalRate: decided ? r.approved / decided : 0,
      editRate: decided ? r.edited / decided : 0,
    }
  })
}
