import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  cancelPlan,
  changePlan,
  planAllowance,
  planCatalogue,
  planUsage,
  previewPlanChange,
  renewDueSubscriptions,
  resumePlan,
  seatCheck,
  StepUpRequiredError,
  subscription,
  ValidationError,
  PermissionError,
  type BillingProviderLike,
} from '@superwork/core'
import { MockBillingProvider } from '@superwork/integrations'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * A plan somebody can change (ADR 0086).
 *
 * `subscriptions.tier`, `seats_purchased`, `status` and `period_end` were read by the runtime and
 * written by the seed or by nothing at all, so an organization was on the plan the seed gave it
 * for ever — while `seatCheck` refused an invitation with "buy more seats" and the screen showed
 * a status and a renewal date the product could not produce.
 *
 * What this pack holds:
 *
 *   • **who** — the owner, not an admin, and never a session that cannot prove it is still a
 *     person at the keyboard;
 *   • **the arithmetic** — thirty-two people do not fit on twenty-five seats, and no plan change
 *     deactivates anybody to make it true;
 *   • **the four limits that used to enforce nothing** — a plan you can change must be a plan
 *     that decides something, or changing it is theatre;
 *   • **the period** — cancelling ends at the date already paid for, not today; a declined
 *     renewal stops new work and says why.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let owner: { organizationId: string; userId: string; timezone: string; steppedUpAt?: Date }
let admin: { organizationId: string; userId: string; timezone: string; steppedUpAt?: Date }
let provider: BillingProviderLike

/** A billing system that will not take the money. The mock never declines, on purpose. */
const declining: BillingProviderLike = {
  mode: 'mock',
  quote: (input) => new MockBillingProvider().quote(input),
  commit: (input) => new MockBillingProvider().commit(input),
  renew: async () => ({
    paid: false,
    reference: null,
    periodStart: new Date(),
    periodEnd: new Date(),
    declineReason: 'The card on file expired.',
  }),
}

async function setPlan(tier: string, seats: number, extra: Record<string, unknown> = {}): Promise<void> {
  const columns = { tier, seats_purchased: seats, status: 'active', ...extra }
  await adminSql()`DELETE FROM subscriptions WHERE organization_id = ${org.organizationId}`
  await adminSql()`
    INSERT INTO subscriptions ${adminSql()({ organization_id: org.organizationId, ...columns } as never)}`
}

/** A workflow and one compiled version of it, which is all `workflow_runs` insists on. */
async function aWorkflow(): Promise<string> {
  const [workflow] = await adminSql()<{ id: string }[]>`
    INSERT INTO workflows (organization_id, name, description, status, created_by)
    VALUES (${org.organizationId}, 'Chase quiet threads', 'For the allowance count', 'draft', ${org.ownerId})
    RETURNING id`
  const [version] = await adminSql()<{ id: string }[]>`
    INSERT INTO workflow_versions (organization_id, workflow_id, ordinal, graph, created_by)
    VALUES (${org.organizationId}, ${workflow!.id}, 1, '{}'::jsonb, ${org.ownerId})
    RETURNING id`
  await adminSql()`
    UPDATE workflows SET current_version_id = ${version!.id} WHERE id = ${workflow!.id}`
  return workflow!.id
}

async function aWorkflowRun(workflowId: string, simulated: boolean): Promise<void> {
  const [version] = await adminSql()<{ id: string }[]>`
    SELECT current_version_id AS id FROM workflows WHERE id = ${workflowId}`
  await adminSql()`
    INSERT INTO workflow_runs (organization_id, workflow_id, workflow_version_id, status, trigger,
                               simulated, idempotency_key, started_at, created_by)
    VALUES (${org.organizationId}, ${workflowId}, ${version!.id}, 'succeeded',
            ${simulated ? 'simulation' : 'schedule'}, ${simulated},
            ${`${workflowId}:${simulated}:${Date.now()}`}, now(), ${org.ownerId})`
}

beforeAll(async () => {
  org = await createTenant('billing-self-service')
  owner = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ, steppedUpAt: new Date() }
  admin = { organizationId: org.organizationId, userId: org.memberId, timezone: TZ, steppedUpAt: new Date() }
  await adminSql()`
    UPDATE memberships SET role = 'admin'
    WHERE organization_id = ${org.organizationId} AND user_id = ${org.memberId}`
  provider = new MockBillingProvider()
})

beforeEach(async () => {
  await setPlan('team', 10, { period_start: new Date(Date.now() - 86_400_000), period_end: new Date(Date.now() + 86_400_000) })
})

afterAll(async () => {
  await destroyTenant('billing-self-service')
  await closePools()
})

describe('who may change what the company pays for', () => {
  it('is the owner', async () => {
    const view = await withTenant(owner, async (ctx) =>
      changePlan(
        ctx,
        await loadActor(ctx),
        { tier: 'business', seats: 12, reason: 'Operations doubled this quarter.' },
        provider,
      ),
    )
    expect(view.tier).toBe('business')
    expect(view.seatsPurchased).toBe(12)
  })

  it('is not an administrator, who may read what it costs and not change it', async () => {
    await expect(
      withTenant(admin, async (ctx) =>
        changePlan(ctx, await loadActor(ctx), { tier: 'business', reason: 'We need more room.' }, provider),
      ),
    ).rejects.toThrow(PermissionError)

    // Reading is theirs: the billing screen is an admin screen, and an upgrade they cannot buy is
    // still one they may cost.
    const preview = await withTenant(admin, async (ctx) =>
      previewPlanChange(ctx, await loadActor(ctx), { tier: 'business' }, provider),
    )
    expect(preview.to.tier).toBe('business')
  })

  it('is not a session that cannot prove it is still a person', async () => {
    await expect(
      withTenant({ ...owner, steppedUpAt: undefined as never }, async (ctx) =>
        changePlan(ctx, await loadActor(ctx), { tier: 'business', reason: 'Trying it on a stale cookie.' }, provider),
      ),
    ).rejects.toThrow(StepUpRequiredError)
  })

  it('asks in both directions, unlike every other step-up', async () => {
    // Cancelling narrows what the company has and still asks. Spending money and stopping the
    // service are both things a lifted cookie must not do on somebody's behalf.
    await expect(
      withTenant({ ...owner, steppedUpAt: undefined as never }, async (ctx) =>
        cancelPlan(ctx, await loadActor(ctx), 'Trying to cancel from a stale session.'),
      ),
    ).rejects.toThrow(StepUpRequiredError)
  })

  it('will not commit without a reason', async () => {
    await expect(
      withTenant(owner, async (ctx) => changePlan(ctx, await loadActor(ctx), { tier: 'business', reason: '  ' }, provider)),
    ).rejects.toThrow(ValidationError)
  })
})

describe('what a change would do, before it is committed', () => {
  it('prices it, and says the figure is simulated', async () => {
    const preview = await withTenant(owner, async (ctx) =>
      previewPlanChange(ctx, await loadActor(ctx), { tier: 'business', seats: 10 }, provider),
    )
    expect(preview.direction).toBe('upgrade')
    expect(preview.quote.amountCents).toBeGreaterThan(0)
    expect(preview.quote.simulated).toBe(true)
  })

  it('says what stops working, not only what starts', async () => {
    const preview = await withTenant(owner, async (ctx) =>
      previewPlanChange(ctx, await loadActor(ctx), { tier: 'free', seats: 3 }, provider),
    )
    expect(preview.direction).toBe('downgrade')
    expect(preview.losses.join(' ')).toMatch(/documents indexed|agent runs|seats/i)
    // Every axis is compared in both directions, so a plan that is worse on six and better on one
    // reads as both rather than as whichever the code looked at first.
    expect(preview.gains.every((line) => /budget/.test(line))).toBe(true)
  })

  it('refuses to buy fewer seats than there are people, with the arithmetic', async () => {
    const usage = await withTenant(owner, (ctx) => planUsage(ctx))
    const preview = await withTenant(owner, async (ctx) =>
      previewPlanChange(ctx, await loadActor(ctx), { tier: 'team', seats: 1 }, provider),
    )
    expect(usage.seatsUsed).toBeGreaterThan(1)
    expect(preview.blockers.join(' ')).toContain(`${usage.seatsUsed} seats are in use`)

    await expect(
      withTenant(owner, async (ctx) =>
        changePlan(ctx, await loadActor(ctx), { seats: 1, reason: 'Cutting costs rather sharply.' }, provider),
      ),
    ).rejects.toThrow(/seats are in use/)
  })

  it('refuses more seats than the plan includes', async () => {
    const preview = await withTenant(owner, async (ctx) =>
      previewPlanChange(ctx, await loadActor(ctx), { tier: 'free', seats: 30 }, provider),
    )
    expect(preview.blockers.join(' ')).toMatch(/free plan includes at most 3 seats/)
  })

  it('refuses an upgrade while a payment has not gone through, and allows a downgrade', async () => {
    await setPlan('team', 10, { status: 'past_due', period_end: new Date(Date.now() + 86_400_000) })
    const up = await withTenant(owner, async (ctx) =>
      previewPlanChange(ctx, await loadActor(ctx), { tier: 'business' }, provider),
    )
    expect(up.blockers.join(' ')).toMatch(/has not gone through/)

    const down = await withTenant(owner, async (ctx) =>
      previewPlanChange(ctx, await loadActor(ctx), { tier: 'free', seats: 3 }, provider),
    )
    expect(down.blockers).toEqual([])
  })

  it('refuses a change that is not one', async () => {
    await expect(
      withTenant(owner, async (ctx) =>
        changePlan(ctx, await loadActor(ctx), { tier: 'team', seats: 10, reason: 'Same plan, same seats.' }, provider),
      ),
    ).rejects.toThrow(/already on/)
  })
})

describe('what a committed change writes', () => {
  it('keeps organizations.plan_tier in step, because the database does it', async () => {
    await withTenant(owner, async (ctx) =>
      changePlan(ctx, await loadActor(ctx), { tier: 'business', reason: 'Autopilot is worth having.' }, provider),
    )
    const [row] = await adminSql()<{ plan_tier: string }[]>`
      SELECT plan_tier FROM organizations WHERE id = ${org.organizationId}`
    expect(row!.plan_tier).toBe('business')
  })

  it('records who, why, and what the billing system called it', async () => {
    const view = await withTenant(owner, async (ctx) =>
      changePlan(ctx, await loadActor(ctx), { tier: 'business', reason: 'Six more people joined operations.' }, provider),
    )
    expect(view.planChangeReason).toBe('Six more people joined operations.')
    expect(view.planChangedByName).toBeTruthy()
    expect(view.providerReference).toMatch(/^sim_/)

    const [audit] = await adminSql()<{ action: string; diff: Record<string, unknown> }[]>`
      SELECT action, diff FROM audit_logs
      WHERE organization_id = ${org.organizationId} AND action = 'billing.plan_changed'
      ORDER BY occurred_at DESC LIMIT 1`
    expect(audit!.action).toBe('billing.plan_changed')
    expect(JSON.stringify(audit!.diff)).toContain('business')
  })

  it('gives the seat check something to be right about', async () => {
    await setPlan('team', 25)
    const before = await withTenant(owner, (ctx) => seatCheck(ctx))
    expect(before.allow).toBe(true)

    const usage = await withTenant(owner, (ctx) => planUsage(ctx))
    await withTenant(owner, async (ctx) =>
      changePlan(ctx, await loadActor(ctx), { seats: usage.seatsUsed, reason: 'Only paying for who is here.' }, provider),
    )
    const after = await withTenant(owner, (ctx) => seatCheck(ctx))
    expect(after.allow).toBe(false)
    expect(after.reason).toContain('buy more seats')
  })
})

describe('the four limits that used to enforce nothing', () => {
  it('counts what is held rather than what happened, for documents and files', async () => {
    const usage = await withTenant(owner, (ctx) => planUsage(ctx))
    // The fixture indexes one document and attaches no file.
    expect(usage.documentsIndexed).toBe(1)
    expect(usage.storageBytes).toBe(0)
  })

  it('stops a document when the plan is full, and says by how much', async () => {
    await setPlan('free', 3)
    await adminSql()`
      UPDATE plan_limits SET documents_indexed = 1 WHERE tier = 'free'`
    const room = await withTenant(owner, (ctx) => planAllowance(ctx, 'document'))
    expect(room.allow).toBe(false)
    expect(room.reason).toMatch(/free plan allows 1 documents indexed/)
    await adminSql()`UPDATE plan_limits SET documents_indexed = 100 WHERE tier = 'free'`
  })

  it('measures files in bytes against a limit written in gigabytes', async () => {
    await setPlan('free', 3)
    const room = await withTenant(owner, (ctx) => planAllowance(ctx, 'storage', 2 * 1024 * 1024 * 1024))
    expect(room.allow).toBe(false)
    expect(room.reason).toMatch(/allows 1\.0GB of files kept/)
  })

  it('does not count a dry run against the workflow allowance', async () => {
    const workflowId = await aWorkflow()
    await aWorkflowRun(workflowId, true)
    const usage = await withTenant(owner, (ctx) => planUsage(ctx))
    expect(usage.workflowRunsThisMonth).toBe(0)

    await aWorkflowRun(workflowId, false)
    const after = await withTenant(owner, (ctx) => planUsage(ctx))
    expect(after.workflowRunsThisMonth).toBe(1)
    await adminSql()`DELETE FROM workflow_runs WHERE organization_id = ${org.organizationId}`
  })
})

describe('the period', () => {
  it('cancels at the end of what was paid for, not today', async () => {
    const endsAt = new Date(Date.now() + 5 * 86_400_000)
    await setPlan('team', 10, { period_end: endsAt })
    const view = await withTenant(owner, async (ctx) =>
      cancelPlan(ctx, await loadActor(ctx), 'Moving to another tool in the new year.'),
    )
    expect(view.status).toBe('cancelled')
    expect(view.tier).toBe('team')

    // Nothing has stopped: the organization keeps what it bought until the date it bought it to.
    const room = await withTenant(owner, (ctx) => planAllowance(ctx, 'agent_run'))
    expect(room.allow).toBe(true)
  })

  it('stops new work once that date has passed, without waiting for a sweep', async () => {
    await setPlan('team', 10, {
      status: 'cancelled',
      period_start: new Date(Date.now() - 40 * 86_400_000),
      period_end: new Date(Date.now() - 86_400_000),
    })
    const room = await withTenant(owner, (ctx) => planAllowance(ctx, 'agent_run'))
    expect(room.allow).toBe(false)
    expect(room.reason).toMatch(/plan ended on/)
  })

  it('drops to free when the sweep reaches it, and deletes nothing', async () => {
    await setPlan('team', 10, {
      status: 'cancelled',
      period_start: new Date(Date.now() - 40 * 86_400_000),
      period_end: new Date(Date.now() - 86_400_000),
    })
    const outcome = await withTenant(owner, (ctx) => renewDueSubscriptions(ctx, provider))
    expect(outcome?.action).toBe('ended')

    const view = await withTenant(owner, async (ctx) => subscription(ctx, await loadActor(ctx)))
    expect(view.tier).toBe('free')
    expect(view.status).toBe('active')
    expect(view.periodEnd).toBeNull()

    const usage = await withTenant(owner, (ctx) => planUsage(ctx))
    expect(usage.documentsIndexed).toBe(1)
  })

  it('renews a period that has ended, once, and tells the owner', async () => {
    await setPlan('team', 10, {
      period_start: new Date(Date.now() - 40 * 86_400_000),
      period_end: new Date(Date.now() - 86_400_000),
    })
    const first = await withTenant(owner, (ctx) => renewDueSubscriptions(ctx, provider))
    expect(first?.action).toBe('renewed')
    // The next sweep finds nothing: the period it renewed into has not ended.
    const second = await withTenant(owner, (ctx) => renewDueSubscriptions(ctx, provider))
    expect(second).toBeNull()

    const [note] = await adminSql()<{ title: string }[]>`
      SELECT title FROM notifications
      WHERE organization_id = ${org.organizationId} AND type = 'billing'
      ORDER BY created_at DESC LIMIT 1`
    expect(note!.title).toMatch(/renewed/i)
  })

  it('stops new work when the payment is declined, and says what failed', async () => {
    await setPlan('team', 10, {
      period_start: new Date(Date.now() - 40 * 86_400_000),
      period_end: new Date(Date.now() - 86_400_000),
    })
    const outcome = await withTenant(owner, (ctx) => renewDueSubscriptions(ctx, declining))
    expect(outcome?.action).toBe('declined')

    const room = await withTenant(owner, (ctx) => planAllowance(ctx, 'agent_run'))
    expect(room.allow).toBe(false)
    expect(room.reason).toMatch(/did not go through/)

    // A week out rather than every pass: retrying a declined card every minute is how a product
    // gets its merchant account reviewed.
    const [row] = await adminSql()<{ period_end: Date }[]>`
      SELECT period_end FROM subscriptions WHERE organization_id = ${org.organizationId}`
    expect(row!.period_end.getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000)
  })

  it('never renews the free plan, and takes its end date away', async () => {
    await setPlan('free', 3, {
      period_start: new Date(Date.now() - 40 * 86_400_000),
      period_end: new Date(Date.now() - 86_400_000),
    })
    const outcome = await withTenant(owner, (ctx) => renewDueSubscriptions(ctx, provider))
    expect(outcome?.action).toBe('released')
    const [row] = await adminSql()<{ period_end: Date | null }[]>`
      SELECT period_end FROM subscriptions WHERE organization_id = ${org.organizationId}`
    expect(row!.period_end).toBeNull()
  })

  it('resumes inside the period, and refuses to resume one that has ended', async () => {
    await setPlan('team', 10, { status: 'cancelled', period_end: new Date(Date.now() + 5 * 86_400_000) })
    const resumed = await withTenant(owner, async (ctx) =>
      resumePlan(ctx, await loadActor(ctx), 'The replacement tool did not work out.'),
    )
    expect(resumed.status).toBe('active')

    await setPlan('team', 10, {
      status: 'cancelled',
      period_start: new Date(Date.now() - 40 * 86_400_000),
      period_end: new Date(Date.now() - 86_400_000),
    })
    await expect(
      withTenant(owner, async (ctx) => resumePlan(ctx, await loadActor(ctx), 'Changed our minds too late.')),
    ).rejects.toThrow(/new purchase/)
  })
})

describe('the price list', () => {
  it('is the same catalogue for everybody, and nothing here writes it', async () => {
    const catalogue = await withTenant(owner, (ctx) => planCatalogue(ctx))
    expect(catalogue.map((row) => row.tier)).toEqual(['free', 'team', 'business', 'enterprise'])

    // `plan_limits` has no `organization_id`: one row per tier, shared by every tenant in the
    // installation. That is why a tenant picks a row from it and never writes one.
    const [column] = await adminSql()<{ count: number }[]>`
      SELECT count(*)::int AS count FROM information_schema.columns
      WHERE table_name = 'plan_limits' AND column_name = 'organization_id'`
    expect(column!.count).toBe(0)
  })
})
