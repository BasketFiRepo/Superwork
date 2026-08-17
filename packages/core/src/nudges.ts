import type { TenantContext } from '@superwork/db'
import { asJson } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { PermissionError, ValidationError } from './errors.js'
import { writeActivity } from './audit.js'
import { inQuietHours, notify, quietHoursEnd, routingFor } from './notify.js'
import { recordDisclosure } from './transparency.js'
import { PROFILES, strictestProfile, type JurisdictionProfile } from './compliance.js'
import { managerOf } from './org-chart.js'
import { restReason, shiftToWorkingDay, workingCalendarFor } from './working-days.js'

/**
 * The nudge ladder and its shared budget (§29.2, §29.5).
 *
 * Chasing people is the feature operations leaders buy and the feature employees route
 * around. Three properties decide which of those it becomes:
 *
 *   • the budget belongs to the *person*, not to the agent. Five agents with a limit of
 *     three each is a limit of fifteen, which is no limit at all;
 *   • every nudge is answerable in one action — done, snooze, renegotiate, reassign,
 *     blocked — from wherever it was delivered;
 *   • finishing the work cancels the ladder everywhere, immediately. Nothing erodes trust
 *     faster than being chased for something already done.
 *
 * The jurisdiction profile sets the ceiling, and in a co-determined workplace the ladder
 * stops before it reaches a manager at all.
 */

export type NudgeSubject = 'task' | 'commitment' | 'approval'

export interface LadderStage {
  stage: number
  label: string
  /** Days relative to the due date. Negative is a heads-up before it. */
  offsetDays: number
  channel: 'in_app' | 'chat' | 'email'
  audience: 'owner' | 'waiter' | 'manager'
  template: string
}

/** The representative default from §29.2. Stage 5 only exists where the profile allows it. */
export const LADDER: LadderStage[] = [
  {
    stage: 1,
    label: 'Heads-up',
    offsetDays: -2,
    channel: 'chat',
    audience: 'owner',
    template: 'Due {due}. On track, need more time, or blocked?',
  },
  {
    stage: 2,
    label: 'Due',
    offsetDays: 0,
    channel: 'chat',
    audience: 'owner',
    template: 'Still open — mark it done, or set a new date.',
  },
  {
    stage: 3,
    label: 'Follow-up',
    offsetDays: 2,
    channel: 'chat',
    audience: 'owner',
    template: 'Overdue. What do you need to close this?',
  },
  {
    stage: 4,
    label: 'Tell whoever is waiting',
    offsetDays: 3,
    channel: 'in_app',
    audience: 'waiter',
    template: 'Your dependency is late. {owner} has been asked twice.',
  },
  {
    stage: 5,
    label: 'Escalate',
    offsetDays: 5,
    channel: 'in_app',
    audience: 'manager',
    template: '{owner} has an item {days} days overdue that others are waiting on.',
  },
]

export const NUDGE_ACTIONS = ['done', 'snooze', 'renegotiate', 'reassign', 'blocked'] as const
export type NudgeAction = (typeof NUDGE_ACTIONS)[number]

export interface NudgeView {
  id: string
  recipientUserId: string
  recipientName: string | null
  subjectType: NudgeSubject
  subjectId: string
  stage: number
  channel: string
  message: string
  actions: NudgeAction[]
  scheduledFor: Date
  deliveredAt: Date | null
  respondedAt: Date | null
  response: string | null
  cancelledAt: Date | null
  cancelReason: string | null
}

export interface BudgetState {
  profile: JurisdictionProfile
  perDay: number
  usedToday: number
  remaining: number
}

/** What the profile allows, and what this person has already had today. */
export async function nudgeBudget(ctx: TenantContext, recipientUserId: string): Promise<BudgetState> {
  const entities = await ctx.sql<{ jurisdictionProfile: JurisdictionProfile }[]>`
    SELECT jurisdiction_profile AS "jurisdictionProfile" FROM legal_entities
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL`
  const profile = strictestProfile(entities)

  const [policy] = await ctx.sql<{ nudge_budget_per_person_per_day: number }[]>`
    SELECT nudge_budget_per_person_per_day FROM monitoring_policies
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL LIMIT 1`

  // The stricter of the profile and the organization's own setting wins.
  const perDay = Math.min(PROFILES[profile].maxNudgesPerPersonPerDay, policy?.nudge_budget_per_person_per_day ?? 3)

  const [used] = await ctx.sql<{ count: string }[]>`
    SELECT count(*)::text AS count FROM nudges
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
      AND recipient_user_id = ${recipientUserId}
      AND delivered_at > date_trunc('day', now())`

  const usedToday = Number(used?.count ?? 0)
  return { profile, perDay, usedToday, remaining: Math.max(0, perDay - usedToday) }
}

export interface ScheduleInput {
  recipientUserId: string
  subjectType: NudgeSubject
  subjectId: string
  subjectLabel: string
  dueAt: Date | null
  ownerName?: string
  agentId?: string | null
  now?: Date
}

/**
 * Lays out the ladder for one thing. Nothing is delivered here — the stages are scheduled,
 * and the worker delivers what is due inside the budget. Scheduling twice for the same
 * subject is a no-op, which is what stops two agents chasing the same task.
 */
export async function scheduleLadder(
  ctx: TenantContext,
  input: ScheduleInput,
): Promise<{ scheduled: number; skipped: string | null }> {
  if (!input.dueAt) return { scheduled: 0, skipped: 'Nothing without a date is chased — there is nothing to be late for.' }

  const entities = await ctx.sql<{ jurisdictionProfile: JurisdictionProfile }[]>`
    SELECT jurisdiction_profile AS "jurisdictionProfile" FROM legal_entities
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL`
  const rules = PROFILES[strictestProfile(entities)]

  // The organization's own window, which was shown on two screens and enforced nowhere: the
  // wait below read the profile constant. The longer of the two wins, because an
  // organization may give its people more time to answer and never less.
  const [own] = await ctx.sql<{ hours: number }[]>`
    SELECT no_surprises_review_hours AS hours FROM monitoring_policies
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL`
  const reviewHours = Math.max(rules.noSurprisesReviewHours, own?.hours ?? 0)

  const now = input.now ?? new Date()

  // Which rung is due. A ladder opened on something already overdue starts at the rung
  // that fits *now* — chasing somebody with a heads-up about a date that has passed reads
  // as a system that has not noticed.
  let chosen: { stage: LadderStage; at: Date } | null = null
  for (const stage of LADDER) {
    if (stage.audience === 'manager' && !rules.allowsManagerEscalation) continue
    const at = new Date(input.dueAt.getTime() + stage.offsetDays * 86_400_000)
    if (at.getTime() <= now.getTime()) {
      chosen = { stage, at: now }
      continue
    }
    if (!chosen) chosen = { stage, at }
    break
  }
  if (!chosen) return { scheduled: 0, skipped: 'Every rung of the ladder is disallowed by this jurisdiction profile.' }

  const { stage, at } = chosen

  // Who this rung actually goes to.
  //
  // Every rung used to be delivered to `recipientUserId` — the owner — whatever its
  // declared audience. So the escalation rung sent the owner a message written in the third
  // person about themselves, and the `waiter` rung told the owner that their own dependency
  // was late. The `audience` field had never selected a recipient; it only ever decided
  // whether a rung was skipped.
  const audience = await resolveAudience(ctx, stage, input)
  if (!audience.userId) return { scheduled: 0, skipped: audience.reason }

  // "Nothing about a person reaches their manager before the person has seen it" (§29.2) is
  // a promise every profile makes and nothing enforced. A rung that goes to somebody else
  // waits until the owner has actually been contacted and had the review window to answer.
  if (audience.userId !== input.recipientUserId) {
    const [seen] = await ctx.sql<{ hours: number | null }[]>`
      SELECT (EXTRACT(EPOCH FROM (${now}::timestamptz - max(delivered_at))) / 3600)::float8 AS hours
      FROM nudges
      WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
        AND recipient_user_id = ${input.recipientUserId}
        AND subject_type = ${input.subjectType} AND subject_id = ${input.subjectId}
        AND delivered_at IS NOT NULL`
    const hours = seen?.hours ?? null
    if (hours === null) {
      return {
        scheduled: 0,
        skipped: `Nothing about ${input.ownerName ?? 'this person'} goes past them before they have seen it. They have not been contacted about this yet.`,
      }
    }
    if (hours < reviewHours) {
      return {
        scheduled: 0,
        skipped:
          `They were contacted ${hours.toFixed(1)}h ago and they have ${reviewHours}h to answer first` +
          `${reviewHours > rules.noSurprisesReviewHours ? ' — this organization gives longer than its profile requires' : ''}.`,
      }
    }
  }

  // One open ladder per recipient and subject, so two agents cannot chase the same person
  // about the same thing. Checked against the *resolved* recipient: an owner rung still
  // open is exactly the situation an escalation exists for, and testing the owner here is
  // what made escalation unreachable for precisely the unresponsive case.
  const [existing] = await ctx.sql<{ id: string }[]>`
    SELECT id FROM nudges
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
      AND recipient_user_id = ${audience.userId}
      AND subject_type = ${input.subjectType} AND subject_id = ${input.subjectId}
      AND cancelled_at IS NULL AND responded_at IS NULL
    LIMIT 1`
  if (existing) return { scheduled: 0, skipped: 'A ladder is already open for this, so a second agent adds nothing.' }

  // A rung dated for a day nobody works is one that sits undeliverable until somebody
  // notices. It is moved forward to the next working day where the *recipient* is — not
  // where the owner is, because the two are different people on the escalation rungs.
  const calendar = await workingCalendarFor(ctx, audience.userId)
  const onAWorkingDay = shiftToWorkingDay(calendar, at)
  // And out of their evening, for the same reason (ADR 0047). A rung dated for eleven at
  // night would be written now and held at delivery, which works but schedules something
  // nobody can be shown — the ladder says when it will arrive, so the row should say the
  // truth. Delivery still checks, because a window can change after a rung is written.
  const quiet = await routingFor(ctx, audience.userId, 'nudge')
  const scheduledFor = inQuietHours(quiet.quietHours, onAWorkingDay, quiet.timezone)
    ? shiftToWorkingDay(calendar, quietHoursEnd(quiet.quietHours, onAWorkingDay, quiet.timezone))
    : onAWorkingDay

  const message = stage.template
    .replace('{due}', input.dueAt.toISOString().slice(0, 10))
    .replace('{owner}', input.ownerName ?? 'The owner')
    .replace('{days}', String(Math.max(0, stage.offsetDays)))

  await ctx.sql`
    INSERT INTO nudges (
      organization_id, recipient_user_id, about_user_id, subject_type, subject_id, stage,
      channel, message, actions, scheduled_for, agent_id, created_by
    ) VALUES (
      ${ctx.organizationId}, ${audience.userId},
      ${audience.userId === input.recipientUserId ? null : input.recipientUserId},
      ${input.subjectType}, ${input.subjectId},
      ${stage.stage}, ${stage.channel}, ${`${input.subjectLabel} — ${message}`},
      ${ctx.sql.json(asJson(NUDGE_ACTIONS))}, ${scheduledFor}, ${input.agentId ?? null}, ${ctx.userId}
    )
    ON CONFLICT DO NOTHING`

  return { scheduled: 1, skipped: null }
}

/**
 * The person a rung is addressed to.
 *
 * A rung with nobody to address is not sent to the owner as a fallback. Telling somebody
 * that they are late in the third person is worse than saying nothing, and a fallback here
 * is how the audience field stopped meaning anything in the first place.
 */
async function resolveAudience(
  ctx: TenantContext,
  stage: LadderStage,
  input: ScheduleInput,
): Promise<{ userId: string | null; reason: string }> {
  if (stage.audience === 'owner') return { userId: input.recipientUserId, reason: '' }

  if (stage.audience === 'manager') {
    const manager = await managerOf(ctx, input.recipientUserId)
    return {
      userId: manager,
      reason: manager
        ? ''
        : 'This rung escalates to a manager and nobody is recorded as theirs, so it is not sent at all.',
    }
  }

  // `waiter` — whoever is held up by this. Resolved from the dependency graph rather than
  // guessed at; a task nobody is waiting on has no waiter rung.
  if (input.subjectType !== 'task') {
    return { userId: null, reason: 'Only a task has dependants, so there is nobody waiting on this.' }
  }
  const [waiting] = await ctx.sql<{ assigneeId: string | null }[]>`
    SELECT t.assignee_id AS "assigneeId"
    FROM task_dependencies d
    JOIN tasks t ON t.id = d.task_id AND t.deleted_at IS NULL
    WHERE d.organization_id = ${ctx.organizationId} AND d.depends_on_task_id = ${input.subjectId}
      AND d.deleted_at IS NULL AND t.assignee_id IS NOT NULL
      AND t.assignee_id <> ${input.recipientUserId}
      AND t.status NOT IN ('completed', 'cancelled')
    ORDER BY t.due_at NULLS LAST
    LIMIT 1`
  return {
    userId: waiting?.assigneeId ?? null,
    reason: 'Nobody is waiting on this, so there is nobody to tell.',
  }
}

/**
 * Opens a ladder for work that is near its date or past it.
 *
 * **Nothing in the product called `scheduleLadder`.** The ladder, the audience rules, the
 * per-person budget, the manager escalation and the delivery pass all existed, and no code
 * path ever started one — so `deliverDueNudges` ran on an empty queue on every tick, and the
 * whole of §29.2 was reachable only from the acceptance loops. This is the missing link, and
 * it is deliberately the dullest possible one: every open task with a date and an assignee
 * gets the rung that fits today, and scheduling twice is already a no-op.
 *
 * Only tasks. An approval and a commitment have their own screens with their own decisions
 * on them, and chasing somebody about one from here would be a second place to decide.
 */
export async function openLaddersForDueWork(
  ctx: TenantContext,
  options: { now?: Date; limit?: number } = {},
): Promise<{ opened: number; considered: number }> {
  const now = options.now ?? new Date()
  // The ladder spans two days before the date to five after it. Outside that window there is
  // no rung to open, so the sweep does not look.
  const from = new Date(now.getTime() - 5 * 86_400_000)
  const to = new Date(now.getTime() + 2 * 86_400_000)

  const due = await ctx.sql<{ id: string; title: string; assigneeId: string; dueAt: Date }[]>`
    SELECT t.id, t.title, t.assignee_id AS "assigneeId", t.due_at AS "dueAt"
    FROM tasks t
    WHERE t.organization_id = ${ctx.organizationId} AND t.deleted_at IS NULL
      AND t.status NOT IN ('completed', 'cancelled')
      AND t.assignee_id IS NOT NULL
      AND t.due_at BETWEEN ${from} AND ${to}
    ORDER BY t.due_at
    LIMIT ${options.limit ?? 200}`

  let opened = 0
  for (const task of due) {
    const outcome = await scheduleLadder(ctx, {
      recipientUserId: task.assigneeId,
      subjectType: 'task',
      subjectId: task.id,
      subjectLabel: task.title,
      dueAt: task.dueAt,
      now,
    })
    opened += outcome.scheduled
  }
  return { opened, considered: due.length }
}

/**
 * Delivers what is due, inside each person's shared budget. Returns what went out and
 * what was held back, because a silently dropped nudge is indistinguishable from a bug.
 */
export async function deliverDueNudges(
  ctx: TenantContext,
  options: {
    now?: Date
    limit?: number
    /**
     * Deliver only what is due about one thing. The budget is per person and shared across
     * every agent, so a caller that wants to push one reminder through must be able to say
     * so rather than draining somebody else's queue on the way past.
     */
    subjectId?: string
  } = {},
): Promise<{
  delivered: number
  heldByBudget: number
  heldByCalendar: number
  heldByQuietHours: number
  cancelled: number
}> {
  const now = options.now ?? new Date()

  // Anything whose work is already done cancels itself before anybody is contacted.
  const cancelled = await ctx.sql<{ id: string }[]>`
    UPDATE nudges SET cancelled_at = now(), cancel_reason = 'The work was already finished.'
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
      AND delivered_at IS NULL AND cancelled_at IS NULL
      AND subject_type = 'task'
      AND subject_id IN (
        SELECT id FROM tasks
        WHERE organization_id = ${ctx.organizationId} AND status IN ('completed', 'cancelled')
      )
    RETURNING id`

  const due = await ctx.sql<
    {
      id: string
      recipient_user_id: string
      about_user_id: string | null
      subject_type: string
      subject_id: string
      channel: string
      message: string
    }[]
  >`
    SELECT id, recipient_user_id, about_user_id, subject_type, subject_id, channel, message FROM nudges
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
      AND delivered_at IS NULL AND cancelled_at IS NULL AND scheduled_for <= ${now}
      ${options.subjectId ? ctx.sql`AND subject_id = ${options.subjectId}` : ctx.sql``}
    ORDER BY scheduled_for
    LIMIT ${options.limit ?? 200}`

  let delivered = 0
  let heldByBudget = 0
  let heldByCalendar = 0
  let heldByQuietHours = 0

  // One lookup per person rather than per reminder: a backlog after a long weekend is
  // mostly the same handful of people.
  const calendars = new Map<string, Awaited<ReturnType<typeof workingCalendarFor>>>()
  const quietFor = new Map<string, Awaited<ReturnType<typeof routingFor>>>()

  for (const nudge of due) {
    // The gate that makes the guarantee true regardless of when the row was written: a
    // reminder scheduled before the calendar was set, or before the holiday was known, is
    // still not delivered on a day its recipient does not work. It waits, and says why —
    // a reminder that silently did not arrive is indistinguishable from a bug.
    let calendar = calendars.get(nudge.recipient_user_id)
    if (!calendar) {
      calendar = await workingCalendarFor(ctx, nudge.recipient_user_id)
      calendars.set(nudge.recipient_user_id, calendar)
    }
    const resting = restReason(calendar, now)
    if (resting) {
      await ctx.sql`
        UPDATE nudges SET held_reason = ${`Not delivered: ${resting} where they work.`}, updated_at = now()
        WHERE organization_id = ${ctx.organizationId} AND id = ${nudge.id}`
      heldByCalendar += 1
      continue
    }

    // The evening, for the same reason as the weekend: a person's own quiet hours are when
    // this product may not write to them (ADR 0047). It waits and says so — the ladder has
    // never dropped a reminder and does not start here.
    const routing = quietFor.get(nudge.recipient_user_id) ?? (await routingFor(ctx, nudge.recipient_user_id, 'nudge'))
    quietFor.set(nudge.recipient_user_id, routing)
    if (inQuietHours(routing.quietHours, now, routing.timezone)) {
      await ctx.sql`
        UPDATE nudges
        SET held_reason = ${`Not delivered: it is their quiet hours, ${routing.quietHours.start}–${routing.quietHours.end} where they are.`},
            updated_at = now()
        WHERE organization_id = ${ctx.organizationId} AND id = ${nudge.id}`
      heldByQuietHours += 1
      continue
    }

    // Re-read the budget per nudge: the count comes from the rows this transaction has
    // already written, so there is no separate tally to drift out of step with them.
    const budget = await nudgeBudget(ctx, nudge.recipient_user_id)
    if (budget.remaining <= 0) {
      heldByBudget += 1
      continue
    }

    // Chat presence, where the organization has connected it (§30). A chat failure
    // degrades to the in-app notification rather than losing the reminder.
    let channel = nudge.channel
    if (channel === 'chat') {
      const posted = await postToChat(ctx, nudge.recipient_user_id, nudge.message)
      if (!posted) channel = 'in_app'
    }

    await ctx.sql`
      UPDATE nudges SET delivered_at = now(), channel = ${channel}, held_reason = NULL
      WHERE organization_id = ${ctx.organizationId} AND id = ${nudge.id}`
    await notify(ctx, {
      userId: nudge.recipient_user_id,
      type: 'nudge',
      title: 'A reminder',
      body: nudge.message,
      channel,
      entityType: 'nudge',
      entityId: nudge.id,
      now,
    })

    // Something about a person reached somebody else, so that person's own record says so —
    // in the same transaction as the delivery, because a disclosure written afterwards is
    // one that can be forgotten (§29.3). This is what turns "nothing reaches your manager
    // that you have not seen" from a claim into something with evidence behind it.
    if (nudge.about_user_id) {
      const [recipient] = await ctx.sql<{ name: string }[]>`
        SELECT name FROM users WHERE id = ${nudge.recipient_user_id}`
      await recordDisclosure(ctx, {
        subjectUserId: nudge.about_user_id,
        recipientUserId: nudge.recipient_user_id,
        recipientLabel: recipient?.name ?? 'a colleague',
        kind: 'manager_rollup',
        summary: `An overdue ${nudge.subject_type} of yours was escalated to ${recipient?.name ?? 'a colleague'}, after you were contacted about it first.`,
        fields: [`${nudge.subject_type}.due_at`, `${nudge.subject_type}.status`],
        sourceType: nudge.subject_type,
        sourceId: nudge.subject_id,
      })
    }
    delivered += 1
  }

  return { delivered, heldByBudget, heldByCalendar, heldByQuietHours, cancelled: cancelled.length }
}

/**
 * Posts to the organization's chat workspace when that capability is connected. Identity
 * is resolved by verified email, never by display name (§30.1), and anything that fails
 * falls back to the in-app channel — a reminder nobody receives is worse than one in the
 * wrong place.
 */
async function postToChat(ctx: TenantContext, recipientUserId: string, message: string): Promise<boolean> {
  const [connection] = await ctx.sql<{ status: string }[]>`
    SELECT status FROM integration_connections
    WHERE organization_id = ${ctx.organizationId} AND capability = 'chat' AND deleted_at IS NULL`
  if (!connection || connection.status !== 'connected') return false

  const [user] = await ctx.sql<{ email: string }[]>`SELECT email FROM users WHERE id = ${recipientUserId}`
  if (!user) return false

  try {
    const { chatProvider } = await import('@superwork/integrations')
    const provider = chatProvider()
    const resolved = await provider.resolveUser(user.email)
    if (!resolved) return false
    await provider.postDirectMessage(resolved.chatUserId, message)
    return true
  } catch {
    return false
  }
}

/** One action closes it. The person answering is always the recipient. */
export async function respondToNudge(
  ctx: TenantContext,
  actor: Actor,
  input: { nudgeId: string; action: NudgeAction; note?: string },
): Promise<void> {
  const [nudge] = await ctx.sql<{ recipient_user_id: string; subject_type: string; subject_id: string }[]>`
    SELECT recipient_user_id, subject_type, subject_id FROM nudges
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.nudgeId} AND deleted_at IS NULL`
  if (!nudge) throw new ValidationError('That reminder no longer exists.')
  if (nudge.recipient_user_id !== actor.userId) {
    throw new PermissionError('Only the person who was reminded can answer a reminder.')
  }
  if (!NUDGE_ACTIONS.includes(input.action)) throw new ValidationError('Unknown response.')

  await ctx.sql`
    UPDATE nudges SET responded_at = now(), response = ${input.action}
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.nudgeId}`

  await writeActivity(ctx, {
    actorType: 'user',
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'answered a reminder about',
    entityType: nudge.subject_type,
    entityId: nudge.subject_id,
    entityLabel: nudge.subject_type,
    summary: `Answered "${input.action}"${input.note ? `: ${input.note}` : ''}.`,
  })
}

/** Cancels every open ladder for a thing — called when the work completes (§28.4). */
export async function cancelLadder(
  ctx: TenantContext,
  input: { subjectType: NudgeSubject; subjectId: string; reason: string },
): Promise<number> {
  const rows = await ctx.sql<{ id: string }[]>`
    UPDATE nudges SET cancelled_at = now(), cancel_reason = ${input.reason}
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
      AND subject_type = ${input.subjectType} AND subject_id = ${input.subjectId}
      AND cancelled_at IS NULL AND responded_at IS NULL
    RETURNING id`
  return rows.length
}

export async function listNudges(
  ctx: TenantContext,
  actor: Actor,
  filter: { recipientUserId?: string; limit?: number } = {},
): Promise<NudgeView[]> {
  const recipient = filter.recipientUserId ?? actor.userId
  if (recipient !== actor.userId) {
    const decision = can(actor, 'agent_run:read', { type: 'agent_run', organizationId: ctx.organizationId })
    if (!decision.allow) throw new PermissionError(decision.reason)
  }

  return ctx.sql<NudgeView[]>`
    SELECT n.id, n.recipient_user_id AS "recipientUserId", u.name AS "recipientName",
           n.subject_type AS "subjectType", n.subject_id AS "subjectId", n.stage, n.channel,
           n.message, n.actions, n.scheduled_for AS "scheduledFor", n.delivered_at AS "deliveredAt",
           n.responded_at AS "respondedAt", n.response, n.cancelled_at AS "cancelledAt",
           n.cancel_reason AS "cancelReason"
    FROM nudges n
    LEFT JOIN users u ON u.id = n.recipient_user_id
    WHERE n.organization_id = ${ctx.organizationId} AND n.deleted_at IS NULL
      AND n.recipient_user_id = ${recipient}
    ORDER BY n.scheduled_for DESC
    LIMIT ${Math.min(filter.limit ?? 50, 200)}`
}
