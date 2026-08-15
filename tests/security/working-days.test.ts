import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  createDepartment,
  deliverDueNudges,
  easterSunday,
  holidaysIn,
  isWorkingDay,
  listDepartments,
  nextWorkingDay,
  nonWorkingReason,
  scheduleLadder,
  updateDepartment,
  ValidationError,
  workingCalendarFor,
  worksOn,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Working days (ADR 0039).
 *
 * `departments.holiday_calendar` has existed since migration 0001 and nothing has ever
 * written to it or read it, so the nudge ladder chased people on Saturdays and on Christmas
 * Day. §29 says at length how *hard* the system may chase somebody and said nothing about
 * *when*, because the column that could answer it was inert.
 *
 * The dates are computed from published rules rather than fetched, so the first block here is
 * the arithmetic: a calendar that is wrong about Easter is a calendar that chases people on
 * Good Friday.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let departmentId: string

/** A Saturday, a UK bank holiday, and an ordinary working day, all in the demo's timezone. */
const SATURDAY = '2026-06-13'
const CHRISTMAS = '2026-12-25'
const BOXING_SUBSTITUTE = '2026-12-28'
const ORDINARY = '2026-06-11'

beforeAll(async () => {
  org = await createTenant('working-days')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }

  await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const created = await createDepartment(ctx, actor, { name: 'Operations', timezone: 'Europe/London' })
    departmentId = created.find((row) => row.name === 'Operations')!.id
    await ctx.sql`
      UPDATE memberships SET department_id = ${departmentId}
      WHERE organization_id = ${org.organizationId} AND user_id = ${org.memberId}`
  })
})

afterAll(async () => {
  await destroyTenant('working-days')
  await closePools()
})

describe('the calendars are right about the dates', () => {
  it('computes Easter, which is what Good Friday and Easter Monday hang off', () => {
    expect(easterSunday(2021)).toBe('2021-04-04')
    expect(easterSunday(2026)).toBe('2026-04-05')
    expect(easterSunday(2027)).toBe('2027-03-28')
  })

  it('knows the England and Wales bank holidays, substitute days included', () => {
    const y2026 = holidaysIn('uk-england-wales', 2026)
    expect(y2026.get('2026-04-03')).toBe('Good Friday')
    expect(y2026.get('2026-04-06')).toBe('Easter Monday')
    expect(y2026.get('2026-05-04')).toBe('Early May bank holiday')
    expect(y2026.get('2026-05-25')).toBe('Spring bank holiday')
    expect(y2026.get('2026-08-31')).toBe('Summer bank holiday')
    // Boxing Day 2026 is a Saturday, so it is kept on the following Monday.
    expect(y2026.get(BOXING_SUBSTITUTE)).toBe('Boxing Day')

    // 2027 puts Christmas on a Saturday, which pushes *both* substitutes along.
    const y2027 = holidaysIn('uk-england-wales', 2027)
    expect(y2027.get('2027-12-27')).toBe('Christmas Day')
    expect(y2027.get('2027-12-28')).toBe('Boxing Day')
  })

  it('knows the US federal holidays and the weekday they are observed on', () => {
    const y2026 = holidaysIn('us-federal', 2026)
    expect(y2026.get('2026-01-19')).toBe('Birthday of Martin Luther King, Jr.')
    expect(y2026.get('2026-11-26')).toBe('Thanksgiving Day')
    // 4 July 2026 is a Saturday, so it is observed on the Friday before.
    expect(y2026.get('2026-07-03')).toBe('Independence Day')
  })

  it('says why a day is not worked, and finds the next one that is', () => {
    expect(nonWorkingReason('uk-england-wales', SATURDAY)).toBe('a Saturday')
    expect(nonWorkingReason('uk-england-wales', CHRISTMAS)).toBe('Christmas Day')
    expect(nonWorkingReason('uk-england-wales', ORDINARY)).toBeNull()
    // Christmas Day 2026 is a Friday; the next working day is the Tuesday after the
    // substitute Boxing Day bank holiday.
    expect(nextWorkingDay('uk-england-wales', CHRISTMAS)).toBe('2026-12-29')
  })

  it('treats an unset calendar as the behaviour that was there before', () => {
    expect(isWorkingDay(null, CHRISTMAS)).toBe(true)
    expect(isWorkingDay('none', SATURDAY)).toBe(true)
    expect(nonWorkingReason(undefined, SATURDAY)).toBeNull()
  })
})

describe('a calendar is a department fact, and it is inherited', () => {
  it('refuses a name the product cannot work out', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        updateDepartment(ctx, actor, { id: departmentId, holidayCalendar: 'narnia' }),
      ).rejects.toThrow(ValidationError)
    })
  })

  it('is inherited by everything underneath, so a company says it once', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await updateDepartment(ctx, actor, { id: departmentId, holidayCalendar: 'uk-england-wales' })
      const created = await createDepartment(ctx, actor, { name: 'Customs', parentId: departmentId })
      const child = created.find((row) => row.name === 'Customs')!

      expect(child.holidayCalendar).toBeNull()
      expect(child.effectiveHolidayCalendar).toBe('uk-england-wales')
      expect(child.holidayCalendarFrom).toBe('Operations')
    })
  })

  it('lets a department underneath set its own, and go back to inheriting', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const child = (await listDepartments(ctx, actor)).find((row) => row.name === 'Customs')!

      await updateDepartment(ctx, actor, { id: child.id, holidayCalendar: 'us-federal' })
      let after = (await listDepartments(ctx, actor)).find((row) => row.name === 'Customs')!
      expect(after.effectiveHolidayCalendar).toBe('us-federal')
      expect(after.holidayCalendarFrom).toBeNull()

      await updateDepartment(ctx, actor, { id: child.id, holidayCalendar: null })
      after = (await listDepartments(ctx, actor)).find((row) => row.name === 'Customs')!
      expect(after.holidayCalendar).toBeNull()
      expect(after.effectiveHolidayCalendar).toBe('uk-england-wales')
    })
  })

  it('governs the people who sit in it', async () => {
    await withTenant(session, async (ctx) => {
      const calendar = await workingCalendarFor(ctx, org.memberId)
      expect(calendar.calendarId).toBe('uk-england-wales')
      expect(calendar.departmentName).toBe('Operations')
      expect(worksOn(calendar, new Date(`${CHRISTMAS}T10:00:00Z`))).toBe(false)
      expect(worksOn(calendar, new Date(`${ORDINARY}T10:00:00Z`))).toBe(true)
    })

    // Nobody's department, nobody's calendar: chased exactly as before.
    await withTenant(session, async (ctx) => {
      const calendar = await workingCalendarFor(ctx, org.viewerId)
      expect(calendar.calendarId).toBeNull()
      expect(worksOn(calendar, new Date(`${CHRISTMAS}T10:00:00Z`))).toBe(true)
    })
  })
})

describe('nobody is chased on a day they do not work', () => {
  async function taskFor(title: string, dueAt: Date, assigneeId: string): Promise<string> {
    const [task] = await adminSql()<{ id: string }[]>`
      INSERT INTO tasks (organization_id, title, status, priority, assignee_id, due_at, is_demo, created_by)
      VALUES (${org.organizationId}, ${title}, 'todo', 'medium', ${assigneeId}, ${dueAt}, true, ${org.ownerId})
      RETURNING id`
    return task!.id
  }

  it('schedules the rung onto the next working day rather than a day nobody works', async () => {
    const taskId = await taskFor('Pre-cool the trailer', new Date(`${CHRISTMAS}T09:00:00Z`), org.memberId)

    await withTenant(session, async (ctx) => {
      const outcome = await scheduleLadder(ctx, {
        recipientUserId: org.memberId,
        subjectType: 'task',
        subjectId: taskId,
        subjectLabel: 'Pre-cool the trailer',
        dueAt: new Date(`${CHRISTMAS}T09:00:00Z`),
        // Two days before the due date, so the heads-up rung is the one that is chosen.
        now: new Date('2026-12-22T09:00:00Z'),
      })
      expect(outcome.scheduled).toBe(1)
    })

    const [nudge] = await adminSql()<{ scheduledFor: Date }[]>`
      SELECT scheduled_for AS "scheduledFor" FROM nudges
      WHERE organization_id = ${org.organizationId} AND subject_id = ${taskId}`
    // The heads-up lands on 23 December, which is a Wednesday and a working day, so it does
    // not move. What matters is that it never lands on the 25th, 26th, 27th or 28th.
    expect(nudge!.scheduledFor.toISOString().slice(0, 10)).toBe('2026-12-23')
  })

  it('holds a delivery due on a non-working day, and says why', async () => {
    const taskId = await taskFor('File the customs entry', new Date(`${ORDINARY}T09:00:00Z`), org.memberId)
    await adminSql()`
      INSERT INTO nudges (
        organization_id, recipient_user_id, subject_type, subject_id, stage, channel, message,
        actions, scheduled_for, is_demo, created_by
      ) VALUES (
        ${org.organizationId}, ${org.memberId}, 'task', ${taskId}, 2, 'in_app',
        'File the customs entry — still open.', '["done"]'::jsonb,
        ${new Date(`${CHRISTMAS}T09:00:00Z`)}, true, ${org.ownerId}
      )`

    const held = await withTenant(session, async (ctx) =>
      deliverDueNudges(ctx, { now: new Date(`${CHRISTMAS}T10:00:00Z`), subjectId: taskId }),
    )
    expect(held.delivered).toBe(0)
    expect(held.heldByCalendar).toBe(1)

    const [row] = await adminSql()<{ deliveredAt: Date | null; heldReason: string | null }[]>`
      SELECT delivered_at AS "deliveredAt", held_reason AS "heldReason" FROM nudges
      WHERE organization_id = ${org.organizationId} AND subject_id = ${taskId}`
    expect(row!.deliveredAt).toBeNull()
    expect(row!.heldReason).toContain('Christmas Day')

    // And the same reminder goes out on the next working day, rather than being lost.
    const sent = await withTenant(session, async (ctx) =>
      deliverDueNudges(ctx, { now: new Date('2026-12-29T10:00:00Z'), subjectId: taskId }),
    )
    expect(sent.delivered).toBe(1)
    expect(sent.heldByCalendar).toBe(0)

    const [after] = await adminSql()<{ deliveredAt: Date | null; heldReason: string | null }[]>`
      SELECT delivered_at AS "deliveredAt", held_reason AS "heldReason" FROM nudges
      WHERE organization_id = ${org.organizationId} AND subject_id = ${taskId}`
    expect(after!.deliveredAt).not.toBeNull()
    expect(after!.heldReason).toBeNull()
  })

  it('still chases somebody whose department sets no calendar, which is what it did before', async () => {
    const taskId = await taskFor('Something for the viewer', new Date(`${ORDINARY}T09:00:00Z`), org.viewerId)
    await adminSql()`
      INSERT INTO nudges (
        organization_id, recipient_user_id, subject_type, subject_id, stage, channel, message,
        actions, scheduled_for, is_demo, created_by
      ) VALUES (
        ${org.organizationId}, ${org.viewerId}, 'task', ${taskId}, 2, 'in_app',
        'Something for the viewer — still open.', '["done"]'::jsonb,
        ${new Date(`${CHRISTMAS}T09:00:00Z`)}, true, ${org.ownerId}
      )`

    const outcome = await withTenant(session, async (ctx) =>
      deliverDueNudges(ctx, { now: new Date(`${CHRISTMAS}T10:00:00Z`), subjectId: taskId }),
    )
    expect(outcome.delivered).toBe(1)
    expect(outcome.heldByCalendar).toBe(0)
  })
})
