import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor, type Actor } from '@superwork/auth'
import { listDecisions, recordDecision } from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * When it was actually decided (ADR 0078).
 *
 * `decisions.decided_at` is `NOT NULL DEFAULT now()` and nothing in the product ever set it — so
 * it held the moment the summarizer ran. It is not decorative: it is the `ORDER BY` of the
 * decision log and both of the table's indexes, so a meeting summarised a week late produced
 * decisions that sorted above ones made yesterday.
 *
 * The answer was already in the data. A decision carries the segment it was read out of, a
 * segment carries its offset into the recording, and the meeting carries when it began.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let owner: { organizationId: string; userId: string; timezone: string }
let actor: Actor
let meetingId: string
let began: Date
/** 275 seconds into the meeting — the line the decision is read out of. */
let segmentId: string
let otherMeetingSegmentId: string

beforeAll(async () => {
  org = await createTenant('decision-when')
  owner = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  actor = await withTenant(owner, async (ctx) => loadActor(ctx))

  began = new Date(Date.now() - 9 * 86_400_000)
  began.setUTCHours(9, 30, 0, 0)
  const made = await adminSql()<{ id: string }[]>`
    INSERT INTO meetings (organization_id, title, starts_at, ends_at, status, is_demo, created_by)
    VALUES (${org.organizationId}, 'Weekly operations meeting', ${began},
            ${new Date(began.getTime() + 45 * 60_000)}, 'completed', true, ${org.ownerId}),
           (${org.organizationId}, 'A different room', ${began}, ${new Date(began.getTime() + 3_600_000)},
            'completed', true, ${org.ownerId})
    RETURNING id`
  meetingId = made[0]!.id

  const segments = async (meeting: string, seconds: number) => {
    const [transcript] = await adminSql()<{ id: string }[]>`
      INSERT INTO transcripts (organization_id, meeting_id, source, is_demo, created_by)
      VALUES (${org.organizationId}, ${meeting}, 'seed', true, ${org.ownerId})
      RETURNING id`
    const [segment] = await adminSql()<{ id: string }[]>`
      INSERT INTO transcript_segments (organization_id, transcript_id, ordinal, speaker,
                                       starts_at_seconds, text, is_demo, created_by)
      VALUES (${org.organizationId}, ${transcript!.id}, 1, 'Ruth Kavanagh', ${seconds},
              'We agreed we will go with a banded waiting charge.', true, ${org.ownerId})
      RETURNING id`
    return segment!.id
  }
  segmentId = await segments(meetingId, 275)
  otherMeetingSegmentId = await segments(made[1]!.id, 30)
})

afterAll(async () => {
  await destroyTenant('decision-when')
  await closePools()
})

describe('the moment a decision was made', () => {
  it('is the line it was read out of, not the moment the summarizer ran', async () => {
    const decision = await withTenant(owner, async (ctx) =>
      recordDecision(ctx, actor, {
        summary: 'Price Glasgow with a banded waiting charge.',
        meetingId,
        sourceSegmentId: segmentId,
        confidence: 0.84,
      }),
    )
    // The meeting began nine days ago; the line is 275 seconds into it.
    expect(decision.decidedAt.getTime()).toBe(began.getTime() + 275_000)
  })

  it('falls back to when the meeting began, for a decision with no line to cite', async () => {
    const decision = await withTenant(owner, async (ctx) =>
      recordDecision(ctx, actor, { summary: 'Somebody typed this in afterwards.', meetingId }),
    )
    expect(decision.decidedAt.getTime()).toBe(began.getTime())
  })

  it('and to now, for one that came out of no meeting at all', async () => {
    const before = Date.now()
    const decision = await withTenant(owner, async (ctx) =>
      recordDecision(ctx, actor, { summary: 'Decided in a corridor.' }),
    )
    // Which is then the truth rather than a default standing in for one.
    expect(decision.decidedAt.getTime()).toBeGreaterThanOrEqual(before - 1000)
  })

  it('so the log reads in the order things were decided', async () => {
    const decisions = await withTenant(owner, async (ctx) => listDecisions(ctx, actor, {}))
    const dates = decisions.map((d) => d.decidedAt.getTime())
    expect([...dates].sort((a, b) => b - a)).toEqual(dates)
    // The corridor decision was made just now, so it is first. Last is the one that fell back
    // to the meeting's start — 09:30 is earlier than the line 275 seconds into it, which is the
    // ordering being right rather than a surprise.
    expect(decisions[0]!.summary).toBe('Decided in a corridor.')
    expect(decisions.at(-1)!.summary).toBe('Somebody typed this in afterwards.')
  })
})

describe('what the database holds to, whatever writes the row', () => {
  it('a decision cannot have been made in the future', async () => {
    await expect(
      adminSql()`
        INSERT INTO decisions (organization_id, summary, decided_at, is_demo, created_by)
        VALUES (${org.organizationId}, 'Decided next Tuesday.', now() + interval '3 days', true,
                ${org.ownerId})`,
    ).rejects.toThrow(/cannot have been made in the future/i)
  })

  it('nor before the meeting it came out of', async () => {
    // A sum that has gone wrong rather than a date somebody typed — which is exactly the failure
    // a trigger should catch rather than a reviewer.
    await expect(
      adminSql()`
        INSERT INTO decisions (organization_id, meeting_id, summary, decided_at, is_demo, created_by)
        VALUES (${org.organizationId}, ${meetingId}, 'Decided before the room opened.',
                ${new Date(began.getTime() - 3_600_000)}, true, ${org.ownerId})`,
    ).rejects.toThrow(/before the meeting it came out of/i)
  })

  it('and cannot cite a line from a different meeting', async () => {
    await expect(
      adminSql()`
        INSERT INTO decisions (organization_id, meeting_id, summary, source_segment_id, is_demo, created_by)
        VALUES (${org.organizationId}, ${meetingId}, 'Cited from the wrong room.',
                ${otherMeetingSegmentId}, true, ${org.ownerId})`,
    ).rejects.toThrow(/only cite a line from the meeting it came out of/i)
  })

  it('but confirming one months later is not refused over a date it never touched', async () => {
    // The two-trigger split: the guard is narrowed to the arriving value.
    const [row] = await adminSql()<{ id: string }[]>`
      SELECT id FROM decisions WHERE organization_id = ${org.organizationId}
        AND meeting_id = ${meetingId} LIMIT 1`
    await adminSql()`
      UPDATE decisions SET confirmed_at = now(), confirmed_by = ${org.ownerId}
      WHERE id = ${row!.id}`
    const [after] = await adminSql()<{ confirmed_at: Date | null }[]>`
      SELECT confirmed_at FROM decisions WHERE id = ${row!.id}`
    expect(after!.confirmed_at).toBeInstanceOf(Date)
  })
})
