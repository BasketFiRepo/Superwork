/**
 * Timezone arithmetic (§2.4).
 *
 * "Today", "overdue" and "this week" are always computed in the *viewing user's*
 * timezone. Computing them in server local time is listed in the spec as a top-3
 * source of silent bugs in operations software, so none of it is done with
 * `new Date().getHours()` anywhere in this codebase.
 */

interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(timeZone, f)
  }
  return f
}

export function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = formatterFor(timeZone).formatToParts(instant)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0')
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  }
}

function offsetMs(instant: Date, timeZone: string): number {
  const p = localParts(instant, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000
}

/** The UTC instant at which the given local wall-clock time occurs in `timeZone`. */
export function zonedTimeToUtc(
  parts: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number },
  timeZone: string,
): Date {
  const naive = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour ?? 0, parts.minute ?? 0, parts.second ?? 0)
  // Two passes converge across DST boundaries.
  let guess = new Date(naive - offsetMs(new Date(naive), timeZone))
  guess = new Date(naive - offsetMs(guess, timeZone))
  return guess
}

export function startOfDay(instant: Date, timeZone: string): Date {
  const p = localParts(instant, timeZone)
  return zonedTimeToUtc({ year: p.year, month: p.month, day: p.day }, timeZone)
}

export function endOfDay(instant: Date, timeZone: string): Date {
  return new Date(addDays(startOfDay(instant, timeZone), 1, timeZone).getTime() - 1)
}

export function addDays(instant: Date, days: number, timeZone: string): Date {
  const p = localParts(instant, timeZone)
  return zonedTimeToUtc(
    { year: p.year, month: p.month, day: p.day + days, hour: p.hour, minute: p.minute, second: p.second },
    timeZone,
  )
}

/** Monday-start week, in the viewing user's timezone. */
export function startOfWeek(instant: Date, timeZone: string): Date {
  const midnight = startOfDay(instant, timeZone)
  const dow = new Date(midnight).getUTCDay() // 0=Sun
  const back = dow === 0 ? 6 : dow - 1
  return addDays(midnight, -back, timeZone)
}

export function isOverdue(dueAt: Date | null, timeZone: string, now = new Date()): boolean {
  if (!dueAt) return false
  return dueAt.getTime() < startOfDay(now, timeZone).getTime()
}

export function isDueToday(dueAt: Date | null, timeZone: string, now = new Date()): boolean {
  if (!dueAt) return false
  const start = startOfDay(now, timeZone).getTime()
  const end = endOfDay(now, timeZone).getTime()
  return dueAt.getTime() >= start && dueAt.getTime() <= end
}

export function formatInZone(instant: Date, timeZone: string, opts: Intl.DateTimeFormatOptions = {}): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, ...opts }).format(instant)
}

/** "6 overdue (as of 09:41, your timezone)" — numbers always carry their basis (§16.9). */
export function asOfLabel(timeZone: string, now = new Date()): string {
  return `as of ${formatInZone(now, timeZone, { hour: '2-digit', minute: '2-digit' })}, your timezone`
}

export function daysBetween(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000)
}
