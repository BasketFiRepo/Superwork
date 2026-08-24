import { DEFAULT_PLAN_LIMITS, type PlanLimits, type PlanTier } from '@superwork/config'
import type { TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { PermissionError, ValidationError } from './errors.js'
import { writeAudit } from './audit.js'

/**
 * The plan a company is on (§19).
 *
 * Three statements of it, agreeing with each other by luck.
 *
 *   • `plan_limits` — seeded from `DEFAULT_PLAN_LIMITS` and read by nothing, while the
 *     config module's own comment says *"the database is the source of truth at runtime so
 *     limits can be changed without a deploy"*. `checkSpendLimits` read the constant, so a
 *     limit could not be changed without a deploy — the precise opposite of the promise;
 *   • `subscriptions` — a tier, a seat count and an AI spend cap per organization, read by
 *     nothing, so neither the seats nor the organization's own cap did anything;
 *   • `organizations.plan_tier` — the one the runtime actually read, with nothing keeping it
 *     in step with the subscription's tier.
 *
 * The sharpest consequence was the refusal. On hitting the cap the agent stops and says
 * *"An admin can raise the cap in Settings → Billing"* — and there was no such control on
 * that screen. A refusal that points at a setting which does not exist is worse than a
 * plain no.
 *
 * So: one resolved answer, from the database, and an organization may **tighten** its own
 * limits but never raise them above what the plan allows. That is the same rule as an
 * approval policy (ADR 0026), for the same reason — a limit a tenant can raise on its own
 * is not a limit.
 */

export interface EffectiveLimits extends PlanLimits {
  /** True when this organization has tightened a cap below its plan's. */
  tightened: boolean
  /** Where each number came from, so the screen can say rather than imply. */
  source: {
    tier: 'subscription' | 'organization'
    limits: 'database' | 'built-in defaults'
    aiSpendCap: 'plan' | 'this organization'
    perUserDailyCap: 'plan' | 'this organization'
  }
}

export interface SubscriptionView {
  tier: PlanTier
  status: string
  seatsPurchased: number
  seatsUsed: number
  seatsRemaining: number | null
  periodStart: Date | null
  periodEnd: Date | null
  capsReason: string | null
  capsSetByName: string | null
  capsSetAt: Date | null
  /** Who last changed the plan itself, when and why — the same shape the caps use (ADR 0086). */
  planChangeReason: string | null
  planChangedByName: string | null
  planChangedAt: Date | null
  /** What the billing system called the last change. Recorded and shown, never parsed. */
  providerReference: string | null
  /** What the plan's limits are being measured against, so a screen can show where it is. */
  usage: PlanUsage
  limits: EffectiveLimits
  /**
   * The plan's own caps, before this organization tightened anything — so a screen can show
   * what was tightened *from*. Resolved the same way as the limits themselves: reading the
   * config constant here would reintroduce the bug this module exists to fix.
   */
  planCaps: { aiSpendCapCents: number | null; perUserDailySpendCapCents: number | null }
}

interface Row {
  tier: PlanTier
  status: string
  seatsPurchased: number
  aiSpendCapCents: number | null
  perUserDailyCapCents: number | null
  periodStart: Date | null
  periodEnd: Date | null
  capsReason: string | null
  capsSetByName: string | null
  capsSetAt: Date | null
  planChangeReason: string | null
  planChangedByName: string | null
  planChangedAt: Date | null
  providerReference: string | null
}

/**
 * The limits in force, resolved once.
 *
 * A missing `plan_limits` row falls back to the built-in defaults rather than to no limit —
 * a table that has not been seeded should not silently uncap an organization — and the
 * result says which of the two it used.
 */
export async function effectiveLimits(ctx: TenantContext): Promise<EffectiveLimits> {
  const row = await subscriptionRow(ctx)
  const tier = row?.tier ?? (await organizationTier(ctx))

  const [stored] = await ctx.sql<
    {
      seats: number | null
      agentRunsPerMonth: number | null
      aiSpendCapCents: number | null
      perUserDailySpendCapCents: number | null
      documentsIndexed: number | null
      storageGb: number | null
      workflowRunsPerMonth: number | null
      autopilotAllowed: boolean
    }[]
  >`
    SELECT seats, agent_runs_per_month AS "agentRunsPerMonth",
           ai_spend_cap_cents AS "aiSpendCapCents",
           per_user_daily_spend_cap_cents AS "perUserDailySpendCapCents",
           documents_indexed AS "documentsIndexed", storage_gb AS "storageGb",
           workflow_runs_per_month AS "workflowRunsPerMonth",
           autopilot_allowed AS "autopilotAllowed"
    FROM plan_limits WHERE tier = ${tier}::sw_plan_tier`

  const plan: PlanLimits = stored ? { tier, ...stored } : DEFAULT_PLAN_LIMITS[tier]

  // An organization may only tighten. `tighter` treats null as "no limit", so a plan with
  // no cap can be given one and a plan with a cap can never have it raised.
  const aiSpendCapCents = tighter(plan.aiSpendCapCents, row?.aiSpendCapCents ?? null)
  const perUserDailySpendCapCents = tighter(plan.perUserDailySpendCapCents, row?.perUserDailyCapCents ?? null)

  return {
    ...plan,
    aiSpendCapCents,
    perUserDailySpendCapCents,
    tightened:
      aiSpendCapCents !== plan.aiSpendCapCents || perUserDailySpendCapCents !== plan.perUserDailySpendCapCents,
    source: {
      tier: row ? 'subscription' : 'organization',
      limits: stored ? 'database' : 'built-in defaults',
      aiSpendCap: aiSpendCapCents !== plan.aiSpendCapCents ? 'this organization' : 'plan',
      perUserDailyCap:
        perUserDailySpendCapCents !== plan.perUserDailySpendCapCents ? 'this organization' : 'plan',
    },
  }
}

/** The stricter of a plan limit and an organization's own. `null` means "no limit". */
export function tighter(plan: number | null, own: number | null): number | null {
  if (own === null) return plan
  if (plan === null) return own
  return Math.min(plan, own)
}

export async function subscription(ctx: TenantContext, actor: Actor): Promise<SubscriptionView> {
  const decision = can(actor, 'billing:read', { type: 'billing', organizationId: ctx.organizationId })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const row = await subscriptionRow(ctx)
  const limits = await effectiveLimits(ctx)
  const plan = await planLimitsFor(ctx)
  // One read of what the limits are measured against, used for both the seat line and the four
  // limits the plan now actually stops (ADR 0086).
  const usage = await planUsage(ctx)
  const seatsUsed = usage.seatsUsed
  const seatsPurchased = row?.seatsPurchased ?? limits.seats ?? 0

  return {
    tier: row?.tier ?? (await organizationTier(ctx)),
    status: row?.status ?? 'active',
    seatsPurchased,
    seatsUsed,
    // A plan with unlimited seats and no subscription row has no seat ceiling to report.
    seatsRemaining: row || limits.seats !== null ? Math.max(0, seatsPurchased - seatsUsed) : null,
    periodStart: row?.periodStart ?? null,
    periodEnd: row?.periodEnd ?? null,
    capsReason: row?.capsReason ?? null,
    capsSetByName: row?.capsSetByName ?? null,
    capsSetAt: row?.capsSetAt ?? null,
    planChangeReason: row?.planChangeReason ?? null,
    planChangedByName: row?.planChangedByName ?? null,
    planChangedAt: row?.planChangedAt ?? null,
    providerReference: row?.providerReference ?? null,
    usage,
    limits,
    planCaps: {
      aiSpendCapCents: plan.aiSpendCapCents,
      perUserDailySpendCapCents: plan.perUserDailySpendCapCents,
    },
  }
}

/**
 * Seats in use: active memberships plus invitations still outstanding.
 *
 * An open invitation holds a seat. Counting only accepted ones lets an administrator invite
 * a hundred people onto twenty-five seats and discover the problem when they arrive.
 */
export async function seatsInUse(ctx: TenantContext): Promise<number> {
  const [row] = await ctx.sql<{ used: number }[]>`
    SELECT (
      (SELECT count(*) FROM memberships
        WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL AND status = 'active')
      +
      (SELECT count(*) FROM invitations
        WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
          AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now())
    )::int AS used`
  return row?.used ?? 0
}

/**
 * Whether one more person can be let in, and what to say when they cannot.
 *
 * Seats are a hard limit rather than a soft one: an organization bought a number. The
 * refusal names the number and what is using it, because "no seats" with no arithmetic is
 * a support ticket.
 */
export async function seatCheck(ctx: TenantContext): Promise<{ allow: boolean; reason: string }> {
  const row = await subscriptionRow(ctx)
  const limits = await effectiveLimits(ctx)
  const purchased = row?.seatsPurchased ?? limits.seats
  if (purchased === null || purchased === undefined) return { allow: true, reason: 'This plan has no seat limit.' }

  const used = await seatsInUse(ctx)
  if (used < purchased) {
    return { allow: true, reason: `${purchased - used} of ${purchased} seats free.` }
  }
  return {
    allow: false,
    reason:
      `All ${purchased} seats are taken — ${used} in use, counting invitations that have not been accepted yet. ` +
      'Withdraw an outstanding invitation, deactivate somebody who has left, or buy more seats.',
  }
}

/**
 * An organization tightening its own caps.
 *
 * There is no way to raise one above the plan, and no self-serve tier change: what a company
 * pays for is a commercial agreement rather than a setting, and a button that appeared to
 * change it would be the fake integration §25 forbids.
 */
export async function setOrganizationCaps(
  ctx: TenantContext,
  actor: Actor,
  input: { aiSpendCapCents: number | null; perUserDailyCapCents: number | null; reason: string },
): Promise<SubscriptionView> {
  const decision = can(actor, 'settings:update', {
    type: 'settings',
    organizationId: ctx.organizationId,
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
  if (!input.reason?.trim()) {
    throw new ValidationError('Say why. The agent stops when a cap is reached, and somebody will ask who set it.')
  }

  const limits = await effectiveLimits(ctx)
  const planCap = (await planLimitsFor(ctx)).aiSpendCapCents
  const planUserCap = (await planLimitsFor(ctx)).perUserDailySpendCapCents

  for (const [value, ceiling, label] of [
    [input.aiSpendCapCents, planCap, 'monthly AI spend cap'],
    [input.perUserDailyCapCents, planUserCap, 'per-person daily cap'],
  ] as const) {
    if (value === null) continue
    if (value < 0 || !Number.isInteger(value)) {
      throw new ValidationError(`The ${label} must be a whole number of cents, or empty for the plan's own.`)
    }
    if (ceiling !== null && value > ceiling) {
      throw new ValidationError(
        `The ${label} cannot be raised above the plan's ${(ceiling / 100).toFixed(2)}. An organization may tighten its limits, never widen them — changing the plan is a commercial change, not a setting.`,
      )
    }
  }

  const before = { ai: limits.aiSpendCapCents, perUser: limits.perUserDailySpendCapCents }

  await ctx.sql`
    INSERT INTO subscriptions (
      organization_id, tier, ai_spend_cap_cents, per_user_daily_cap_cents,
      caps_reason, caps_set_by, caps_set_at, created_by
    ) VALUES (
      ${ctx.organizationId}, ${await organizationTier(ctx)}::sw_plan_tier,
      ${input.aiSpendCapCents}, ${input.perUserDailyCapCents},
      ${input.reason.trim()}, ${actor.userId}, now(), ${ctx.userId}
    )
    ON CONFLICT (organization_id) WHERE deleted_at IS NULL
    DO UPDATE SET
      ai_spend_cap_cents = EXCLUDED.ai_spend_cap_cents,
      per_user_daily_cap_cents = EXCLUDED.per_user_daily_cap_cents,
      caps_reason = EXCLUDED.caps_reason,
      caps_set_by = EXCLUDED.caps_set_by,
      caps_set_at = EXCLUDED.caps_set_at,
      updated_at = now()`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'billing.caps_set',
    entityType: 'subscription',
    entityId: null,
    before: { aiSpendCapCents: before.ai, perUserDailyCapCents: before.perUser },
    after: {
      aiSpendCapCents: input.aiSpendCapCents,
      perUserDailyCapCents: input.perUserDailyCapCents,
      reason: input.reason.trim(),
    },
  })

  return subscription(ctx, actor)
}

async function planLimitsFor(ctx: TenantContext): Promise<PlanLimits> {
  const tier = (await subscriptionRow(ctx))?.tier ?? (await organizationTier(ctx))
  const [stored] = await ctx.sql<{ aiSpendCapCents: number | null; perUserDailySpendCapCents: number | null }[]>`
    SELECT ai_spend_cap_cents AS "aiSpendCapCents",
           per_user_daily_spend_cap_cents AS "perUserDailySpendCapCents"
    FROM plan_limits WHERE tier = ${tier}::sw_plan_tier`
  return stored ? { ...DEFAULT_PLAN_LIMITS[tier], ...stored } : DEFAULT_PLAN_LIMITS[tier]
}

async function subscriptionRow(ctx: TenantContext): Promise<Row | null> {
  const [row] = await ctx.sql<Row[]>`
    SELECT s.tier, s.status, s.seats_purchased AS "seatsPurchased",
           s.ai_spend_cap_cents AS "aiSpendCapCents",
           s.per_user_daily_cap_cents AS "perUserDailyCapCents",
           s.period_start AS "periodStart", s.period_end AS "periodEnd",
           s.caps_reason AS "capsReason", u.name AS "capsSetByName", s.caps_set_at AS "capsSetAt",
           s.plan_change_reason AS "planChangeReason", p.name AS "planChangedByName",
           s.plan_changed_at AS "planChangedAt", s.provider_reference AS "providerReference"
    FROM subscriptions s
    LEFT JOIN users u ON u.id = s.caps_set_by
    LEFT JOIN users p ON p.id = s.plan_changed_by
    WHERE s.organization_id = ${ctx.organizationId} AND s.deleted_at IS NULL`
  return row ?? null
}

async function organizationTier(ctx: TenantContext): Promise<PlanTier> {
  const [row] = await ctx.sql<{ tier: PlanTier }[]>`
    SELECT plan_tier AS tier FROM organizations WHERE id = ${ctx.organizationId}`
  return row?.tier ?? 'free'
}

/**
 * What the plan's limits are being measured against, right now (ADR 0086).
 *
 * Four of these numbers had a limit on the plan, a row in `plan_limits`, a line on the billing
 * screen — and no reader anywhere. `agent_runs_per_month`, `documents_indexed`, `storage_gb` and
 * `workflow_runs_per_month` were resolved, displayed, and enforced by nothing, so every tier
 * allowed exactly what every other tier allowed and changing plan changed nothing but a word.
 *
 * Two are a **stock** and two are a **flow**, and the difference is not cosmetic: documents and
 * bytes are what the organization is holding at this moment, so the limit says how much may be
 * held; runs are what it did this month, so the limit says how many may be started. Counting a
 * stock per month would let somebody index a million documents in twelve batches.
 *
 * Counted from the rows themselves rather than from `usage_records`, because retention deletes
 * usage records on a schedule (§21) and a limit that quietly rises when the meter is pruned is
 * not a limit.
 */
export interface PlanUsage {
  seatsUsed: number
  agentRunsThisMonth: number
  workflowRunsThisMonth: number
  documentsIndexed: number
  storageBytes: number
}

export async function planUsage(ctx: TenantContext): Promise<PlanUsage> {
  const [row] = await ctx.sql<
    {
      agentRuns: string
      workflowRuns: string
      documents: string
      storageBytes: string
    }[]
  >`
    SELECT
      (SELECT count(*) FROM agent_runs
        WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
          AND created_at >= date_trunc('month', now()))::text AS "agentRuns",
      -- A dry run is excluded on purpose. Activation is refused until one has passed (ADR 0012),
      -- so charging the plan for the safety step teaches people to skip it.
      (SELECT count(*) FROM workflow_runs
        WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
          AND simulated = false AND started_at >= date_trunc('month', now()))::text AS "workflowRuns",
      (SELECT count(*) FROM documents
        WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
          AND index_status = 'indexed')::text AS "documents",
      (SELECT coalesce(sum(file_bytes), 0) FROM documents
        WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
          AND storage_key IS NOT NULL)::text AS "storageBytes"`

  return {
    seatsUsed: await seatsInUse(ctx),
    agentRunsThisMonth: Number(row?.agentRuns ?? 0),
    workflowRunsThisMonth: Number(row?.workflowRuns ?? 0),
    documentsIndexed: Number(row?.documents ?? 0),
    storageBytes: Number(row?.storageBytes ?? 0),
  }
}

/** The things a plan actually stops. One name per limit, so a refusal can be traced to a row. */
export type PlanAllowanceUnit = 'agent_run' | 'workflow_run' | 'document' | 'storage'

export interface PlanAllowance {
  allow: boolean
  reason: string
  used: number
  limit: number | null
}

const BYTES_PER_GB = 1024 * 1024 * 1024

/**
 * Whether the plan allows one more of something, and what to say when it does not.
 *
 * The refusal names the arithmetic and the way out, the same shape `seatCheck` takes: a limit
 * quoted without the number it was measured against is a support ticket.
 *
 * It also answers for the *subscription*, not only the plan. A period that has ended on a plan
 * somebody cancelled stops new work here rather than waiting for the worker's renewal sweep to
 * write the change — a read that depends on a sweep having run is a limit that is off whenever
 * the worker is.
 */
export async function planAllowance(
  ctx: TenantContext,
  unit: PlanAllowanceUnit,
  add = 1,
  now = new Date(),
): Promise<PlanAllowance> {
  const row = await subscriptionRow(ctx)
  const limits = await effectiveLimits(ctx)

  if (row && row.status === 'cancelled' && row.periodEnd && row.periodEnd.getTime() <= now.getTime()) {
    return {
      allow: false,
      used: 0,
      limit: 0,
      reason:
        `This organization's plan ended on ${row.periodEnd.toISOString().slice(0, 10)}. Nothing has been ` +
        'deleted and everything already here can still be read — starting new work needs a plan, in ' +
        'Settings → Billing.',
    }
  }
  if (row && row.status === 'past_due') {
    return {
      allow: false,
      used: 0,
      limit: 0,
      reason:
        'The last payment for this plan did not go through, so new work is stopped rather than run ' +
        'up on an unpaid account. Nothing has been deleted. Settings → Billing says what failed.',
    }
  }

  const [limit, what, remedy] = ({
    agent_run: [
      limits.agentRunsPerMonth,
      'agent runs a month',
      'The count resets on the first of the month, or a larger plan raises it.',
    ],
    workflow_run: [
      limits.workflowRunsPerMonth,
      'workflow runs a month',
      'The count resets on the first of the month, or a larger plan raises it. Dry runs are not counted.',
    ],
    document: [
      limits.documentsIndexed,
      'documents indexed',
      'Delete a document that is no longer true, or move to a larger plan.',
    ],
    storage: [
      limits.storageGb === null ? null : limits.storageGb * BYTES_PER_GB,
      'of files kept',
      'Delete a document that carries a file, or move to a larger plan.',
    ],
  } as Record<PlanAllowanceUnit, [number | null, string, string]>)[unit]

  // A plan with no limit on this is not asked what the count is. This runs on the way into every
  // agent run, so counting the other three to answer about one would put three queries on the
  // §26.9 budgets to reach an answer nothing was going to read.
  if (limit === null) return { allow: true, reason: `This plan has no limit on ${what}.`, used: 0, limit }
  const used = await usedFor(ctx, unit)

  // Bytes are read out as bytes; everything else is a count. A limit quoted in a unit nobody
  // thinks in is one nobody can act on.
  const measure = unit === 'storage' ? formatBytes : (value: number) => value.toLocaleString('en-GB')

  if (used + add <= limit) {
    return { allow: true, reason: `${measure(used + add)} of ${measure(limit)} ${what}.`, used, limit }
  }
  return {
    allow: false,
    used,
    limit,
    reason:
      `The ${limits.tier} plan allows ${measure(limit)} ${what}, and this organization is at ` +
      `${measure(used)}. ${remedy}`,
  }
}

/** One number, for the one limit being asked about. `planUsage` is the whole picture, for a screen. */
async function usedFor(ctx: TenantContext, unit: PlanAllowanceUnit): Promise<number> {
  if (unit === 'agent_run') {
    const [row] = await ctx.sql<{ used: string }[]>`
      SELECT count(*)::text AS used FROM agent_runs
      WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
        AND created_at >= date_trunc('month', now())`
    return Number(row?.used ?? 0)
  }
  if (unit === 'workflow_run') {
    const [row] = await ctx.sql<{ used: string }[]>`
      SELECT count(*)::text AS used FROM workflow_runs
      WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
        AND simulated = false AND started_at >= date_trunc('month', now())`
    return Number(row?.used ?? 0)
  }
  if (unit === 'document') {
    const [row] = await ctx.sql<{ used: string }[]>`
      SELECT count(*)::text AS used FROM documents
      WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL AND index_status = 'indexed'`
    return Number(row?.used ?? 0)
  }
  const [row] = await ctx.sql<{ used: string }[]>`
    SELECT coalesce(sum(file_bytes), 0)::text AS used FROM documents
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL AND storage_key IS NOT NULL`
  return Number(row?.used ?? 0)
}

function formatBytes(bytes: number): string {
  if (bytes >= BYTES_PER_GB) return `${(bytes / BYTES_PER_GB).toFixed(1)}GB`
  return `${Math.round(bytes / 1024 / 1024)}MB`
}
