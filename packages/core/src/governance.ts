import type { Sensitivity, TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from './errors.js'
import { assertSteppedUp } from './step-up.js'
import { writeAudit } from './audit.js'
import { PROFILES, strictestProfile, type JurisdictionProfile } from './compliance.js'
import { DEFAULT_RECERTIFICATION_DAYS } from './agent-recertification.js'

/**
 * The two ceilings an admin could see and not set (§4.4, §29.5).
 *
 * `monitoring_policies` holds the organization's own limits on how hard the system may chase
 * its people. The screen displayed them; nothing but the seed had ever written the row. And
 * the no-surprises window was *displayed* from this row while being *enforced* from the
 * jurisdiction profile constant, so an organization that gave its people longer to answer
 * than its jurisdiction requires would have seen its own number and had the shorter one
 * applied.
 *
 * `agent_permissions` is the ceiling on what any agent may do, and the agent's own refusal
 * says "An admin can add it in Settings → AI Governance" — a screen that listed the grants
 * and had no control on it. Two of its columns were hollow: `effect = 'deny'` rows were
 * filtered out and never denied anything, and `max_sensitivity` was never read.
 *
 * **An organization may tighten what its jurisdiction allows, never loosen it.** The same
 * rule as an approval policy (ADR 0026) and a spend cap (ADR 0030): a limit a tenant can
 * raise on its own is not a limit.
 */

export interface MonitoringPolicyView {
  jurisdictionProfile: JurisdictionProfile
  nudgeBudgetPerPersonPerDay: number
  noSurprisesReviewHours: number
  /** How long an agent's recertification is good for (ADR 0068). */
  agentRecertificationDays: number
  /** What the jurisdiction itself requires — the boundary the organization may only tighten. */
  ceiling: { nudgeBudgetPerPersonPerDay: number; noSurprisesReviewHours: number }
  reason: string | null
  setByName: string | null
  setAt: Date | null
  /** The five things §29.5 forbids, refused by a database constraint rather than a setting. */
  prohibited: string[]
}

const PROHIBITED = [
  'Individual productivity scoring, ranking or league tables.',
  'Keystroke, screen, webcam, location or idle-time monitoring.',
  'Covert monitoring of any kind.',
  'Automated employment, pay, promotion or discipline decisions.',
  'Reading private messages between people.',
]

/** The profile in force, from the legal entities rather than from this row's own copy. */
async function profileFor(ctx: TenantContext): Promise<JurisdictionProfile> {
  const entities = await ctx.sql<{ jurisdictionProfile: JurisdictionProfile }[]>`
    SELECT jurisdiction_profile AS "jurisdictionProfile" FROM legal_entities
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL`
  return strictestProfile(entities)
}

export async function monitoringPolicy(
  ctx: TenantContext,
  actor?: Actor,
): Promise<MonitoringPolicyView> {
  if (actor) {
    const decision = can(actor, 'settings:read', { type: 'settings', organizationId: ctx.organizationId })
    if (!decision.allow) throw new PermissionError(decision.reason)
  }

  const profile = await profileFor(ctx)
  const rules = PROFILES[profile]

  const [row] = await ctx.sql<
    {
      nudgeBudgetPerPersonPerDay: number
      noSurprisesReviewHours: number
      agentRecertificationDays: number
      reason: string | null
      setByName: string | null
      setAt: Date | null
    }[]
  >`
    SELECT nudge_budget_per_person_per_day AS "nudgeBudgetPerPersonPerDay",
           no_surprises_review_hours AS "noSurprisesReviewHours",
           agent_recertification_days AS "agentRecertificationDays",
           reason, set_at AS "setAt",
           (SELECT u.name FROM users u WHERE u.id = set_by) AS "setByName"
    FROM monitoring_policies
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL`

  return {
    jurisdictionProfile: profile,
    // With no row of its own, an organization gets exactly what its jurisdiction requires.
    nudgeBudgetPerPersonPerDay: Math.min(
      rules.maxNudgesPerPersonPerDay,
      row?.nudgeBudgetPerPersonPerDay ?? rules.maxNudgesPerPersonPerDay,
    ),
    noSurprisesReviewHours: Math.max(
      rules.noSurprisesReviewHours,
      row?.noSurprisesReviewHours ?? rules.noSurprisesReviewHours,
    ),
    // Not a jurisdiction rule: no profile has an opinion about how often a company reviews
    // what its own agents may do. The schema's default is the whole policy until somebody
    // sets one.
    agentRecertificationDays: row?.agentRecertificationDays ?? DEFAULT_RECERTIFICATION_DAYS,
    ceiling: {
      nudgeBudgetPerPersonPerDay: rules.maxNudgesPerPersonPerDay,
      noSurprisesReviewHours: rules.noSurprisesReviewHours,
    },
    reason: row?.reason ?? null,
    setByName: row?.setByName ?? null,
    setAt: row?.setAt ?? null,
    prohibited: PROHIBITED,
  }
}

/**
 * Tightens the organization's own limits.
 *
 * Both directions of "tighter" run the same way they are enforced: **fewer** contacts a day,
 * and a **longer** window to answer before anything about somebody goes past them. Asking for
 * more contacts than the jurisdiction allows, or a shorter window than it requires, is
 * refused with the number that stopped it rather than silently clamped — a setting that
 * quietly disagrees with the screen is how a control stops being one.
 */
export async function setMonitoringPolicy(
  ctx: TenantContext,
  actor: Actor,
  input: {
    nudgeBudgetPerPersonPerDay?: number
    noSurprisesReviewHours?: number
    agentRecertificationDays?: number
    reason: string
  },
): Promise<MonitoringPolicyView> {
  const decision = can(actor, 'settings:update', {
    type: 'settings',
    organizationId: ctx.organizationId,
    riskTier: 'high',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
  if (input.reason.trim().length < 4) {
    throw new ValidationError('Say why. How hard the system may chase people is a decision somebody will be asked about.')
  }

  const current = await monitoringPolicy(ctx)
  const budget = input.nudgeBudgetPerPersonPerDay ?? current.nudgeBudgetPerPersonPerDay
  const hours = input.noSurprisesReviewHours ?? current.noSurprisesReviewHours
  const recertDays = input.agentRecertificationDays ?? current.agentRecertificationDays

  if (!Number.isInteger(budget) || budget < 0 || budget > 20) {
    throw new ValidationError('The daily contact budget is a whole number between 0 and 20.')
  }
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
    throw new ValidationError('The review window is a whole number of hours between 1 and 168.')
  }
  // The bounds are the database's, stated here in words. The floor exists because a review
  // interval of a day is a review nobody performs; the ceiling because one of five years is a
  // policy that reads like a control and behaves like nothing.
  if (!Number.isInteger(recertDays) || recertDays < 7 || recertDays > 365) {
    throw new ValidationError(
      'How often agents are re-examined is a whole number of days between 7 and 365.',
    )
  }
  if (budget > current.ceiling.nudgeBudgetPerPersonPerDay) {
    throw new ValidationError(
      `This organization's jurisdiction profile (${current.jurisdictionProfile.replace(/_/g, ' ')}) allows at most ` +
        `${current.ceiling.nudgeBudgetPerPersonPerDay} contacts per person per day. An organization can ask for fewer, never more.`,
    )
  }
  if (hours < current.ceiling.noSurprisesReviewHours) {
    throw new ValidationError(
      `This organization's jurisdiction profile requires at least ${current.ceiling.noSurprisesReviewHours}h for somebody ` +
        'to answer before anything about them goes past them. An organization can give longer, never less.',
    )
  }

  await ctx.sql`
    INSERT INTO monitoring_policies (
      organization_id, jurisdiction_profile, nudge_budget_per_person_per_day,
      no_surprises_review_hours, agent_recertification_days, reason, set_by, set_at, created_by
    ) VALUES (
      ${ctx.organizationId}, ${current.jurisdictionProfile}, ${budget}, ${hours}, ${recertDays},
      ${input.reason.trim()}, ${actor.userId}, now(), ${ctx.userId}
    )
    ON CONFLICT (organization_id) WHERE deleted_at IS NULL
    DO UPDATE SET jurisdiction_profile = EXCLUDED.jurisdiction_profile,
                  nudge_budget_per_person_per_day = EXCLUDED.nudge_budget_per_person_per_day,
                  no_surprises_review_hours = EXCLUDED.no_surprises_review_hours,
                  agent_recertification_days = EXCLUDED.agent_recertification_days,
                  reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = now(),
                  updated_at = now()`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'monitoring_policy.set',
    entityType: 'settings',
    entityId: ctx.organizationId,
    before: {
      nudgeBudgetPerPersonPerDay: current.nudgeBudgetPerPersonPerDay,
      noSurprisesReviewHours: current.noSurprisesReviewHours,
    },
    after: { nudgeBudgetPerPersonPerDay: budget, noSurprisesReviewHours: hours, reason: input.reason.trim() },
  })

  return monitoringPolicy(ctx)
}

export interface AgentGrantView {
  id: string
  capability: string
  toolPattern: string
  effect: 'allow' | 'deny'
  maxSensitivity: Sensitivity
  departmentId: string | null
  departmentName: string | null
  reason: string | null
  grantedByName: string | null
  grantedAt: Date
}

export async function agentGrants(ctx: TenantContext, actor: Actor): Promise<AgentGrantView[]> {
  const decision = can(actor, 'settings:read', { type: 'settings', organizationId: ctx.organizationId })
  if (!decision.allow) throw new PermissionError(decision.reason)

  return ctx.sql<AgentGrantView[]>`
    SELECT p.id, p.capability, p.tool_pattern AS "toolPattern", p.effect,
           p.max_sensitivity AS "maxSensitivity", p.department_id AS "departmentId",
           d.name AS "departmentName", p.reason,
           (SELECT u.name FROM users u WHERE u.id = p.granted_by) AS "grantedByName",
           p.granted_at AS "grantedAt"
    FROM agent_permissions p
    LEFT JOIN departments d ON d.id = p.department_id
    WHERE p.organization_id = ${ctx.organizationId} AND p.deleted_at IS NULL
    ORDER BY p.effect DESC, p.capability, p.tool_pattern`
}

export interface SetGrantInput {
  capability: string
  toolPattern: string
  effect: 'allow' | 'deny'
  maxSensitivity?: Sensitivity
  departmentId?: string | null
  reason: string
}

/**
 * Sets one line of the organization's ceiling on agents.
 *
 * Step-up, like an approval policy (§4.1): this decides what every agent in the company may
 * do, and the moment to check that the person at the keyboard is still the admin is before
 * the change, not after it.
 *
 * An `allow` line is a widening and a `deny` line is a narrowing, and **deny wins** wherever
 * both match. That rule is what makes the column mean anything — `asAgent` filtered for
 * 'allow' and dropped everything else, so a deny row had never denied a thing.
 */
export async function setAgentGrant(
  ctx: TenantContext,
  actor: Actor,
  input: SetGrantInput,
): Promise<AgentGrantView[]> {
  const decision = can(actor, 'settings:update', {
    type: 'settings',
    organizationId: ctx.organizationId,
    riskTier: 'high',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
  assertSteppedUp(actor, 'agent_grant.set')

  const capability = input.capability.trim()
  const toolPattern = input.toolPattern.trim()
  if (!/^[a-z_:]{2,40}$/.test(capability)) {
    throw new ValidationError('A capability is a lower-case name like `email`, `crm` or `execute:low`.')
  }
  // A *permission* pattern, despite the column's name: the matcher splits on ':' and
  // compares the halves to the resource and the verb. The seed wrote tool names here, which
  // parse as a resource nothing is called and so matched nothing at all.
  if (!/^(\*|[a-z_]{2,30}:(\*|[a-z_]{2,30}))$/.test(toolPattern)) {
    throw new ValidationError('A pattern looks like `email:send`, `crm:*`, or `*` — a resource and a verb, not a tool name.')
  }
  if (input.reason.trim().length < 4) {
    throw new ValidationError('Say why an agent may — or may not — do this.')
  }

  await ctx.sql`
    INSERT INTO agent_permissions (
      organization_id, department_id, capability, tool_pattern, effect, max_sensitivity,
      reason, granted_by, granted_at, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.departmentId ?? null}, ${capability}, ${toolPattern},
      ${input.effect}, ${input.maxSensitivity ?? 'internal'}::sw_sensitivity,
      ${input.reason.trim()}, ${actor.userId}, now(), ${ctx.userId}
    )
    ON CONFLICT (organization_id, coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid), capability, tool_pattern)
      WHERE deleted_at IS NULL
    DO UPDATE SET effect = EXCLUDED.effect, max_sensitivity = EXCLUDED.max_sensitivity,
                  reason = EXCLUDED.reason, granted_by = EXCLUDED.granted_by,
                  granted_at = now(), updated_at = now()`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'agent_grant.set',
    entityType: 'settings',
    entityId: ctx.organizationId,
    after: {
      capability,
      toolPattern,
      effect: input.effect,
      maxSensitivity: input.maxSensitivity ?? 'internal',
      department: input.departmentId ?? 'all',
      reason: input.reason.trim(),
    },
  })

  return agentGrants(ctx, actor)
}

/** Removes a line. Taking a grant away is a narrowing, and still asks who is at the keyboard. */
export async function removeAgentGrant(
  ctx: TenantContext,
  actor: Actor,
  input: { id: string; reason: string },
): Promise<AgentGrantView[]> {
  const decision = can(actor, 'settings:update', {
    type: 'settings',
    organizationId: ctx.organizationId,
    riskTier: 'high',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
  assertSteppedUp(actor, 'agent_grant.set')
  if (input.reason.trim().length < 4) throw new ValidationError('Say why it is being removed.')

  const [removed] = await ctx.sql<{ capability: string; toolPattern: string; effect: string }[]>`
    UPDATE agent_permissions SET deleted_at = now(), updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.id} AND deleted_at IS NULL
    RETURNING capability, tool_pattern AS "toolPattern", effect`
  if (!removed) throw new NotFoundError()

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'agent_grant.removed',
    entityType: 'settings',
    entityId: ctx.organizationId,
    before: { ...removed },
    after: { reason: input.reason.trim() },
  })

  return agentGrants(ctx, actor)
}
