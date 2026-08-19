import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  createCompany,
  listCompanies,
  listInteractions,
  logInteraction,
  NotFoundError,
  PermissionError,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * What was said, and when (ADR 0057).
 *
 * The company screen has always shown a relationship timeline, and `last_interaction_at` — what
 * the quiet-account watcher acts on — is derived from it. Only an agent could add to it:
 * `logInteraction` was reachable through `log_interaction@v1` and from nowhere else, so somebody
 * who rang a customer this morning could watch the product decide the account had gone quiet.
 *
 * It also had no permission check at all, which was survivable while its only caller was a tool
 * with `requiredPermissions` of its own.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let memberSession: { organizationId: string; userId: string; timezone: string }
let companyId = ''

beforeAll(async () => {
  org = await createTenant('log-interaction')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  memberSession = { organizationId: org.organizationId, userId: org.memberId, timezone: TZ }

  await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const company = await createCompany(ctx, actor, {
      name: 'Kestrel Cold Chain',
      domains: ['kestrelcold.example'],
    })
    companyId = company.id
  })
})

afterAll(async () => {
  await destroyTenant('log-interaction')
  await closePools()
})

describe('a person can log what was said', () => {
  it('puts it on the timeline and stops the account looking quiet', async () => {
    const [before] = await withTenant(session, async (ctx) =>
      listCompanies(ctx, await loadActor(ctx), { search: 'Kestrel' }),
    )
    expect(before!.lastInteractionAt).toBeNull()

    await withTenant(memberSession, async (ctx) =>
      logInteraction(ctx, await loadActor(ctx), {
        companyId,
        kind: 'call',
        summary: 'Rang about the reefer handover — happy with 14:00 from Monday.',
      }),
    )

    const rows = await withTenant(session, (ctx) => listInteractions(ctx, companyId, 10))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.kind).toBe('call')
    expect(rows[0]!.summary).toContain('reefer handover')

    // The reason it matters: this is what the quiet-account watcher reads.
    const [after] = await withTenant(session, async (ctx) =>
      listCompanies(ctx, await loadActor(ctx), { search: 'Kestrel' }),
    )
    expect(after!.lastInteractionAt).not.toBeNull()
    expect(after!.daysSinceInteraction).toBe(0)
  })

  it('tells the rest of the team, so two people do not ring the same customer', async () => {
    const [activity] = await adminSql()<{ summary: string; verb: string }[]>`
      SELECT summary, verb FROM activities
      WHERE organization_id = ${org.organizationId} AND entity_type = 'company'
        AND entity_id = ${companyId}
      ORDER BY created_at DESC LIMIT 1`
    expect(activity!.verb).toBe('logged')
    expect(activity!.summary).toContain('reefer handover')
  })

  it('keeps a date somebody gives it, rather than stamping now', async () => {
    const when = new Date(Date.now() - 3 * 86_400_000)
    await withTenant(memberSession, async (ctx) =>
      logInteraction(ctx, await loadActor(ctx), {
        companyId,
        kind: 'meeting',
        summary: 'Site visit at Immingham, walked the cold store.',
        occurredAt: when,
      }),
    )
    const rows = await withTenant(session, (ctx) => listInteractions(ctx, companyId, 10))
    const meeting = rows.find((row) => row.kind === 'meeting')!
    expect(Math.abs(meeting.occurredAt.getTime() - when.getTime())).toBeLessThan(2000)

    // And the account's last contact is still the more recent one: the column only moves forward.
    const [company] = await withTenant(session, async (ctx) =>
      listCompanies(ctx, await loadActor(ctx), { search: 'Kestrel' }),
    )
    expect(company!.daysSinceInteraction).toBe(0)
  })
})

describe('what an interaction may not be', () => {
  it('is not something anybody can write — the same gate the tool declares', async () => {
    // A guest has no `note:create` at any scope.
    await adminSql()`
      UPDATE memberships SET role = 'guest'
      WHERE organization_id = ${org.organizationId} AND user_id = ${org.viewerId}`
    await withTenant({ ...memberSession, userId: org.viewerId }, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        logInteraction(ctx, actor, { companyId, kind: 'call', summary: 'Rang them about nothing.' }),
      ).rejects.toThrow(PermissionError)
    })
    await adminSql()`
      UPDATE memberships SET role = 'viewer'
      WHERE organization_id = ${org.organizationId} AND user_id = ${org.viewerId}`
  })

  it('is not a kind the product does not have, in the repository or the database', async () => {
    await withTenant(memberSession, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        logInteraction(ctx, actor, { companyId, kind: 'seance', summary: 'Contacted them somehow.' }),
      ).rejects.toThrow(/one of: email, call, meeting, note, task/i)
    })
    await expect(
      adminSql()`
        INSERT INTO interactions (organization_id, company_id, kind, summary, occurred_at, created_by)
        VALUES (${org.organizationId}, ${companyId}, 'seance', 'By another door', now(), ${org.ownerId})`,
    ).rejects.toThrow(/interactions_kind_known/)
  })

  it('is not about nobody, which would be a row nothing ever shows', async () => {
    await withTenant(memberSession, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        logInteraction(ctx, actor, { kind: 'call', summary: 'Rang somebody, cannot say who.' }),
      ).rejects.toThrow(/about a company or a person/i)
    })
    await expect(
      adminSql()`
        INSERT INTO interactions (organization_id, kind, summary, occurred_at, created_by)
        VALUES (${org.organizationId}, 'call', 'By another door', now(), ${org.ownerId})`,
    ).rejects.toThrow(/interactions_about_somebody/)
  })

  it('is not dated in the future, and not empty', async () => {
    await withTenant(memberSession, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        logInteraction(ctx, actor, {
          companyId,
          kind: 'call',
          summary: 'Will ring them next week.',
          occurredAt: new Date(Date.now() + 7 * 86_400_000),
        }),
      ).rejects.toThrow(/Log it after it happens/i)
      await expect(
        logInteraction(ctx, actor, { companyId, kind: 'call', summary: ' x ' }),
      ).rejects.toThrow(ValidationError)
    })
    await expect(
      adminSql()`
        INSERT INTO interactions (organization_id, company_id, kind, summary, occurred_at, created_by)
        VALUES (${org.organizationId}, ${companyId}, 'call', 'x', now(), ${org.ownerId})`,
    ).rejects.toThrow(/interactions_summary_said/)
  })

  it('is another tenant’s 404, never their 403', async () => {
    const other = await createTenant('log-interaction-other')
    try {
      const [theirs] = await adminSql()<{ id: string }[]>`
        INSERT INTO companies (organization_id, name, created_by)
        VALUES (${other.organizationId}, 'Their Company', ${other.ownerId}) RETURNING id`
      await withTenant(memberSession, async (ctx) => {
        const actor = await loadActor(ctx)
        await expect(
          logInteraction(ctx, actor, {
            companyId: theirs!.id,
            kind: 'call',
            summary: 'Rang a company in another organization.',
          }),
        ).rejects.toThrow(NotFoundError)
      })
    } finally {
      await destroyTenant('log-interaction-other')
    }
  })
})
