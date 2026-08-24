import type { TenantContext } from '@superwork/db'
import { localParts, zonedTimeToUtc } from './time.js'

/**
 * The one place a notification is written (§15.1, ADR 0047).
 *
 * Seven call sites used to hand-write `INSERT INTO notifications`, each with its `delivery`
 * hard-coded — so the three columns that exist to let a person say *when* they are written to
 * had nothing to act on. Routing a notification is not something a call site should decide: it
 * is a fact about the recipient, and the recipient is the same person whichever subsystem is
 * writing to them.
 *
 * Two decisions are made here and nowhere else:
 *
 *   **How it is delivered** — `per_type` for that kind, else `channel_defaults.in_app`, else
 *   immediate. A person who never wants to be interrupted by a watched task changing turns that
 *   one type down without touching the rest.
 *
 *   **When it becomes visible** — `deliver_after`, computed from the recipient's own quiet
 *   hours in the recipient's own timezone. Quiet hours *hold*, they never drop: the row is
 *   written the moment the thing happens, and appears when the window opens. A notification
 *   that silently did not arrive is indistinguishable from a bug, which is the same reason the
 *   reminder ladder says why it held something (ADR 0039).
 */

export type Delivery = 'immediate' | 'digest' | 'none'

export const DELIVERIES: Delivery[] = ['immediate', 'digest', 'none']

/** Sixteen hours: at least eight hours a day when a colleague can reach you (ADR 0047). */
export const MAX_QUIET_MINUTES = 960

/** How long a window covers, whichever way round it is written. */
export function quietMinutes(quiet: QuietHours): number {
  const start = MINUTES(quiet.start)
  const end = MINUTES(quiet.end)
  if (start === end) return 1440
  return (end - start + 1440) % 1440
}

/**
 * Types nobody may silence.
 *
 * `disclosure` is the notice that something about a person reached somebody else. The product's
 * whole claim is that nothing about you reaches your manager that you have not already seen
 * (§29.3) — a preference that could switch that off would make the guarantee a setting, and a
 * guarantee somebody can turn off is not one. `agent_needs_input` is here for a smaller
 * reason: it is the agent stopping and waiting for the person who asked, and muting it strands
 * the run rather than quieting it.
 */
export const UNMUTEABLE_TYPES = ['disclosure', 'agent_needs_input'] as const

/**
 * The kinds this product writes, in the words a person would use about them. Listed here
 * rather than discovered from the rows, so a preference can be set before the first one of a
 * kind ever arrives — a screen built from history offers nothing to somebody new.
 */
export const NOTIFICATION_TYPES: { type: string; label: string }[] = [
  { type: 'mention', label: 'Somebody mentions me in a comment' },
  { type: 'task_changed', label: 'A task I am watching changes' },
  { type: 'task_unblocked', label: 'Work of mine stops waiting on somebody else' },
  { type: 'follow_up', label: 'A follow-up I set falls due' },
  { type: 'workflow', label: 'An automation of mine has prepared something' },
  { type: 'agent_needs_input', label: 'The assistant has stopped and needs a decision' },
  { type: 'disclosure', label: 'Something about me reached somebody else' },
  { type: 'agent_digest', label: 'An agent I am accountable for reports on its week' },
  { type: 'approval_delegated', label: 'Somebody hands me an approval to decide' },
]

export interface QuietHours {
  start: string
  end: string
}

export interface NotifyInput {
  userId: string
  type: string
  title: string
  body?: string | null
  entityType?: string | null
  entityId?: string | null
  url?: string | null
  channel?: string
  isDemo?: boolean
  /** Overridden only by tests and the acceptance loops, which name the moment they mean. */
  now?: Date
}

export interface NotifyResult {
  id: string
  delivery: Delivery
  deliverAfter: Date
  /** True when quiet hours pushed it into the future rather than delivering it now. */
  held: boolean
}

const MINUTES = (clock: string): number => {
  const [hour, minute] = clock.split(':')
  return Number(hour) * 60 + Number(minute)
}

/** Whether an instant falls inside a window that may wrap midnight. */
export function inQuietHours(quiet: QuietHours, instant: Date, timeZone: string): boolean {
  const parts = localParts(instant, timeZone)
  const nowMinutes = parts.hour * 60 + parts.minute
  const start = MINUTES(quiet.start)
  const end = MINUTES(quiet.end)
  if (start === end) return false
  return start < end ? nowMinutes >= start && nowMinutes < end : nowMinutes >= start || nowMinutes < end
}

/**
 * The next instant at which the window is over, in the recipient's timezone.
 *
 * Computed from wall-clock parts rather than by adding hours, so the morning a country changes
 * its clocks the window still ends at the time the person wrote down (§26.5).
 */
export function quietHoursEnd(quiet: QuietHours, instant: Date, timeZone: string): Date {
  const parts = localParts(instant, timeZone)
  const nowMinutes = parts.hour * 60 + parts.minute
  const end = MINUTES(quiet.end)
  const sameDay = zonedTimeToUtc(
    { year: parts.year, month: parts.month, day: parts.day, hour: Math.floor(end / 60), minute: end % 60 },
    timeZone,
  )
  if (nowMinutes < end) return sameDay
  // The window ends tomorrow morning: ask the zone for tomorrow's date rather than adding 24h.
  const tomorrow = localParts(new Date(instant.getTime() + 86_400_000), timeZone)
  return zonedTimeToUtc(
    {
      year: tomorrow.year,
      month: tomorrow.month,
      day: tomorrow.day,
      hour: Math.floor(end / 60),
      minute: end % 60,
    },
    timeZone,
  )
}

interface Routing {
  delivery: Delivery
  quietHours: QuietHours
  timezone: string
}

/** What this person has asked for, for this kind of notification. */
export async function routingFor(ctx: TenantContext, userId: string, type: string): Promise<Routing> {
  const [row] = await ctx.sql<
    {
      channelDefaults: Record<string, string>
      perType: Record<string, string>
      quietHours: QuietHours
      timezone: string | null
    }[]
  >`
    SELECT coalesce(np.channel_defaults, '{}'::jsonb) AS "channelDefaults",
           coalesce(np.per_type, '{}'::jsonb) AS "perType",
           coalesce(np.quiet_hours, '{"start":"18:30","end":"08:30"}'::jsonb) AS "quietHours",
           u.timezone
    FROM users u
    LEFT JOIN notification_preferences np
      ON np.organization_id = ${ctx.organizationId} AND np.user_id = u.id AND np.deleted_at IS NULL
    WHERE u.id = ${userId}`

  const asked = (row?.perType?.[type] ?? row?.channelDefaults?.['in_app'] ?? 'immediate') as Delivery
  // A type nobody may silence keeps its delivery whatever the row says: the constraint lives
  // here rather than in the setter alone, so a row written by anything else cannot mute it.
  const delivery: Delivery = (UNMUTEABLE_TYPES as readonly string[]).includes(type) ? 'immediate' : asked
  return {
    delivery,
    quietHours: row?.quietHours ?? { start: '18:30', end: '08:30' },
    timezone: row?.timezone ?? ctx.timezone,
  }
}

/**
 * Writes one notification, routed and timed by what its recipient asked for.
 *
 * Returns what it decided so a caller — or a test, or the acceptance loop — can say what
 * happened to it. Nothing is ever dropped: a `none` type is still recorded, so "why did I not
 * hear about this" has an answer, and turning a type back on does not rewrite history.
 */
export async function notify(ctx: TenantContext, input: NotifyInput): Promise<NotifyResult> {
  const now = input.now ?? new Date()
  const routing = await routingFor(ctx, input.userId, input.type)

  // `digest` and `none` are not held: they are not interruptions in the first place, and
  // holding them would only delay the briefing that gathers them.
  const held = routing.delivery === 'immediate' && inQuietHours(routing.quietHours, now, routing.timezone)
  const deliverAfter = held ? quietHoursEnd(routing.quietHours, now, routing.timezone) : now

  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO notifications (
      organization_id, user_id, type, title, body, entity_type, entity_id, url,
      channel, delivery, deliver_after, is_demo, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.userId}, ${input.type}, ${input.title}, ${input.body ?? null},
      ${input.entityType ?? null}, ${input.entityId ?? null}, ${input.url ?? null},
      ${input.channel ?? 'in_app'}, ${routing.delivery}, ${deliverAfter},
      ${input.isDemo ?? false}, ${ctx.userId}
    ) RETURNING id`

  return { id: row!.id, delivery: routing.delivery, deliverAfter, held }
}
