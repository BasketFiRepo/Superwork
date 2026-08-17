import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant, type TenantContext } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  answerReminder,
  createTask,
  deliverDueNudges,
  getTask,
  listNotifications,
  listReminders,
  markNotificationsRead,
  NotFoundError,
  openLaddersForDueWork,
  notificationPreferences,
  PermissionError,
  reminderCount,
  scheduleLadder,
  setNotificationPreferences,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Reminders (§29.2, §29.3).
 *
 * The ladder's last two rungs are declared `in_app` and there was no in-app anything; every
 * delivery wrote a `notifications` row that nothing read; and when chat is not connected —
 * the default — delivery degrades to `in_app`, so every reminder the product sent landed
 * nowhere and was recorded as delivered.
 *
 * The decision under test: **an answer has to mean something.** `respondToNudge` wrote the
 * word to the row and stopped. The task was untouched and the due query does not filter on
 * `responded_at`, so somebody could answer "done" three times and still be escalated to
 * their manager.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let memberSession: { organizationId: string; userId: string; timezone: string }

const yesterday = () => new Date(Date.now() - 86_400_000)

/**
 * The moment the ladder itself says the reminder will arrive.
 *
 * A rung is now scheduled past a weekend, a public holiday *and* the recipient's quiet hours
 * (ADR 0039, ADR 0047), so a pack asserting that one arrives cannot use "now" — it would pass
 * in the morning and fail after half past six. It asks the row when it means instead.
 */
async function whenItIsDue(ctx: TenantContext, subjectId: string): Promise<Date> {
  const [row] = await ctx.sql<{ scheduledFor: Date }[]>`
    SELECT min(scheduled_for) AS "scheduledFor" FROM nudges
    WHERE organization_id = ${ctx.organizationId} AND subject_id = ${subjectId}
      AND delivered_at IS NULL AND deleted_at IS NULL`
  return new Date(row!.scheduledFor.getTime() + 60_000)
}

/**
 * A task of the member's, with its ladder laid out and the due rung delivered.
 *
 * Yesterday's contacts are aged out first. The budget is per person per day and the demo
 * profile allows two or three, so a pack that chases the same person eight times would find
 * the later ones held back — which is the ration working, not a fixture that needs a
 * different person each time.
 */
async function chaseSomething(title: string): Promise<{ taskId: string; nudgeId: string }> {
  return withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    await ctx.sql`
      UPDATE nudges SET delivered_at = delivered_at - interval '2 days'
      WHERE organization_id = ${ctx.organizationId} AND recipient_user_id = ${org.memberId}
        AND delivered_at > date_trunc('day', now())`
    const task = await createTask(ctx, actor, { title, assigneeId: org.memberId, dueAt: yesterday() })
    await scheduleLadder(ctx, {
      recipientUserId: org.memberId,
      subjectType: 'task',
      subjectId: task.id,
      subjectLabel: title,
      dueAt: yesterday(),
    })
    await deliverDueNudges(ctx, { subjectId: task.id, now: await whenItIsDue(ctx, task.id) })
    const [nudge] = await ctx.sql<{ id: string }[]>`
      SELECT id FROM nudges
      WHERE organization_id = ${ctx.organizationId} AND subject_id = ${task.id}
        AND delivered_at IS NOT NULL AND deleted_at IS NULL
      ORDER BY delivered_at DESC LIMIT 1`
    return { taskId: task.id, nudgeId: nudge!.id }
  })
}

beforeAll(async () => {
  org = await createTenant('reminders')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
  memberSession = { organizationId: org.organizationId, userId: org.memberId, timezone: 'Europe/London' }
})

afterAll(async () => {
  await destroyTenant('reminders')
  await closePools()
})

describe('a reminder arrives somewhere', () => {
  it('shows the person what they were actually sent', async () => {
    // Before this, delivery wrote a notification nothing read and the ladder's in-app rungs
    // had no in-app anything to arrive in.
    const { taskId } = await chaseSomething('Send the pre-cool logs')
    const mine = await withTenant(memberSession, async (ctx) => listReminders(ctx, await loadActor(ctx)))
    expect(mine).toHaveLength(1)
    expect(mine[0]?.subjectId).toBe(taskId)
    expect(mine[0]?.subjectLabel).toBe('Send the pre-cool logs')
    expect(mine[0]?.actions.length).toBeGreaterThan(0)
  })

  it('counts what is waiting for an answer', async () => {
    const count = await withTenant(memberSession, async (ctx) => reminderCount(ctx, await loadActor(ctx)))
    expect(count).toBeGreaterThan(0)
  })

  it('does not show a rung that has not been sent yet', async () => {
    // A ladder is laid out days ahead. Showing somebody the reminders they are *going* to
    // get is a threat, not a reminder.
    const scheduled = await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const task = await createTask(ctx, actor, {
        title: 'Something due next week',
        assigneeId: org.memberId,
        dueAt: new Date(Date.now() + 7 * 86_400_000),
      })
      await scheduleLadder(ctx, {
        recipientUserId: org.memberId,
        subjectType: 'task',
        subjectId: task.id,
        subjectLabel: 'Something due next week',
        dueAt: new Date(Date.now() + 7 * 86_400_000),
      })
      return task.id
    })
    const mine = await withTenant(memberSession, async (ctx) => listReminders(ctx, await loadActor(ctx)))
    expect(mine.map((row) => row.subjectId)).not.toContain(scheduled)
  })

  it('refuses to assemble one person’s reminders for anybody else, admin included', async () => {
    // A list of what somebody has been chased about is a behavioural record of them.
    await expect(
      withTenant(session, async (ctx) => listReminders(ctx, await loadActor(ctx), { userId: org.memberId })),
    ).rejects.toThrow(PermissionError)
    await expect(
      withTenant(session, async (ctx) => listNotifications(ctx, await loadActor(ctx), { userId: org.memberId })),
    ).rejects.toThrow(/§29.5|record of that person/i)
  })

  it('reports absence when answering somebody else’s reminder', async () => {
    const { nudgeId } = await chaseSomething('Not yours to answer')
    await expect(
      withTenant(session, async (ctx) =>
        answerReminder(ctx, await loadActor(ctx), { nudgeId, action: 'done' }),
      ),
    ).rejects.toThrow(NotFoundError)
  })
})

describe('the answer means something', () => {
  it('marks the work done, and stops the rest of the ladder', async () => {
    const { taskId, nudgeId } = await chaseSomething('Close the excursion report')
    const outcome = await withTenant(memberSession, async (ctx) =>
      answerReminder(ctx, await loadActor(ctx), { nudgeId, action: 'done' }),
    )
    expect(outcome.effect).toMatch(/marked done/i)

    const task = await withTenant(session, async (ctx) => getTask(ctx, await loadActor(ctx), taskId))
    expect(task.status).toBe('completed')

    // The rung that mattered: before this, answering did not touch the ladder, so "done"
    // three times still ended in an escalation to the person's manager.
    const [open] = await adminSql()<{ count: number }[]>`
      SELECT count(*)::int FROM nudges
      WHERE subject_id = ${taskId} AND cancelled_at IS NULL AND responded_at IS NULL AND deleted_at IS NULL`
    expect(open?.count).toBe(0)
  })

  it('records blocked on the task itself, with what was said', async () => {
    const { taskId, nudgeId } = await chaseSomething('Waiting on the carrier')
    await withTenant(memberSession, async (ctx) =>
      answerReminder(ctx, await loadActor(ctx), {
        nudgeId,
        action: 'blocked',
        note: 'Carrier has not confirmed the slot.',
      }),
    )
    const task = await withTenant(session, async (ctx) => getTask(ctx, await loadActor(ctx), taskId))
    expect(task.status).toBe('blocked')
    expect(task.blockedReason).toMatch(/carrier/i)
  })

  it('will not renegotiate without a date, and follows the new one when given', async () => {
    const { taskId, nudgeId } = await chaseSomething('Draft the peak plan')
    await expect(
      withTenant(memberSession, async (ctx) =>
        answerReminder(ctx, await loadActor(ctx), { nudgeId, action: 'renegotiate' }),
      ),
    ).rejects.toThrow(ValidationError)

    const newDate = new Date(Date.now() + 5 * 86_400_000)
    const outcome = await withTenant(memberSession, async (ctx) =>
      answerReminder(ctx, await loadActor(ctx), { nudgeId, action: 'renegotiate', newDueAt: newDate }),
    )
    expect(outcome.effect).toMatch(/now due/i)

    const task = await withTenant(session, async (ctx) => getTask(ctx, await loadActor(ctx), taskId))
    expect(task.dueAt?.toISOString().slice(0, 10)).toBe(newDate.toISOString().slice(0, 10))

    // A new date deserves a new ladder — laid out against the date the person chose, and
    // not swept away by the cancellation that ends the old one.
    const [pending] = await adminSql()<{ count: number }[]>`
      SELECT count(*)::int FROM nudges
      WHERE subject_id = ${taskId} AND cancelled_at IS NULL AND responded_at IS NULL AND deleted_at IS NULL`
    expect(pending?.count).toBe(1)
  })

  it('hands the work and the chasing to somebody else', async () => {
    const { taskId, nudgeId } = await chaseSomething('Compare the brokers')
    const outcome = await withTenant(memberSession, async (ctx) =>
      answerReminder(ctx, await loadActor(ctx), { nudgeId, action: 'reassign', reassignTo: org.viewerId }),
    )
    expect(outcome.effect).toMatch(/reminders go to them/i)

    const task = await withTenant(session, async (ctx) => getTask(ctx, await loadActor(ctx), taskId))
    expect(task.assigneeId).toBe(org.viewerId)

    const [theirs] = await adminSql()<{ count: number }[]>`
      SELECT count(*)::int FROM nudges
      WHERE subject_id = ${taskId} AND recipient_user_id = ${org.viewerId}
        AND cancelled_at IS NULL AND deleted_at IS NULL`
    expect(theirs?.count).toBe(1)
  })

  it('keeps chasing after a snooze, and stops after a done', async () => {
    // The difference is the whole point of having five answers rather than one. A snooze
    // leaves the work open, so the next sweep opens the next rung; "done" closes the work,
    // so the sweep passes over it.
    const snoozed = await chaseSomething('Book the audit slot')
    const outcome = await withTenant(memberSession, async (ctx) =>
      answerReminder(ctx, await loadActor(ctx), { nudgeId: snoozed.nudgeId, action: 'snooze' }),
    )
    expect(outcome.laddersCancelled).toBe(0)
    expect(outcome.effect).toMatch(/still runs/i)

    const finished = await chaseSomething('Something actually finished')
    await withTenant(memberSession, async (ctx) =>
      answerReminder(ctx, await loadActor(ctx), { nudgeId: finished.nudgeId, action: 'done' }),
    )

    await withTenant(session, async (ctx) => openLaddersForDueWork(ctx))
    const [again] = await adminSql()<{ count: number }[]>`
      SELECT count(*)::int FROM nudges
      WHERE subject_id = ${snoozed.taskId} AND cancelled_at IS NULL AND responded_at IS NULL
        AND deleted_at IS NULL`
    expect(again?.count).toBeGreaterThan(0)

    const [closed] = await adminSql()<{ count: number }[]>`
      SELECT count(*)::int FROM nudges
      WHERE subject_id = ${finished.taskId} AND cancelled_at IS NULL AND responded_at IS NULL
        AND deleted_at IS NULL`
    expect(closed?.count).toBe(0)
  })

  it('keeps the answered reminder on the screen with what was said', async () => {
    const answered = await withTenant(memberSession, async (ctx) => listReminders(ctx, await loadActor(ctx)))
    const blocked = answered.find((row) => row.response === 'blocked')
    expect(blocked?.responseNote).toMatch(/carrier/i)
  })

  it('refuses an answer the reminder did not offer', async () => {
    const { nudgeId } = await chaseSomething('Something with fixed choices')
    await adminSql()`UPDATE nudges SET actions = '["done"]'::jsonb WHERE id = ${nudgeId}`
    await expect(
      withTenant(memberSession, async (ctx) =>
        answerReminder(ctx, await loadActor(ctx), { nudgeId, action: 'reassign', reassignTo: org.viewerId }),
      ),
    ).rejects.toThrow(/offers done/i)
  })

  it('records the answer in the audit trail', async () => {
    const [entry] = await adminSql()<{ diff: Record<string, { to: unknown }> }[]>`
      SELECT diff FROM audit_logs
      WHERE organization_id = ${org.organizationId} AND action = 'nudge.answered'
        AND diff -> 'action' ->> 'to' = 'blocked'`
    expect(entry?.diff['effect']?.to).toMatch(/blocked/i)
  })
})

describe('what the system told you', () => {
  it('shows the notifications nothing has ever read, and marks them read', async () => {
    await adminSql()`
      INSERT INTO notifications (organization_id, user_id, type, title, body, delivery, is_demo, created_by)
      VALUES (${org.organizationId}, ${org.memberId}, 'task_unblocked', 'You can start this now',
              'Something it was waiting on is done.', 'immediate', true, ${org.ownerId})`

    const mine = await withTenant(memberSession, async (ctx) => listNotifications(ctx, await loadActor(ctx)))
    expect(mine.map((row) => row.title)).toContain('You can start this now')

    const read = await withTenant(memberSession, async (ctx) =>
      markNotificationsRead(ctx, await loadActor(ctx), { all: true }),
    )
    expect(read).toBeGreaterThan(0)
    const after = await withTenant(memberSession, async (ctx) => listNotifications(ctx, await loadActor(ctx)))
    expect(after.every((row) => row.readAt !== null)).toBe(true)
  })

  it('does not show a nudge twice — once answerable and once not', async () => {
    const mine = await withTenant(memberSession, async (ctx) => listNotifications(ctx, await loadActor(ctx)))
    expect(mine.some((row) => row.type === 'nudge')).toBe(false)
  })

  it('marks nobody else’s notifications read', async () => {
    const [theirs] = await adminSql()<{ id: string }[]>`
      INSERT INTO notifications (organization_id, user_id, type, title, delivery, is_demo, created_by)
      VALUES (${org.organizationId}, ${org.ownerId}, 'workflow', 'Somebody else’s', 'immediate', true, ${org.ownerId})
      RETURNING id`
    const read = await withTenant(memberSession, async (ctx) =>
      markNotificationsRead(ctx, await loadActor(ctx), { ids: [theirs!.id] }),
    )
    expect(read).toBe(0)
  })
})

describe('when you hear from it', () => {
  it('gives everybody preferences whether or not a row exists', async () => {
    const prefs = await withTenant(memberSession, async (ctx) =>
      notificationPreferences(ctx, await loadActor(ctx)),
    )
    expect(prefs.briefingHour).toBe(8)
    expect(prefs.briefingEnabled).toBe(true)
  })

  it('saves the hour the briefing scheduler actually reads', async () => {
    const saved = await withTenant(memberSession, async (ctx) =>
      setNotificationPreferences(ctx, await loadActor(ctx), { briefingHour: 6, endOfDayHour: 19 }),
    )
    expect(saved.briefingHour).toBe(6)
    const [row] = await adminSql()<{ briefing_hour: number }[]>`
      SELECT briefing_hour FROM notification_preferences
      WHERE organization_id = ${org.organizationId} AND user_id = ${org.memberId} AND deleted_at IS NULL`
    expect(row?.briefing_hour).toBe(6)
  })

  it('keeps one row per person however many times it is saved', async () => {
    await withTenant(memberSession, async (ctx) =>
      setNotificationPreferences(ctx, await loadActor(ctx), { briefingHour: 7 }),
    )
    const [count] = await adminSql()<{ count: number }[]>`
      SELECT count(*)::int FROM notification_preferences
      WHERE organization_id = ${org.organizationId} AND user_id = ${org.memberId} AND deleted_at IS NULL`
    expect(count?.count).toBe(1)
  })

  it('refuses an hour that is not one', async () => {
    await expect(
      withTenant(memberSession, async (ctx) =>
        setNotificationPreferences(ctx, await loadActor(ctx), { briefingHour: 26 }),
      ),
    ).rejects.toThrow(ValidationError)
  })
})
