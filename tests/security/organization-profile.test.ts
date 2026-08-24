import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  checkSpendLimits,
  formatCents,
  hybridSearch,
  knownCurrency,
  knownTimezone,
  organizationCurrency,
  organizationProfile,
  PermissionError,
  removeGlossaryTerm,
  setGlossaryTerm,
  transformQuery,
  updateOrganizationProfile,
  uploadDocument,
  ValidationError,
} from '@superwork/core'
import { loadSystemPrompt, renderPrompt } from '@superwork/ai'
import { DEFAULT_PLAN_LIMITS } from '@superwork/config'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * What the organization says about itself (ADR 0052).
 *
 * `organizations` was written by the seed and by almost nothing else since Phase 0. Two columns
 * picked up a control on the way — `data_region` and the kill switch — and the rest of the row
 * was whatever the seed said, so every organization was Northwind Logistics, in Europe/London,
 * that thinks a reefer is a temperature-controlled trailer.
 *
 * Two of these columns were read by nothing, which is the opposite failure and is fixed the
 * other way round: `currency` and `profile.tone` are given a reader here rather than a settings
 * field that does nothing. Those are the tests that matter most, because a control with no
 * effect is the thing this build is not allowed to ship.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }

beforeAll(async () => {
  org = await createTenant('org-profile')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
})

afterAll(async () => {
  await destroyTenant('org-profile')
  await closePools()
})

describe('an organization can describe itself', () => {
  it('shows what it is now, and what the clock reaches', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const profile = await organizationProfile(ctx, actor)
      expect(profile.name).toBe('Fixture org-profile')
      expect(profile.slug).toBe('org-profile')
      expect(profile.timezone).toBe('Europe/London')
      expect(profile.currency).toBe('GBP')
      // The screen has to be able to say what changing the clock will reach.
      expect(profile.peopleOnTheOrgClock).toBeGreaterThan(0)
    })
  })

  it('is administrators only, at both ends', async () => {
    await withTenant({ ...session, userId: org.memberId }, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(organizationProfile(ctx, actor)).rejects.toThrow(PermissionError)
      await expect(
        updateOrganizationProfile(ctx, actor, { name: 'Something Else Ltd' }),
      ).rejects.toThrow(PermissionError)
      await expect(setGlossaryTerm(ctx, actor, { term: 'ETA', meaning: 'estimated arrival' })).rejects.toThrow(
        PermissionError,
      )
    })
  })

  it('refuses a name nobody could read, and keeps the address out of it', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(updateOrganizationProfile(ctx, actor, { name: ' N ' })).rejects.toThrow(ValidationError)

      const after = await updateOrganizationProfile(ctx, actor, {
        name: 'Northwind Logistics',
        industry: 'Freight forwarding',
      })
      expect(after.name).toBe('Northwind Logistics')
      // The slug is an address. Renaming the company does not move it.
      expect(after.slug).toBe('org-profile')
    })
  })

  it('refuses a timezone this machine cannot work in, and says what one looks like', async () => {
    expect(knownTimezone('Europe/London')).toBe(true)
    expect(knownTimezone('America/New_York')).toBe(true)
    expect(knownTimezone('Mars/Olympus')).toBe(false)
    expect(knownTimezone('GMT+1')).toBe(false)

    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        updateOrganizationProfile(ctx, actor, { timezone: 'Mars/Olympus' }),
      ).rejects.toThrow(/IANA names, like Europe\/London/)
    })
  })

  it('refuses a currency money cannot be written in', async () => {
    expect(knownCurrency('GBP')).toBe(true)
    expect(knownCurrency('USD')).toBe(true)
    expect(knownCurrency('gbp')).toBe(false)
    expect(knownCurrency('POUNDS')).toBe(false)

    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(updateOrganizationProfile(ctx, actor, { currency: 'ZZ9' })).rejects.toThrow(
        ValidationError,
      )
    })
  })

  it('keeps a record of the change, and says on the feed when the clock moved', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await updateOrganizationProfile(ctx, actor, { timezone: 'America/New_York' })
    })

    const [audit] = await adminSql()<{ diff: Record<string, unknown> }[]>`
      SELECT diff FROM audit_logs
      WHERE organization_id = ${org.organizationId} AND action = 'organization.updated'
      ORDER BY occurred_at DESC LIMIT 1`
    expect(JSON.stringify(audit!.diff)).toContain('America/New_York')
    expect(JSON.stringify(audit!.diff)).toContain('Europe/London')

    const [activity] = await adminSql()<{ summary: string }[]>`
      SELECT summary FROM activities
      WHERE organization_id = ${org.organizationId} AND entity_type = 'organization'
      ORDER BY created_at DESC LIMIT 1`
    expect(activity!.summary).toContain('America/New_York')
    expect(activity!.summary).toMatch(/what “today” and “overdue” mean/)

    // Put it back, and prove the other way round is not announced: renaming reaches nobody's
    // sense of what is late.
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const after = await updateOrganizationProfile(ctx, actor, { timezone: 'Europe/London' })
      expect(after.timezone).toBe('Europe/London')
    })
  })
})

describe('the currency is the one money is written in', () => {
  it('answers from the column rather than from a default nobody chose', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await updateOrganizationProfile(ctx, actor, { currency: 'USD' })
      expect(await organizationCurrency(ctx)).toBe('USD')
      // `formatCents` has taken a currency since Phase 1 and no caller ever passed one.
      expect(formatCents(125_00, 'USD')).toContain('$')
      expect(formatCents(125_00)).toContain('£')
    })
  })

  it('is the money a refusal quotes a figure in, which is where it is felt', async () => {
    // A real budget, really exceeded, refused through the real gate. Asserting the helper
    // alone would pass with the refusal still hardcoded to pounds — which it was.
    await adminSql()`
      UPDATE plan_limits SET ai_spend_cap_cents = 1000
      WHERE tier = (SELECT plan_tier FROM organizations WHERE id = ${org.organizationId})`
    await adminSql()`
      INSERT INTO usage_records (organization_id, user_id, unit, quantity, cost_cents, is_demo, created_by)
      VALUES (${org.organizationId}, ${org.ownerId}, 'tokens', 1, 5000, true, ${org.ownerId})`

    const refusal = await withTenant(session, (ctx) => checkSpendLimits(ctx, 'business'))
    expect(refusal.allow).toBe(false)
    expect(refusal.reason).toContain('$')
    expect(refusal.reason).not.toContain('£')

    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await updateOrganizationProfile(ctx, actor, { currency: 'GBP' })
    })
    const inPounds = await withTenant(session, (ctx) => checkSpendLimits(ctx, 'business'))
    expect(inPounds.reason).toContain('£')

    // Put the shared plan row back: it is not this tenant's to keep changed.
    //
    // Restored from `DEFAULT_PLAN_LIMITS` rather than from a literal. It was `NULL` here, and the
    // fixture tenant is on the free plan whose cap is £5 — so this test left every plan row it
    // touched uncapped for everything that ran after it, in a table with no `organization_id` and
    // therefore no tenant boundary to contain the damage (ADR 0086).
    const [tenant] = await adminSql()<{ tier: 'free' | 'team' | 'business' | 'enterprise' }[]>`
      SELECT plan_tier AS tier FROM organizations WHERE id = ${org.organizationId}`
    await adminSql()`
      UPDATE plan_limits SET ai_spend_cap_cents = ${DEFAULT_PLAN_LIMITS[tenant!.tier].aiSpendCapCents}
      WHERE tier = ${tenant!.tier}`
    await adminSql()`
      DELETE FROM usage_records WHERE organization_id = ${org.organizationId}`
  })
})

describe('the words this company uses reach the search', () => {
  it('expands a query with the meaning, on whole words only', () => {
    const glossary = [{ term: 'IMM', meaning: 'Immingham port' }]
    expect(transformQuery('delays at IMM', glossary)).toBe('delays at IMM Immingham port')
    // Not a substring: "immediate" does not contain the term as a word.
    expect(transformQuery('immediate action', glossary)).toBe('immediate action')
  })

  it('cannot become a pattern, whatever somebody types as a term', () => {
    // A term is escaped before it becomes a regular expression, so a metacharacter matches
    // itself and nothing else. Admin-authored text never gets to decide what a search means.
    const dotted = [{ term: 'a.b', meaning: 'the a-b run' }]
    expect(transformQuery('the a.b run is late', dotted)).toContain('the a-b run')
    // Without the escape, `a.b` would match `axb` as well.
    expect(transformQuery('the axb run is late', dotted)).toBe('the axb run is late')

    // And something that is all metacharacters neither throws nor matches everything.
    const noisy = [{ term: '(.*)', meaning: 'everything' }]
    expect(transformQuery('an ordinary question', noisy)).toBe('an ordinary question')
  })

  it('refuses a term short enough to match every search', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(setGlossaryTerm(ctx, actor, { term: 'x', meaning: 'anything' })).rejects.toThrow(
        /almost every search/i,
      )
      await expect(setGlossaryTerm(ctx, actor, { term: 'ETA', meaning: 'e' })).rejects.toThrow(
        ValidationError,
      )
    })
    // And the database refuses it too, so no other writer can put one there.
    await expect(
      adminSql()`
        UPDATE organizations SET glossary = '[{"term":"x","meaning":"anything"}]'::jsonb
        WHERE id = ${org.organizationId}`,
    ).rejects.toThrow(/organizations_glossary_valid/)
  })

  it('holds one entry per term, so a meaning is corrected rather than doubled', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await setGlossaryTerm(ctx, actor, { term: 'IMM', meaning: 'Immingham' })
      const after = await setGlossaryTerm(ctx, actor, { term: 'imm', meaning: 'Immingham port' })
      const entries = after.glossary.filter((entry) => entry.term.toLowerCase() === 'imm')
      expect(entries).toHaveLength(1)
      expect(entries[0]!.meaning).toBe('Immingham port')
    })

    // The same rule in the database, which is what makes it true for every writer.
    await expect(
      adminSql()`
        UPDATE organizations
        SET glossary = '[{"term":"IMM","meaning":"one"},{"term":"imm","meaning":"two"}]'::jsonb
        WHERE id = ${org.organizationId}`,
    ).rejects.toThrow(/organizations_glossary_valid/)
  })

  it('reaches a real search, which is the whole point of it', async () => {
    // Through the real ingestion path, so the passage is embedded and indexed the way any
    // document is — a hand-inserted chunk would prove the query expansion and not the search.
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await uploadDocument(ctx, actor, {
        title: 'Berth allocation',
        body: [
          '# Berth allocation',
          '',
          '## Allocation',
          'Berths at Immingham port are allocated the evening before arrival.',
        ].join('\n'),
        docType: 'sop',
      })
    })

    const withoutTerm = await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await removeGlossaryTerm(ctx, actor, { term: 'IMM' })
      return hybridSearch(ctx, actor, 'IMM berths')
    })
    expect(withoutTerm.expandedQuery).toBe('IMM berths')

    const withTerm = await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await setGlossaryTerm(ctx, actor, { term: 'IMM', meaning: 'Immingham port' })
      return hybridSearch(ctx, actor, 'IMM berths')
    })
    expect(withTerm.expandedQuery).toBe('IMM berths Immingham port')
    // The term the person typed appears in no document; the meaning does, which is why the
    // expansion is the difference between finding the passage and not.
    expect(withTerm.chunks.length).toBeGreaterThan(0)
    expect(withTerm.chunks.some((chunk) => /Immingham/.test(chunk.content))).toBe(true)
  })

  it('refuses to remove one that is not there rather than saying it did something', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(removeGlossaryTerm(ctx, actor, { term: 'NOPE' })).rejects.toThrow(
        /not in the glossary/i,
      )
    })
  })
})

describe('the tone reaches the model, and cannot switch the rest off', () => {
  it('is kept as a note and merged into the profile rather than replacing it', async () => {
    await adminSql()`
      UPDATE organizations
      SET profile = '{"operatingSites":["Immingham"]}'::jsonb
      WHERE id = ${org.organizationId}`

    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const after = await updateOrganizationProfile(ctx, actor, {
        tone: 'Direct, warm, never breezy.',
      })
      expect(after.tone).toBe('Direct, warm, never breezy.')
    })

    // What this screen does not offer is still there. A write that silently drops keys it was
    // not asked about is a write nobody can trust.
    const [row] = await adminSql()<{ profile: Record<string, unknown> }[]>`
      SELECT profile FROM organizations WHERE id = ${org.organizationId}`
    expect(row!.profile['operatingSites']).toEqual(['Immingham'])
    expect(row!.profile['tone']).toBe('Direct, warm, never breezy.')
  })

  it('can be taken away, leaving no instruction rather than an empty one', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const after = await updateOrganizationProfile(ctx, actor, { tone: null })
      expect(after.tone).toBeNull()
    })
    const [row] = await adminSql()<{ hasTone: boolean }[]>`
      SELECT profile ? 'tone' AS "hasTone" FROM organizations WHERE id = ${org.organizationId}`
    expect(row!.hasTone).toBe(false)
  })

  it('reaches the prompt, and does not displace what the product already promises', () => {
    // The reader that makes this a control rather than a stored string, asked for the same way
    // the runtime asks for it — `loadSystemPrompt` is the one place the live version is named,
    // so this cannot pass while the product sends a prompt without the placeholder. The rules
    // above the organization's note are not the organization's to switch off, so both have to
    // be in what is rendered.
    const rendered = renderPrompt(loadSystemPrompt(), {
      org: {
        name: 'Northwind Logistics',
        industry: 'Freight forwarding',
        tone: 'This organization asks to be written to like this: Direct, warm, never breezy.',
      },
      user: { name: 'Maya', role: 'owner', department: 'Executive', timezone: 'Europe/London' },
      now: '2026-08-19T09:00:00.000Z',
      route_context: '/tasks',
      mode: 'ask',
      effective_capabilities: 'read only',
    })
    expect(rendered).toContain('Direct, warm, never breezy.')
    expect(rendered).toContain('Hedge honestly')
    expect(rendered).toContain('Every number carries its')
    expect(rendered).not.toContain('{{org.tone}}')

    // And an organization that has said nothing contributes nothing, rather than an empty
    // instruction the model has to interpret.
    const silent = renderPrompt(loadSystemPrompt(), {
      org: { name: 'Northwind Logistics', industry: 'Freight forwarding', tone: '' },
      user: { name: 'Maya', role: 'owner', department: 'Executive', timezone: 'Europe/London' },
      now: '2026-08-19T09:00:00.000Z',
      route_context: '/tasks',
      mode: 'ask',
      effective_capabilities: 'read only',
    })
    expect(silent.trimEnd()).toBe(silent.trimEnd().replace(/\n+$/, ''))
    expect(silent).toContain('Hedge honestly')
  })

  it('is refused by the database if it is not a string, whoever writes it', async () => {
    await expect(
      adminSql()`
        UPDATE organizations SET profile = '{"tone":42}'::jsonb WHERE id = ${org.organizationId}`,
    ).rejects.toThrow(/organizations_profile_valid/)
  })
})
