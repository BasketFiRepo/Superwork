import { asJson, type AgentMode, type Role, type RiskTier, type TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from './errors.js'
import { writeAudit } from './audit.js'
import { assertSteppedUp } from './step-up.js'

/**
 * Approval policies (§11.1).
 *
 * `approval_policies` has been seeded since migration 0005 with three rules — external
 * communication needs a manager, twenty or more writes needs a person, autopilot may never
 * take a high-risk action — and read by nothing. The rules were real and the gate had its
 * own hardcoded copy of one of them: `writes.length > 20`, the same twenty the seeded row
 * states. The row and the constant agreed, and only the constant ran.
 *
 * The consequence was not a missing feature. `approvals.policy_id` and `policy_reason` were
 * columns nothing filled, so an approval could not answer *why am I being asked this?*, and
 * an admin could not answer *what will need approval, and who decides it?* — while a screen
 * existed listing rules that governed nothing.
 *
 * **A policy can only tighten.** There is no `allow` effect and there will not be one. A
 * rule may raise the approver's role, shorten the deadline, or forbid an action outright;
 * it can never remove an approval the product would otherwise require. That is what keeps
 * "nothing is auto-sent externally, ever, under any setting" (§25.7) true in the presence
 * of a configurable rule engine: there is no configuration that reaches it.
 */

export type PolicyEffect = 'require' | 'deny'

export interface PolicyRule {
  match: {
    /** Tool ids, matched exactly — `send_email@v1`, not a prefix or a pattern. */
    tools?: string[]
    /** Writes in the plan, inclusive: `minWrites: 20` matches a plan of exactly twenty. */
    minWrites?: number
    minRisk?: RiskTier
    actorType?: 'user' | 'agent'
    mode?: AgentMode
    departmentId?: string
  }
  require?: { approverRole?: Role; slaHours?: number }
  effect: PolicyEffect
}

export interface PolicyRow {
  id: string
  name: string
  description: string | null
  rule: PolicyRule
  priority: number
  enabled: boolean
}

/** What the gate knows about a proposed plan when the policies are evaluated. */
export interface PolicyFacts {
  tools: string[]
  writes: number
  riskTier: RiskTier
  actorType: 'user' | 'agent'
  mode?: AgentMode | null
  departmentId?: string | null
}

export interface PolicyOutcome {
  /** True when a `deny` rule matched — the plan is refused, not held. */
  denied: boolean
  /** True when an approval is needed. The default is "any write", and a policy cannot lower it. */
  requiresApproval: boolean
  /** The narrowest role that may decide, or null for "whoever would ordinarily decide". */
  approverRole: Role | null
  slaHours: number
  /** The policy that decided, so the card can say why it is being asked. */
  policyId: string | null
  reason: string
  /** Every rule that matched, for the admin screen's "what would this do?" panel. */
  matched: Array<{ id: string; name: string; effect: PolicyEffect }>
}

const RISK_RANK: Record<RiskTier, number> = { read: 0, low: 1, high: 2 }

/** Role seniority, used to take the strictest requirement when several rules match. */
const ROLE_RANK: Record<Role, number> = {
  service: 0,
  guest: 1,
  viewer: 2,
  member: 3,
  manager: 4,
  admin: 5,
  owner: 6,
}

export const DEFAULT_SLA_HOURS = 4

export function roleAtLeast(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required]
}

export function matchesRule(rule: PolicyRule, facts: PolicyFacts): boolean {
  const { match } = rule
  if (match.tools?.length && !match.tools.some((tool) => facts.tools.includes(tool))) return false
  if (match.minWrites !== undefined && facts.writes < match.minWrites) return false
  if (match.minRisk !== undefined && RISK_RANK[facts.riskTier] < RISK_RANK[match.minRisk]) return false
  if (match.actorType !== undefined && facts.actorType !== match.actorType) return false
  if (match.mode !== undefined && facts.mode !== match.mode) return false
  if (match.departmentId !== undefined && facts.departmentId !== match.departmentId) return false
  // A rule with an empty match would apply to everything, including a read-only plan. That
  // is almost certainly a mistake in the rule rather than an intention, so it matches
  // nothing and the admin screen says the rule is inert.
  return Object.keys(match).length > 0
}

/**
 * Evaluate the policy set against one proposed plan.
 *
 * Lower `priority` is considered first, which is why the seeded deny sits at 5 and the
 * requirements at 10 and 20 — a `deny` that loses to a `require` would be a rule that
 * says "forbidden" and produces a card somebody can approve.
 */
export function evaluateApprovalPolicies(
  policies: PolicyRow[],
  facts: PolicyFacts,
  /** The product's own floor, independent of configuration: any write is held for a person. */
  baseRequiresApproval = facts.writes > 0,
): PolicyOutcome {
  const active = policies
    .filter((policy) => policy.enabled)
    .slice()
    .sort((a, b) => a.priority - b.priority)

  const matched: PolicyOutcome['matched'] = []
  let approverRole: Role | null = null
  let slaHours = DEFAULT_SLA_HOURS
  let policyId: string | null = null
  let requireReason: string | null = null

  for (const policy of active) {
    if (!matchesRule(policy.rule, facts)) continue
    matched.push({ id: policy.id, name: policy.name, effect: policy.rule.effect })

    if (policy.rule.effect === 'deny') {
      return {
        denied: true,
        requiresApproval: false,
        approverRole: null,
        slaHours,
        policyId: policy.id,
        reason: `Refused by the “${policy.name}” policy. ${policy.description ?? ''}`.trim(),
        matched,
      }
    }

    // Several requirements can match at once; the strictest of each wins independently, so
    // a rule that only shortens a deadline cannot quietly lower an approver's role.
    const wanted = policy.rule.require?.approverRole
    if (wanted && (!approverRole || ROLE_RANK[wanted] > ROLE_RANK[approverRole])) {
      approverRole = wanted
      policyId = policy.id
      requireReason = `The “${policy.name}” policy requires a ${wanted} to decide this.`
    }
    const wantedSla = policy.rule.require?.slaHours
    if (wantedSla !== undefined && wantedSla < slaHours) {
      slaHours = wantedSla
      if (!policyId) {
        policyId = policy.id
        requireReason = `The “${policy.name}” policy gives this ${wantedSla} hours.`
      }
    }
  }

  return {
    denied: false,
    // A policy can raise the bar and never lower it: the floor is ORed in, not replaced.
    requiresApproval: baseRequiresApproval || matched.length > 0,
    approverRole,
    slaHours,
    policyId,
    reason:
      requireReason ??
      (baseRequiresApproval
        ? 'Changes are held for a person before they happen.'
        : 'Nothing here needs a decision.'),
    matched,
  }
}

/** Every policy in the organization, newest rules last, for evaluation and for the screen. */
export async function approvalPolicies(ctx: TenantContext): Promise<PolicyRow[]> {
  return ctx.sql<PolicyRow[]>`
    SELECT id, name, description, rule, priority, enabled
    FROM approval_policies
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
    ORDER BY priority, name`
}

/**
 * Writing policies.
 *
 * The match is a constrained shape, not free JSON: the tools it names must exist, the
 * numbers must be numbers, and the effect is `require` or `deny`. A rule engine that
 * accepts arbitrary documents is a rule engine whose failures are silent, and a policy
 * that silently matches nothing is worse than no policy at all — it reads as protection.
 */
export interface SavePolicyInput {
  name: string
  description?: string | null
  rule: PolicyRule
  priority?: number
}

export async function savePolicy(
  ctx: TenantContext,
  actor: Actor,
  input: SavePolicyInput,
  knownTools: string[],
): Promise<PolicyRow> {
  const decision = can(actor, 'settings:update', {
    type: 'settings',
    organizationId: ctx.organizationId,
    riskTier: 'high',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
  assertSteppedUp(actor, 'approval_policy.set')

  const name = input.name?.trim()
  if (!name) throw new ValidationError('A policy needs a name — it is what the approval card will cite.')

  const match = input.rule?.match ?? {}
  if (Object.keys(match).length === 0) {
    throw new ValidationError(
      'A policy with nothing to match on would apply to everything, including reading. Name a tool, a number of changes, or a risk level.',
    )
  }
  for (const tool of match.tools ?? []) {
    if (!knownTools.includes(tool)) {
      throw new ValidationError(
        `No tool called "${tool}" exists, so this rule would never match. Rules are checked against the tool registry when they are written, not quietly ignored when they run.`,
      )
    }
  }
  if (match.minWrites !== undefined && (!Number.isInteger(match.minWrites) || match.minWrites < 1)) {
    throw new ValidationError('“At least this many changes” has to be a whole number, one or more.')
  }
  if (input.rule.effect !== 'require' && input.rule.effect !== 'deny') {
    throw new ValidationError('A policy either requires an approval or refuses the action. There is no third effect.')
  }
  if (input.rule.effect === 'require' && !input.rule.require?.approverRole && input.rule.require?.slaHours === undefined) {
    throw new ValidationError(
      'A rule that requires approval has to say something about it — who decides, or by when. Otherwise it changes nothing.',
    )
  }
  const sla = input.rule.require?.slaHours
  if (sla !== undefined && (!Number.isInteger(sla) || sla < 1 || sla > 168)) {
    throw new ValidationError('A deadline is between 1 and 168 hours. Longer than a week is not a deadline.')
  }

  const [row] = await ctx.sql<PolicyRow[]>`
    INSERT INTO approval_policies (organization_id, name, description, rule, priority, created_by)
    VALUES (${ctx.organizationId}, ${name}, ${input.description?.trim() || null},
            ${ctx.sql.json(asJson(input.rule))}, ${input.priority ?? 100}, ${ctx.userId})
    RETURNING id, name, description, rule, priority, enabled`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'approval_policy.created',
    entityType: 'approval_policy',
    entityId: row!.id,
    after: { name, rule: input.rule, priority: input.priority ?? 100 },
  })
  return row!
}

/**
 * Turning one off, or on.
 *
 * A reason is required in both directions. Switching a rule off is the change somebody will
 * be asked about later, and "who turned this off and why" is not answerable from a boolean.
 */
export async function setPolicyEnabled(
  ctx: TenantContext,
  actor: Actor,
  input: { policyId: string; enabled: boolean; reason: string },
): Promise<PolicyRow> {
  const decision = can(actor, 'settings:update', {
    type: 'settings',
    organizationId: ctx.organizationId,
    riskTier: 'high',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
  assertSteppedUp(actor, 'approval_policy.set')

  if (!input.reason?.trim()) {
    throw new ValidationError(
      'Say why. Turning a rule off is the change somebody will be asked about, and a boolean does not answer it.',
    )
  }

  const [before] = await ctx.sql<{ name: string; enabled: boolean }[]>`
    SELECT name, enabled FROM approval_policies
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.policyId} AND deleted_at IS NULL`
  if (!before) throw new NotFoundError()

  const [row] = await ctx.sql<PolicyRow[]>`
    UPDATE approval_policies SET enabled = ${input.enabled}, updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.policyId} AND deleted_at IS NULL
    RETURNING id, name, description, rule, priority, enabled`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: input.enabled ? 'approval_policy.enabled' : 'approval_policy.disabled',
    entityType: 'approval_policy',
    entityId: input.policyId,
    before: { enabled: before.enabled },
    after: { enabled: input.enabled, reason: input.reason.trim(), name: before.name },
  })
  return row!
}
