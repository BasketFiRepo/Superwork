import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  addCalendarDays,
  closeDepartmentDay,
  createDepartment,
  deliverDueNudges,
  easterSunday,
  holidaysIn,
  isWorkingDay,
  listDepartments,
  nextWorkingDay,
  nonWorkingReason,
  NotFoundError,
  PermissionError,
  reopenDepartmentDay,
  restDaysAhead,
  restReason,
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

/**
 * Days a department names for itself (ADR 0051).
 *
 * The four calendars above are national ones. They know Christmas Day and they cannot know
 * the week between Christmas and New Year, the Monday the depot moves, or the public holidays
 * of anywhere outside England, Wales and the United States. Every date here is worked out
 * relative to today rather than written down: a closure is refused once it is in the past, so
 * a hardcoded one would pass this year and fail next.
 */
describe('a department can name a day of its own', () => {
  /** A date roughly `days` ahead that the UK calendar already treats as a working day. */
  function workingDayAhead(days: number): string {
    let date = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
    while (!isWorkingDay('uk-england-wales', date)) date = addCalendarDays(date, 1)
    return date
  }

  const STOCKTAKE = workingDayAhead(60)
  const DEPOT_MOVE = workingDayAhead(75)
  const MOVED_AGAIN = workingDayAhead(90)

  it('adds a non-working day, and never takes one away', () => {
    const closed = new Map([[STOCKTAKE, 'Stocktake shutdown'], [SATURDAY, 'Stocktake shutdown']])

    expect(nonWorkingReason('uk-england-wales', STOCKTAKE, closed)).toBe('Stocktake shutdown')
    expect(isWorkingDay('uk-england-wales', STOCKTAKE, closed)).toBe(false)
    // A closure on a Saturday describes a day that was already not worked, so the calendar
    // still answers. There is no direction in which one of these makes a day workable.
    expect(nonWorkingReason('uk-england-wales', SATURDAY, closed)).toBe('a Saturday')
    expect(isWorkingDay('uk-england-wales', CHRISTMAS, closed)).toBe(false)
    // And it counts with no calendar at all, which is the case a French department is in.
    expect(isWorkingDay(null, STOCKTAKE, closed)).toBe(false)
    expect(nonWorkingReason(null, ORDINARY, closed)).toBeNull()

    expect(nextWorkingDay('uk-england-wales', STOCKTAKE, closed)).toBe(addCalendarDays(STOCKTAKE, 1))
  })

  it('refuses a day that is not a day, a name that says nothing, and a day gone by', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        closeDepartmentDay(ctx, actor, { departmentId, date: STOCKTAKE, label: 'x' }),
      ).rejects.toThrow(ValidationError)
      await expect(
        closeDepartmentDay(ctx, actor, { departmentId, date: '2027-02-30', label: 'Stocktake' }),
      ).rejects.toThrow(/not a day on the calendar/i)
      await expect(
        closeDepartmentDay(ctx, actor, { departmentId, date: 'next Tuesday', label: 'Stocktake' }),
      ).rejects.toThrow(ValidationError)
      // Closing a day that has gone would change nothing: a reminder is only ever held on the
      // day it would have arrived.
      await expect(
        closeDepartmentDay(ctx, actor, { departmentId, date: '2026-01-05', label: 'Stocktake' }),
      ).rejects.toThrow(/already gone/i)
    })
  })

  it('is org structure, so somebody who cannot change the tree cannot close a day', async () => {
    await withTenant({ ...session, userId: org.memberId }, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        closeDepartmentDay(ctx, actor, { departmentId, date: STOCKTAKE, label: 'Stocktake shutdown' }),
      ).rejects.toThrow(PermissionError)
    })
  })

  it('records who closed it and refuses a second one on the same day', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const after = await closeDepartmentDay(ctx, actor, {
        departmentId,
        date: STOCKTAKE,
        label: 'Stocktake shutdown',
      })
      const operations = after.find((row) => row.id === departmentId)!
      const closure = operations.closures.find((row) => row.date === STOCKTAKE)!
      expect(closure.label).toBe('Stocktake shutdown')
      expect(closure.own).toBe(true)
      expect(closure.setBy).not.toBeNull()

      await expect(
        closeDepartmentDay(ctx, actor, { departmentId, date: STOCKTAKE, label: 'Something else' }),
      ).rejects.toThrow(/already closed/i)
    })

    const [audit] = await adminSql()<{ action: string }[]>`
      SELECT action FROM audit_logs
      WHERE organization_id = ${org.organizationId} AND action = 'department.closed'
      ORDER BY occurred_at DESC LIMIT 1`
    expect(audit!.action).toBe('department.closed')
  })

  it('accumulates down the tree rather than overriding, unlike the calendar above it', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const child = (await listDepartments(ctx, actor)).find((row) => row.name === 'Customs')!
      await closeDepartmentDay(ctx, actor, {
        departmentId: child.id,
        date: DEPOT_MOVE,
        label: 'Depot move',
      })

      const after = await listDepartments(ctx, actor)
      const customs = after.find((row) => row.id === child.id)!
      // Both are true at once: the shutdown it inherited and the day it named itself. A
      // calendar is a single answer; closures are a set.
      expect(customs.closures.map((row) => row.date).sort()).toEqual([STOCKTAKE, DEPOT_MOVE].sort())
      expect(customs.closures.find((row) => row.date === STOCKTAKE)!.own).toBe(false)
      expect(customs.closures.find((row) => row.date === STOCKTAKE)!.from).toBe('Operations')
      expect(customs.closures.find((row) => row.date === DEPOT_MOVE)!.own).toBe(true)

      // And it does not travel upwards: Operations knows nothing about the depot move.
      const operations = after.find((row) => row.id === departmentId)!
      expect(operations.closures.map((row) => row.date)).toEqual([STOCKTAKE])
    })
  })

  it('governs the people who sit in the department, and the ones underneath it', async () => {
    await withTenant(session, async (ctx) => {
      const calendar = await workingCalendarFor(ctx, org.memberId)
      expect(calendar.closed.get(STOCKTAKE)).toBe('Stocktake shutdown')
      expect(worksOn(calendar, new Date(`${STOCKTAKE}T10:00:00Z`))).toBe(false)
      expect(restReason(calendar, new Date(`${STOCKTAKE}T10:00:00Z`))).toBe('Stocktake shutdown')
      // An ordinary working day is still one.
      expect(worksOn(calendar, new Date(`${addCalendarDays(STOCKTAKE, 1)}T10:00:00Z`))).toBe(true)
      // What the person is shown on their own reminders screen.
      expect(restDaysAhead(calendar, new Date(`${addCalendarDays(STOCKTAKE, -3)}T10:00:00Z`))
        .some((day) => day.date === STOCKTAKE && day.name === 'Stocktake shutdown')).toBe(true)
    })
  })

  it('holds a reminder on a closed day and says which day it was', async () => {
    const [task] = await adminSql()<{ id: string }[]>`
      INSERT INTO tasks (organization_id, title, status, priority, assignee_id, due_at, is_demo, created_by)
      VALUES (${org.organizationId}, 'Count the reefers', 'todo', 'medium', ${org.memberId},
              ${new Date(`${STOCKTAKE}T09:00:00Z`)}, true, ${org.ownerId})
      RETURNING id`
    await adminSql()`
      INSERT INTO nudges (
        organization_id, recipient_user_id, subject_type, subject_id, stage, channel, message,
        actions, scheduled_for, is_demo, created_by
      ) VALUES (
        ${org.organizationId}, ${org.memberId}, 'task', ${task!.id}, 2, 'in_app',
        'Count the reefers — still open.', '["done"]'::jsonb,
        ${new Date(`${STOCKTAKE}T09:00:00Z`)}, true, ${org.ownerId}
      )`

    const held = await withTenant(session, async (ctx) =>
      deliverDueNudges(ctx, { now: new Date(`${STOCKTAKE}T10:00:00Z`), subjectId: task!.id }),
    )
    expect(held.delivered).toBe(0)
    expect(held.heldByCalendar).toBe(1)

    const [row] = await adminSql()<{ heldReason: string | null }[]>`
      SELECT held_reason AS "heldReason" FROM nudges
      WHERE organization_id = ${org.organizationId} AND subject_id = ${task!.id}`
    expect(row!.heldReason).toContain('Stocktake shutdown')

    // And it arrives the next working day rather than being lost, which is the guarantee the
    // ladder has always made.
    const sent = await withTenant(session, async (ctx) =>
      deliverDueNudges(ctx, {
        now: new Date(`${addCalendarDays(STOCKTAKE, 1)}T10:00:00Z`),
        subjectId: task!.id,
      }),
    )
    expect(sent.delivered).toBe(1)
  })

  it('counts for a department that has set no calendar at all', async () => {
    // A department with no calendar and no ancestor that has one — the case a company outside
    // England, Wales and the United States is in. It moves the viewer, so it comes last.
    let warehouseId = ''
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const created = await createDepartment(ctx, actor, { name: 'Warehouse', timezone: 'Europe/London' })
      warehouseId = created.find((row) => row.name === 'Warehouse')!.id
      await ctx.sql`
        UPDATE memberships SET department_id = ${warehouseId}
        WHERE organization_id = ${org.organizationId} AND user_id = ${org.viewerId}`
      await closeDepartmentDay(ctx, actor, {
        departmentId: warehouseId,
        date: MOVED_AGAIN,
        label: 'Bastille Day',
      })
    })

    await withTenant(session, async (ctx) => {
      const calendar = await workingCalendarFor(ctx, org.viewerId)
      expect(calendar.calendarId).toBeNull()
      expect(worksOn(calendar, new Date(`${MOVED_AGAIN}T10:00:00Z`))).toBe(false)
      // Still chased on every other day, because a closure only ever adds one.
      expect(worksOn(calendar, new Date(`${SATURDAY}T10:00:00Z`))).toBe(true)
    })
  })

  it('keeps the row when a day is reopened, saying who did it and why', async () => {
    let closureId = ''
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const operations = (await listDepartments(ctx, actor)).find((row) => row.id === departmentId)!
      closureId = operations.closures.find((row) => row.date === STOCKTAKE)!.id

      await expect(
        reopenDepartmentDay(ctx, actor, { closureId, reason: 'no' }),
      ).rejects.toThrow(ValidationError)

      const after = await reopenDepartmentDay(ctx, actor, {
        closureId,
        reason: 'The stocktake moved to the following week.',
      })
      expect(after.find((row) => row.id === departmentId)!.closures).toEqual([])
    })

    // The row stays. Taking a closure away is the widening direction — people are chased on a
    // day the company had said it was shut — so it says who and why rather than disappearing.
    const [row] = await adminSql()<
      { deletedAt: Date | null; reopenedBy: string | null; reopenReason: string | null }[]
    >`
      SELECT deleted_at AS "deletedAt", reopened_by AS "reopenedBy", reopen_reason AS "reopenReason"
      FROM department_closures
      WHERE organization_id = ${org.organizationId} AND id = ${closureId}`
    expect(row!.deletedAt).not.toBeNull()
    expect(row!.reopenedBy).toBe(org.ownerId)
    expect(row!.reopenReason).toContain('following week')

    // And the day is worked again, for the people it was closed for.
    await withTenant(session, async (ctx) => {
      const calendar = await workingCalendarFor(ctx, org.memberId)
      expect(worksOn(calendar, new Date(`${STOCKTAKE}T10:00:00Z`))).toBe(true)
    })

    // The same day can be closed again afterwards: the unique index only holds for live rows.
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const after = await closeDepartmentDay(ctx, actor, {
        departmentId,
        date: STOCKTAKE,
        label: 'Stocktake shutdown, again',
      })
      expect(after.find((row) => row.id === departmentId)!.closures).toHaveLength(1)
    })
  })

  it('is another tenant’s 404, never their 403', async () => {
    const other = await createTenant('working-days-other')
    try {
      const [theirs] = await adminSql()<{ id: string }[]>`
        INSERT INTO department_closures (organization_id, department_id, closed_on, label, set_by, created_by)
        SELECT ${other.organizationId}, d.id, current_date + 30, 'Their shutdown', ${other.ownerId}, ${other.ownerId}
        FROM departments d WHERE d.organization_id = ${other.organizationId} LIMIT 1
        RETURNING id`

      if (theirs) {
        await withTenant(session, async (ctx) => {
          const actor = await loadActor(ctx)
          await expect(
            reopenDepartmentDay(ctx, actor, { closureId: theirs.id, reason: 'Not mine to reopen.' }),
          ).rejects.toThrow(NotFoundError)
        })
      }

      // And it governs nobody here.
      await withTenant(session, async (ctx) => {
        const calendar = await workingCalendarFor(ctx, org.memberId)
        expect([...calendar.closed.values()]).not.toContain('Their shutdown')
      })
    } finally {
      await destroyTenant('working-days-other')
    }
  })
})
