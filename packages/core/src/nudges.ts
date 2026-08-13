import type { TenantContext } from '@superwork/db'
import { asJson } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { PermissionError, ValidationError } from './errors.js'
import { writeActivity } from './audit.js'
import { PROFILES, strictestProfile, type JurisdictionProfile } from './compliance.js'

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

  const [existing] = await ctx.sql<{ id: string }[]>`
    SELECT id FROM nudges
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
      AND recipient_user_id = ${input.recipientUserId}
      AND subject_type = ${input.subjectType} AND subject_id = ${input.subjectId}
      AND cancelled_at IS NULL AND responded_at IS NULL
    LIMIT 1`
  if (existing) return { scheduled: 0, skipped: 'A ladder is already open for this, so a second agent adds nothing.' }

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

  let scheduled = 0

  {
    const { stage, at } = chosen
    const message = stage.template
      .replace('{due}', input.dueAt.toISOString().slice(0, 10))
      .replace('{owner}', input.ownerName ?? 'The owner')
      .replace('{days}', String(Math.max(0, stage.offsetDays)))

    await ctx.sql`
      INSERT INTO nudges (
        organization_id, recipient_user_id, subject_type, subject_id, stage, channel,
        message, actions, scheduled_for, agent_id, created_by
      ) VALUES (
        ${ctx.organizationId}, ${input.recipientUserId}, ${input.subjectType}, ${input.subjectId},
        ${stage.stage}, ${stage.channel}, ${`${input.subjectLabel} — ${message}`},
        ${ctx.sql.json(asJson(NUDGE_ACTIONS))}, ${at}, ${input.agentId ?? null}, ${ctx.userId}
      )
      ON CONFLICT DO NOTHING`
    scheduled += 1
  }

  return { scheduled, skipped: null }
}

/**
 * Delivers what is due, inside each person's shared budget. Returns what went out and
 * what was held back, because a silently dropped nudge is indistinguishable from a bug.
 */
export async function deliverDueNudges(
  ctx: TenantContext,
  options: { now?: Date; limit?: number } = {},
): Promise<{ delivered: number; heldByBudget: number; cancelled: number }> {
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

  const due = await ctx.sql<{ id: string; recipient_user_id: string; channel: string; message: string }[]>`
    SELECT id, recipient_user_id, channel, message FROM nudges
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
      AND delivered_at IS NULL AND cancelled_at IS NULL AND scheduled_for <= ${now}
    ORDER BY scheduled_for
    LIMIT ${options.limit ?? 200}`

  let delivered = 0
  let heldByBudget = 0

  for (const nudge of due) {
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
      UPDATE nudges SET delivered_at = now(), channel = ${channel}
      WHERE organization_id = ${ctx.organizationId} AND id = ${nudge.id}`
    await ctx.sql`
      INSERT INTO notifications (
        organization_id, user_id, type, title, body, channel, delivery, entity_type, entity_id, is_demo, created_by
      ) VALUES (
        ${ctx.organizationId}, ${nudge.recipient_user_id}, 'nudge', 'A reminder',
        ${nudge.message}, ${channel}, 'immediate', 'nudge', ${nudge.id}, false, ${ctx.userId}
      )`
    delivered += 1
  }

  return { delivered, heldByBudget, cancelled: cancelled.length }
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
