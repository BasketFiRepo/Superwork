import type { TenantContext } from '@superwork/db'
import {
  calendarInfo,
  isWorkingDay,
  nextWorkingDay,
  nonWorkingReason,
  upcomingNonWorkingDays,
  type Holiday,
} from './holidays.js'
import { calendarDate } from './time.js'

/**
 * Which calendar governs a person (§29.2).
 *
 * A department is where somebody sits (ADR 0036), so it is the right place for "which days
 * do these people work" — and it is where the column has been since migration 0001. The
 * calendar is inherited from the nearest ancestor that sets one, so a company says "England
 * and Wales" once on the top of the tree instead of on every department.
 *
 * A person with no department, or a department tree that sets no calendar anywhere above
 * them, is governed by nothing and is chased exactly as before. That is deliberate: this
 * feature may only ever *reduce* chasing, so its absence has to mean the old behaviour rather
 * than a new default somebody did not choose.
 */

export interface WorkingCalendar {
  /** Null when nothing governs this person. */
  calendarId: string | null
  label: string | null
  timezone: string
  departmentName: string | null
}

export async function workingCalendarFor(
  ctx: TenantContext,
  userId: string,
): Promise<WorkingCalendar> {
  const [row] = await ctx.sql<
    { calendarId: string | null; timezone: string | null; departmentName: string | null }[]
  >`
    SELECT
      coalesce(d.holiday_calendar, (
        SELECT a.holiday_calendar FROM departments a
        WHERE a.organization_id = d.organization_id AND a.deleted_at IS NULL
          AND a.holiday_calendar IS NOT NULL
          AND d.path LIKE a.path || ' / %'
        ORDER BY a.depth DESC LIMIT 1
      )) AS "calendarId",
      coalesce(d.timezone, o.timezone) AS timezone,
      d.name AS "departmentName"
    FROM memberships m
    JOIN organizations o ON o.id = m.organization_id
    LEFT JOIN departments d ON d.id = m.department_id AND d.deleted_at IS NULL
    WHERE m.organization_id = ${ctx.organizationId} AND m.user_id = ${userId}
      AND m.deleted_at IS NULL AND m.status = 'active'
    LIMIT 1`

  const calendarId = row?.calendarId ?? null
  return {
    calendarId,
    label: calendarInfo(calendarId)?.label ?? null,
    // The department's timezone, then the organization's. A public holiday is a date in a
    // place; asking whether "now" falls on it in the wrong place gets the wrong answer at
    // both ends of the day (§26.5).
    timezone: row?.timezone ?? ctx.timezone,
    departmentName: row?.departmentName ?? null,
  }
}

/** Whether this person is at work on the day `instant` falls on, where they are. */
export function worksOn(calendar: WorkingCalendar, instant: Date): boolean {
  if (!calendar.calendarId) return true
  return isWorkingDay(calendar.calendarId, calendarDate(calendar.timezone, instant))
}

/** Why they are not, in words a reminder's `held_reason` can carry. */
export function restReason(calendar: WorkingCalendar, instant: Date): string | null {
  if (!calendar.calendarId) return null
  return nonWorkingReason(calendar.calendarId, calendarDate(calendar.timezone, instant))
}

/**
 * Moves an instant forward to the first working day on or after it, keeping the time of day.
 *
 * Used when a rung is *scheduled* rather than delivered: a reminder dated for a day nobody
 * works is one that will sit undeliverable until somebody notices.
 */
export function shiftToWorkingDay(calendar: WorkingCalendar, instant: Date): Date {
  if (!calendar.calendarId) return instant
  const date = calendarDate(calendar.timezone, instant)
  const moved = nextWorkingDay(calendar.calendarId, date)
  if (moved === date) return instant
  const days = Math.round(
    (Date.parse(`${moved}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000,
  )
  return new Date(instant.getTime() + days * 86_400_000)
}

/** The named days ahead, for the screen that tells somebody when they will not be chased. */
export function restDaysAhead(calendar: WorkingCalendar, from: Date = new Date()): Holiday[] {
  return upcomingNonWorkingDays(calendar.calendarId, calendarDate(calendar.timezone, from))
}
