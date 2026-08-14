import { localParts, zonedTimeToUtc } from './time.js'

/**
 * Cron, evaluated in a timezone (§2.4).
 *
 * "Every weekday at 9" means nine o'clock where the company is, not nine o'clock UTC, and
 * it means it on the morning the clocks change too. Computing a schedule in server local
 * time — or in UTC and hoping — is the same class of bug as computing "overdue" that way,
 * so none of this uses `new Date().getHours()`.
 *
 * The supported grammar is the five standard fields with `*`, lists, ranges and steps,
 * plus the traditional `@daily`-style aliases. The date part is evaluated a whole local day
 * at a time, which is what gives exactly one firing per matching day across a
 * daylight-saving change rather than none or two.
 *
 * Anything outside that grammar is refused where the schedule is written, with the
 * supported forms named. A spec that parses to nothing would be a workflow that silently
 * never fires, which is the failure this product exists to not have.
 */

/**
 * The traditional aliases (`man 5 crontab`). They are normalized to five fields on the way
 * in, so everything downstream — the scheduler, the dry run, the description — deals with
 * one grammar rather than two.
 *
 * `@reboot` is deliberately absent: a schedule row is a promise about wall-clock time, and
 * "when the process happens to start" is not one. It is refused by name below.
 */
export const CRON_ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

/** Turns an alias into five fields; anything else is returned unchanged and trimmed. */
export function normalizeCron(spec: string): string {
  const trimmed = spec.trim()
  return CRON_ALIASES[trimmed.toLowerCase()] ?? trimmed
}

/**
 * Why a spec cannot be used, in words a person can act on — or null when it is fine.
 * Used by the API so a rejected schedule explains itself instead of failing a regex.
 */
export function cronProblem(spec: string): string | null {
  const trimmed = spec.trim()
  if (!trimmed) return 'Give a schedule — either an alias like @daily or five cron fields like "0 9 * * 1-5".'
  if (trimmed.toLowerCase() === '@reboot') {
    return (
      '@reboot is not a schedule, it is "whenever the process happens to start". Say when it should run — ' +
      '@daily, or "0 9 * * 1-5" for every weekday at nine.'
    )
  }
  if (trimmed.startsWith('@') && !(trimmed.toLowerCase() in CRON_ALIASES)) {
    return `"${trimmed}" is not one of the aliases. The ones that work: ${Object.keys(CRON_ALIASES).join(', ')}.`
  }
  if (parseCron(trimmed)) return null
  const fields = normalizeCron(trimmed).split(/\s+/).length
  if (fields !== 5) {
    return `A cron expression has five fields — minute, hour, day of month, month, day of week — and this has ${fields}.`
  }
  return (
    'One of those fields is out of range or uses something this does not support. `*`, lists (1,3), ranges (1-5) ' +
    'and steps (*/15) work; `L`, `W` and `#` do not.'
  )
}

export interface CronFields {
  minute: number[]
  hour: number[]
  dayOfMonth: string
  month: string
  dayOfWeek: string
}

const LIMITS: Record<string, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  dayOfWeek: [0, 6],
}

export function parseCron(spec: string): CronFields | null {
  const parts = normalizeCron(spec).split(/\s+/)
  if (parts.length !== 5) return null
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [string, string, string, string, string]
  const minutes = expand(minute, 'minute')
  const hours = expand(hour, 'hour')
  if (!minutes || !hours) return null
  for (const [field, name] of [
    [dayOfMonth, 'dayOfMonth'],
    [month, 'month'],
    [dayOfWeek, 'dayOfWeek'],
  ] as const) {
    if (!expand(field, name)) return null
  }
  return { minute: minutes, hour: hours, dayOfMonth, month, dayOfWeek }
}

function expand(field: string, name: keyof typeof LIMITS | string): number[] | null {
  const [min, max] = LIMITS[name] ?? [0, 59]
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const [range, stepText] = part.split('/')
    const stride = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(stride) || stride < 1) return null
    let start = min
    let end = max
    if (range !== '*') {
      const [startText, endText] = range!.split('-')
      start = Number(startText)
      end = endText === undefined ? start : Number(endText)
      if (!Number.isInteger(start) || !Number.isInteger(end)) return null
      if (start < min || end > max || end < start) return null
      if (endText === undefined && stepText !== undefined) end = max
    }
    for (let value = start; value <= end; value += stride) out.add(value)
  }
  return out.size ? [...out].sort((a, b) => a - b) : null
}

function matches(field: string, value: number, name: string): boolean {
  if (field === '*') return true
  const values = expand(field, name)
  return values ? values.includes(value) : false
}

/**
 * Whether a calendar date is one this schedule fires on. Cron's historical rule: when both
 * day-of-month and day-of-week are restricted, either matching is enough.
 */
function dateMatches(fields: CronFields, year: number, month: number, day: number): boolean {
  if (!matches(fields.month, month, 'month')) return false
  const dow = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  const domRestricted = fields.dayOfMonth !== '*'
  const dowRestricted = fields.dayOfWeek !== '*'
  if (domRestricted && dowRestricted) {
    return matches(fields.dayOfMonth, day, 'dayOfMonth') || matches(fields.dayOfWeek, dow, 'dayOfWeek')
  }
  if (domRestricted) return matches(fields.dayOfMonth, day, 'dayOfMonth')
  if (dowRestricted) return matches(fields.dayOfWeek, dow, 'dayOfWeek')
  return true
}

/** The first firing strictly after `after`, or null if there is none within a year. */
export function nextOccurrence(spec: string, timeZone: string, after: Date = new Date()): Date | null {
  const fields = parseCron(spec)
  if (!fields) return null

  const start = localParts(after, timeZone)
  const cursor = new Date(Date.UTC(start.year, start.month - 1, start.day))

  for (let day = 0; day < 400; day += 1) {
    const year = cursor.getUTCFullYear()
    const month = cursor.getUTCMonth() + 1
    const date = cursor.getUTCDate()
    if (dateMatches(fields, year, month, date)) {
      for (const hour of fields.hour) {
        for (const minute of fields.minute) {
          const instant = zonedTimeToUtc({ year, month, day: date, hour, minute }, timeZone)
          if (instant.getTime() > after.getTime()) return instant
        }
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return null
}

/** Every firing in `(from, to]`. Used to count history and to count what a worker missed. */
export function occurrencesBetween(spec: string, timeZone: string, from: Date, to: Date, cap = 10_000): Date[] {
  const out: Date[] = []
  let cursor = from
  while (out.length < cap) {
    const next = nextOccurrence(spec, timeZone, cursor)
    if (!next || next.getTime() > to.getTime()) break
    out.push(next)
    cursor = next
  }
  return out
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/**
 * The sentence shown beside a schedule. A cron string is not an explanation, and neither is
 * `@monthly` — both are rendered as the same kind of English so the reader never has to
 * know which form was typed.
 */
export function describeCron(spec: string, timeZone: string): string {
  const fields = parseCron(spec)
  if (!fields) return spec

  // Every hour, every quarter hour: the time list is the wrong way to say it.
  if (fields.hour.length === 24) {
    const minutes = fields.minute.length === 60 ? 'every minute' : `at ${fields.minute.map(pad).map((m) => `:${m}`).join(', ')}`
    return `${everyDayPart(fields)}, hourly ${minutes} ${timeZone}`.replace('every day, ', '')
  }

  const at = fields.hour
    .flatMap((hour) => fields.minute.map((minute) => `${pad(hour)}:${pad(minute)}`))
    .slice(0, 4)
    .join(', ')
  return `${everyDayPart(fields)} at ${at} ${timeZone}`
}

function everyDayPart(fields: CronFields): string {
  const monthPart = fields.month === '*' ? '' : ` in ${(expand(fields.month, 'month') ?? []).map((m) => MONTH_NAMES[m - 1]).join(', ')}`

  if (fields.dayOfWeek !== '*') {
    const days = expand(fields.dayOfWeek, 'dayOfWeek') ?? []
    if (days.length === 5 && days.every((day) => day >= 1 && day <= 5)) return `every weekday${monthPart}`
    if (days.length === 1) return `every ${DAY_NAMES[days[0]!]}${monthPart}`
    return `every ${days.map((day) => DAY_NAMES[day]).join(', ')}${monthPart}`
  }
  if (fields.dayOfMonth !== '*') {
    const dates = expand(fields.dayOfMonth, 'dayOfMonth') ?? []
    // "1 January" reads better than "day 1 of the month in January".
    if (dates.length === 1 && monthPart) {
      const months = expand(fields.month, 'month') ?? []
      if (months.length === 1) return `on ${dates[0]} ${MONTH_NAMES[months[0]! - 1]}`
    }
    return `on day ${dates.join(', ')} of the month${monthPart}`
  }
  return `every day${monthPart}`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}
