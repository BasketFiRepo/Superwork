import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  inQuietHours,
  listNotifications,
  notificationPreferences,
  notify,
  quietHoursEnd,
  reminderCount,
  recordDisclosure,
  setNotificationPreferences,
  UNMUTEABLE_TYPES,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * When you are written to (ADR 0047).
 *
 * `quiet_hours`, `channel_defaults` and `per_type` have sat in `notification_preferences`
 * since migration 0010, honoured by nothing: every notification was written with its delivery
 * hard-coded at one of seven call sites, and the window a person had recorded against their
 * own account was consulted by no code path at all.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let subjectSession: { organizationId: string; userId: string; timezone: string }

/**
 * Instants named rather than waited for, the seam the reminder tests already use (ADR 0039).
 * A fixed March date, when London is on UTC, so the arithmetic below is legible.
 */
const at = (clock: string) => new Date(`2026-03-04T${clock}:00Z`)

/** `HH:MM` in a zone, for building a window around the moment the test actually runs. */
function clockIn(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant)
}

beforeAll(async () => {
  org = await createTenant('notification-routing')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  subjectSession = { organizationId: org.organizationId, userId: org.memberId, timezone: TZ }
  await adminSql()`UPDATE users SET timezone = ${TZ} WHERE id = ${org.memberId}`
})

afterAll(async () => {
  await destroyTenant('notification-routing')
  await closePools()
})

describe('the window itself', () => {
  it('understands a window that wraps midnight', () => {
    const quiet = { start: '18:30', end: '08:30' }
    expect(inQuietHours(quiet, at('23:10'), TZ)).toBe(true)
    expect(inQuietHours(quiet, at('06:00'), TZ)).toBe(true)
    expect(inQuietHours(quiet, at('12:00'), TZ)).toBe(false)
    expect(inQuietHours(quiet, at('18:29'), TZ)).toBe(false)
  })

  it('ends at the wall-clock time the person wrote down, on the next day when it has to', () => {
    const quiet = { start: '18:30', end: '08:30' }
    expect(quietHoursEnd(quiet, at('23:10'), TZ).toISOString()).toBe('2026-03-05T08:30:00.000Z')
    expect(quietHoursEnd(quiet, at('06:00'), TZ).toISOString()).toBe('2026-03-04T08:30:00.000Z')
  })

  it('is read in the recipient’s timezone, not the server’s or the company’s', () => {
    // 23:10 UTC is 18:10 in New York — outside the same window, which is the whole point of
    // asking the person's own zone (§26.5).
    const quiet = { start: '18:30', end: '08:30' }
    expect(inQuietHours(quiet, at('23:10'), 'Europe/London')).toBe(true)
    expect(inQuietHours(quiet, at('23:10'), 'America/New_York')).toBe(false)
  })
})

describe('what a person may ask for', () => {
  it('starts with a window and no opinion about any particular kind', async () => {
    await withTenant(subjectSession, async (ctx) => {
      const actor = await loadActor(ctx)
      const preferences = await notificationPreferences(ctx, actor)
      expect(preferences.quietHours).toEqual({ start: '18:30', end: '08:30' })
      expect(preferences.perType).toEqual({})
      expect(preferences.inApp).toBe('immediate')
    })
  })

  it('saves a window and a routing, and they are their own', async () => {
    const saved = await withTenant(subjectSession, async (ctx) => {
      const actor = await loadActor(ctx)
      return setNotificationPreferences(ctx, actor, {
        quietHours: { start: '20:00', end: '07:00' },
        perType: { task_changed: 'digest', workflow: 'none' },
      })
    })
    expect(saved.quietHours).toEqual({ start: '20:00', end: '07:00' })
    expect(saved.perType['task_changed']).toBe('digest')

    // Nobody else's: the read refuses another user id even for the owner.
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(notificationPreferences(ctx, actor, org.memberId)).rejects.toThrow()
    })
  })

  it('refuses a window that covers the day', async () => {
    await withTenant(subjectSession, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        setNotificationPreferences(ctx, actor, { quietHours: { start: '00:00', end: '23:59' } }),
      ).rejects.toThrow(ValidationError)
      await expect(
        setNotificationPreferences(ctx, actor, { quietHours: { start: '09:00', end: '09:00' } }),
      ).rejects.toThrow(ValidationError)
      await expect(
        setNotificationPreferences(ctx, actor, { quietHours: { start: 'half eight', end: '09:00' } }),
      ).rejects.toThrow(ValidationError)
    })
  })

  it('refuses to silence what the product promises you will see', async () => {
    await withTenant(subjectSession, async (ctx) => {
      const actor = await loadActor(ctx)
      for (const type of UNMUTEABLE_TYPES) {
        await expect(
          setNotificationPreferences(ctx, actor, { perType: { [type]: 'none' } }),
        ).rejects.toThrow(ValidationError)
      }
    })
  })

  it('cannot be given a delivery that is not one, whatever writes the row', async () => {
    await expect(
      adminSql()`
        UPDATE notification_preferences SET per_type = '{"mention":"whenever"}'::jsonb
        WHERE user_id = ${org.memberId}`,
    ).rejects.toThrow(/notification_preferences_per_type_known/)
    await expect(
      adminSql()`
        UPDATE notification_preferences SET quiet_hours = '{"start":"25:00","end":"07:00"}'::jsonb
        WHERE user_id = ${org.memberId}`,
    ).rejects.toThrow(/notification_preferences_quiet_hours_valid/)
  })
})

describe('what then happens to a notification', () => {
  it('is held until the window opens, and nothing is lost', async () => {
    // A window around the moment this test runs, so "held" means held into a real future
    // rather than into a date that has already passed.
    const now = new Date()
    await withTenant(subjectSession, async (ctx) => {
      const actor = await loadActor(ctx)
      await setNotificationPreferences(ctx, actor, {
        quietHours: {
          start: clockIn(new Date(now.getTime() - 3_600_000), TZ),
          end: clockIn(new Date(now.getTime() + 2 * 3_600_000), TZ),
        },
      })
    })

    const held = await withTenant(session, (ctx) =>
      notify(ctx, {
        userId: org.memberId,
        type: 'mention',
        title: 'Somebody mentioned you',
        body: 'While they were not to be interrupted.',
      }),
    )
    expect(held.held).toBe(true)
    expect(held.delivery).toBe('immediate')
    expect(held.deliverAfter.getTime()).toBeGreaterThan(now.getTime())

    // Written down the moment it happened — nothing about it is conditional on the window.
    const [row] = await adminSql()<{ id: string; createdAt: Date }[]>`
      SELECT id, created_at AS "createdAt" FROM notifications WHERE id = ${held.id}`
    expect(row).toBeDefined()

    // And invisible until then: not in the list, not on the badge.
    const badgeWhileQuiet = await withTenant(subjectSession, async (ctx) => {
      const actor = await loadActor(ctx)
      const visible = await listNotifications(ctx, actor, {})
      expect(visible.some((n) => n.id === held.id)).toBe(false)
      return reminderCount(ctx, actor)
    })

    // The window opening is the only thing that changes, and it needs no sweep to run.
    await adminSql()`UPDATE notifications SET deliver_after = now() - interval '1 minute' WHERE id = ${held.id}`
    await withTenant(subjectSession, async (ctx) => {
      const actor = await loadActor(ctx)
      const visible = await listNotifications(ctx, actor, {})
      expect(visible.some((n) => n.id === held.id)).toBe(true)
      expect(await reminderCount(ctx, actor)).toBe(badgeWhileQuiet + 1)
    })
  })

  it('arrives immediately outside the window', async () => {
    // Back to an evening window, so "now" is outside it.
    await withTenant(subjectSession, async (ctx) => {
      const actor = await loadActor(ctx)
      await setNotificationPreferences(ctx, actor, { quietHours: { start: '20:00', end: '07:00' } })
    })
    const straightAway = await withTenant(session, (ctx) =>
      notify(ctx, { userId: org.memberId, type: 'mention', title: 'In the afternoon', now: at('14:00') }),
    )
    expect(straightAway.held).toBe(false)
  })

  it('routes a kind the person turned down to the briefing, and off the badge', async () => {
    const before = await withTenant(subjectSession, (ctx) =>
      loadActor(ctx).then((actor) => reminderCount(ctx, actor)))

    const digested = await withTenant(session, (ctx) =>
      notify(ctx, {
        userId: org.memberId,
        type: 'task_changed',
        title: '“Cold chain audit” changed',
        now: at('14:00'),
      }),
    )
    expect(digested.delivery).toBe('digest')
    expect(digested.held).toBe(false)

    await withTenant(subjectSession, async (ctx) => {
      const actor = await loadActor(ctx)
      const visible = await listNotifications(ctx, actor, {})
      // Visible where they can look, and not counted as an interruption.
      expect(visible.some((n) => n.id === digested.id)).toBe(true)
      expect(await reminderCount(ctx, actor)).toBe(before)
    })
  })

  it('records a kind turned off entirely rather than dropping it', async () => {
    const muted = await withTenant(session, (ctx) =>
      notify(ctx, { userId: org.memberId, type: 'workflow', title: 'An automation ran', now: at('14:00') }),
    )
    expect(muted.delivery).toBe('none')

    await withTenant(subjectSession, async (ctx) => {
      const actor = await loadActor(ctx)
      expect((await listNotifications(ctx, actor, {})).some((n) => n.id === muted.id)).toBe(false)
      // Still there for somebody who goes looking: "why did I not hear about this" has an answer.
      expect((await listNotifications(ctx, actor, { mutedToo: true })).some((n) => n.id === muted.id)).toBe(true)
    })
  })

  it('will not silence a disclosure, whatever the person has asked for', async () => {
    // Even with every kind turned down, the notice that something about you reached somebody
    // else is written and delivered.
    await adminSql()`
      UPDATE notification_preferences SET per_type = per_type || '{"disclosure":"none"}'::jsonb
      WHERE user_id = ${org.memberId}`

    const before = await withTenant(session, async (ctx) => {
      await recordDisclosure(ctx, {
        subjectUserId: org.memberId,
        recipientUserId: org.ownerId,
        recipientLabel: 'their manager',
        kind: 'manager_rollup',
        summary: 'An overdue task of yours was escalated.',
      })
      return true
    })
    expect(before).toBe(true)

    const [notice] = await adminSql()<{ delivery: string; title: string }[]>`
      SELECT delivery, title FROM notifications
      WHERE user_id = ${org.memberId} AND type = 'disclosure'
      ORDER BY created_at DESC LIMIT 1`
    expect(notice!.delivery).toBe('immediate')
    expect(notice!.title).toMatch(/went to their manager/i)
  })
})
