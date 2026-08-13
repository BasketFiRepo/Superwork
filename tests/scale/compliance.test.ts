import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  cancelLadder,
  createLegalEntity,
  deliverDueNudges,
  listNudges,
  nudgeBudget,
  PROFILES,
  recordConsultation,
  recordDisclosure,
  scheduleLadder,
  setJurisdiction,
  share,
  strictestProfile,
  worksCouncilReview,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Phase 4's third acceptance criterion (§24): "the accountability features pass a
 * works-council-style review in the strictest configured jurisdiction."
 *
 * The review is only worth having if it can fail, so these tests check both directions:
 * a clean tenant passes, and a tenant that breaks a rule is reported as breaking it.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let entityId: string

beforeAll(async () => {
  org = await createTenant('compliance')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }

  await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx, org.ownerId)
    await ctx.sql`
      INSERT INTO monitoring_policies (organization_id, jurisdiction_profile, created_by)
      VALUES (${ctx.organizationId}, 'strict', ${org.ownerId})`
    const entity = await createLegalEntity(ctx, actor, { name: 'Northwind GmbH', country: 'DE' })
    entityId = entity.id
  })
})

afterAll(async () => {
  await destroyTenant(org.organizationId)
  await closePools()
})

describe('jurisdiction profiles', () => {
  it('defaults a new entity to the strictest profile', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx, org.ownerId)
      const review = await worksCouncilReview(ctx, actor)
      expect(review.profile).toBe('works_council')
      expect(review.entities[0]!.jurisdictionProfile).toBe('works_council')
    })
  })

  it('refuses to loosen a profile without a named approver', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx, org.ownerId)
      await expect(
        setJurisdiction(ctx, actor, {
          legalEntityId: entityId,
          profile: 'standard',
          justification: 'We would like fewer restrictions.',
        }),
      ).rejects.toThrow(/named approver/i)
    })
  })

  it('records who loosened it, and why', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx, org.ownerId)
      await setJurisdiction(ctx, actor, {
        legalEntityId: entityId,
        profile: 'gdpr',
        justification: 'No works council exists at this entity; confirmed with counsel.',
        approvedBy: org.memberId,
      })
      const [change] = await ctx.sql<{ from_profile: string; to_profile: string; justification: string }[]>`
        SELECT from_profile, to_profile, justification FROM jurisdiction_changes
        WHERE organization_id = ${ctx.organizationId} ORDER BY changed_at DESC LIMIT 1`
      expect(change?.from_profile).toBe('works_council')
      expect(change?.to_profile).toBe('gdpr')
      expect(change?.justification).toMatch(/counsel/i)

      // Put it back — the rest of the suite reviews against the strictest profile.
      await setJurisdiction(ctx, actor, {
        legalEntityId: entityId,
        profile: 'works_council',
        justification: 'Restoring the default.',
      })
    })
  })

  it('takes the strictest profile in use, not the average', () => {
    expect(strictestProfile([{ jurisdictionProfile: 'standard' }, { jurisdictionProfile: 'works_council' }])).toBe(
      'works_council',
    )
    expect(strictestProfile([{ jurisdictionProfile: 'standard' }, { jurisdictionProfile: 'gdpr' }])).toBe('gdpr')
    expect(strictestProfile([])).toBe('works_council')
  })
})

describe('the works-council review', () => {
  it('fails while the consultation is missing, and passes once it is recorded', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx, org.ownerId)

      const before = await worksCouncilReview(ctx, actor)
      const consultationBefore = before.findings.find((finding) => finding.id === 'consultation')!
      expect(consultationBefore.status).toBe('fail')

      await recordConsultation(ctx, actor, {
        legalEntityId: entityId,
        status: 'agreed',
        reference: 'BV-2026-014',
      })

      const after = await worksCouncilReview(ctx, actor)
      const consultationAfter = after.findings.find((finding) => finding.id === 'consultation')!
      expect(consultationAfter.status).toBe('pass')
      expect(consultationAfter.evidence).toContain('BV-2026-014')
    })
  })

  it('answers every question with evidence from this tenant', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx, org.ownerId)
      const review = await worksCouncilReview(ctx, actor)

      expect(review.findings.length).toBeGreaterThanOrEqual(10)
      for (const finding of review.findings) {
        expect(finding.evidence.length, `${finding.id} has no evidence`).toBeGreaterThan(20)
        expect(finding.why.length, `${finding.id} does not say why it is asked`).toBeGreaterThan(20)
      }
      expect(review.failed, JSON.stringify(review.findings.filter((f) => f.status !== 'pass'), null, 2)).toBe(0)
    })
  })

  it('cannot store a covert disclosure at all', async () => {
    // Outside a tenant transaction on purpose: the statement fails, and a failed statement
    // inside `withTenant` would poison the surrounding transaction rather than being
    // caught. The constraint is what is under test, and it holds for every role.
    const { adminSql } = await import('@superwork/db')
    await expect(
      adminSql()`
        INSERT INTO disclosures (
          organization_id, subject_user_id, recipient_label, kind, summary, visible_to_subject, created_by
        ) VALUES (
          ${org.organizationId}, ${org.memberId}, 'HR', 'manager_rollup', 'Quiet note', false, ${org.ownerId}
        )`,
    ).rejects.toThrow(/disclosure_never_covert/)
  })

  it('notices an export that nobody authorized', async () => {
    await withTenant(session, async (ctx) => {
      await expect(
        recordDisclosure(ctx, {
          subjectUserId: org.memberId,
          recipientLabel: 'HR system',
          kind: 'export',
          summary: 'Activity file',
        }),
      ).rejects.toThrow(/named authorization/i)
    })
  })
})

describe('the nudge ladder', () => {
  it('shares one budget across every agent', async () => {
    await withTenant(session, async (ctx) => {
      const budget = await nudgeBudget(ctx, org.memberId)
      // The strictest profile allows two; the organization's own policy allows three.
      // The stricter of the two wins.
      expect(budget.perDay).toBe(PROFILES.works_council.maxNudgesPerPersonPerDay)
      expect(budget.remaining).toBe(budget.perDay)
    })
  })

  it('holds back everything past the budget rather than dropping it silently', async () => {
    await withTenant(session, async (ctx) => {
      const due = new Date(Date.now() - 86_400_000)
      for (let index = 0; index < 5; index += 1) {
        const [task] = await ctx.sql<{ id: string }[]>`
          INSERT INTO tasks (organization_id, title, status, priority, assignee_id, due_at, is_demo, created_by)
          VALUES (${ctx.organizationId}, ${`chase me ${index}`}, 'todo', 'medium', ${org.memberId}, ${due}, true, ${org.ownerId})
          RETURNING id`
        await scheduleLadder(ctx, {
          recipientUserId: org.memberId,
          subjectType: 'task',
          subjectId: task!.id,
          subjectLabel: `chase me ${index}`,
          dueAt: due,
        })
      }

      const outcome = await deliverDueNudges(ctx)
      expect(outcome.delivered).toBe(PROFILES.works_council.maxNudgesPerPersonPerDay)
      expect(outcome.heldByBudget).toBeGreaterThan(0)

      const budget = await nudgeBudget(ctx, org.memberId)
      expect(budget.remaining).toBe(0)
    })
  })

  it('will not open a second ladder for the same thing', async () => {
    await withTenant(session, async (ctx) => {
      const due = new Date(Date.now() + 86_400_000)
      const [task] = await ctx.sql<{ id: string }[]>`
        INSERT INTO tasks (organization_id, title, status, priority, assignee_id, due_at, is_demo, created_by)
        VALUES (${ctx.organizationId}, 'one ladder only', 'todo', 'medium', ${org.memberId}, ${due}, true, ${org.ownerId})
        RETURNING id`

      const first = await scheduleLadder(ctx, {
        recipientUserId: org.memberId,
        subjectType: 'task',
        subjectId: task!.id,
        subjectLabel: 'one ladder only',
        dueAt: due,
      })
      const second = await scheduleLadder(ctx, {
        recipientUserId: org.memberId,
        subjectType: 'task',
        subjectId: task!.id,
        subjectLabel: 'one ladder only',
        dueAt: due,
      })

      expect(first.scheduled).toBe(1)
      expect(second.scheduled).toBe(0)
      expect(second.skipped).toMatch(/already open/i)
    })
  })

  it('cancels the ladder the moment the work is finished', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx, org.memberId)
      const due = new Date(Date.now() - 3_600_000)
      const [task] = await ctx.sql<{ id: string }[]>`
        INSERT INTO tasks (organization_id, title, status, priority, assignee_id, due_at, is_demo, created_by)
        VALUES (${ctx.organizationId}, 'already done', 'todo', 'medium', ${org.memberId}, ${due}, true, ${org.ownerId})
        RETURNING id`
      await scheduleLadder(ctx, {
        recipientUserId: org.memberId,
        subjectType: 'task',
        subjectId: task!.id,
        subjectLabel: 'already done',
        dueAt: due,
      })

      await ctx.sql`
        UPDATE tasks SET status = 'completed' WHERE organization_id = ${ctx.organizationId} AND id = ${task!.id}`
      const outcome = await deliverDueNudges(ctx)
      expect(outcome.cancelled).toBeGreaterThan(0)

      const nudges = await listNudges(ctx, actor, { recipientUserId: org.memberId })
      const forTask = nudges.filter((nudge) => nudge.subjectId === task!.id)
      expect(forTask.every((nudge) => nudge.cancelledAt !== null || nudge.deliveredAt === null)).toBe(true)
      expect(forTask[0]!.cancelReason).toMatch(/already finished/i)
    })
  })

  it('does not escalate to a manager where the profile forbids it', async () => {
    await withTenant(session, async (ctx) => {
      const [row] = await ctx.sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM nudges
        WHERE organization_id = ${ctx.organizationId} AND stage = 5 AND deleted_at IS NULL`
      expect(Number(row!.count)).toBe(0)
    })
  })

  it('is cancelled everywhere at once when the subject closes', async () => {
    await withTenant(session, async (ctx) => {
      const due = new Date(Date.now() + 3_600_000)
      const [task] = await ctx.sql<{ id: string }[]>`
        INSERT INTO tasks (organization_id, title, status, priority, assignee_id, due_at, is_demo, created_by)
        VALUES (${ctx.organizationId}, 'cancel me', 'todo', 'medium', ${org.viewerId}, ${due}, true, ${org.ownerId})
        RETURNING id`
      await scheduleLadder(ctx, {
        recipientUserId: org.viewerId,
        subjectType: 'task',
        subjectId: task!.id,
        subjectLabel: 'cancel me',
        dueAt: due,
      })
      const cancelled = await cancelLadder(ctx, {
        subjectType: 'task',
        subjectId: task!.id,
        reason: 'Closed by its owner.',
      })
      expect(cancelled).toBeGreaterThan(0)
    })
  })
})

describe('relation tuples', () => {
  it('grants access to one thing without changing anybody’s role', async () => {
    await withTenant(session, async (ctx) => {
      const owner = await loadActor(ctx, org.ownerId)
      const [project] = await ctx.sql<{ id: string }[]>`
        INSERT INTO projects (organization_id, name, status, is_demo, created_by)
        VALUES (${ctx.organizationId}, 'Shared project', 'active', true, ${org.ownerId})
        RETURNING id`

      await share(ctx, owner, {
        subjectType: 'user',
        subjectId: org.viewerId,
        relation: 'editor',
        objectType: 'project',
        objectId: project!.id,
        reason: 'Covering while the owner is away.',
      })

      const viewer = await loadActor(ctx, org.viewerId)
      expect(viewer.role).toBe('viewer')
      expect(viewer.relations?.has(`editor:project:${project!.id}`)).toBe(true)

      const { can } = await import('@superwork/auth')
      const allowed = can(viewer, 'project:update', {
        type: 'project',
        id: project!.id,
        organizationId: ctx.organizationId,
        riskTier: 'low',
      })
      expect(allowed.allow).toBe(true)
      expect(allowed.reason).toMatch(/shared with you as editor/i)

      // And only that one thing.
      const other = can(viewer, 'project:update', {
        type: 'project',
        id: '00000000-0000-0000-0000-000000000000',
        organizationId: ctx.organizationId,
        riskTier: 'low',
      })
      expect(other.allow).toBe(false)
    })
  })

  it('refuses to let somebody share what they cannot do themselves', async () => {
    await withTenant(session, async (ctx) => {
      const viewer = await loadActor(ctx, org.viewerId)
      const [project] = await ctx.sql<{ id: string }[]>`
        INSERT INTO projects (organization_id, name, status, is_demo, created_by)
        VALUES (${ctx.organizationId}, 'Not yours to give', 'active', true, ${org.ownerId})
        RETURNING id`

      await expect(
        share(ctx, viewer, {
          subjectType: 'user',
          subjectId: org.memberId,
          relation: 'editor',
          objectType: 'project',
          objectId: project!.id,
        }),
      ).rejects.toThrow(/only share something you can/i)
    })
  })
})
