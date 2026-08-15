/**
 * Working days (§29.2).
 *
 * `departments.holiday_calendar` has existed since migration 0001 and nothing has ever
 * written to it or read it. The consequence was not cosmetic: the nudge ladder chased people
 * on Christmas Day, and on every Saturday, because nothing in the product had any notion of a
 * day somebody does not work.
 *
 * The column holds a calendar *name*, so the dates have to come from somewhere. They are
 * computed here from the published rules rather than fetched, for the same reason every other
 * external dependency has a working mock (build rule 3): the whole product runs with no
 * credentials. A real holiday feed belongs behind a provider interface, and when one exists
 * this becomes its fallback rather than being replaced by it.
 *
 * Everything here works in **calendar dates** as `YYYY-MM-DD` strings, never in `Date`
 * arithmetic. A public holiday is a date in a place, not an instant, and the two are not the
 * same thing anywhere but UTC (§26.5).
 */

export type CalendarId = 'none' | 'weekends' | 'uk-england-wales' | 'us-federal'

export interface CalendarInfo {
  id: CalendarId
  label: string
  /** What it means in one sentence, for the screen that sets it. */
  description: string
  /** ISO weekday numbers that are *not* worked: 6 = Saturday, 7 = Sunday. */
  restDays: number[]
}

export const CALENDARS: CalendarInfo[] = [
  {
    id: 'none',
    label: 'Every day is a working day',
    description:
      'For round-the-clock operations. Nobody is protected from being chased at a weekend, so choose it deliberately.',
    restDays: [],
  },
  {
    id: 'weekends',
    label: 'Weekends off, no public holidays',
    description: 'Monday to Friday. Use it where the public holidays are not ones this product knows.',
    restDays: [6, 7],
  },
  {
    id: 'uk-england-wales',
    label: 'United Kingdom — England & Wales',
    description: 'Monday to Friday, plus England and Wales bank holidays including their substitute days.',
    restDays: [6, 7],
  },
  {
    id: 'us-federal',
    label: 'United States — federal',
    description: 'Monday to Friday, plus the federal holidays and the weekday they are observed on.',
    restDays: [6, 7],
  },
]

const BY_ID = new Map(CALENDARS.map((calendar) => [calendar.id, calendar]))

export function calendarInfo(id: string | null | undefined): CalendarInfo | null {
  if (!id) return null
  return BY_ID.get(id as CalendarId) ?? null
}

// ---- Date helpers, all on YYYY-MM-DD strings -------------------------------

function toParts(date: string): { year: number; month: number; day: number } {
  const [year, month, day] = date.split('-').map(Number)
  return { year: year!, month: month!, day: day! }
}

function iso(year: number, month: number, day: number): string {
  // Date.UTC normalises overflow (32 January becomes 1 February), which is why the round
  // trip goes through it rather than through string arithmetic.
  const at = new Date(Date.UTC(year, month - 1, day))
  return at.toISOString().slice(0, 10)
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  const { year, month, day } = toParts(date)
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return dow === 0 ? 7 : dow
}

export function addCalendarDays(date: string, days: number): string {
  const { year, month, day } = toParts(date)
  return iso(year, month, day + days)
}

/** The nth given weekday of a month — `nth: -1` means the last one. */
function nthWeekday(year: number, month: number, weekday: number, nth: number): string {
  if (nth > 0) {
    const first = iso(year, month, 1)
    const shift = (weekday - isoWeekday(first) + 7) % 7
    return addCalendarDays(first, shift + (nth - 1) * 7)
  }
  // Last: walk back from the final day of the month.
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const last = iso(year, month, lastDay)
  const shift = (isoWeekday(last) - weekday + 7) % 7
  return addCalendarDays(last, -shift)
}

/**
 * Easter Sunday, by the anonymous Gregorian algorithm (Meeus/Jones/Butcher).
 *
 * Good Friday and Easter Monday are bank holidays in England and Wales and they move, so
 * there is no way to state that calendar without this.
 */
export function easterSunday(year: number): string {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return iso(year, month, day)
}

/**
 * The weekday a fixed-date holiday is kept on.
 *
 * `uk`: a weekend date moves forward to the next weekday that is not already a holiday —
 * which is what produces two substitute days when Christmas falls on a Saturday.
 * `us`: Saturday is observed on the Friday before, Sunday on the Monday after.
 */
function observed(date: string, rule: 'uk' | 'us', taken: Set<string>): string {
  const weekday = isoWeekday(date)
  if (weekday < 6) return date
  if (rule === 'us') return weekday === 6 ? addCalendarDays(date, -1) : addCalendarDays(date, 1)
  let candidate = date
  do {
    candidate = addCalendarDays(candidate, 1)
  } while (isoWeekday(candidate) > 5 || taken.has(candidate))
  return candidate
}

export interface Holiday {
  date: string
  name: string
}

function ukEnglandWales(year: number): Holiday[] {
  const taken = new Set<string>()
  const add = (date: string, name: string): Holiday => {
    taken.add(date)
    return { date, name }
  }

  const easter = easterSunday(year)
  const holidays: Holiday[] = []

  holidays.push(add(observed(iso(year, 1, 1), 'uk', taken), 'New Year’s Day'))
  holidays.push(add(addCalendarDays(easter, -2), 'Good Friday'))
  holidays.push(add(addCalendarDays(easter, 1), 'Easter Monday'))
  holidays.push(add(nthWeekday(year, 5, 1, 1), 'Early May bank holiday'))
  holidays.push(add(nthWeekday(year, 5, 1, -1), 'Spring bank holiday'))
  holidays.push(add(nthWeekday(year, 8, 1, -1), 'Summer bank holiday'))
  // Christmas and Boxing Day are substituted in order, so a Saturday Christmas pushes
  // Boxing Day's substitute one further along rather than onto the same Monday.
  holidays.push(add(observed(iso(year, 12, 25), 'uk', taken), 'Christmas Day'))
  holidays.push(add(observed(iso(year, 12, 26), 'uk', taken), 'Boxing Day'))

  return holidays
}

function usFederal(year: number): Holiday[] {
  const taken = new Set<string>()
  const fixed = (month: number, day: number, name: string): Holiday => ({
    date: observed(iso(year, month, day), 'us', taken),
    name,
  })
  return [
    fixed(1, 1, 'New Year’s Day'),
    { date: nthWeekday(year, 1, 1, 3), name: 'Birthday of Martin Luther King, Jr.' },
    { date: nthWeekday(year, 2, 1, 3), name: 'Washington’s Birthday' },
    { date: nthWeekday(year, 5, 1, -1), name: 'Memorial Day' },
    fixed(6, 19, 'Juneteenth National Independence Day'),
    fixed(7, 4, 'Independence Day'),
    { date: nthWeekday(year, 9, 1, 1), name: 'Labor Day' },
    { date: nthWeekday(year, 10, 1, 2), name: 'Columbus Day' },
    fixed(11, 11, 'Veterans Day'),
    { date: nthWeekday(year, 11, 4, 4), name: 'Thanksgiving Day' },
    fixed(12, 25, 'Christmas Day'),
  ]
}

const cache = new Map<string, Map<string, string>>()

/** The public holidays a calendar names in one year, as date → name. */
export function holidaysIn(id: CalendarId, year: number): Map<string, string> {
  const key = `${id}:${year}`
  const hit = cache.get(key)
  if (hit) return hit

  let holidays: Holiday[] = []
  if (id === 'uk-england-wales') holidays = ukEnglandWales(year)
  else if (id === 'us-federal') holidays = usFederal(year)

  const map = new Map(holidays.map((holiday) => [holiday.date, holiday.name]))
  cache.set(key, map)
  return map
}

/** Why a date is not worked, or null when it is. */
export function nonWorkingReason(id: string | null | undefined, date: string): string | null {
  const calendar = calendarInfo(id)
  if (!calendar) return null
  const weekday = isoWeekday(date)
  if (calendar.restDays.includes(weekday)) {
    return weekday === 6 ? 'a Saturday' : 'a Sunday'
  }
  const named = holidaysIn(calendar.id, Number(date.slice(0, 4))).get(date)
  return named ?? null
}

export function isWorkingDay(id: string | null | undefined, date: string): boolean {
  return nonWorkingReason(id, date) === null
}

/**
 * The first working day on or after `date`.
 *
 * Bounded rather than unbounded: a calendar that somehow marked every day as a holiday would
 * otherwise spin, and a reminder pushed more than a fortnight is one nobody wants anyway —
 * at that point the honest answer is to deliver it rather than to defer for ever.
 */
export function nextWorkingDay(id: string | null | undefined, date: string, limit = 14): string {
  let candidate = date
  for (let i = 0; i < limit; i++) {
    if (isWorkingDay(id, candidate)) return candidate
    candidate = addCalendarDays(candidate, 1)
  }
  return candidate
}

/** The next few non-working days, for the screen that tells somebody what they are. */
export function upcomingNonWorkingDays(
  id: string | null | undefined,
  from: string,
  count = 5,
  horizonDays = 120,
): Holiday[] {
  const calendar = calendarInfo(id)
  if (!calendar) return []
  const found: Holiday[] = []
  let candidate = from
  for (let i = 0; i < horizonDays && found.length < count; i++) {
    const reason = nonWorkingReason(calendar.id, candidate)
    // Weekends are not news. What somebody wants to see is the days that are not obvious.
    if (reason && !calendar.restDays.includes(isoWeekday(candidate))) {
      found.push({ date: candidate, name: reason })
    }
    candidate = addCalendarDays(candidate, 1)
  }
  return found
}
