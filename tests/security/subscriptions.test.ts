import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  checkSpendLimits,
  effectiveLimits,
  PermissionError,
  seatCheck,
  setOrganizationCaps,
  spendSnapshot,
  subscription,
  tighter,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * The plan a company is on (§19).
 *
 * Three statements of it, agreeing by luck. `plan_limits` was seeded and read by nothing,
 * while the config module's own comment said *"the database is the source of truth at
 * runtime so limits can be changed without a deploy"* — and `checkSpendLimits` read the
 * compile-time constant. `subscriptions` held a tier, a seat count and a spend cap that
 * nothing consulted. And `organizations.plan_tier` was the one the runtime actually used,
 * with nothing keeping it in step.
 *
 * The consequence somebody would have met: on hitting the cap the agent stops and says "an
 * admin can raise the cap in Settings → Billing", and there was no such control.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let memberSession: { organizationId: string; userId: string; timezone: string }

beforeAll(async () => {
  org = await createTenant('subscriptions')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
  memberSession = { organizationId: org.organizationId, userId: org.memberId, timezone: 'Europe/London' }

  await adminSql()`
    INSERT INTO subscriptions (organization_id, tier, seats_purchased, created_by)
    VALUES (${org.organizationId}, 'business', 25, ${org.ownerId})`
})

afterAll(async () => {
  await destroyTenant('subscriptions')
  await closePools()
})

describe('one resolved answer', () => {
  it('takes the limits from the database rather than a compile-time constant', async () => {
    const limits = await withTenant(session, async (ctx) => effectiveLimits(ctx))
    expect(limits.tier).toBe('business')
    expect(limits.source.limits).toBe('database')

    // The claim the config module always made: a limit changes without a deploy.
    await adminSql()`UPDATE plan_limits SET ai_spend_cap_cents = 12345 WHERE tier = 'business'`
    const after = await withTenant(session, async (ctx) => effectiveLimits(ctx))
    expect(after.aiSpendCapCents).toBe(12345)
    await adminSql()`UPDATE plan_limits SET ai_spend_cap_cents = 250000 WHERE tier = 'business'`
  })

  it('falls back to the built-in defaults rather than to no limit', async () => {
    // A table that has not been seeded must not silently uncap an organization.
    const [row] = await adminSql()<{ aiSpendCapCents: number | null }[]>`
      DELETE FROM plan_limits WHERE tier = 'business'
      RETURNING ai_spend_cap_cents AS "aiSpendCapCents"`
    const limits = await withTenant(session, async (ctx) => effectiveLimits(ctx))
    expect(limits.aiSpendCapCents).toBe(250_000)
    expect(limits.source.limits).toBe('built-in defaults')

    await adminSql()`
      INSERT INTO plan_limits (tier, seats, agent_runs_per_month, ai_spend_cap_cents,
                               per_user_daily_spend_cap_cents, documents_indexed, storage_gb,
                               workflow_runs_per_month, autopilot_allowed)
      VALUES ('business', 250, 100000, ${row!.aiSpendCapCents}, 5000, 250000, 2000, 100000, true)`
  })

  it('keeps the organization’s tier in step with the subscription', async () => {
    // Two statements of the tier, reconciled by nobody. The database keeps the older column
    // true rather than trusting application code to remember.
    await adminSql()`UPDATE subscriptions SET tier = 'team' WHERE organization_id = ${org.organizationId}`
    const [orgRow] = await adminSql()<{ planTier: string }[]>`
      SELECT plan_tier AS "planTier" FROM organizations WHERE id = ${org.organizationId}`
    expect(orgRow?.planTier).toBe('team')

    await adminSql()`UPDATE subscriptions SET tier = 'business' WHERE organization_id = ${org.organizationId}`
  })
})

describe('an organization may tighten, never widen', () => {
  it('takes the stricter of the plan and its own', () => {
    expect(tighter(250_000, 50_000)).toBe(50_000)
    // `null` is "no limit", so a plan without one can be given one…
    expect(tighter(null, 50_000)).toBe(50_000)
    // …and an organization that sets none keeps the plan's.
    expect(tighter(250_000, null)).toBe(250_000)
    expect(tighter(null, null)).toBeNull()
  })

  it('applies the organization’s own cap when it is lower', async () => {
    const view = await withTenant(session, async (ctx) =>
      setOrganizationCaps(ctx, await loadActor(ctx), {
        aiSpendCapCents: 1_000,
        // Left at the plan's, so the monthly cap is the only thing under test below — a
        // per-person daily cap of 200 would trip first and prove something else.
        perUserDailyCapCents: null,
        reason: 'Trialling the agent on a small budget this month.',
      }),
    )
    expect(view.limits.aiSpendCapCents).toBe(1_000)
    expect(view.limits.tightened).toBe(true)
    expect(view.limits.source.aiSpendCap).toBe('this organization')
    expect(view.capsReason).toMatch(/small budget/i)
    expect(view.capsSetByName).toBeTruthy()
  })

  it('refuses a cap above the plan’s', async () => {
    // A limit a tenant can raise on its own is not a limit.
    await expect(
      withTenant(session, async (ctx) =>
        setOrganizationCaps(ctx, await loadActor(ctx), {
          aiSpendCapCents: 999_999_999,
          perUserDailyCapCents: null,
          reason: 'Trying to buy more with a form.',
        }),
      ),
    ).rejects.toThrow(/cannot be raised above the plan/i)
  })

  it('will not change a cap without a reason', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        setOrganizationCaps(ctx, await loadActor(ctx), {
          aiSpendCapCents: 1_000,
          perUserDailyCapCents: null,
          reason: '   ',
        }),
      ),
    ).rejects.toThrow(ValidationError)
  })

  it('is not something an ordinary member can do', async () => {
    await expect(
      withTenant(memberSession, async (ctx) =>
        setOrganizationCaps(ctx, await loadActor(ctx), {
          aiSpendCapCents: 1_000,
          perUserDailyCapCents: null,
          reason: 'A member trying to change the budget.',
        }),
      ),
    ).rejects.toThrow(PermissionError)
  })
})

describe('the cap actually stops the agent, at the number on the screen', () => {
  it('stops at the organization’s own cap rather than the plan’s', async () => {
    // The cap is 1,000 cents from the test above; the plan's is 250,000. Spending past the
    // organization's own must stop, or tightening it did nothing. Kept under the plan's
    // 5,000-a-day per-person cap so it is the monthly one that bites.
    await withTenant(session, async (ctx) => {
      await ctx.sql`
        INSERT INTO usage_records (organization_id, user_id, unit, quantity, cost_cents, created_by)
        VALUES (${ctx.organizationId}, ${org.ownerId}, 'ai_tokens', 1, 1200, ${org.ownerId})`
    })

    const snap = await withTenant(session, async (ctx) => spendSnapshot(ctx))
    expect(snap.capCents).toBe(1_000)
    expect(snap.monthToDateCents).toBeGreaterThanOrEqual(1_200)

    const decision = await withTenant(session, async (ctx) => checkSpendLimits(ctx, 'business'))
    expect(decision.allow).toBe(false)
    // And the refusal points at a screen that now has the control on it.
    expect(decision.reason).toMatch(/Settings → Billing/)
  })

  it('lets it run again once the cap is raised back to the plan’s', async () => {
    await withTenant(session, async (ctx) =>
      setOrganizationCaps(ctx, await loadActor(ctx), {
        aiSpendCapCents: null,
        perUserDailyCapCents: null,
        reason: 'Back to the plan’s own limits.',
      }),
    )
    const decision = await withTenant(session, async (ctx) => checkSpendLimits(ctx, 'business'))
    expect(decision.allow).toBe(true)
  })
})

describe('seats', () => {
  it('counts memberships and outstanding invitations together', async () => {
    const before = await withTenant(session, async (ctx) => subscription(ctx, await loadActor(ctx)))
    expect(before.seatsUsed).toBeGreaterThan(0)
    expect(before.seatsRemaining).toBe(before.seatsPurchased - before.seatsUsed)

    await adminSql()`
      INSERT INTO invitations (organization_id, email, role, token_hash, expires_at, created_by)
      VALUES (${org.organizationId}, 'pending@fixture.example', 'member',
              ${'a'.repeat(64)}, now() + interval '7 days', ${org.ownerId})`

    const after = await withTenant(session, async (ctx) => subscription(ctx, await loadActor(ctx)))
    // An invitation nobody has accepted still holds a seat.
    expect(after.seatsUsed).toBe(before.seatsUsed + 1)
  })

  it('says how many are free, with the arithmetic', async () => {
    const check = await withTenant(session, async (ctx) => seatCheck(ctx))
    expect(check.allow).toBe(true)
    expect(check.reason).toMatch(/of 25 seats free/)
  })

  it('is refused to somebody who cannot read billing', async () => {
    await expect(
      withTenant(memberSession, async (ctx) => subscription(ctx, await loadActor(ctx))),
    ).rejects.toThrow(PermissionError)
  })
})

describe('a subscription belongs to one organization', () => {
  it('does not read another tenant’s plan', async () => {
    const other = await createTenant('subscriptions-other')
    const theirs = await withTenant(
      { organizationId: other.organizationId, userId: other.ownerId, timezone: 'Europe/London' },
      async (ctx) => subscription(ctx, await loadActor(ctx)),
    )
    // No subscription row of their own: the free tier, from the organization's own column.
    expect(theirs.tier).toBe('free')
    expect(theirs.limits.source.tier).toBe('organization')
    await destroyTenant('subscriptions-other')
  })
})
