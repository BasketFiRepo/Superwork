import type { TenantContext } from '@superwork/db'
import type { Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from './errors.js'
import {
  DELIVERIES,
  MAX_QUIET_MINUTES,
  quietMinutes,
  UNMUTEABLE_TYPES,
  type Delivery,
} from './notify.js'
import { writeAudit } from './audit.js'
import { cancelLadder, scheduleLadder, type NudgeAction } from './nudges.js'
import { getTask, updateTask } from './repositories/tasks.js'

/**
 * Where a reminder actually arrives (§29.2, §29.3).
 *
 * The ladder has five rungs. Three chase the owner over chat; the fourth tells whoever is
 * waiting and the fifth escalates to the owner's manager, and both of those are declared
 * `channel: 'in_app'`. There was no in-app anything. Every delivery also writes a
 * `notifications` row, in a table written by four subsystems and read only by retention and
 * erasure — both of which delete it. And when chat is not connected, which is the default
 * because the product runs with no credentials at all, delivery degrades to `in_app`: every
 * reminder the product sent landed nowhere and was recorded as delivered.
 *
 * **Nobody but you can read your reminders.** Not an admin, not your manager. A list of what
 * somebody has been chased about is a behavioural record of that person, and §29.5 does not
 * allow one to be assembled. What a manager receives is their own rung-five nudge about one
 * overdue thing, which arrives here as *their* reminder.
 */

export interface ReminderView {
  id: string
  kind: 'nudge'
  stage: number
  message: string
  subjectType: string
  subjectId: string
  subjectLabel: string | null
  /** Where it went. `in_app` means here, which is the only place it could arrive. */
  channel: string
  actions: NudgeAction[]
  deliveredAt: Date | null
  respondedAt: Date | null
  response: string | null
  responseNote: string | null
  /** True when this reminder is about somebody else's work — a rung 4 or 5. */
  aboutSomebodyElse: boolean
}

export interface NotificationView {
  id: string
  type: string
  title: string
  body: string | null
  url: string | null
  entityType: string | null
  entityId: string | null
  readAt: Date | null
  createdAt: Date
}

/** Refuses to assemble one person's reminders for anybody else, including an admin. */
function onlyYourOwn(actor: Actor, userId: string): void {
  if (userId !== actor.userId) {
    throw new PermissionError(
      'These are the reminders you were sent. Nobody — including an admin or your manager — can open somebody else’s: a list of what a person has been chased about is a record of that person, and §29.5 does not allow one to be built.',
    )
  }
}

/**
 * What this person has been asked, newest first.
 *
 * Undelivered rungs are deliberately absent. A ladder is laid out days ahead, and showing
 * somebody the three reminders they are *going* to get is a threat rather than a reminder.
 */
export async function listReminders(
  ctx: TenantContext,
  actor: Actor,
  options: { userId?: string; limit?: number } = {},
): Promise<ReminderView[]> {
  const userId = options.userId ?? actor.userId
  onlyYourOwn(actor, userId)

  const rows = await ctx.sql<
    (Omit<ReminderView, 'kind' | 'aboutSomebodyElse'> & { aboutUserId: string | null })[]
  >`
    SELECT n.id, n.stage, n.message, n.subject_type AS "subjectType", n.subject_id AS "subjectId",
           n.channel, n.actions, n.delivered_at AS "deliveredAt", n.responded_at AS "respondedAt",
           n.response, n.response_note AS "responseNote", n.about_user_id AS "aboutUserId",
           CASE n.subject_type
             WHEN 'task' THEN (SELECT t.title FROM tasks t WHERE t.id = n.subject_id)
             WHEN 'approval' THEN (SELECT a.title FROM approvals a WHERE a.id = n.subject_id)
             WHEN 'commitment' THEN (SELECT c.obligation FROM commitments c WHERE c.id = n.subject_id)
             ELSE NULL
           END AS "subjectLabel"
    FROM nudges n
    WHERE n.organization_id = ${ctx.organizationId} AND n.deleted_at IS NULL
      AND n.recipient_user_id = ${userId}
      AND n.delivered_at IS NOT NULL
      AND n.cancelled_at IS NULL
    ORDER BY n.delivered_at DESC
    LIMIT ${Math.min(options.limit ?? 50, 200)}`

  return rows.map(({ aboutUserId, ...row }) => ({
    ...row,
    kind: 'nudge' as const,
    aboutSomebodyElse: aboutUserId !== null && aboutUserId !== userId,
  }))
}

/** Everything else that was addressed to this person: workflow runs, unblocked work, the agent. */
export async function listNotifications(
  ctx: TenantContext,
  actor: Actor,
  options: { userId?: string; limit?: number; unreadOnly?: boolean; mutedToo?: boolean } = {},
): Promise<NotificationView[]> {
  const userId = options.userId ?? actor.userId
  onlyYourOwn(actor, userId)
  const sql = ctx.sql

  return sql<NotificationView[]>`
    SELECT id, type, title, body, url, entity_type AS "entityType", entity_id AS "entityId",
           read_at AS "readAt", created_at AS "createdAt"
    FROM notifications
    WHERE organization_id = ${ctx.organizationId} AND user_id = ${userId} AND deleted_at IS NULL
      -- A nudge's notification is the same sentence as the reminder above it, so it is left
      -- to that list rather than shown twice with one copy answerable and one not.
      AND type <> 'nudge'
      -- Quiet hours hold rather than drop: the row was written when the thing happened and
      -- becomes visible when the window opens (ADR 0047).
      AND deliver_after <= now()
      ${options.mutedToo ? sql`` : sql`AND delivery <> 'none'`}
      ${options.unreadOnly ? sql`AND read_at IS NULL` : sql``}
    ORDER BY created_at DESC
    LIMIT ${Math.min(options.limit ?? 50, 200)}`
}

/** For the badge in the header: unanswered reminders and unread notifications. */
export async function reminderCount(ctx: TenantContext, actor: Actor): Promise<number> {
  const [row] = await ctx.sql<{ count: number }[]>`
    SELECT (
      (SELECT count(*) FROM nudges
        WHERE organization_id = ${ctx.organizationId} AND recipient_user_id = ${actor.userId}
          AND deleted_at IS NULL AND delivered_at IS NOT NULL
          AND responded_at IS NULL AND cancelled_at IS NULL)
      +
      (SELECT count(*) FROM notifications
        WHERE organization_id = ${ctx.organizationId} AND user_id = ${actor.userId}
          AND deleted_at IS NULL AND read_at IS NULL AND type <> 'nudge'
          -- Held or turned down: neither is an interruption, so neither is on the badge.
          AND deliver_after <= now() AND delivery = 'immediate')
    )::int AS count`
  return row?.count ?? 0
}

/** Marks notifications read. Only your own, so there is no id-guessing to defend against. */
export async function markNotificationsRead(
  ctx: TenantContext,
  actor: Actor,
  input: { ids?: string[]; all?: boolean },
): Promise<number> {
  const sql = ctx.sql
  if (!input.all && (!input.ids || input.ids.length === 0)) return 0

  const rows = await sql<{ id: string }[]>`
    UPDATE notifications SET read_at = now(), updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND user_id = ${actor.userId}
      AND deleted_at IS NULL AND read_at IS NULL AND deliver_after <= now()
      ${input.all ? sql`` : sql`AND id = ANY(${input.ids!}::uuid[])`}
    RETURNING id`
  return rows.length
}

export interface AnswerInput {
  nudgeId: string
  action: NudgeAction
  note?: string
  /** For `renegotiate`: the date being asked for instead. */
  newDueAt?: Date | null
  /** For `reassign`: who is taking it. */
  reassignTo?: string | null
}

export interface AnswerOutcome {
  action: NudgeAction
  /** What happened to the thing itself, in the words the person will be shown. */
  effect: string
  /** How many later rungs were called off. */
  laddersCancelled: number
}

/**
 * Answers a reminder, and makes the answer mean something.
 *
 * `respondToNudge` wrote the word to the row and stopped there. The task was untouched, and
 * the due query does not filter on `responded_at` — so answering rung one changed nothing
 * and did not stop rungs two to five. Somebody could say "done" three times and still be
 * escalated to their manager, which is the worst possible version of a system that asks.
 *
 * Every effect goes through `updateTask`, so the permission check, the optimistic version
 * and the audit entry are the ones the task screen uses. A person can only answer a reminder
 * addressed to them, and that does not by itself let them change the work: answering "done"
 * on somebody else's task — a rung four, where you are the one waiting — records the answer
 * and says plainly that the task was not touched.
 */
export async function answerReminder(
  ctx: TenantContext,
  actor: Actor,
  input: AnswerInput,
): Promise<AnswerOutcome> {
  const [nudge] = await ctx.sql<
    {
      id: string
      recipientUserId: string
      subjectType: string
      subjectId: string
      actions: NudgeAction[]
      deliveredAt: Date | null
      aboutUserId: string | null
    }[]
  >`
    SELECT id, recipient_user_id AS "recipientUserId", subject_type AS "subjectType",
           subject_id AS "subjectId", actions, delivered_at AS "deliveredAt",
           about_user_id AS "aboutUserId"
    FROM nudges
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.nudgeId} AND deleted_at IS NULL`
  if (!nudge) throw new NotFoundError()
  if (nudge.recipientUserId !== actor.userId) {
    // Reported as absence: whether somebody else was chased about something is not a fact
    // this person is entitled to have confirmed.
    throw new NotFoundError()
  }
  if (!nudge.deliveredAt) {
    throw new ValidationError('That reminder has not been sent yet.')
  }
  if (!nudge.actions.includes(input.action)) {
    throw new ValidationError(`This reminder offers ${nudge.actions.join(', ')}.`)
  }

  // Order matters here, and each step depends on the one before it.
  //
  // The answer is recorded first, so that calling off the rest of the ladder does not sweep
  // up the rung being answered — `cancelLadder` takes everything unanswered, and an answered
  // reminder that vanished from the screen would be the answer disappearing with it.
  await ctx.sql`
    UPDATE nudges SET responded_at = now(), response = ${input.action},
                      response_note = ${input.note?.trim() || null}, updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.nudgeId}`

  // Then the rest of the ladder is called off. Without this the answer changed nothing about
  // what happens next, which is the whole reason somebody answers.
  const laddersCancelled =
    input.action === 'snooze'
      ? 0
      : await cancelLadder(ctx, {
          subjectType: nudge.subjectType as 'task',
          subjectId: nudge.subjectId,
          reason: `Answered "${input.action}" by the person who was asked.`,
        })

  // And only then the effect, because renegotiating and reassigning lay out a *new* ladder
  // and doing that first would have it cancelled a line later.
  const effect = await applyToSubject(ctx, actor, nudge, input)

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'nudge.answered',
    entityType: 'nudge',
    entityId: input.nudgeId,
    after: {
      action: input.action,
      note: input.note?.trim() || null,
      effect,
      remainingRungsCancelled: laddersCancelled,
    },
  })

  return { action: input.action, effect, laddersCancelled }
}

/**
 * What each answer does to the thing itself.
 *
 * Only a task can be acted on this way today — approvals and commitments have their own
 * screens with their own decisions on them, and a reminder about one is a pointer to that
 * screen rather than a second place to decide. Saying so is better than a button that
 * silently does nothing.
 */
async function applyToSubject(
  ctx: TenantContext,
  actor: Actor,
  nudge: { subjectType: string; subjectId: string; aboutUserId: string | null },
  input: AnswerInput,
): Promise<string> {
  if (nudge.subjectType !== 'task') {
    return `Recorded. A ${nudge.subjectType.replace(/_/g, ' ')} is decided on its own screen, so nothing here was changed.`
  }

  // A rung four or five is about *somebody else's* work. The answer is worth recording —
  // it is how the person waiting says they no longer need it — but it must not reach into
  // a task that is not theirs.
  if (nudge.aboutUserId && nudge.aboutUserId !== actor.userId) {
    return 'Recorded against this reminder. The task belongs to somebody else, so it was not changed.'
  }

  const task = await getTask(ctx, actor, nudge.subjectId).catch(() => null)
  if (!task) return 'Recorded. The work this was about is no longer there.'

  switch (input.action) {
    case 'done': {
      await updateTask(ctx, actor, { id: task.id, status: 'completed' })
      return `“${task.title}” is marked done.`
    }
    case 'blocked': {
      await updateTask(ctx, actor, {
        id: task.id,
        status: 'blocked',
        blockedReason: input.note?.trim() || 'Reported blocked when reminded.',
      })
      return `“${task.title}” is marked blocked, and the chasing stops until it moves.`
    }
    case 'renegotiate': {
      if (!input.newDueAt) {
        throw new ValidationError('A new date is what makes this different from ignoring it. Pick one.')
      }
      await updateTask(ctx, actor, { id: task.id, dueAt: input.newDueAt })
      // A new date deserves a new ladder, or renegotiating is a way of never being asked
      // again. It is laid out against the date the person themselves chose.
      await scheduleLadder(ctx, {
        recipientUserId: actor.userId,
        subjectType: 'task',
        subjectId: task.id,
        subjectLabel: task.title,
        dueAt: input.newDueAt,
      })
      return `“${task.title}” is now due ${input.newDueAt.toISOString().slice(0, 10)}, and the reminders follow the new date.`
    }
    case 'reassign': {
      if (!input.reassignTo) throw new ValidationError('Say who is taking it.')
      const [taker] = await ctx.sql<{ name: string }[]>`
        SELECT u.name FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = ${ctx.organizationId} AND m.user_id = ${input.reassignTo}
          AND m.deleted_at IS NULL AND m.status = 'active'`
      if (!taker) throw new ValidationError('That person is not a member of this organization.')
      await updateTask(ctx, actor, { id: task.id, assigneeId: input.reassignTo })
      // The ladder belongs to whoever holds the work, so it is laid out again for them
      // rather than following the person who handed it over.
      if (task.dueAt) {
        await scheduleLadder(ctx, {
          recipientUserId: input.reassignTo,
          subjectType: 'task',
          subjectId: task.id,
          subjectLabel: task.title,
          dueAt: task.dueAt,
        })
      }
      return `“${task.title}” is ${taker.name}’s now, and the reminders go to them.`
    }
    case 'snooze': {
      return 'Snoozed. The rest of the ladder still runs — a reminder you can switch off for good is not a reminder.'
    }
  }
}

export interface PreferencesView {
  briefingHour: number
  endOfDayHour: number
  briefingEnabled: boolean
  /** Stored, and honoured by nothing yet. Named so the screen can say so (§25). */
  quietHours: { start: string; end: string }
  /** Per notification type, where a person has said something about that type. */
  perType: Record<string, Delivery>
  /** The fallback for a type nobody has said anything about. */
  inApp: Delivery
}

/** Everybody has preferences whether or not a row exists, so the read never returns null. */
export async function notificationPreferences(
  ctx: TenantContext,
  actor: Actor,
  userId = actor.userId,
): Promise<PreferencesView> {
  onlyYourOwn(actor, userId)
  const [row] = await ctx.sql<
    {
      briefingHour: number
      endOfDayHour: number
      briefingEnabled: boolean
      quietHours: { start: string; end: string }
      perType: Record<string, Delivery>
      channelDefaults: Record<string, Delivery>
    }[]
  >`
    SELECT briefing_hour AS "briefingHour", end_of_day_hour AS "endOfDayHour",
           briefing_enabled AS "briefingEnabled", quiet_hours AS "quietHours",
           per_type AS "perType", channel_defaults AS "channelDefaults"
    FROM notification_preferences
    WHERE organization_id = ${ctx.organizationId} AND user_id = ${userId} AND deleted_at IS NULL`

  return {
    briefingHour: row?.briefingHour ?? 8,
    endOfDayHour: row?.endOfDayHour ?? 17,
    briefingEnabled: row?.briefingEnabled ?? true,
    quietHours: row?.quietHours ?? { start: '18:30', end: '08:30' },
    perType: row?.perType ?? {},
    inApp: row?.channelDefaults?.['in_app'] ?? 'immediate',
  }
}

/**
 * Changes when this person is written to (§15.1, ADR 0047).
 *
 * All of it is the person's own: `onlyYourOwn` in the read, and `actor.userId` in the write.
 * Nobody sets somebody else's quiet hours, for the same reason nobody enrols somebody else's
 * second factor (ADR 0043) — a preference an administrator can change on your behalf is not a
 * preference, and "who may write to me at eleven at night" is not a management decision.
 */
export async function setNotificationPreferences(
  ctx: TenantContext,
  actor: Actor,
  input: {
    briefingHour?: number
    endOfDayHour?: number
    briefingEnabled?: boolean
    quietHours?: { start: string; end: string }
    perType?: Record<string, Delivery>
    inApp?: Delivery
  },
): Promise<PreferencesView> {
  const before = await notificationPreferences(ctx, actor)
  const briefingHour = input.briefingHour ?? before.briefingHour
  const endOfDayHour = input.endOfDayHour ?? before.endOfDayHour
  const briefingEnabled = input.briefingEnabled ?? before.briefingEnabled
  const quietHours = input.quietHours ?? before.quietHours
  const inApp = input.inApp ?? before.inApp
  const perType = { ...before.perType, ...(input.perType ?? {}) }

  for (const clock of [quietHours.start, quietHours.end]) {
    if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(clock)) {
      throw new ValidationError(`Quiet hours are wall-clock times like 18:30. “${clock}” is not one.`)
    }
  }
  if (quietMinutes(quietHours) > MAX_QUIET_MINUTES) {
    throw new ValidationError(
      'Quiet hours can cover at most sixteen hours a day. "Never write to me" is not on offer — ' +
        'colleagues reach each other through this, and the honest version is turning individual ' +
        'kinds down to “nothing”, which is visible to you and to nobody else.',
    )
  }
  for (const [type, delivery] of Object.entries(perType)) {
    if (!DELIVERIES.includes(delivery)) {
      throw new ValidationError(`“${delivery}” is not a delivery. It is immediate, digest or nothing.`)
    }
    if ((UNMUTEABLE_TYPES as readonly string[]).includes(type) && delivery !== 'immediate') {
      throw new ValidationError(
        `“${type}” cannot be turned down. It is how you find out that something about you reached ` +
          'somebody else, or that the assistant has stopped and is waiting for you — a guarantee ' +
          'you can switch off is not one.',
      )
    }
  }
  if (!DELIVERIES.includes(inApp)) {
    throw new ValidationError(`“${inApp}” is not a delivery. It is immediate, digest or nothing.`)
  }

  for (const [label, hour] of [
    ['The briefing hour', briefingHour],
    ['The end-of-day hour', endOfDayHour],
  ] as const) {
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
      throw new ValidationError(`${label} is an hour of the day, from 0 to 23.`)
    }
  }

  await ctx.sql`
    INSERT INTO notification_preferences (
      organization_id, user_id, briefing_hour, end_of_day_hour, briefing_enabled,
      quiet_hours, per_type, channel_defaults, created_by
    ) VALUES (
      ${ctx.organizationId}, ${actor.userId}, ${briefingHour}, ${endOfDayHour}, ${briefingEnabled},
      ${ctx.sql.json(quietHours)}, ${ctx.sql.json(perType)},
      ${ctx.sql.json({ in_app: inApp, email: 'digest' })}, ${ctx.userId}
    )
    ON CONFLICT (organization_id, user_id) WHERE deleted_at IS NULL
    DO UPDATE SET briefing_hour = EXCLUDED.briefing_hour,
                  end_of_day_hour = EXCLUDED.end_of_day_hour,
                  briefing_enabled = EXCLUDED.briefing_enabled,
                  quiet_hours = EXCLUDED.quiet_hours,
                  per_type = EXCLUDED.per_type,
                  channel_defaults = EXCLUDED.channel_defaults,
                  updated_at = now()`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'notification_preferences.updated',
    entityType: 'user',
    entityId: actor.userId,
    before: { ...before },
    after: { briefingHour, endOfDayHour, briefingEnabled, quietHours, perType, inApp },
  })

  return notificationPreferences(ctx, actor)
}
