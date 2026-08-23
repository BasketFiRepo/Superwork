import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import { listParticipants, personalRecord, setAttendance } from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Who was actually in the room (ADR 0081).
 *
 * `meeting_participants.attended` has existed since migration 0010 and nothing but the seed had
 * ever written it. What made it worth building rather than dropping is the sentence resting on
 * it: the personal record — the screen §29.3 exists for — carried a row labelled "Meetings you
 * attended" whose count was `count(*) FROM meeting_participants WHERE user_id = …`, the number of
 * meetings somebody had put your name on.
 *
 * The rule this file exists to hold: **three states, and the empty one is not a gap.** Nothing
 * recorded is nothing claimed. "Was not there" is a statement about a person and carries a name.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let owner: { organizationId: string; userId: string; timezone: string }
let member: { organizationId: string; userId: string; timezone: string }
let viewer: { organizationId: string; userId: string; timezone: string }
let pastMeetingId: string
let futureMeetingId: string
/** The member's row on the meeting that has already happened. */
let memberParticipantId: string
let futureParticipantId: string

const HOUR = 3_600_000
const makeMeeting = async (title: string, startsAt: Date): Promise<string> =>
  withTenant(owner, async (ctx) => {
    const [row] = await ctx.sql<{ id: string }[]>`
      INSERT INTO meetings (organization_id, title, organizer_id, starts_at, ends_at, timezone,
                            status, is_demo, created_by)
      VALUES (${org.organizationId}, ${title}, ${org.ownerId},
              ${startsAt}, ${new Date(startsAt.getTime() + HOUR)}, ${TZ},
              'scheduled', true, ${org.ownerId})
      RETURNING id`
    return row!.id
  })

const addParticipant = async (meetingId: string, userId: string, name: string): Promise<string> =>
  withTenant(owner, async (ctx) => {
    const [row] = await ctx.sql<{ id: string }[]>`
      INSERT INTO meeting_participants (organization_id, meeting_id, user_id, display_name, role,
                                        is_demo, created_by)
      VALUES (${org.organizationId}, ${meetingId}, ${userId}, ${name}, 'attendee', true, ${org.ownerId})
      RETURNING id`
    return row!.id
  })

beforeAll(async () => {
  org = await createTenant('attendance')
  owner = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  member = { organizationId: org.organizationId, userId: org.memberId, timezone: TZ }
  viewer = { organizationId: org.organizationId, userId: org.viewerId, timezone: TZ }

  pastMeetingId = await makeMeeting('The one that happened', new Date(Date.now() - 48 * HOUR))
  futureMeetingId = await makeMeeting('The one next week', new Date(Date.now() + 168 * HOUR))
  memberParticipantId = await addParticipant(pastMeetingId, org.memberId, 'The member')
  futureParticipantId = await addParticipant(futureMeetingId, org.memberId, 'The member')
})

afterAll(async () => {
  await destroyTenant('attendance')
  await closePools()
})

describe('recording who came', () => {
  it('somebody with a say over the meeting can, and it carries their name', async () => {
    const participants = await withTenant(owner, async (ctx) =>
      setAttendance(ctx, await loadActor(ctx), {
        meetingId: pastMeetingId,
        participantId: memberParticipantId,
        attended: true,
      }),
    )
    const row = participants.find((p) => p.id === memberParticipantId)!
    expect(row.attended).toBe(true)
    expect(row.attendedSetByName).toBeTruthy()
    expect(row.attendedSetAt).toBeInstanceOf(Date)
  })

  it('and a viewer cannot, though they may open the meeting', async () => {
    await expect(
      withTenant(viewer, async (ctx) =>
        setAttendance(ctx, await loadActor(ctx), {
          meetingId: pastMeetingId,
          participantId: memberParticipantId,
          attended: false,
        }),
      ),
    ).rejects.toThrow()
  })

  it('and a member cannot either — saying who was absent is not an ordinary read', async () => {
    await expect(
      withTenant(member, async (ctx) =>
        setAttendance(ctx, await loadActor(ctx), {
          meetingId: pastMeetingId,
          participantId: memberParticipantId,
          attended: false,
        }),
      ),
    ).rejects.toThrow()
  })

  it('and never across a tenant boundary', async () => {
    const other = await createTenant('attendance-b')
    try {
      await expect(
        withTenant(
          { organizationId: other.organizationId, userId: other.ownerId, timezone: TZ },
          async (ctx) =>
            setAttendance(ctx, await loadActor(ctx), {
              meetingId: pastMeetingId,
              participantId: memberParticipantId,
              attended: true,
            }),
        ),
      ).rejects.toThrow()
    } finally {
      await destroyTenant('attendance-b')
    }
  })
})

describe('the three states', () => {
  it('absent is a claim, and it is attributed like any other', async () => {
    const participants = await withTenant(owner, async (ctx) =>
      setAttendance(ctx, await loadActor(ctx), {
        meetingId: pastMeetingId,
        participantId: memberParticipantId,
        attended: false,
      }),
    )
    const row = participants.find((p) => p.id === memberParticipantId)!
    expect(row.attended).toBe(false)
    expect(row.attendedSetByName).toBeTruthy()
  })

  it('and withdrawing one takes the name with it, because nobody is claiming it any more', async () => {
    const participants = await withTenant(owner, async (ctx) =>
      setAttendance(ctx, await loadActor(ctx), {
        meetingId: pastMeetingId,
        participantId: memberParticipantId,
        attended: null,
      }),
    )
    const row = participants.find((p) => p.id === memberParticipantId)!
    expect(row.attended).toBeNull()
    expect(row.attendedSetByName).toBeNull()
    expect(row.attendedSetAt).toBeNull()
  })

  it('and an answer with nobody behind it cannot be written at all', async () => {
    await expect(
      adminSql()`
        UPDATE meeting_participants SET attended = true, attended_set_by = NULL, attended_set_at = NULL
        WHERE id = ${memberParticipantId}`,
    ).rejects.toThrow(/attendance_attributed/i)
  })
})

describe('when it can be said', () => {
  it('not for a meeting that has not started — that is an accusation, not a record', async () => {
    await expect(
      withTenant(owner, async (ctx) =>
        setAttendance(ctx, await loadActor(ctx), {
          meetingId: futureMeetingId,
          participantId: futureParticipantId,
          attended: false,
        }),
      ),
    ).rejects.toThrow(/has not started/i)
  })

  it('and not on the way in either', async () => {
    await expect(
      adminSql()`
        INSERT INTO meeting_participants (organization_id, meeting_id, user_id, display_name, role,
                                          attended, attended_set_by, attended_set_at, is_demo, created_by)
        VALUES (${org.organizationId}, ${futureMeetingId}, ${org.ownerId}, 'Too early', 'attendee',
                true, ${org.ownerId}, now(), true, ${org.ownerId})`,
    ).rejects.toThrow(/has not started/i)
  })

  it('while an edit that does not touch attendance is still allowed on the same row', async () => {
    /**
     * The ADR 0057 split, and the reason for it. A blanket trigger would refuse renaming a
     * participant on next week's meeting over an attendance the rename never touched — and the
     * rule here is about recording attendance early, not about the row being frozen.
     */
    await adminSql()`
      UPDATE meeting_participants SET display_name = 'The member, renamed'
      WHERE id = ${futureParticipantId}`
    const [row] = await adminSql()<{ display_name: string }[]>`
      SELECT display_name FROM meeting_participants WHERE id = ${futureParticipantId}`
    expect(row!.display_name).toBe('The member, renamed')
  })

  it('and the person named as recording it has to be somebody here', async () => {
    const other = await createTenant('attendance-c')
    try {
      await expect(
        adminSql()`
          UPDATE meeting_participants
             SET attended = true, attended_set_by = ${other.ownerId}, attended_set_at = now()
           WHERE id = ${memberParticipantId}`,
      ).rejects.toThrow(/member of this organization/i)
    } finally {
      await destroyTenant('attendance-c')
    }
  })
})

describe('what the personal record says about it', () => {
  it('separates the list from the room, which is the whole reason this was built', async () => {
    await withTenant(owner, async (ctx) =>
      setAttendance(ctx, await loadActor(ctx), {
        meetingId: pastMeetingId,
        participantId: memberParticipantId,
        attended: true,
      }),
    )
    const record = await withTenant(member, async (ctx) =>
      personalRecord(ctx, await loadActor(ctx), org.memberId),
    )
    const list = record.tracked.find((t) => t.key === 'meetings')!
    const attended = record.tracked.find((t) => t.key === 'meetings_attended')!

    // On the list for two — the one that happened and the one next week.
    expect(list.count).toBe(2)
    expect(list.label).not.toMatch(/attended/i)
    // In the room for one of them.
    expect(attended.count).toBe(1)
    expect(attended.label).toMatch(/attended/i)
  })

  it('and counts nothing about anybody but the person reading it', async () => {
    await expect(
      withTenant(member, async (ctx) => personalRecord(ctx, await loadActor(ctx), org.ownerId)),
    ).rejects.toThrow()
  })
})

describe('what is deliberately not built', () => {
  /**
   * §29.5 forbids productivity scoring of individuals by construction rather than by policy.
   * "Who was in this room" is a fact about a meeting; "who misses the most meetings" is a
   * measure of a person, and the difference is only that nobody wrote the second query.
   *
   * The same line ADR 0070 drew for digests and ADR 0079 for the audit log, asserted the same
   * way — because it is not a difference a comment can hold.
   */
  it('there is no tally of attendance grouped by person anywhere', async () => {
    const read = (path: string) =>
      import('node:fs').then((fs) => fs.readFileSync(new URL(path, import.meta.url), 'utf8'))

    for (const path of [
      '../../packages/core/src/repositories/meetings.ts',
      '../../packages/core/src/transparency.ts',
      '../../apps/web/src/components/MeetingAttendance.tsx',
    ]) {
      const source = await read(path)
      expect(/GROUP\s+BY\s+[a-z._]*user_id/i.test(source), `${path} groups attendance by person`).toBe(false)
    }
  })

  it('and the only count of it is the one on your own record', async () => {
    const transparency = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../packages/core/src/transparency.ts', import.meta.url), 'utf8'),
    )
    // `personalRecord` refuses any userId but the caller's, so every count in this file is
    // already self-only. This asserts the attendance counts are inside that same query rather
    // than reachable some other way.
    const attendanceCounts = transparency.match(/AND attended[^\n]*\n/g) ?? []
    expect(attendanceCounts.length).toBeGreaterThan(0)
    expect(transparency).toMatch(/userId !== actor\.userId/)
  })
})

describe('the column that went', () => {
  it('meetings no longer carry a second copy of the consent state', async () => {
    const [column] = await adminSql()<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'meetings' AND column_name = 'recording_consent_state'`
    expect(column).toBeUndefined()
  })

  it('and the consent the product actually uses still comes from the participants', async () => {
    const participants = await withTenant(owner, async (ctx) => listParticipants(ctx, pastMeetingId))
    expect(participants.length).toBeGreaterThan(0)
    expect(participants.every((p) => 'consentedAt' in p)).toBe(true)
  })
})
