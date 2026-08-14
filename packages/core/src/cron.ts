import { localParts, zonedTimeToUtc } from './time.js'

/**
 * Cron, evaluated in a timezone (§2.4).
 *
 * "Every weekday at 9" means nine o'clock where the company is, not nine o'clock UTC, and
 * it means it on the morning the clocks change too. Computing a schedule in server local
 * time — or in UTC and hoping — is the same class of bug as computing "overdue" that way,
 * so none of this uses `new Date().getHours()`.
 *
 * The supported grammar is the five standard fields with `*`, lists, ranges and steps.
 * The date part is evaluated a whole local day at a time, which is what gives exactly one
 * firing per matching day across a daylight-saving change rather than none or two.
 */

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
  const parts = spec.trim().split(/\s+/)
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

/** The sentence shown beside a schedule. A cron string is not an explanation. */
export function describeCron(spec: string, timeZone: string): string {
  const fields = parseCron(spec)
  if (!fields) return spec
  const at = fields.hour
    .flatMap((hour) => fields.minute.map((minute) => `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`))
    .slice(0, 4)
    .join(', ')

  let when = 'every day'
  if (fields.dayOfWeek !== '*') {
    const days = expand(fields.dayOfWeek, 'dayOfWeek') ?? []
    if (days.length === 5 && days.every((day) => day >= 1 && day <= 5)) when = 'every weekday'
    else when = `every ${days.map((day) => DAY_NAMES[day]).join(', ')}`
  } else if (fields.dayOfMonth !== '*') {
    when = `on day ${fields.dayOfMonth} of the month`
  }
  return `${when} at ${at} ${timeZone}`
}
