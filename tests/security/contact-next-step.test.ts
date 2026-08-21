import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant, type Role } from '@superwork/db'
import { can, loadActor, ROLE_PERMISSIONS, type Actor } from '@superwork/auth'
import { listContacts, getContact } from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * A next step that is already true (ADR 0071).
 *
 * `contacts.next_step` and `contacts.next_step_at` were added in 0010 and nothing ever wrote
 * either. The repair was not to make them writable — that would have been a fourth place
 * meaning "something is owed", beside commitments, follow-ups and tasks, reconciled with none
 * of them. The product already knows what is next with a person; what was missing was the query.
 *
 * So these tests are mostly about *which* facts count as a next step and which deliberately
 * do not.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let owner: { organizationId: string; userId: string; timezone: string }
let actor: Actor
let contactId: string
let otherContactId: string

const DAY = 86_400_000

async function contact(id = contactId) {
  return withTenant(owner, async (ctx) => getContact(ctx, actor, id))
}

async function commitment(input: {
  contactId: string | null
  obligation: string
  direction: 'we_owe' | 'they_owe'
  status: string
  dueInDays: number | null
}): Promise<string> {
  const [row] = await adminSql()<{ id: string }[]>`
    INSERT INTO commitments (organization_id, owner_user_id, counterparty_contact_id, obligation,
                             direction, due_at, status, is_demo, created_by)
    VALUES (${org.organizationId}, ${org.ownerId}, ${input.contactId}, ${input.obligation},
            ${input.direction}::sw_commitment_direction,
            ${input.dueInDays === null ? null : new Date(Date.now() + input.dueInDays * DAY)},
            ${input.status}::sw_commitment_status, true, ${org.ownerId})
    RETURNING id`
  return row!.id
}

async function meeting(input: {
  contactId: string
  title: string
  inDays: number
  status?: string
}): Promise<string> {
  const startsAt = new Date(Date.now() + input.inDays * DAY)
  const [row] = await adminSql()<{ id: string }[]>`
    INSERT INTO meetings (organization_id, title, starts_at, ends_at, status, is_demo, created_by)
    VALUES (${org.organizationId}, ${input.title}, ${startsAt},
            ${new Date(startsAt.getTime() + 3_600_000)},
            ${input.status ?? 'scheduled'}::sw_meeting_status, true, ${org.ownerId})
    RETURNING id`
  await adminSql()`
    INSERT INTO meeting_participants (organization_id, meeting_id, contact_id, display_name,
                                      role, is_demo, created_by)
    VALUES (${org.organizationId}, ${row!.id}, ${input.contactId}, 'Outsider', 'external', true,
            ${org.ownerId})`
  return row!.id
}

/** Everything written by a beat, so the next beat starts from "nothing is next". */
async function clear() {
  await adminSql()`DELETE FROM commitments WHERE organization_id = ${org.organizationId}`
  await adminSql()`DELETE FROM meeting_participants WHERE organization_id = ${org.organizationId}`
  await adminSql()`DELETE FROM meetings WHERE organization_id = ${org.organizationId}`
}

beforeAll(async () => {
  org = await createTenant('contact-next-step')
  owner = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  const made = await adminSql()<{ id: string }[]>`
    INSERT INTO contacts (organization_id, company_id, name, emails, is_demo, created_by)
    VALUES (${org.organizationId}, ${org.companyId}, 'Ingrid Solberg',
            ${['ingrid@fixture.example']}, true, ${org.ownerId}),
           (${org.organizationId}, ${org.companyId}, 'Peter Nowak',
            ${['peter@fixture.example']}, true, ${org.ownerId})
    RETURNING id`
  contactId = made[0]!.id
  otherContactId = made[1]!.id
  actor = await withTenant(owner, async (ctx) => loadActor(ctx))
})

afterAll(async () => {
  await destroyTenant('contact-next-step')
  await closePools()
})

describe('what counts as a next step', () => {
  it('is nothing at all when nothing is owed and nobody is meeting them', async () => {
    await clear()
    const row = await contact()
    // Not a stale string somebody typed in March. There is genuinely nothing next.
    expect(row.nextStep).toBeNull()
  })

  it('is an outstanding promise they are the counterparty to', async () => {
    await clear()
    await commitment({
      contactId,
      obligation: 'Confirm the Gothenburg inbound window with Coldstore.',
      direction: 'we_owe',
      status: 'confirmed',
      dueInDays: 2,
    })
    const row = await contact()
    expect(row.nextStep?.source).toBe('commitment')
    expect(row.nextStep?.what).toMatch(/Gothenburg/)
    expect(row.nextStep?.direction).toBe('we_owe')
  })

  it('and a promise running the other way is just as much a next step', async () => {
    await clear()
    await commitment({
      contactId,
      obligation: 'Halden will send their QA sign-off form.',
      direction: 'they_owe',
      status: 'confirmed',
      dueInDays: 1,
    })
    expect((await contact()).nextStep?.direction).toBe('they_owe')
  })

  it('is a meeting they are coming to', async () => {
    await clear()
    await meeting({ contactId, title: 'Peak season readiness review', inDays: 3 })
    const row = await contact()
    expect(row.nextStep?.source).toBe('meeting')
    expect(row.nextStep?.what).toBe('Peak season readiness review')
    expect(row.nextStep?.direction).toBeNull()
  })

  it('is the soonest of the two, whichever kind that turns out to be', async () => {
    await clear()
    await meeting({ contactId, title: 'Peak season readiness review', inDays: 6 })
    await commitment({
      contactId,
      obligation: 'Answer the pre-cool question in writing.',
      direction: 'we_owe',
      status: 'confirmed',
      dueInDays: 4,
    })
    expect((await contact()).nextStep?.source).toBe('commitment')

    await meeting({ contactId, title: 'Excursion close-out', inDays: 1 })
    expect((await contact()).nextStep?.what).toBe('Excursion close-out')
  })
})

describe('what deliberately does not', () => {
  it('a proposal nobody has accepted, because the ledger calls that a suggestion', async () => {
    await clear()
    await commitment({
      contactId,
      obligation: 'Someone might look at the demurrage position.',
      direction: 'we_owe',
      status: 'proposed',
      dueInDays: 2,
    })
    // ADR 0066 built the whole ledger on this distinction; a next step is not the place to
    // quietly undo it.
    expect((await contact()).nextStep).toBeNull()
  })

  it('a promise already kept, or cancelled', async () => {
    await clear()
    await commitment({ contactId, obligation: 'Done.', direction: 'we_owe', status: 'kept', dueInDays: 2 })
    await commitment({
      contactId,
      obligation: 'Dropped.',
      direction: 'they_owe',
      status: 'cancelled',
      dueInDays: 1,
    })
    expect((await contact()).nextStep).toBeNull()
  })

  it('a promise with no date, which is not a step anybody can take next', async () => {
    await clear()
    await commitment({
      contactId,
      obligation: 'Look into the demurrage position at some point.',
      direction: 'we_owe',
      status: 'confirmed',
      dueInDays: null,
    })
    expect((await contact()).nextStep).toBeNull()
  })

  it('a meeting that has already happened, or been cancelled', async () => {
    await clear()
    await meeting({ contactId, title: 'Last month’s review', inDays: -30, status: 'completed' })
    await meeting({ contactId, title: 'The one nobody held', inDays: 5, status: 'cancelled' })
    expect((await contact()).nextStep).toBeNull()
  })

  /**
   * The asymmetry, which is the point rather than an oversight. A date that has passed on a
   * promise is still what is next with the person — it is what is next *and late*. A meeting
   * that has passed is history.
   */
  it('but an overdue promise is still what is next, and sorts first', async () => {
    await clear()
    await commitment({
      contactId,
      obligation: 'The written pre-cool answer, owed last week.',
      direction: 'we_owe',
      status: 'confirmed',
      dueInDays: -7,
    })
    await meeting({ contactId, title: 'Next week’s review', inDays: 7 })
    const row = await contact()
    expect(row.nextStep?.source).toBe('commitment')
    expect(row.nextStep?.at.getTime()).toBeLessThan(Date.now())
  })

  it('and somebody else’s promise, which belongs to somebody else', async () => {
    await clear()
    await commitment({
      contactId: otherContactId,
      obligation: 'Peter’s problem.',
      direction: 'we_owe',
      status: 'confirmed',
      dueInDays: 1,
    })
    // A commitment with no counterparty at all is nobody's next step either.
    await commitment({
      contactId: null,
      obligation: 'Owed to the account, not to a person.',
      direction: 'we_owe',
      status: 'confirmed',
      dueInDays: 1,
    })
    expect((await contact()).nextStep).toBeNull()
    expect((await contact(otherContactId)).nextStep?.what).toBe('Peter’s problem.')
  })
})

describe('the column it replaced', () => {
  it('is gone, so there is no second place for this to disagree with', async () => {
    const columns = await adminSql()<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'contacts' AND column_name IN ('next_step', 'next_step_at')`
    expect(columns).toHaveLength(0)
  })
})

describe('who may read it', () => {
  /**
   * The derivation reads two tables the caller was never gated on. It is not a widening,
   * because every role that can list contacts can already list both — but "it happens to be
   * true today" is not a control, so the ladder is walked here and the invariant stated.
   */
  it('learns nothing a contact reader could not already read for themselves', () => {
    const resource = (type: string) => ({ type, organizationId: org.organizationId })
    for (const role of Object.keys(ROLE_PERMISSIONS) as Role[]) {
      const who = { ...actor, role, permissions: ROLE_PERMISSIONS[role] } as Actor
      if (!can(who, 'contact:read', resource('contact')).allow) continue
      expect(can(who, 'conversation:read', resource('conversation')).allow).toBe(true)
      expect(can(who, 'project:read', resource('project')).allow).toBe(true)
    }
  })

  it('is not visible across a tenant boundary, because the contact is not', async () => {
    await clear()
    await commitment({
      contactId,
      obligation: 'Visible to this organization only.',
      direction: 'we_owe',
      status: 'confirmed',
      dueInDays: 1,
    })
    const other = await createTenant('contact-next-step-b')
    try {
      const rows = await withTenant(
        { organizationId: other.organizationId, userId: other.ownerId, timezone: TZ },
        async (ctx) => listContacts(ctx, await loadActor(ctx), {}),
      )
      expect(rows.some((r) => r.id === contactId)).toBe(false)
    } finally {
      await destroyTenant('contact-next-step-b')
    }
  })
})
