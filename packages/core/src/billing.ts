import { DEFAULT_PLAN_LIMITS, type PlanLimits, type PlanTier } from '@superwork/config'
import type { TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { PermissionError, ValidationError } from './errors.js'
import { writeAudit } from './audit.js'
import { notify } from './notify.js'
import { assertSteppedUp } from './step-up.js'
import { organizationCurrency, formatCents } from './metering.js'
import { planUsage, subscription, type SubscriptionView } from './subscription.js'

/**
 * What the company pays for, changed by the company (§19, ADR 0086).
 *
 * `subscriptions.tier`, `seats_purchased`, `status` and `period_end` were read by the runtime and
 * written by the seed or by nothing at all. An organization was on the plan the seed gave it, for
 * ever; `seatCheck` refused the twenty-sixth invitation with "buy more seats" and there was
 * nowhere to buy one; and `status` and the renewal date were shown on a screen that could not
 * produce either.
 *
 * The rule this file keeps is the one `setOrganizationCaps` states next door: **an organization
 * may tighten its own limits and never widen them past the plan.** Changing the plan is how the
 * ceiling moves, and it is a different act — it costs money, it is asked of a person rather than
 * an agent, and it is recorded with a reason. So it lives here rather than beside the caps.
 *
 * ### What Superwork does not do
 *
 * It does not take payments. It holds the *consequence* of one — a tier, a seat count, a period,
 * a status — and asks a `BillingProvider` the three questions only a billing system can answer:
 * what would this cost, did it go through, did the period renew. In `mock` mode the answers are
 * deterministic and locally generated, and every figure derived from them is badged **Simulated**,
 * exactly as an admin-authored HTTP tool's response is. Nothing about the permission, the seat
 * arithmetic, the refusals or the audit trail is simulated.
 *
 * The provider is passed in rather than imported, the same shape `attachFile` takes for storage:
 * it keeps this file out of `@superwork/integrations` and lets a test hand in one that declines.
 *
 * ### What `plan_limits` is
 *
 * The price list, not a setting. It has no `organization_id` — one row per tier, shared by every
 * tenant in the installation — so a write from inside one organization would reprice all of them.
 * A tenant picks a row from it; nothing here writes one.
 */

/** Weakest first. A change's direction is the difference between two positions in this list. */
export const PLAN_LADDER: PlanTier[] = ['free', 'team', 'business', 'enterprise']

export interface BillingProviderLike {
  readonly mode: 'mock' | 'sandbox' | 'live'
  quote(input: { tier: string; seats: number; currency: string }): Promise<{
    amountCents: number
    currency: string
    periodDays: number
    description: string
  }>
  commit(input: { tier: string; seats: number; currency: string; idempotencyKey: string }): Promise<{
    reference: string
    periodStart: Date
    periodEnd: Date
    status: 'active' | 'trialing'
  }>
  renew(input: {
    tier: string
    seats: number
    currency: string
    reference: string | null
    idempotencyKey: string
  }): Promise<{
    paid: boolean
    reference: string | null
    periodStart: Date
    periodEnd: Date
    declineReason?: string
  }>
}

export interface PlanChangeInput {
  /** Omitted means "the tier this organization is already on" — a seats-only change. */
  tier?: PlanTier
  /** Omitted means "the seats already purchased". */
  seats?: number
  reason: string
}

export interface PlanChangePreview {
  from: { tier: PlanTier; seats: number; status: string; periodEnd: Date | null }
  to: { tier: PlanTier; seats: number }
  direction: 'upgrade' | 'downgrade' | 'seats' | 'unchanged'
  /** What the billing system says the period would cost. `simulated` when nothing was charged. */
  quote: { amountCents: number; currency: string; periodDays: number; description: string; simulated: boolean }
  seats: { used: number; after: number; ceiling: number | null }
  /** What the new plan allows that this one does not. */
  gains: string[]
  /** What would stop working, in the words the refusal would use. Never silent. */
  losses: string[]
  /** Why this cannot be committed. Empty means it can. */
  blockers: string[]
}

const BYTES_PER_GB = 1024 * 1024 * 1024

/** The tiers, as the screen offers them. Read from the catalogue, never from the constant. */
export async function planCatalogue(ctx: TenantContext): Promise<PlanLimits[]> {
  const rows = await ctx.sql<
    {
      tier: PlanTier
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
    SELECT tier, seats, agent_runs_per_month AS "agentRunsPerMonth",
           ai_spend_cap_cents AS "aiSpendCapCents",
           per_user_daily_spend_cap_cents AS "perUserDailySpendCapCents",
           documents_indexed AS "documentsIndexed", storage_gb AS "storageGb",
           workflow_runs_per_month AS "workflowRunsPerMonth",
           autopilot_allowed AS "autopilotAllowed"
    FROM plan_limits`

  // A catalogue that has not been seeded falls back to the built-in defaults rather than to an
  // empty screen — the same direction `effectiveLimits` falls in, for the same reason.
  const stored = new Map(rows.map((row) => [row.tier, row]))
  return PLAN_LADDER.map((tier) => {
    const row = stored.get(tier)
    return row ? { ...DEFAULT_PLAN_LIMITS[tier], ...row } : DEFAULT_PLAN_LIMITS[tier]
  })
}

interface CurrentPlan {
  tier: PlanTier
  seats: number
  status: string
  periodStart: Date | null
  periodEnd: Date | null
  providerReference: string | null
  exists: boolean
}

async function currentPlan(ctx: TenantContext): Promise<CurrentPlan> {
  const [row] = await ctx.sql<
    {
      tier: PlanTier
      seatsPurchased: number
      status: string
      periodStart: Date | null
      periodEnd: Date | null
      providerReference: string | null
    }[]
  >`
    SELECT tier, seats_purchased AS "seatsPurchased", status,
           period_start AS "periodStart", period_end AS "periodEnd",
           provider_reference AS "providerReference"
    FROM subscriptions
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL`
  if (row) {
    return {
      tier: row.tier,
      seats: row.seatsPurchased,
      status: row.status,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      providerReference: row.providerReference,
      exists: true,
    }
  }

  // No subscription row: the organization is on whatever `organizations.plan_tier` says, which is
  // where the tier lived before ADR 0030 and is still what the trigger keeps in step.
  const [org] = await ctx.sql<{ tier: PlanTier }[]>`
    SELECT plan_tier AS tier FROM organizations WHERE id = ${ctx.organizationId}`
  const tier = org?.tier ?? 'free'
  return {
    tier,
    seats: DEFAULT_PLAN_LIMITS[tier].seats ?? 1,
    status: 'active',
    periodStart: null,
    periodEnd: null,
    providerReference: null,
    exists: false,
  }
}

/**
 * What a change would do, before anybody is charged for it.
 *
 * Reading takes `billing:read`, the same permission the screen already asks for: knowing what an
 * upgrade would cost is not the same act as buying one, and making somebody commit to find out is
 * how a product gets accidental purchases.
 */
export async function previewPlanChange(
  ctx: TenantContext,
  actor: Actor,
  input: { tier?: PlanTier; seats?: number },
  provider: BillingProviderLike,
): Promise<PlanChangePreview> {
  const decision = can(actor, 'billing:read', { type: 'billing', organizationId: ctx.organizationId })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const current = await currentPlan(ctx)
  const tier = input.tier ?? current.tier
  if (!PLAN_LADDER.includes(tier)) {
    throw new ValidationError(`"${tier}" is not one of the plans: ${PLAN_LADDER.join(', ')}.`)
  }

  const catalogue = await planCatalogue(ctx)
  const to = catalogue.find((plan) => plan.tier === tier)!
  const from = catalogue.find((plan) => plan.tier === current.tier)!

  // Seats default to what the plan includes when moving tier, and to what is already purchased
  // when staying on one — a tier change that silently kept a seat count the new plan does not
  // allow would be refused a moment later with arithmetic nobody asked for.
  const requestedSeats = input.seats ?? (tier === current.tier ? current.seats : (to.seats ?? current.seats))
  const seats = Math.trunc(requestedSeats)
  const usage = await planUsage(ctx)
  const currency = await organizationCurrency(ctx)
  const quote = await provider.quote({ tier, seats, currency })

  const direction: PlanChangePreview['direction'] =
    tier === current.tier
      ? seats === current.seats
        ? 'unchanged'
        : 'seats'
      : PLAN_LADDER.indexOf(tier) > PLAN_LADDER.indexOf(current.tier)
        ? 'upgrade'
        : 'downgrade'

  const blockers: string[] = []
  if (!Number.isFinite(seats) || seats < 1) {
    blockers.push('A plan with no seats is not a plan: buy at least one.')
  } else if (seats < usage.seatsUsed) {
    blockers.push(
      `${usage.seatsUsed} seats are in use — people here plus invitations nobody has accepted yet — ` +
        `and this would buy ${seats}. Withdraw an invitation or deactivate somebody who has left first; ` +
        'Superwork will not deactivate anybody to fit a plan.',
    )
  }
  if (to.seats !== null && seats > to.seats) {
    blockers.push(`The ${tier} plan includes at most ${to.seats} seats. ${seats} needs a larger plan.`)
  }
  if (current.status === 'past_due' && PLAN_LADDER.indexOf(tier) > PLAN_LADDER.indexOf(current.tier)) {
    blockers.push(
      'The last payment for this plan has not gone through, so nothing larger can be bought until it ' +
        'has. Moving to a smaller plan, or cancelling, is not blocked.',
    )
  }

  return {
    from: { tier: current.tier, seats: current.seats, status: current.status, periodEnd: current.periodEnd },
    to: { tier, seats },
    direction,
    quote: {
      amountCents: quote.amountCents,
      currency: quote.currency,
      periodDays: quote.periodDays,
      description: quote.description,
      simulated: provider.mode === 'mock',
    },
    seats: { used: usage.seatsUsed, after: seats, ceiling: to.seats },
    gains: differences(from, to, 'gains'),
    losses: [...differences(from, to, 'losses'), ...alreadyOver(to, usage)],
    blockers,
  }
}

/**
 * Commits it.
 *
 * Three things have to be true before the provider is asked for money: the person may change what
 * the company pays for, they have re-authenticated, and they said why.
 *
 * **Step-up is asked in both directions here**, unlike every other action that asks for it. Those
 * have a safe direction — tightening a throttle, narrowing a grant, raising a classification — and
 * this one does not: spending more and stopping the service are both things a lifted cookie must
 * not be able to do on somebody's behalf.
 */
export async function changePlan(
  ctx: TenantContext,
  actor: Actor,
  input: PlanChangeInput,
  provider: BillingProviderLike,
): Promise<SubscriptionView> {
  const decision = can(actor, 'billing:update', {
    type: 'billing',
    organizationId: ctx.organizationId,
    riskTier: 'high',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
  if (!input.reason?.trim()) {
    throw new ValidationError('Say why. A plan change costs money, and somebody will ask who made it.')
  }
  assertSteppedUp(actor, 'billing.change')

  const preview = await previewPlanChange(ctx, actor, { tier: input.tier, seats: input.seats }, provider)
  if (preview.direction === 'unchanged') {
    throw new ValidationError('That is the plan this organization is already on, with the same number of seats.')
  }
  if (preview.blockers.length > 0) throw new ValidationError(preview.blockers.join(' '))

  const current = await currentPlan(ctx)
  const currency = await organizationCurrency(ctx)
  // Stable across a retry of the same intent and different for the next one, so a double-submit
  // cannot be charged twice and next month's change is not mistaken for this one.
  const idempotencyKey = [
    ctx.organizationId,
    preview.to.tier,
    preview.to.seats,
    current.periodStart?.toISOString() ?? 'first',
  ].join(':')

  const committed = await provider.commit({
    tier: preview.to.tier,
    seats: preview.to.seats,
    currency,
    idempotencyKey,
  })

  await ctx.sql`
    INSERT INTO subscriptions (
      organization_id, tier, seats_purchased, status, period_start, period_end,
      provider_reference, plan_changed_by, plan_changed_at, plan_change_reason, created_by
    ) VALUES (
      ${ctx.organizationId}, ${preview.to.tier}::sw_plan_tier, ${preview.to.seats}, ${committed.status},
      ${committed.periodStart}, ${committed.periodEnd}, ${committed.reference},
      ${actor.userId}, now(), ${input.reason.trim()}, ${ctx.userId}
    )
    ON CONFLICT (organization_id) WHERE deleted_at IS NULL
    DO UPDATE SET
      tier = EXCLUDED.tier,
      seats_purchased = EXCLUDED.seats_purchased,
      status = EXCLUDED.status,
      period_start = EXCLUDED.period_start,
      period_end = EXCLUDED.period_end,
      provider_reference = EXCLUDED.provider_reference,
      plan_changed_by = EXCLUDED.plan_changed_by,
      plan_changed_at = EXCLUDED.plan_changed_at,
      plan_change_reason = EXCLUDED.plan_change_reason,
      updated_at = now()`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'billing.plan_changed',
    entityType: 'subscription',
    entityId: null,
    before: { tier: preview.from.tier, seats: preview.from.seats, status: preview.from.status },
    after: {
      tier: preview.to.tier,
      seats: preview.to.seats,
      status: committed.status,
      direction: preview.direction,
      reason: input.reason.trim(),
      // What the organization gave up, recorded where it cannot be argued about later. A
      // downgrade that turned off autopilot is a fact somebody will want the date of.
      losses: preview.losses,
      amountCents: preview.quote.amountCents,
      currency: preview.quote.currency,
      simulated: preview.quote.simulated,
      providerReference: committed.reference,
    },
  })

  return subscription(ctx, actor)
}

/**
 * Cancelling ends the plan at the end of the period that has been paid for.
 *
 * Nothing is deleted and nothing stops today: the organization keeps what it bought until the date
 * it bought it to. A cancellation that took effect immediately would be Superwork keeping money for
 * a period it stopped serving.
 */
export async function cancelPlan(ctx: TenantContext, actor: Actor, reason: string): Promise<SubscriptionView> {
  const decision = can(actor, 'billing:update', {
    type: 'billing',
    organizationId: ctx.organizationId,
    riskTier: 'high',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
  if (!reason?.trim()) throw new ValidationError('Say why. Somebody will ask when the plan ends.')
  assertSteppedUp(actor, 'billing.change')

  const current = await currentPlan(ctx)
  if (!current.exists || current.tier === 'free') {
    throw new ValidationError('The free plan costs nothing and has nothing to cancel.')
  }
  if (current.status === 'cancelled') {
    throw new ValidationError('This plan is already set to end at the end of the period.')
  }

  await ctx.sql`
    UPDATE subscriptions
       SET status = 'cancelled', plan_changed_by = ${actor.userId}, plan_changed_at = now(),
           plan_change_reason = ${reason.trim()}, updated_at = now()
     WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'billing.cancelled',
    entityType: 'subscription',
    entityId: null,
    before: { tier: current.tier, status: current.status },
    after: { status: 'cancelled', endsAt: current.periodEnd, reason: reason.trim() },
  })

  return subscription(ctx, actor)
}

/**
 * Changing your mind inside the period you already paid for. The plan carries on where it was —
 * no new charge, because nothing was refunded when it was cancelled.
 *
 * Once the period has ended there is nothing to resume: that is a purchase, and it goes through
 * `changePlan` with everything a purchase asks for.
 */
export async function resumePlan(ctx: TenantContext, actor: Actor, reason: string): Promise<SubscriptionView> {
  const decision = can(actor, 'billing:update', {
    type: 'billing',
    organizationId: ctx.organizationId,
    riskTier: 'high',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
  if (!reason?.trim()) throw new ValidationError('Say why, so the change reads as a decision rather than a wobble.')
  assertSteppedUp(actor, 'billing.change')

  const current = await currentPlan(ctx)
  if (current.status !== 'cancelled') throw new ValidationError('This plan is not ending, so there is nothing to resume.')
  if (!current.periodEnd || current.periodEnd.getTime() <= Date.now()) {
    throw new ValidationError(
      'That period has already ended, so this would be a new purchase rather than a resumption. ' +
        'Choose a plan.',
    )
  }

  await ctx.sql`
    UPDATE subscriptions
       SET status = 'active', plan_changed_by = ${actor.userId}, plan_changed_at = now(),
           plan_change_reason = ${reason.trim()}, updated_at = now()
     WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'billing.resumed',
    entityType: 'subscription',
    entityId: null,
    before: { status: 'cancelled', endsAt: current.periodEnd },
    after: { status: 'active', reason: reason.trim() },
  })

  return subscription(ctx, actor)
}

export interface RenewalOutcome {
  action: 'renewed' | 'declined' | 'ended' | 'released'
  tier: PlanTier
  periodEnd: Date | null
  note: string
}

/**
 * The period that ended, swept by the worker (§19).
 *
 * `period_end` was a column nothing wrote and nothing acted on, so a subscription had no end and
 * no renewal — the date on the screen was whatever the seed happened to leave. This is the writer.
 *
 * Four endings, and each one is written down rather than left to be inferred:
 *
 *   • a plan somebody **cancelled** reaches its date and the organization drops to `free`. Nothing
 *     is deleted; what is held stays readable, and new work is what the free plan allows;
 *   • a plan that **renewed** gets its next period and the owner is told;
 *   • a payment that was **declined** puts the subscription in `past_due`, which stops new work,
 *     and the next attempt is a week out rather than every pass — retrying a declined card every
 *     minute is how a product gets its merchant account reviewed;
 *   • a `free` plan that somehow carries an end date has it **released**: free does not renew, and
 *     asking a billing system to charge nothing for it is a request nobody should have to explain.
 */
export async function renewDueSubscriptions(
  ctx: TenantContext,
  provider: BillingProviderLike,
  now = new Date(),
): Promise<RenewalOutcome | null> {
  const [row] = await ctx.sql<
    {
      id: string
      tier: PlanTier
      seatsPurchased: number
      status: string
      periodEnd: Date
      providerReference: string | null
    }[]
  >`
    SELECT id, tier, seats_purchased AS "seatsPurchased", status,
           period_end AS "periodEnd", provider_reference AS "providerReference"
    FROM subscriptions
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
      AND period_end IS NOT NULL AND period_end <= ${now}`
  if (!row) return null

  const owner = await ownerUserId(ctx)

  if (row.tier === 'free') {
    await ctx.sql`
      UPDATE subscriptions SET period_end = NULL, updated_at = now()
      WHERE organization_id = ${ctx.organizationId} AND id = ${row.id}`
    return { action: 'released', tier: 'free', periodEnd: null, note: 'The free plan does not renew.' }
  }

  if (row.status === 'cancelled') {
    const freeSeats = (await planCatalogue(ctx)).find((plan) => plan.tier === 'free')?.seats ?? 1
    // Never below what a subscription is allowed to hold: `seats_purchased > 0` is a constraint,
    // and dropping to zero seats to represent "ended" would be a state the schema refuses.
    const seats = Math.max(1, Math.min(row.seatsPurchased, freeSeats))
    await ctx.sql`
      UPDATE subscriptions
         SET tier = 'free'::sw_plan_tier, seats_purchased = ${seats}, status = 'active',
             period_start = ${now}, period_end = NULL, provider_reference = NULL, updated_at = now()
       WHERE organization_id = ${ctx.organizationId} AND id = ${row.id}`
    await writeAudit(ctx, {
      actorType: 'system',
      actorId: null,
      action: 'billing.plan_ended',
      entityType: 'subscription',
      entityId: row.id,
      before: { tier: row.tier, seats: row.seatsPurchased, status: 'cancelled' },
      after: { tier: 'free', seats, endedAt: row.periodEnd },
    })
    if (owner) {
      await notify(ctx, {
        userId: owner,
        type: 'billing',
        title: 'Your plan has ended',
        body:
          `The ${row.tier} plan you cancelled ran to the end of its period and this organization is now ` +
          'on Free. Nothing has been deleted. Settings → Billing has the plans.',
        entityType: 'subscription',
        entityId: row.id,
        url: '/settings/billing',
      })
    }
    return { action: 'ended', tier: 'free', periodEnd: null, note: `The ${row.tier} plan ended; now on free.` }
  }

  const currency = await organizationCurrency(ctx)
  const renewal = await provider.renew({
    tier: row.tier,
    seats: row.seatsPurchased,
    currency,
    reference: row.providerReference,
    // The period being renewed, so one period is never charged for twice however often the sweep
    // runs — the same promise the outbox keeps for a send.
    idempotencyKey: `${ctx.organizationId}:renew:${row.periodEnd.toISOString()}`,
  })

  if (!renewal.paid) {
    const retryAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
    await ctx.sql`
      UPDATE subscriptions
         SET status = 'past_due', period_end = ${retryAt}, updated_at = now()
       WHERE organization_id = ${ctx.organizationId} AND id = ${row.id}`
    await writeAudit(ctx, {
      actorType: 'system',
      actorId: null,
      action: 'billing.payment_declined',
      entityType: 'subscription',
      entityId: row.id,
      before: { status: row.status },
      after: { status: 'past_due', retryAt, reason: renewal.declineReason ?? null },
    })
    if (owner) {
      await notify(ctx, {
        userId: owner,
        type: 'billing',
        title: 'A payment did not go through',
        body:
          `${renewal.declineReason ?? 'The billing system declined the renewal.'} New agent and workflow ` +
          'runs are stopped until it is settled; nothing has been deleted.',
        entityType: 'subscription',
        entityId: row.id,
        url: '/settings/billing',
      })
    }
    return {
      action: 'declined',
      tier: row.tier,
      periodEnd: retryAt,
      note: renewal.declineReason ?? 'The renewal was declined.',
    }
  }

  await ctx.sql`
    UPDATE subscriptions
       SET status = 'active', period_start = ${renewal.periodStart}, period_end = ${renewal.periodEnd},
           provider_reference = ${renewal.reference}, updated_at = now()
     WHERE organization_id = ${ctx.organizationId} AND id = ${row.id}`
  await writeAudit(ctx, {
    actorType: 'system',
    actorId: null,
    action: 'billing.renewed',
    entityType: 'subscription',
    entityId: row.id,
    before: { periodEnd: row.periodEnd, status: row.status },
    after: { periodEnd: renewal.periodEnd, status: 'active', providerReference: renewal.reference },
  })
  if (owner) {
    await notify(ctx, {
      userId: owner,
      type: 'billing',
      title: 'Your plan renewed',
      body: `The ${row.tier} plan renewed for ${row.seatsPurchased} seats, to ${renewal.periodEnd.toISOString().slice(0, 10)}.`,
      entityType: 'subscription',
      entityId: row.id,
      url: '/settings/billing',
    })
  }
  return { action: 'renewed', tier: row.tier, periodEnd: renewal.periodEnd, note: 'Renewed.' }
}

async function ownerUserId(ctx: TenantContext): Promise<string | null> {
  const [row] = await ctx.sql<{ userId: string }[]>`
    SELECT user_id AS "userId" FROM memberships
    WHERE organization_id = ${ctx.organizationId} AND role = 'owner' AND deleted_at IS NULL
    ORDER BY created_at LIMIT 1`
  return row?.userId ?? null
}

/**
 * What one plan allows that another does not, in sentences rather than a diff.
 *
 * Every limit is compared in both directions from the same table, so a plan that is better on one
 * axis and worse on another — which a real price list eventually has — reads as both rather than
 * as whichever the code checked first.
 */
function differences(from: PlanLimits, to: PlanLimits, side: 'gains' | 'losses'): string[] {
  const lines: string[] = []
  const rows: [number | null, number | null, (value: number | null) => string][] = [
    [from.seats, to.seats, (v) => `${v ?? 'unlimited'} seats`],
    [from.agentRunsPerMonth, to.agentRunsPerMonth, (v) => `${count(v)} agent runs a month`],
    [from.workflowRunsPerMonth, to.workflowRunsPerMonth, (v) => `${count(v)} workflow runs a month`],
    [from.documentsIndexed, to.documentsIndexed, (v) => `${count(v)} documents indexed`],
    [from.storageGb, to.storageGb, (v) => `${v === null ? 'unlimited' : `${v}GB`} of files`],
    [from.aiSpendCapCents, to.aiSpendCapCents, (v) => `${v === null ? 'an uncapped' : formatCents(v)} monthly AI budget`],
    [
      from.perUserDailySpendCapCents,
      to.perUserDailySpendCapCents,
      (v) => `${v === null ? 'an uncapped' : formatCents(v)} daily budget per person`,
    ],
  ]

  for (const [before, after, say] of rows) {
    // `null` is "no limit", so it is larger than every number rather than smaller than all of them.
    const rank = (value: number | null) => (value === null ? Number.POSITIVE_INFINITY : value)
    if (rank(after) === rank(before)) continue
    const better = rank(after) > rank(before)
    if (better && side === 'gains') lines.push(`${say(after)}, up from ${say(before)}.`)
    if (!better && side === 'losses') lines.push(`${say(after)}, down from ${say(before)}.`)
  }

  if (from.autopilotAllowed !== to.autopilotAllowed) {
    if (to.autopilotAllowed && side === 'gains') lines.push('Agents may run unattended on this plan.')
    if (!to.autopilotAllowed && side === 'losses') {
      lines.push('Agents may no longer run unattended: anything on autopilot will stop and wait for a person.')
    }
  }

  return lines
}

/** Limits the organization is already past, which a downgrade would put it on the wrong side of. */
function alreadyOver(to: PlanLimits, usage: Awaited<ReturnType<typeof planUsage>>): string[] {
  const lines: string[] = []
  if (to.documentsIndexed !== null && usage.documentsIndexed > to.documentsIndexed) {
    lines.push(
      `${usage.documentsIndexed.toLocaleString('en-GB')} documents are indexed and this plan allows ` +
        `${to.documentsIndexed.toLocaleString('en-GB')}. Nothing is deleted — nothing more can be indexed until you are under it.`,
    )
  }
  if (to.storageGb !== null && usage.storageBytes > to.storageGb * BYTES_PER_GB) {
    lines.push(
      `${(usage.storageBytes / BYTES_PER_GB).toFixed(1)}GB of files are kept and this plan allows ${to.storageGb}GB. ` +
        'Nothing is deleted — no more files can be attached until you are under it.',
    )
  }
  if (to.agentRunsPerMonth !== null && usage.agentRunsThisMonth > to.agentRunsPerMonth) {
    lines.push(
      `${usage.agentRunsThisMonth.toLocaleString('en-GB')} agent runs have happened this month and this plan ` +
        `allows ${to.agentRunsPerMonth.toLocaleString('en-GB')}. No more will start until the first of the month.`,
    )
  }
  if (to.workflowRunsPerMonth !== null && usage.workflowRunsThisMonth > to.workflowRunsPerMonth) {
    lines.push(
      `${usage.workflowRunsThisMonth.toLocaleString('en-GB')} workflow runs have happened this month and this ` +
        `plan allows ${to.workflowRunsPerMonth.toLocaleString('en-GB')}. Scheduled workflows will be held until the first of the month.`,
    )
  }
  return lines
}

function count(value: number | null): string {
  return value === null ? 'unlimited' : value.toLocaleString('en-GB')
}
