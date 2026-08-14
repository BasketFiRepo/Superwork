import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  applyRetention,
  deleteDocument,
  listDisclosures,
  listHolds,
  placeHold,
  previewErasure,
  releaseHold,
  StepUpRequiredError,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Legal holds (§21).
 *
 * A hold is a promise not to delete, and the only way anybody can rely on it is if the
 * purge actually consults it. So the properties asserted here are the ones that would be
 * argued about after the fact: that a held record survives a sweep that removes its
 * neighbours, that the hold reaches exactly the custodians and the period it claims, that
 * it refuses the two other ways records leave — erasure and document deletion — and that
 * every custodian was told, which is what keeps a hold from being covert retention of one
 * person's records.
 */

const DAY = 86_400_000
const daysAgo = (days: number) => new Date(Date.now() - days * DAY)

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let confirmed: { organizationId: string; userId: string; timezone: string; steppedUpAt: Date }

/** An agent run finished `days` ago, attributed to `principal`. */
async function seedRun(principal: string, days: number): Promise<string> {
  return withTenant(session, async (ctx) => {
    const [row] = await ctx.sql<{ id: string }[]>`
      INSERT INTO agent_runs (
        organization_id, principal_user_id, mode, status, request, trace_id, created_by,
        finished_at, created_at
      ) VALUES (
        ${ctx.organizationId}, ${principal}, 'ask', 'succeeded', 'hold fixture',
        ${`trace-${principal}-${days}-${Math.random()}`}, ${org.ownerId},
        ${daysAgo(days)}, ${daysAgo(days)}
      ) RETURNING id`
    return row!.id
  })
}

async function survivors(ids: string[]): Promise<string[]> {
  const rows = await adminSql()<{ id: string }[]>`
    SELECT id FROM agent_runs WHERE organization_id = ${org.organizationId} AND id = ANY(${ids}::uuid[])`
  return rows.map((row) => row.id)
}

beforeAll(async () => {
  org = await createTenant('hold')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
  confirmed = { ...session, steppedUpAt: new Date() }
})

afterAll(async () => {
  await destroyTenant('hold')
  await closePools()
})

describe('placing a hold', () => {
  it('refuses one with no matter, no basis, or a period that ends before it starts', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        placeHold(ctx, await loadActor(ctx), {
          matter: 'x',
          basis: 'Preservation notice received 2026-03-02 from counsel.',
          custodianIds: [],
          coversFrom: daysAgo(400),
        }),
      ),
    ).rejects.toThrow(ValidationError)

    // A hold with no stated basis is indistinguishable from keeping one person's records
    // for ever because somebody felt like it.
    await expect(
      withTenant(session, async (ctx) =>
        placeHold(ctx, await loadActor(ctx), {
          matter: 'Ahlgren',
          basis: 'because',
          custodianIds: [],
          coversFrom: daysAgo(400),
        }),
      ),
    ).rejects.toThrow(/what the hold is for/i)

    await expect(
      withTenant(session, async (ctx) =>
        placeHold(ctx, await loadActor(ctx), {
          matter: 'Ahlgren',
          basis: 'Preservation notice received 2026-03-02 from counsel.',
          custodianIds: [],
          coversFrom: daysAgo(100),
          coversTo: daysAgo(400),
        }),
      ),
    ).rejects.toThrow(/end after it starts/i)
  })

  it('needs no step-up, because preserving in a hurry is the point', async () => {
    // Deliberately the un-stepped-up session: this is the one destructive-adjacent admin
    // action that does not ask, and it should keep not asking.
    const hold = await withTenant(session, async (ctx) =>
      placeHold(ctx, await loadActor(ctx), {
        matter: 'Fast hold',
        basis: 'Counsel called at 17:40 and asked us to stop deleting immediately.',
        custodianIds: [org.viewerId],
        coversFrom: daysAgo(500),
      }),
    )
    expect(hold.live).toBe(true)
    await withTenant(confirmed, async (ctx) =>
      releaseHold(ctx, await loadActor(ctx), { holdId: hold.id, reason: 'Test teardown, matter never opened.' }),
    )
  })

  it('tells every custodian, in the log where they already look', async () => {
    const hold = await withTenant(session, async (ctx) =>
      placeHold(ctx, await loadActor(ctx), {
        matter: 'Bergström v. Fixture',
        basis: 'Preservation notice received 2026-03-02 from outside counsel.',
        custodianIds: [org.memberId],
        coversFrom: daysAgo(500),
      }),
    )

    // Read as the custodian: nobody may read somebody else's disclosure record, which is
    // the same rule that makes this notice worth anything.
    const disclosures = await withTenant(
      { organizationId: org.organizationId, userId: org.memberId, timezone: 'Europe/London' },
      async (ctx) => listDisclosures(ctx, await loadActor(ctx), org.memberId),
    )
    const notice = disclosures.find((d) => d.kind === 'legal_hold')
    expect(notice).toBeDefined()
    expect(notice!.summary).toMatch(/Bergström v\. Fixture/)
    // Never covert: the disclosures table refuses to store an invisible one at all, and the
    // custodian is the subject of this one.
    expect(notice!.summary).toMatch(/will not be deleted on the usual schedule/i)

    await withTenant(confirmed, async (ctx) =>
      releaseHold(ctx, await loadActor(ctx), { holdId: hold.id, reason: 'Test teardown.' }),
    )
  })
})

describe('what a hold stops', () => {
  it('keeps records past their window and lets their neighbours go', async () => {
    const held = await seedRun(org.memberId, 400)
    const outsideCustodian = await seedRun(org.viewerId, 400)
    const outsidePeriod = await seedRun(org.memberId, 900)

    const hold = await withTenant(session, async (ctx) =>
      placeHold(ctx, await loadActor(ctx), {
        matter: 'Reach test',
        basis: 'Preservation notice received 2026-03-02 from outside counsel.',
        custodianIds: [org.memberId],
        coversFrom: daysAgo(600),
        coversTo: daysAgo(200),
      }),
    )

    const outcomes = await withTenant(session, (ctx) => applyRetention(ctx))
    const runs = outcomes.find((outcome) => outcome.dataClass === 'agent_runs')!

    const left = await survivors([held, outsideCustodian, outsidePeriod])
    expect(left).toContain(held)
    // The hold names one custodian and one window. A record belonging to somebody else,
    // or from before the window opened, is not part of the matter and is not preserved.
    expect(left).not.toContain(outsideCustodian)
    expect(left).not.toContain(outsidePeriod)

    // And the sweep says so. A hold that works silently cannot be told apart from one that
    // does not work.
    expect(runs.held).toBeGreaterThanOrEqual(1)
    expect(runs.purged).toBeGreaterThanOrEqual(2)

    await withTenant(confirmed, async (ctx) =>
      releaseHold(ctx, await loadActor(ctx), { holdId: hold.id, reason: 'Reach test finished.' }),
    )
  })

  it('covers everybody when it names nobody', async () => {
    const mine = await seedRun(org.ownerId, 400)
    const theirs = await seedRun(org.viewerId, 400)

    const hold = await withTenant(session, async (ctx) =>
      placeHold(ctx, await loadActor(ctx), {
        matter: 'Whole organization',
        basis: 'Regulator opened a file on the whole company on 2026-02-01.',
        custodianIds: [],
        coversFrom: daysAgo(600),
      }),
    )

    await withTenant(session, (ctx) => applyRetention(ctx))
    const left = await survivors([mine, theirs])
    expect(left).toHaveLength(2)

    await withTenant(confirmed, async (ctx) =>
      releaseHold(ctx, await loadActor(ctx), { holdId: hold.id, reason: 'Regulator closed the file.' }),
    )
  })

  it('refuses to erase a custodian, and names the matter', async () => {
    const hold = await withTenant(session, async (ctx) =>
      placeHold(ctx, await loadActor(ctx), {
        matter: 'Ahlgren v. Northwind',
        basis: 'Preservation notice received 2026-03-02 from outside counsel.',
        custodianIds: [org.memberId],
        coversFrom: daysAgo(600),
      }),
    )

    const preview = await withTenant(session, async (ctx) =>
      previewErasure(ctx, await loadActor(ctx), org.memberId),
    )
    // Both obligations are real; only one of them can still be satisfied later, so the
    // erasure waits and the screen says which matter it is waiting on.
    expect(preview.blockers.some((blocker) => /Ahlgren v\. Northwind/.test(blocker))).toBe(true)
    expect(preview.blockers.some((blocker) => /destroy evidence/i.test(blocker))).toBe(true)

    await withTenant(confirmed, async (ctx) =>
      releaseHold(ctx, await loadActor(ctx), { holdId: hold.id, reason: 'Matter settled 2026-05-04.' }),
    )
    const after = await withTenant(session, async (ctx) => previewErasure(ctx, await loadActor(ctx), org.memberId))
    expect(after.blockers.some((blocker) => /Ahlgren/.test(blocker))).toBe(false)
  })

  it('refuses to delete a document inside the matter', async () => {
    const hold = await withTenant(session, async (ctx) =>
      placeHold(ctx, await loadActor(ctx), {
        matter: 'Document matter',
        basis: 'Preservation notice received 2026-03-02 from outside counsel.',
        custodianIds: [org.ownerId],
        coversFrom: daysAgo(600),
      }),
    )

    await expect(
      withTenant(session, async (ctx) =>
        deleteDocument(ctx, await loadActor(ctx), {
          documentId: org.documentId,
          reason: 'Tidying up.',
        }),
      ),
    ).rejects.toThrow(/preserved for “Document matter”/)

    await withTenant(confirmed, async (ctx) =>
      releaseHold(ctx, await loadActor(ctx), { holdId: hold.id, reason: 'Matter closed.' }),
    )
    const removed = await withTenant(session, async (ctx) =>
      deleteDocument(ctx, await loadActor(ctx), { documentId: org.documentId, reason: 'Tidying up.' }),
    )
    expect(removed.title).toMatch(/confidential document/)
  })
})

describe('releasing a hold', () => {
  it('will not release without re-confirming who you are, or without a reason', async () => {
    const hold = await withTenant(session, async (ctx) =>
      placeHold(ctx, await loadActor(ctx), {
        matter: 'Release rules',
        basis: 'Preservation notice received 2026-03-02 from outside counsel.',
        custodianIds: [],
        coversFrom: daysAgo(600),
      }),
    )

    // The next sweep will delete what this was keeping, and it will not ask first.
    await expect(
      withTenant(session, async (ctx) =>
        releaseHold(ctx, await loadActor(ctx), { holdId: hold.id, reason: 'Matter closed 2026-05-04.' }),
      ),
    ).rejects.toThrow(StepUpRequiredError)

    await expect(
      withTenant(confirmed, async (ctx) =>
        releaseHold(ctx, await loadActor(ctx), { holdId: hold.id, reason: 'done' }),
      ),
    ).rejects.toThrow(/why the matter is closed/i)

    const released = await withTenant(confirmed, async (ctx) =>
      releaseHold(ctx, await loadActor(ctx), { holdId: hold.id, reason: 'Matter closed 2026-05-04.' }),
    )
    expect(released.live).toBe(false)
    expect(released.releaseReason).toMatch(/2026-05-04/)
    expect(released.releasedByName).toBeTruthy()

    await expect(
      withTenant(confirmed, async (ctx) =>
        releaseHold(ctx, await loadActor(ctx), { holdId: hold.id, reason: 'Matter closed 2026-05-04.' }),
      ),
    ).rejects.toThrow(/already released/i)
  })

  it('lets the records go on the next sweep, and stays in the record itself', async () => {
    const run = await seedRun(org.ownerId, 400)
    const hold = await withTenant(session, async (ctx) =>
      placeHold(ctx, await loadActor(ctx), {
        matter: 'Then released',
        basis: 'Preservation notice received 2026-03-02 from outside counsel.',
        custodianIds: [org.ownerId],
        coversFrom: daysAgo(600),
      }),
    )

    await withTenant(session, (ctx) => applyRetention(ctx))
    expect(await survivors([run])).toContain(run)

    await withTenant(confirmed, async (ctx) =>
      releaseHold(ctx, await loadActor(ctx), { holdId: hold.id, reason: 'Matter closed 2026-05-04.' }),
    )
    await withTenant(session, (ctx) => applyRetention(ctx))
    expect(await survivors([run])).not.toContain(run)

    // A released hold is not a deleted hold: what was preserved, for what, and who decided
    // to stop is the whole point of being able to answer for it afterwards.
    const holds = await withTenant(session, async (ctx) => listHolds(ctx, await loadActor(ctx)))
    const record = holds.find((entry) => entry.id === hold.id)
    expect(record).toBeDefined()
    expect(record!.live).toBe(false)
    expect(record!.basis).toMatch(/Preservation notice/)
  })

  it('records placing and releasing in the audit trail', async () => {
    const actions = await adminSql()<{ action: string }[]>`
      SELECT DISTINCT action FROM audit_logs
      WHERE organization_id = ${org.organizationId} AND action LIKE 'legal_hold.%'`
    expect(actions.map((row) => row.action).sort()).toEqual(['legal_hold.placed', 'legal_hold.released'])
  })
})

describe('a hold belongs to one organization', () => {
  it('does not preserve another tenant’s records', async () => {
    const other = await createTenant('hold-other')
    const otherSession = { organizationId: other.organizationId, userId: other.ownerId, timezone: 'Europe/London' }

    const hold = await withTenant(session, async (ctx) =>
      placeHold(ctx, await loadActor(ctx), {
        matter: 'Ours alone',
        basis: 'Preservation notice received 2026-03-02 from outside counsel.',
        custodianIds: [],
        coversFrom: daysAgo(600),
      }),
    )

    const theirRun = await withTenant(otherSession, async (ctx) => {
      const [row] = await ctx.sql<{ id: string }[]>`
        INSERT INTO agent_runs (
          organization_id, principal_user_id, mode, status, request, trace_id, created_by,
          finished_at, created_at
        ) VALUES (
          ${ctx.organizationId}, ${other.ownerId}, 'ask', 'succeeded', 'other tenant',
          ${`trace-other-${Math.random()}`}, ${other.ownerId}, ${daysAgo(400)}, ${daysAgo(400)}
        ) RETURNING id`
      return row!.id
    })

    await withTenant(otherSession, (ctx) => applyRetention(ctx))
    const [left] = await adminSql()<{ count: string }[]>`
      SELECT count(*)::text AS count FROM agent_runs WHERE id = ${theirRun}`
    // Our hold is ours. Their sweep never saw it.
    expect(Number(left?.count ?? 0)).toBe(0)

    const theirHolds = await withTenant(otherSession, async (ctx) => listHolds(ctx, await loadActor(ctx)))
    expect(theirHolds).toHaveLength(0)

    await withTenant(confirmed, async (ctx) =>
      releaseHold(ctx, await loadActor(ctx), { holdId: hold.id, reason: 'Cross-tenant check finished.' }),
    )
    await destroyTenant('hold-other')
  })
})
