import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  createApproval,
  createTask,
  deliverDueNudges,
  directReports,
  getApproval,
  listDisclosures,
  managerOf,
  managersOf,
  NotFoundError,
  orgChart,
  PermissionError,
  personalRecord,
  removeReportingLine,
  reportingFor,
  scheduleLadder,
  setReportingLine,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, makeReachable, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Reporting lines (§26.1, §29.2, §29.5).
 *
 * `reporting_relationships` was seeded with a real org chart in migration 0001 and read by
 * nothing. Three controls sat on top of it and all three were hollow:
 *
 *   • the ladder's fifth rung declares `audience: 'manager'` and every rung was delivered
 *     to `recipient_user_id` — so the escalation went to the *owner*, carrying a message
 *     written in the third person about them;
 *   • `noSurprisesReviewHours` was defined on every profile and enforced nowhere;
 *   • the compliance review counted stage-5 nudges as escalations that had reached a
 *     manager, which none of them had.
 *
 * The rule this pack exists to hold: a reporting line routes accountability *to a person*,
 * and every time it carries something about somebody, that person can see that it did.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let memberSession: { organizationId: string; userId: string; timezone: string }
let taskId: string

const DAY = 86_400_000

beforeAll(async () => {
  org = await createTenant('reporting-lines')
  // These packs assert that something arrives, which now depends on the recipient not being
  // in their own quiet hours (ADR 0047). Say so rather than depending on the hour.
  for (const userId of [org.ownerId, org.memberId, org.viewerId]) {
    await makeReachable(org.organizationId, userId)
  }
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
  memberSession = { organizationId: org.organizationId, userId: org.memberId, timezone: 'Europe/London' }

  // With no legal entity the profile falls to `works_council`, the strictest, which forbids
  // manager escalation entirely — the right default and the wrong setting for testing that
  // escalation works. A `gdpr` entity permits it once the person has seen it first.
  await withTenant(session, async (ctx) => {
    await ctx.sql`
      INSERT INTO legal_entities (organization_id, name, country, jurisdiction_profile, is_demo, created_by)
      VALUES (${ctx.organizationId}, 'Fixture GmbH', 'DE', 'gdpr', true, ${org.ownerId})`
  })

  await withTenant(session, async (ctx) => {
    const task = await createTask(ctx, await loadActor(ctx), {
      title: 'The overdue thing',
      assigneeId: org.memberId,
      dueAt: new Date(Date.now() - 10 * DAY),
    })
    taskId = task.id
  })
})

afterAll(async () => {
  await destroyTenant('reporting-lines')
  await closePools()
})

describe('the chart itself', () => {
  it('records a line with its reason, and refuses one without', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        setReportingLine(ctx, await loadActor(ctx), {
          personId: org.memberId,
          managerId: org.ownerId,
          type: 'functional',
          reason: '   ',
        }),
      ),
    ).rejects.toThrow(ValidationError)

    const line = await withTenant(session, async (ctx) =>
      setReportingLine(ctx, await loadActor(ctx), {
        personId: org.memberId,
        managerId: org.ownerId,
        type: 'functional',
        reason: 'Joined the renewals team in the March reorganisation.',
      }),
    )
    expect(line.managerName).toBeTruthy()
    expect(line.reason).toMatch(/renewals team/)
  })

  it('refuses a loop, in the database rather than politely at the API', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        setReportingLine(ctx, await loadActor(ctx), {
          personId: org.ownerId,
          managerId: org.memberId,
          type: 'functional',
          reason: 'This would close the loop.',
        }),
      ),
    ).rejects.toThrow(/loop/i)
  })

  it('refuses somebody reporting to themselves', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        setReportingLine(ctx, await loadActor(ctx), {
          personId: org.memberId,
          managerId: org.memberId,
          type: 'functional',
          reason: 'Nonsense.',
        }),
      ),
    ).rejects.toThrow(ValidationError)
  })

  it('keeps one functional manager, replacing rather than adding', async () => {
    await withTenant(session, async (ctx) =>
      setReportingLine(ctx, await loadActor(ctx), {
        personId: org.viewerId,
        managerId: org.ownerId,
        type: 'functional',
        reason: 'Initial line.',
      }),
    )
    await withTenant(session, async (ctx) =>
      setReportingLine(ctx, await loadActor(ctx), {
        personId: org.viewerId,
        managerId: org.memberId,
        type: 'functional',
        reason: 'Moved under the member.',
      }),
    )
    const managers = await withTenant(session, async (ctx) => managersOf(ctx, org.viewerId))
    // Nearest first, then up the chain: member, then the member's own manager.
    expect(managers[0]).toBe(org.memberId)
    expect(managers).toContain(org.ownerId)
  })

  it('allows several dotted lines, and never routes by them', async () => {
    await withTenant(session, async (ctx) =>
      setReportingLine(ctx, await loadActor(ctx), {
        personId: org.viewerId,
        managerId: org.ownerId,
        type: 'dotted',
        reason: 'Sits with the owner for the renewal work.',
      }),
    )
    const { managers } = await withTenant(session, async (ctx) =>
      reportingFor(ctx, await loadActor(ctx), org.viewerId),
    )
    expect(managers.map((line) => line.type).sort()).toEqual(['dotted', 'functional'])

    // The escalation path is functional only: two answers to "who is answerable" is no answer.
    const escalatesTo = await withTenant(session, async (ctx) => managerOf(ctx, org.viewerId))
    expect(escalatesTo).toBe(org.memberId)
  })

  it('closes a line rather than deleting it', async () => {
    const before = await withTenant(session, async (ctx) => orgChart(ctx, await loadActor(ctx)))
    const dotted = before.find((line) => line.type === 'dotted')
    await withTenant(session, async (ctx) =>
      removeReportingLine(ctx, await loadActor(ctx), {
        lineId: dotted!.id,
        reason: 'The renewal work finished.',
      }),
    )
    const after = await withTenant(session, async (ctx) => orgChart(ctx, await loadActor(ctx)))
    expect(after.map((line) => line.id)).not.toContain(dotted!.id)

    // "Who did they report to in March" stays answerable.
    const [row] = await adminSql()<{ validTo: Date | null; deletedAt: Date | null }[]>`
      SELECT valid_to AS "validTo", deleted_at AS "deletedAt"
      FROM reporting_relationships WHERE id = ${dotted!.id}`
    expect(row?.validTo).toBeTruthy()
    expect(row?.deletedAt).toBeNull()
  })

  it('is not something an ordinary member can rewrite', async () => {
    await expect(
      withTenant(memberSession, async (ctx) =>
        setReportingLine(ctx, await loadActor(ctx), {
          personId: org.ownerId,
          managerId: org.memberId,
          type: 'functional',
          reason: 'Promoting myself.',
        }),
      ),
    ).rejects.toThrow(PermissionError)
  })
})

describe('an escalation goes to the manager, not to the person about whom it is written', () => {
  it('was delivered to the owner, in the third person, about themselves', async () => {
    // The regression. Stage 5's template is "{owner} has an item {days} days overdue that
    // others are waiting on" and it went to {owner}.
    const scheduled = await withTenant(session, async (ctx) =>
      scheduleLadder(ctx, {
        recipientUserId: org.memberId,
        subjectType: 'task',
        subjectId: taskId,
        subjectLabel: 'The overdue thing',
        dueAt: new Date(Date.now() - 10 * DAY),
        ownerName: 'The member',
      }),
    )
    // Nothing has been delivered to the owner yet, so the escalation rung is held back
    // rather than sent — the no-surprises rule, which nothing enforced.
    expect(scheduled.scheduled).toBe(0)
    expect(scheduled.skipped).toMatch(/have not been contacted|seen it/i)
  })

  it('reaches the manager once the person has been contacted and given the window', async () => {
    // Contact them first, and backdate it past the review window.
    await withTenant(session, async (ctx) => {
      await ctx.sql`
        INSERT INTO nudges (organization_id, recipient_user_id, subject_type, subject_id, stage,
                            channel, message, scheduled_for, delivered_at, created_by)
        VALUES (${ctx.organizationId}, ${org.memberId}, 'task', ${taskId}, 2, 'in_app',
                'Still open — mark it done, or set a new date.', now() - interval '3 days',
                now() - interval '3 days', ${org.ownerId})`
    })

    const scheduled = await withTenant(session, async (ctx) =>
      scheduleLadder(ctx, {
        recipientUserId: org.memberId,
        subjectType: 'task',
        subjectId: taskId,
        subjectLabel: 'The overdue thing',
        dueAt: new Date(Date.now() - 10 * DAY),
        ownerName: 'The member',
      }),
    )
    expect(scheduled.scheduled).toBe(1)

    const [row] = await adminSql()<{ recipient: string; about: string | null; stage: number }[]>`
      SELECT recipient_user_id AS recipient, about_user_id AS about, stage FROM nudges
      WHERE organization_id = ${org.organizationId} AND subject_id = ${taskId}
        AND delivered_at IS NULL ORDER BY created_at DESC LIMIT 1`
    expect(row?.stage).toBe(5)
    expect(row?.recipient).toBe(org.ownerId)
    expect(row?.about).toBe(org.memberId)
  })

  it('tells the person it was about, in the same transaction as the delivery', async () => {
    await withTenant(session, async (ctx) => deliverDueNudges(ctx, { now: new Date() }))

    const disclosed = await withTenant(memberSession, async (ctx) =>
      listDisclosures(ctx, await loadActor(ctx), org.memberId),
    )
    const escalation = disclosed.find((entry) => entry.kind === 'manager_rollup')
    expect(escalation).toBeDefined()
    expect(escalation!.summary).toMatch(/escalated to/i)
    // "Nothing reaches your manager that you have not seen" is only a claim if it is
    // evidenced, and this is the evidence.
    expect(escalation!.recipientUserId).toBe(org.ownerId)
  })

  it('does not escalate at all under a profile that forbids it', async () => {
    // The rung is skipped before a recipient is even resolved. A co-determined workplace
    // gets no manager escalation regardless of what the chart says.
    await withTenant(session, async (ctx) => {
      await ctx.sql`UPDATE legal_entities SET jurisdiction_profile = 'works_council'
        WHERE organization_id = ${ctx.organizationId}`
    })
    const strict = await withTenant(session, async (ctx) => {
      const task = await createTask(ctx, await loadActor(ctx), {
        title: 'Overdue under a works council',
        assigneeId: org.memberId,
        dueAt: new Date(Date.now() - 10 * DAY),
      })
      await ctx.sql`
        INSERT INTO nudges (organization_id, recipient_user_id, subject_type, subject_id, stage,
                            channel, message, scheduled_for, delivered_at, created_by)
        VALUES (${ctx.organizationId}, ${org.memberId}, 'task', ${task.id}, 2, 'in_app',
                'Still open.', now() - interval '3 days', now() - interval '3 days', ${org.ownerId})`
      return scheduleLadder(ctx, {
        recipientUserId: org.memberId,
        subjectType: 'task',
        subjectId: task.id,
        subjectLabel: 'Overdue under a works council',
        dueAt: new Date(Date.now() - 10 * DAY),
        ownerName: 'The member',
      })
    })
    // It falls to the waiter rung, and with nobody waiting there is nobody to tell — which
    // is the honest outcome rather than telling the owner about themselves.
    expect(strict.scheduled).toBe(0)
    expect(strict.skipped).toMatch(/nobody is waiting|nobody to tell/i)

    await withTenant(session, async (ctx) => {
      await ctx.sql`UPDATE legal_entities SET jurisdiction_profile = 'gdpr'
        WHERE organization_id = ${ctx.organizationId}`
    })
  })

  it('does not escalate at all when nobody is recorded as their manager', async () => {
    // The alternative — falling back to the owner — is what made the audience field
    // meaningless, and it reads as a system telling you about yourself in the third person.
    const [line] = await adminSql()<{ id: string }[]>`
      SELECT id FROM reporting_relationships
      WHERE organization_id = ${org.organizationId} AND person_id = ${org.memberId}
        AND type = 'functional' AND valid_to IS NULL AND deleted_at IS NULL`
    await adminSql()`UPDATE reporting_relationships SET valid_to = now() WHERE id = ${line!.id}`

    const orphan = await withTenant(session, async (ctx) => {
      const task = await createTask(ctx, await loadActor(ctx), {
        title: 'Nobody answers for this',
        assigneeId: org.memberId,
        dueAt: new Date(Date.now() - 10 * DAY),
      })
      await ctx.sql`
        INSERT INTO nudges (organization_id, recipient_user_id, subject_type, subject_id, stage,
                            channel, message, scheduled_for, delivered_at, created_by)
        VALUES (${ctx.organizationId}, ${org.memberId}, 'task', ${task.id}, 2, 'in_app',
                'Still open.', now() - interval '3 days', now() - interval '3 days', ${org.ownerId})`
      return scheduleLadder(ctx, {
        recipientUserId: org.memberId,
        subjectType: 'task',
        subjectId: task.id,
        subjectLabel: 'Nobody answers for this',
        dueAt: new Date(Date.now() - 10 * DAY),
        ownerName: 'The member',
      })
    })
    expect(orphan.scheduled).toBe(0)
    expect(orphan.skipped).toMatch(/nobody is recorded as theirs/i)

    // Put it back for the tests after this one.
    await adminSql()`UPDATE reporting_relationships SET valid_to = NULL WHERE id = ${line!.id}`
  })
})

describe('an approval goes to the person answerable, not to a role at large', () => {
  it('routes to the requester’s manager when the policy names a role above them', async () => {
    const id = await withTenant(memberSession, async (ctx) =>
      createApproval(ctx, await loadActor(ctx), {
        title: 'Send the renewal note',
        riskTier: 'high',
        preview: [
          {
            operation: 'Send email',
            entityType: 'email',
            entityLabel: 'Renewal',
            changes: [{ field: 'Body', to: 'The terms are attached.' }],
            riskTier: 'high',
            reversible: false,
          },
        ],
        evidence: [],
        requestedByLabel: 'A member',
        approverRole: 'manager',
      }),
    )
    const view = await withTenant(session, async (ctx) => getApproval(ctx, await loadActor(ctx), id))
    // Not "any manager in the company" — the person answerable for the requester.
    expect(view.approverUserId).toBe(org.ownerId)
    expect(view.approverRole).toBe('manager')
  })
})

describe('a person can see their own line, and it is not a window onto anybody', () => {
  it('shows the chain on the personal record', async () => {
    const record = await withTenant(memberSession, async (ctx) =>
      personalRecord(ctx, await loadActor(ctx), org.memberId),
    )
    expect(record.reporting.managers.map((line) => line.name)).toHaveLength(1)
    expect(record.neverCollected.join(' ')).toMatch(/productivity score/i)
  })

  it('lets a manager see who reports to them, and nothing about their work', async () => {
    // The chart is names and lines. There is no call here that returns a report's tasks,
    // activity or any metric — that is the §29.5 prohibition, not an omission.
    const reports = await withTenant(session, async (ctx) => directReports(ctx, org.ownerId))
    expect(reports.length).toBeGreaterThan(0)
    expect(Object.keys(reports[0]!)).toEqual([
      'id', 'personId', 'personName', 'managerId', 'managerName', 'type', 'reason', 'setByName', 'validFrom',
    ])
  })
})

describe('a chart belongs to one organization', () => {
  it('will not link people across tenants, and reports absence', async () => {
    const other = await createTenant('reporting-lines-other')
    await expect(
      withTenant(session, async (ctx) =>
        setReportingLine(ctx, await loadActor(ctx), {
          personId: org.memberId,
          managerId: other.ownerId,
          type: 'functional',
          reason: 'Should be impossible.',
        }),
      ),
    ).rejects.toThrow(NotFoundError)

    const theirs = await withTenant(
      { organizationId: other.organizationId, userId: other.ownerId, timezone: 'Europe/London' },
      async (ctx) => orgChart(ctx, await loadActor(ctx)),
    )
    expect(theirs).toHaveLength(0)
    await destroyTenant('reporting-lines-other')
  })
})
