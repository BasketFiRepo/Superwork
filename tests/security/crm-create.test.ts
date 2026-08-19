import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  companyForAddress,
  ConflictError,
  createCompany,
  createContact,
  listCompanies,
  listMergeCandidates,
  NotFoundError,
  PermissionError,
  updateCompany,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Adding a customer (ADR 0056).
 *
 * `companies` and `contacts` are read by the companies screen, the relationship view, the inbox's
 * routing and the watchers that ask whether an account has gone quiet — and both were written by
 * the seed and by nothing else since Phase 0. There was no way to add a customer to this product.
 *
 * The tests that matter are about the domain list, because that is the field the product *acts*
 * on: it decides whose customer an inbound message is.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let memberSession: { organizationId: string; userId: string; timezone: string }

beforeAll(async () => {
  org = await createTenant('crm-create')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  memberSession = { organizationId: org.organizationId, userId: org.memberId, timezone: TZ }
})

afterAll(async () => {
  await destroyTenant('crm-create')
  await closePools()
})

describe('a company somebody added', () => {
  it('is on the list, owned by whoever added it, and reachable by its domain', async () => {
    const company = await withTenant(session, async (ctx) =>
      createCompany(ctx, await loadActor(ctx), {
        name: 'Meridian Foods',
        type: 'customer',
        industry: 'Chilled food distribution',
        domains: ['MeridianFoods.example', ' meridian.example '],
      }),
    )
    expect(company.name).toBe('Meridian Foods')
    expect(company.ownerId).toBe(org.ownerId)
    // Trimmed, lowercased and de-duplicated on the way in, because an address is matched
    // against these exactly.
    expect(company.domains).toEqual(['meridianfoods.example', 'meridian.example'])
    // Defaults that mean something: the watchers act on both.
    expect(company.replySlaDays).toBeGreaterThan(0)
    expect(company.healthStatus).toBe('unknown')

    const rows = await withTenant(session, async (ctx) => listCompanies(ctx, await loadActor(ctx), {}))
    expect(rows.map((row) => row.name)).toContain('Meridian Foods')

    // The reason the domain list exists at all.
    const matched = await withTenant(session, (ctx) =>
      companyForAddress(ctx, 'dana@meridianfoods.example'),
    )
    expect(matched?.name).toBe('Meridian Foods')
  })

  it('refuses a second company on the same domain, and says which one has it', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        createCompany(ctx, actor, { name: 'Meridian Cold Chain', domains: ['meridian.example'] }),
      ).rejects.toThrow(/Meridian Foods.*already receives mail from meridian\.example/is)
    })
  })

  it('refuses a domain that could never match an address', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      for (const bad of ['dana@meridian.example', 'meridian', 'meridian .example']) {
        await expect(
          createCompany(ctx, actor, { name: `Bad ${bad}`, domains: [bad] }),
        ).rejects.toThrow(/not a domain mail can be matched on/i)
      }
    })
    // And the database refuses it too, so no other writer can put one there.
    await expect(
      adminSql()`
        INSERT INTO companies (organization_id, name, domains, created_by)
        VALUES (${org.organizationId}, 'By another door', ARRAY['NOT@ADOMAIN'], ${org.ownerId})`,
    ).rejects.toThrow(/companies_domains_ok/)
  })

  it('refuses a second company with the same name', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(createCompany(ctx, actor, { name: '  meridian foods ' })).rejects.toThrow(
        ConflictError,
      )
    })
  })

  it('is not something a member may open', async () => {
    await withTenant(memberSession, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(createCompany(ctx, actor, { name: 'Member Motors' })).rejects.toThrow(
        PermissionError,
      )
    })
  })

  it('cannot be filed above what the person could then read', async () => {
    // Enforced by the policy engine rather than by a second copy of the rule here: the
    // classification is part of the resource the create is checked against, so `can()` refuses it
    // against the actor's own ceiling and says so in its own words.
    await withTenant(memberSession, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        createContact(ctx, actor, { name: 'Someone Secret', sensitivity: 'restricted' }),
      ).rejects.toThrow(PermissionError)
      await expect(
        createContact(ctx, actor, { name: 'Someone Secret', sensitivity: 'restricted' }),
      ).rejects.toThrow(/classified restricted/i)
    })
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        createCompany(ctx, actor, { name: 'Secret Holdings', sensitivity: 'restricted' }),
      ).resolves.toBeDefined()
    })
  })
})

describe('keeping the record true', () => {
  it('sets the numbers the watchers act on, which ran on defaults before', async () => {
    const [company] = await withTenant(session, async (ctx) =>
      listCompanies(ctx, await loadActor(ctx), { search: 'Meridian Foods' }),
    )
    const after = await withTenant(session, async (ctx) =>
      updateCompany(ctx, await loadActor(ctx), {
        id: company!.id,
        healthStatus: 'at_risk',
        replySlaDays: 2,
        checkInDays: 14,
      }),
    )
    expect(after.healthStatus).toBe('at_risk')
    expect(after.replySlaDays).toBe(2)
    expect(after.checkInDays).toBe(14)

    // A change of health is what other people act on, so it goes on the feed.
    const [activity] = await adminSql()<{ summary: string }[]>`
      SELECT summary FROM activities
      WHERE organization_id = ${org.organizationId} AND entity_type = 'company'
      ORDER BY created_at DESC LIMIT 1`
    expect(activity!.summary).toMatch(/is now at risk/i)
  })

  it('refuses a reply promise nobody could keep, in the repository and in the database', async () => {
    const [company] = await withTenant(session, async (ctx) =>
      listCompanies(ctx, await loadActor(ctx), { search: 'Meridian Foods' }),
    )
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        updateCompany(ctx, actor, { id: company!.id, replySlaDays: 0 }),
      ).rejects.toThrow(/chasing the moment a message arrives, for ever/i)
      await expect(
        updateCompany(ctx, actor, { id: company!.id, checkInDays: 0 }),
      ).rejects.toThrow(ValidationError)
      await expect(
        updateCompany(ctx, actor, { id: company!.id, healthStatus: 'grumpy' }),
      ).rejects.toThrow(ValidationError)
    })
    await expect(
      adminSql()`
        UPDATE companies SET reply_sla_days = 0
        WHERE organization_id = ${org.organizationId} AND id = ${company!.id}`,
    ).rejects.toThrow(/companies_sla_sane/)
    await expect(
      adminSql()`
        UPDATE companies SET health_status = 'grumpy'
        WHERE organization_id = ${org.organizationId} AND id = ${company!.id}`,
    ).rejects.toThrow(/companies_health_known/)
  })

  it('will not move a domain onto a company that another one already receives mail from', async () => {
    const second = await withTenant(session, async (ctx) =>
      createCompany(ctx, await loadActor(ctx), { name: 'Northgate Haulage' }),
    )
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        updateCompany(ctx, actor, { id: second.id, domains: ['meridian.example'] }),
      ).rejects.toThrow(/coin toss/i)
    })
  })

  it('is another tenant’s 404, never their 403', async () => {
    const other = await createTenant('crm-create-other')
    try {
      const [theirs] = await adminSql()<{ id: string }[]>`
        INSERT INTO companies (organization_id, name, created_by)
        VALUES (${other.organizationId}, 'Somebody Else Ltd', ${other.ownerId}) RETURNING id`
      await withTenant(session, async (ctx) => {
        const actor = await loadActor(ctx)
        await expect(
          updateCompany(ctx, actor, { id: theirs!.id, healthStatus: 'critical' }),
        ).rejects.toThrow(NotFoundError)
      })
    } finally {
      await destroyTenant('crm-create-other')
    }
  })
})

describe('a contact somebody added', () => {
  it('can be added by a member, and belongs to the company they chose', async () => {
    const [company] = await withTenant(session, async (ctx) =>
      listCompanies(ctx, await loadActor(ctx), { search: 'Meridian Foods' }),
    )
    const contact = await withTenant(memberSession, async (ctx) =>
      createContact(ctx, await loadActor(ctx), {
        name: 'Dana Whitfield',
        companyId: company!.id,
        emails: ['Dana@MeridianFoods.example'],
        title: 'Head of logistics',
      }),
    )
    expect(contact.name).toBe('Dana Whitfield')
    expect(contact.companyId).toBe(company!.id)
    // Lowercased, because an address is matched exactly.
    expect(contact.emails).toEqual(['dana@meridianfoods.example'])
  })

  it('refuses an address that is not one, in both places', async () => {
    await withTenant(memberSession, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        createContact(ctx, actor, { name: 'Nobody', emails: ['not-an-address'] }),
      ).rejects.toThrow(/is not an email address/i)
    })
    await expect(
      adminSql()`
        INSERT INTO contacts (organization_id, name, emails, created_by)
        VALUES (${org.organizationId}, 'By another door', ARRAY['nope'], ${org.ownerId})`,
    ).rejects.toThrow(/contacts_emails_ok/)
  })

  it('sends a duplicate to the merge queue rather than refusing the row', async () => {
    // The same person, typed again by somebody who did not know. Refusing it would take away
    // the thing the merge queue exists to work on.
    const second = await withTenant(memberSession, async (ctx) =>
      createContact(ctx, await loadActor(ctx), {
        name: 'Dana Whitfield',
        emails: ['dana@meridianfoods.example'],
      }),
    )
    expect(second.id).toBeDefined()

    const candidates = await withTenant(session, async (ctx) =>
      listMergeCandidates(ctx, await loadActor(ctx)),
    )
    const pair = candidates.find(
      (row) => row.primary.name === 'Dana Whitfield' && row.duplicate.name === 'Dana Whitfield',
    )
    expect(pair).toBeDefined()
  })

  it('refuses a company that is not this tenant’s', async () => {
    const other = await createTenant('crm-create-other-2')
    try {
      const [theirs] = await adminSql()<{ id: string }[]>`
        INSERT INTO companies (organization_id, name, created_by)
        VALUES (${other.organizationId}, 'Their Company', ${other.ownerId}) RETURNING id`
      await withTenant(memberSession, async (ctx) => {
        const actor = await loadActor(ctx)
        await expect(
          createContact(ctx, actor, { name: 'Somebody', companyId: theirs!.id }),
        ).rejects.toThrow(NotFoundError)
      })
    } finally {
      await destroyTenant('crm-create-other-2')
    }
  })
})
