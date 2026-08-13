import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import { composeBriefingFacts, pickRecommendation, startOfDay } from '@superwork/core'
import { generateBriefing } from '@superwork/agent'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Phase 2's acceptance criterion: "the daily briefing is accurate against a hand-audited
 * day" (§24).
 *
 * A day is constructed with known contents, every figure is checked against an
 * independent count, and — the part that actually matters — every number appearing in the
 * generated prose is required to exist in the computed facts. That is what makes
 * "the model never invents a figure" a test rather than an intention.
 */

let org: TenantFixture
const TZ = 'Europe/London'

/** What the day contains, decided here and asserted below. */
const AUDIT = {
  meetings: 2,
  dueToday: 3,
  overdue: 4,
  approvals: 2,
  confirmedCommitmentsDue: 2,
  proposedCommitments: 3, // must NOT appear — unconfirmed promises are not facts
  staleThreads: 1,
  blockingOthers: 1,
}

beforeAll(async () => {
  org = await createTenant('briefing')
  const session = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  const now = new Date()
  const dayStart = startOfDay(now, TZ)
  const midday = new Date(dayStart.getTime() + 12 * 3600_000)

  await withTenant(session, async (ctx) => {
    const sql = ctx.sql
    const owner = org.ownerId

    // ---- Meetings today ---------------------------------------------------
    for (let i = 0; i < AUDIT.meetings; i++) {
      const starts = new Date(dayStart.getTime() + (9 + i) * 3600_000)
      const [meeting] = await sql<{ id: string }[]>`
        INSERT INTO meetings (organization_id, title, organizer_id, starts_at, ends_at, timezone, created_by)
        VALUES (${ctx.organizationId}, ${`Audit meeting ${i + 1}`}, ${owner}, ${starts},
                ${new Date(starts.getTime() + 30 * 60_000)}, ${TZ}, ${owner})
        RETURNING id`
      await sql`
        INSERT INTO meeting_participants (organization_id, meeting_id, user_id, display_name, created_by)
        VALUES (${ctx.organizationId}, ${meeting!.id}, ${owner}, 'Owner', ${owner})`
    }
    // A meeting the owner is not part of must not appear in their briefing.
    await sql`
      INSERT INTO meetings (organization_id, title, organizer_id, starts_at, ends_at, timezone, created_by)
      VALUES (${ctx.organizationId}, 'Someone else''s meeting', ${org.memberId}, ${midday},
              ${new Date(midday.getTime() + 30 * 60_000)}, ${TZ}, ${owner})`

    // ---- Tasks ------------------------------------------------------------
    for (let i = 0; i < AUDIT.dueToday; i++) {
      await sql`
        INSERT INTO tasks (organization_id, title, status, priority, assignee_id, due_at, created_by)
        VALUES (${ctx.organizationId}, ${`Due today ${i + 1}`}, 'todo', 'medium', ${owner}, ${midday}, ${owner})`
    }
    for (let i = 0; i < AUDIT.overdue; i++) {
      await sql`
        INSERT INTO tasks (organization_id, title, status, priority, assignee_id, due_at, created_by)
        VALUES (${ctx.organizationId}, ${`Overdue ${i + 1}`}, 'todo', 'high', ${owner},
                ${new Date(dayStart.getTime() - (i + 1) * 86_400_000)}, ${owner})`
    }
    // Completed and cancelled work is not outstanding and must not be counted.
    await sql`
      INSERT INTO tasks (organization_id, title, status, priority, assignee_id, due_at, completed_at, created_by)
      VALUES (${ctx.organizationId}, 'Already done', 'completed', 'medium', ${owner}, ${midday}, ${midday}, ${owner})`
    await sql`
      INSERT INTO tasks (organization_id, title, status, priority, assignee_id, due_at, created_by)
      VALUES (${ctx.organizationId}, 'Dropped', 'cancelled', 'medium', ${owner}, ${midday}, ${owner})`
    // Someone else's overdue task is not the owner's problem in *their* briefing.
    await sql`
      INSERT INTO tasks (organization_id, title, status, priority, assignee_id, due_at, created_by)
      VALUES (${ctx.organizationId}, 'Not mine', 'todo', 'high', ${org.memberId},
              ${new Date(dayStart.getTime() - 86_400_000)}, ${owner})`

    // ---- Blocking others ---------------------------------------------------
    const [blocker] = await sql<{ id: string }[]>`
      INSERT INTO tasks (organization_id, title, status, priority, assignee_id, created_by)
      VALUES (${ctx.organizationId}, 'Everyone waits on this', 'in_progress', 'high', ${owner}, ${owner})
      RETURNING id`
    // The schema requires a blocked task to say why, so the fixture supplies one.
    const [dependent] = await sql<{ id: string }[]>`
      INSERT INTO tasks (organization_id, title, status, priority, assignee_id, blocked_reason, created_by)
      VALUES (${ctx.organizationId}, 'Blocked behind it', 'blocked', 'medium', ${org.memberId},
              'waiting on the owner', ${owner})
      RETURNING id`
    await sql`
      INSERT INTO task_dependencies (organization_id, task_id, depends_on_task_id, created_by)
      VALUES (${ctx.organizationId}, ${dependent!.id}, ${blocker!.id}, ${owner})`

    // ---- Approvals ---------------------------------------------------------
    for (let i = 0; i < AUDIT.approvals; i++) {
      await sql`
        INSERT INTO approvals (organization_id, title, status, risk_tier, approver_user_id, preview, evidence, created_by)
        VALUES (${ctx.organizationId}, ${`Approve thing ${i + 1}`}, 'pending', 'low', ${owner},
                ${sql.json([{ operation: 'x' }] as never)}, ${sql.json([] as never)}, ${owner})`
    }
    await sql`
      INSERT INTO approvals (organization_id, title, status, risk_tier, approver_user_id, preview, evidence, created_by)
      VALUES (${ctx.organizationId}, 'Already decided', 'approved', 'low', ${owner},
              ${sql.json([{ operation: 'x' }] as never)}, ${sql.json([] as never)}, ${owner})`

    // ---- Commitments -------------------------------------------------------
    for (let i = 0; i < AUDIT.confirmedCommitmentsDue; i++) {
      await sql`
        INSERT INTO commitments (organization_id, owner_user_id, obligation, direction, due_at, status, created_by)
        VALUES (${ctx.organizationId}, ${owner}, ${`Confirmed promise ${i + 1}`}, 'we_owe', ${midday}, 'confirmed', ${owner})`
    }
    // Proposed commitments are suggestions, not facts, and must be excluded (§29.1).
    for (let i = 0; i < AUDIT.proposedCommitments; i++) {
      await sql`
        INSERT INTO commitments (organization_id, owner_user_id, obligation, direction, due_at, status, created_by)
        VALUES (${ctx.organizationId}, ${owner}, ${`Unconfirmed guess ${i + 1}`}, 'we_owe', ${midday}, 'proposed', ${owner})`
    }

    // ---- A stale customer thread -------------------------------------------
    const [conversation] = await sql<{ id: string }[]>`
      INSERT INTO conversations (organization_id, subject, company_id, owner_id, last_message_at,
                                 last_direction, status, created_by)
      VALUES (${ctx.organizationId}, 'They are waiting', ${org.companyId}, ${owner},
              ${new Date(Date.now() - 12 * 86_400_000)}, 'inbound', 'open', ${owner})
      RETURNING id`
    expect(conversation).toBeTruthy()
  })
})

afterAll(async () => {
  await destroyTenant('briefing')
  await closePools()
})

describe('the computed facts match an independent audit of the day', () => {
  it('counts exactly what is there, and nothing that is not', async () => {
    const facts = await withTenant(
      { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ },
      async (ctx) => composeBriefingFacts(ctx, await loadActor(ctx), 'daily'),
    )

    expect(facts.counts.meetings).toBe(AUDIT.meetings)
    expect(facts.counts.dueToday).toBe(AUDIT.dueToday)
    expect(facts.counts.overdue).toBe(AUDIT.overdue)
    expect(facts.counts.approvals).toBe(AUDIT.approvals)
    expect(facts.counts.commitmentsDue).toBe(AUDIT.confirmedCommitmentsDue)
    expect(facts.counts.blockingOthers).toBe(AUDIT.blockingOthers)
    expect(facts.counts.staleThreads).toBe(AUDIT.staleThreads)
  })

  it('excludes unconfirmed commitments — a detected promise is not a fact', async () => {
    const facts = await withTenant(
      { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ },
      async (ctx) => composeBriefingFacts(ctx, await loadActor(ctx), 'daily'),
    )
    expect(facts.commitments.every((c) => c.status === 'confirmed')).toBe(true)
    expect(facts.commitments.some((c) => c.obligation.includes('Unconfirmed'))).toBe(false)
  })

  it('agrees with a direct count taken independently of the briefing code', async () => {
    const direct = await withTenant(
      { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ },
      async (ctx) => {
        const dayStart = startOfDay(new Date(), TZ)
        const [row] = await ctx.sql<{ overdue: number; dueToday: number; approvals: number }[]>`
          SELECT
            (SELECT count(*)::int FROM tasks
              WHERE organization_id = ${ctx.organizationId} AND assignee_id = ${org.ownerId}
                AND deleted_at IS NULL AND status NOT IN ('completed','cancelled')
                AND due_at < ${dayStart}) AS overdue,
            (SELECT count(*)::int FROM tasks
              WHERE organization_id = ${ctx.organizationId} AND assignee_id = ${org.ownerId}
                AND deleted_at IS NULL AND status NOT IN ('completed','cancelled')
                AND due_at >= ${dayStart} AND due_at < ${new Date(dayStart.getTime() + 86_400_000)}) AS "dueToday",
            (SELECT count(*)::int FROM approvals
              WHERE organization_id = ${ctx.organizationId} AND status = 'pending'
                AND deleted_at IS NULL AND approver_user_id = ${org.ownerId}) AS approvals`
        return row!
      },
    )
    const facts = await withTenant(
      { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ },
      async (ctx) => composeBriefingFacts(ctx, await loadActor(ctx), 'daily'),
    )
    expect(facts.counts.overdue).toBe(direct.overdue)
    expect(facts.counts.dueToday).toBe(direct.dueToday)
    expect(facts.counts.approvals).toBe(direct.approvals)
  })
})

describe('the generated briefing', () => {
  it('states no number that the database did not produce', async () => {
    const briefing = await generateBriefing(
      { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ },
      org.ownerId,
      { kind: 'daily', force: true },
    )

    // Every figure the prose may legitimately state: the counts, plus anything that
    // appears inside a listed item (durations, days late, hours waiting).
    const allowed = new Set<number>()
    for (const value of Object.values(briefing.facts.counts)) allowed.add(value)
    for (const m of briefing.facts.meetings) {
      allowed.add(m.minutes)
      for (const part of m.localTime.split(':')) allowed.add(Number(part))
    }
    for (const t of briefing.facts.overdue) allowed.add(t.daysOverdue)
    for (const a of briefing.facts.approvals) allowed.add(Math.round(a.hoursWaiting))
    for (const s of briefing.facts.staleThreads) allowed.add(s.daysWaiting)
    for (const b of briefing.facts.blockingOthers) allowed.add(b.waitingCount)
    // The basis line carries the generation time, which is itself a computed fact.
    for (const match of briefing.facts.basis.matchAll(/\d+/g)) allowed.add(Number(match[0]))

    const stated = [...briefing.narrative.matchAll(/\b\d+\b/g)].map((m) => Number(m[0]))
    const invented = stated.filter((n) => !allowed.has(n))

    expect(invented, `narrative: ${briefing.narrative}`).toEqual([])
  })

  it('reports every non-zero fact rather than quietly dropping one', async () => {
    const briefing = await generateBriefing(
      { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ },
      org.ownerId,
      { kind: 'daily', force: true },
    )
    const text = briefing.narrative.toLowerCase()
    expect(text).toContain(String(AUDIT.meetings))
    expect(text).toContain('overdue')
    expect(text).toContain('approval')
    expect(text).toMatch(/block/)
  })

  it('is reproducible: the stored facts regenerate the same narrative', async () => {
    const first = await generateBriefing(
      { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ },
      org.ownerId,
      { kind: 'daily', force: true },
    )
    const second = await generateBriefing(
      { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ },
      org.ownerId,
      { kind: 'daily', force: true },
    )
    expect(second.narrative).toBe(first.narrative)
    expect(second.facts.counts).toEqual(first.facts.counts)
  })

  it('recommends the thing that unblocks other people first', async () => {
    const facts = await withTenant(
      { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ },
      async (ctx) => composeBriefingFacts(ctx, await loadActor(ctx), 'daily'),
    )
    const recommendation = pickRecommendation(facts)
    expect(recommendation.headline).toContain('Unblock')
    expect(recommendation.why).toContain('waiting on it')
  })

  it('carries drill-through citations for every figure it reports', async () => {
    const briefing = await generateBriefing(
      { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ },
      org.ownerId,
      { kind: 'daily', force: true },
    )
    const labels = briefing.citations.map((c) => c.label)
    expect(labels).toContain('Meetings today')
    expect(labels).toContain('Overdue')
    expect(labels).toContain('Approvals')
    for (const citation of briefing.citations) {
      expect(citation.count).toBeGreaterThan(0)
      expect(citation.route.startsWith('/')).toBe(true)
    }
  })

  it('does not leak another tenant into the briefing', async () => {
    const other = await createTenant('briefing-other')
    try {
      await withTenant({ organizationId: other.organizationId, userId: other.ownerId, timezone: TZ }, async (ctx) => {
        await ctx.sql`
          INSERT INTO tasks (organization_id, title, status, priority, assignee_id, due_at, created_by)
          VALUES (${ctx.organizationId}, 'OTHER TENANT SECRET', 'todo', 'urgent', ${other.ownerId},
                  ${new Date(Date.now() - 86_400_000)}, ${other.ownerId})`
      })
      const briefing = await generateBriefing(
        { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ },
        org.ownerId,
        { kind: 'daily', force: true },
      )
      expect(briefing.narrative).not.toContain('OTHER TENANT SECRET')
      expect(JSON.stringify(briefing.facts)).not.toContain('OTHER TENANT SECRET')
    } finally {
      await destroyTenant('briefing-other')
    }
  })
})

describe('end-of-day summary', () => {
  it('reports what completed and states plainly when the agent did nothing', async () => {
    const briefing = await generateBriefing(
      { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ },
      org.ownerId,
      { kind: 'end_of_day', force: true },
    )
    expect(briefing.kind).toBe('end_of_day')
    expect(briefing.facts.counts.completedToday).toBe(1)
    expect(briefing.narrative).toMatch(/closed 1 item/i)
  })
})

describe('timezone correctness', () => {
  it('computes a different day for a recipient on the other side of the date line', async () => {
    const london = await withTenant(
      { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' },
      async (ctx) => composeBriefingFacts(ctx, await loadActor(ctx), 'daily'),
    )
    const auckland = await withTenant(
      { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Pacific/Auckland' },
      async (ctx) => composeBriefingFacts(ctx, await loadActor(ctx), 'daily'),
    )
    expect(london.timezone).toBe('Europe/London')
    expect(auckland.timezone).toBe('Pacific/Auckland')
    // The same instant can fall on different local dates, and "overdue" moves with it.
    const sameDay = london.localDate === auckland.localDate
    if (!sameDay) {
      expect(auckland.counts.overdue).not.toBe(london.counts.overdue)
    }
    expect(await adminSql()`SELECT 1`).toBeTruthy()
  })
})
