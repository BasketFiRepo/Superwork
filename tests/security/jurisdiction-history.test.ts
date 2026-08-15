import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  createLegalEntity,
  jurisdictionHistory,
  PermissionError,
  recordConsultation,
  setJurisdiction,
  ValidationError,
  worksCouncilReview,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * The jurisdiction history (§29.6).
 *
 * `jurisdiction_changes` has had a writer since migration 0012 and no reader anywhere, so
 * "who loosened this profile, when, why, and who approved it" — the first question a
 * compliance review asks — was answered by a table nothing selected from.
 *
 * The reader was the smaller hole. The history recorded only what `setJurisdiction` did, so
 * any other path — a sync, a migration, a script, an acceptance loop relaxing a profile to
 * exercise the escalation ladder — changed the column with a plain UPDATE and left no
 * trace. A history that records the well-behaved caller is a log of intentions.
 *
 * So the database writes it. The assertions that matter here are the ones about paths
 * nobody is supposed to take.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let memberSession: { organizationId: string; userId: string; timezone: string }
let entityId: string

beforeAll(async () => {
  org = await createTenant('jurisdiction-history')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
  memberSession = { organizationId: org.organizationId, userId: org.memberId, timezone: 'Europe/London' }

  entityId = await withTenant(session, async (ctx) => {
    const entity = await createLegalEntity(ctx, await loadActor(ctx), {
      name: 'Fixture GmbH',
      country: 'DE',
    })
    return entity.id
  })
})

afterAll(async () => {
  await destroyTenant('jurisdiction-history')
  await closePools()
})

describe('the supported path', () => {
  it('records the change, its reason and its approver', async () => {
    await withTenant(session, async (ctx) =>
      setJurisdiction(ctx, await loadActor(ctx), {
        legalEntityId: entityId,
        profile: 'gdpr',
        justification: 'No works council exists at this entity; confirmed with counsel.',
        approvedBy: org.memberId,
      }),
    )
    const history = await withTenant(session, async (ctx) => jurisdictionHistory(ctx, await loadActor(ctx)))
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      changeKind: 'profile',
      fromState: 'works_council',
      toState: 'gdpr',
      justified: true,
      loosening: true,
    })
    expect(history[0]!.justification).toMatch(/counsel/i)
    expect(history[0]!.approvedByName).toBeTruthy()
    expect(history[0]!.changedByName).toBeTruthy()
  })

  it('writes exactly one row, not two', async () => {
    // `setJurisdiction` used to insert the row itself. Now the trigger does, and leaving
    // both in would have doubled every entry.
    const [row] = await adminSql()<{ count: number }[]>`
      SELECT count(*)::int FROM jurisdiction_changes
      WHERE organization_id = ${org.organizationId} AND change_kind = 'profile'`
    expect(row?.count).toBe(1)
  })

  it('records a consultation moving, which was not recorded at all before', async () => {
    await withTenant(session, async (ctx) =>
      recordConsultation(ctx, await loadActor(ctx), {
        legalEntityId: entityId,
        status: 'agreed',
        reference: 'BV-2026-014',
      }),
    )
    const history = await withTenant(session, async (ctx) => jurisdictionHistory(ctx, await loadActor(ctx)))
    const consultation = history.find((change) => change.changeKind === 'consultation')
    expect(consultation).toBeDefined()
    expect(consultation!.toState).toBe('agreed')
    expect(consultation!.justification).toMatch(/BV-2026-014/)
    // A consultation is not a profile, so it is never classified as loosening one.
    expect(consultation!.loosening).toBe(false)
  })

  it('still refuses to loosen without a named approver', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        setJurisdiction(ctx, await loadActor(ctx), {
          legalEntityId: entityId,
          profile: 'standard',
          justification: 'Trying it on.',
        }),
      ),
    ).rejects.toThrow(/named approver/i)
  })

  it('refuses a change with no reason at all', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        setJurisdiction(ctx, await loadActor(ctx), {
          legalEntityId: entityId,
          profile: 'works_council',
          justification: '   ',
        }),
      ),
    ).rejects.toThrow(ValidationError)
  })
})

describe('the paths nobody is supposed to take', () => {
  it('records a profile changed by a bare UPDATE, and marks it unexplained', async () => {
    // This is the hole. A sync, a migration or a script changing the column directly used
    // to leave nothing behind at all.
    await withTenant(session, async (ctx) => {
      await ctx.sql`
        UPDATE legal_entities SET jurisdiction_profile = 'standard'
        WHERE organization_id = ${ctx.organizationId} AND id = ${entityId}`
    })

    const history = await withTenant(session, async (ctx) => jurisdictionHistory(ctx, await loadActor(ctx)))
    const sneaky = history[0]!
    expect(sneaky.changeKind).toBe('profile')
    expect(sneaky.fromState).toBe('gdpr')
    expect(sneaky.toState).toBe('standard')
    expect(sneaky.justified).toBe(false)
    expect(sneaky.justification).toMatch(/without a stated reason/i)
    // Still attributed: `app.current_user_id` is set for every tenant transaction.
    expect(sneaky.changedByName).toBeTruthy()
  })

  it('makes the review fail on it, which is the point of recording it', async () => {
    const review = await withTenant(session, async (ctx) => worksCouncilReview(ctx, await loadActor(ctx)))
    const finding = review.findings.find((entry) => entry.id === 'jurisdiction_history')
    expect(finding).toBeDefined()
    expect(finding!.status).toBe('fail')
    expect(finding!.evidence).toMatch(/without a stated reason/i)
  })

  it('does not fabricate a row when nothing actually changed', async () => {
    const before = await withTenant(session, async (ctx) => jurisdictionHistory(ctx, await loadActor(ctx)))
    await withTenant(session, async (ctx) => {
      await ctx.sql`
        UPDATE legal_entities SET jurisdiction_profile = 'standard', data_region = 'eu'
        WHERE organization_id = ${ctx.organizationId} AND id = ${entityId}`
    })
    const after = await withTenant(session, async (ctx) => jurisdictionHistory(ctx, await loadActor(ctx)))
    expect(after).toHaveLength(before.length)
  })

  it('does not leak the reason from one transaction into the next', async () => {
    // The justification is transaction-scoped, like the tenant. If it persisted on a
    // pooled connection, the next unexplained change would inherit somebody else's reason
    // and the record would be worse than useless.
    await withTenant(session, async (ctx) =>
      setJurisdiction(ctx, await loadActor(ctx), {
        legalEntityId: entityId,
        profile: 'works_council',
        justification: 'Back to the strictest default.',
      }),
    )
    await withTenant(session, async (ctx) => {
      await ctx.sql`
        UPDATE legal_entities SET consultation_status = 'in_progress'
        WHERE organization_id = ${ctx.organizationId} AND id = ${entityId}`
    })
    const history = await withTenant(session, async (ctx) => jurisdictionHistory(ctx, await loadActor(ctx)))
    expect(history[0]!.changeKind).toBe('consultation')
    expect(history[0]!.justified).toBe(false)
    expect(history[0]!.justification).not.toMatch(/strictest default/i)
  })
})

describe('who may read it', () => {
  it('is not open to somebody who does not administer the organization', async () => {
    await expect(
      withTenant(memberSession, async (ctx) => jurisdictionHistory(ctx, await loadActor(ctx))),
    ).rejects.toThrow(PermissionError)
  })
})

describe('a history belongs to one organization', () => {
  it('does not show another tenant’s changes', async () => {
    const other = await createTenant('jurisdiction-history-other')
    const theirs = await withTenant(
      { organizationId: other.organizationId, userId: other.ownerId, timezone: 'Europe/London' },
      async (ctx) => jurisdictionHistory(ctx, await loadActor(ctx)),
    )
    expect(theirs).toHaveLength(0)
    await destroyTenant('jurisdiction-history-other')
  })
})
