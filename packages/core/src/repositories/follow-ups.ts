import type { TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeAudit } from '../audit.js'
import { notify } from '../notify.js'

/**
 * Follow-ups (§13, §29.1).
 *
 * `create_follow_up@v1` describes itself as recording a dated follow-up on a conversation
 * *"so it resurfaces if no reply arrives"*. It never resurfaced. Nothing read the table, no
 * worker swept it, and `status` had only ever held 'open' and 'cancelled' — so every
 * follow-up the agent has recorded since Phase 2 is still open, and the promise in that
 * sentence was carried entirely by the word "record".
 *
 * Two things make it true. The sweep **closes a follow-up whose thread has been answered**,
 * because being chased about a customer who already replied is the fastest way to teach
 * somebody to ignore the product. And what is left **tells its owner**, once, on their own
 * reminders screen.
 *
 * **Nothing is sent to the customer.** A follow-up coming due surfaces internally and stops
 * there; drafting a reply is a separate act a person takes, and §25.7 forbids the product
 * from sending anything outward on its own, under any setting.
 */

export type FollowUpResolution = 'done' | 'cancelled' | 'replied'

export interface FollowUpView {
  id: string
  conversationId: string | null
  conversationSubject: string | null
  companyId: string | null
  companyName: string | null
  taskId: string | null
  ownerId: string | null
  ownerName: string | null
  dueAt: Date
  reason: string | null
  status: 'open' | 'done' | 'cancelled'
  resolution: FollowUpResolution | null
  resolutionNote: string | null
  resolvedAt: Date | null
  resolvedByName: string | null
  /** True when it is due now — the reason it is on the screen at all. */
  due: boolean
  /** True when an agent recorded it rather than a person. */
  byAgent: boolean
  createdAt: Date
}

const SELECT_FOLLOW_UP = (ctx: TenantContext) => ctx.sql`
  SELECT f.id, f.conversation_id AS "conversationId", c.subject AS "conversationSubject",
         f.company_id AS "companyId", co.name AS "companyName", f.task_id AS "taskId",
         f.owner_id AS "ownerId", u.name AS "ownerName", f.due_at AS "dueAt", f.reason, f.status,
         f.resolution, f.resolution_note AS "resolutionNote", f.resolved_at AS "resolvedAt",
         (SELECT r.name FROM users r WHERE r.id = f.resolved_by) AS "resolvedByName",
         f.due_at <= now() AS due, f.agent_run_id IS NOT NULL AS "byAgent",
         f.created_at AS "createdAt"
  FROM follow_ups f
  LEFT JOIN conversations c ON c.id = f.conversation_id
  LEFT JOIN companies co ON co.id = f.company_id
  LEFT JOIN users u ON u.id = f.owner_id`

/**
 * A follow-up is about a customer thread, not about a person, so it is readable by anybody
 * who may read conversations. That is a different question from the reminders screen, which
 * is one person's own record and is refused to everybody else (ADR 0033).
 */
function guardRead(ctx: TenantContext, actor: Actor): void {
  const decision = can(actor, 'conversation:read', {
    type: 'conversation',
    organizationId: ctx.organizationId,
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
}

export async function listFollowUps(
  ctx: TenantContext,
  actor: Actor,
  filter: { ownerId?: string; conversationId?: string; openOnly?: boolean; limit?: number } = {},
): Promise<FollowUpView[]> {
  guardRead(ctx, actor)
  const sql = ctx.sql

  return sql<FollowUpView[]>`
    ${SELECT_FOLLOW_UP(ctx)}
    WHERE f.organization_id = ${ctx.organizationId} AND f.deleted_at IS NULL
      ${filter.ownerId ? sql`AND f.owner_id = ${filter.ownerId}` : sql``}
      ${filter.conversationId ? sql`AND f.conversation_id = ${filter.conversationId}` : sql``}
      ${filter.openOnly === false ? sql`` : sql`AND f.status = 'open'`}
    ORDER BY f.due_at
    LIMIT ${Math.min(filter.limit ?? 50, 200)}`
}

export interface CreateFollowUpInput {
  conversationId?: string | null
  companyId?: string | null
  taskId?: string | null
  ownerId?: string | null
  dueAt: Date
  reason: string
}

/** A person records one themselves, which until now only the agent could do. */
export async function createFollowUp(
  ctx: TenantContext,
  actor: Actor,
  input: CreateFollowUpInput,
): Promise<FollowUpView> {
  guardRead(ctx, actor)
  if (input.reason.trim().length < 4) {
    throw new ValidationError('Say what the follow-up is for. "Follow up" on its own tells the next person nothing.')
  }
  if (!input.conversationId && !input.companyId && !input.taskId) {
    throw new ValidationError('A follow-up is about something — a thread, an account or a task.')
  }

  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO follow_ups (
      organization_id, conversation_id, company_id, task_id, owner_id, due_at, reason, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.conversationId ?? null}, ${input.companyId ?? null},
      ${input.taskId ?? null}, ${input.ownerId ?? actor.userId}, ${input.dueAt},
      ${input.reason.trim()}, ${ctx.userId}
    )
    ON CONFLICT (conversation_id) WHERE deleted_at IS NULL AND status = 'open' AND conversation_id IS NOT NULL
    DO UPDATE SET due_at = EXCLUDED.due_at, reason = EXCLUDED.reason, updated_at = now()
    RETURNING id`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'follow_up.created',
    entityType: 'follow_up',
    entityId: row!.id,
    after: { dueAt: input.dueAt.toISOString(), reason: input.reason.trim(), owner: input.ownerId ?? actor.userId },
  })

  const [view] = await ctx.sql<FollowUpView[]>`
    ${SELECT_FOLLOW_UP(ctx)} WHERE f.organization_id = ${ctx.organizationId} AND f.id = ${row!.id}`
  return view!
}

/** Closes one, saying which of the three ways it ended. */
export async function resolveFollowUp(
  ctx: TenantContext,
  actor: Actor,
  input: { id: string; resolution: 'done' | 'cancelled'; note?: string },
): Promise<FollowUpView> {
  guardRead(ctx, actor)

  const [existing] = await ctx.sql<{ id: string; ownerId: string | null; status: string }[]>`
    SELECT id, owner_id AS "ownerId", status FROM follow_ups
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.id} AND deleted_at IS NULL`
  if (!existing) throw new NotFoundError()
  if (existing.status !== 'open') throw new ValidationError('That follow-up is already closed.')

  await ctx.sql`
    UPDATE follow_ups
    SET status = ${input.resolution === 'done' ? 'done' : 'cancelled'},
        resolution = ${input.resolution},
        resolved_at = now(), resolved_by = ${actor.userId},
        -- The original reason stays: why it was recorded and how it ended are two facts.
        resolution_note = ${input.note?.trim() || null},
        updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.id}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'follow_up.resolved',
    entityType: 'follow_up',
    entityId: input.id,
    after: { resolution: input.resolution, note: input.note?.trim() || null },
  })

  const [view] = await ctx.sql<FollowUpView[]>`
    ${SELECT_FOLLOW_UP(ctx)} WHERE f.organization_id = ${ctx.organizationId} AND f.id = ${input.id}`
  return view!
}

export interface FollowUpSweep {
  closedByReply: number
  surfaced: number
}

/**
 * The pass that makes "it resurfaces if no reply arrives" true.
 *
 * Answered threads close themselves first, so nobody is asked to chase a customer who has
 * already written back. What is left and due tells its owner once — the unique index on the
 * notification is what makes "once" structural rather than a flag somebody remembers to set.
 */
export async function sweepFollowUps(
  ctx: TenantContext,
  options: { now?: Date; limit?: number } = {},
): Promise<FollowUpSweep> {
  const now = options.now ?? new Date()

  const answered = await ctx.sql<{ id: string }[]>`
    UPDATE follow_ups f
    SET status = 'cancelled', resolution = 'replied', resolved_at = now(), updated_at = now()
    FROM conversations c
    WHERE c.id = f.conversation_id
      AND f.organization_id = ${ctx.organizationId} AND f.deleted_at IS NULL AND f.status = 'open'
      AND c.last_direction = 'inbound' AND c.last_message_at > f.created_at
    RETURNING f.id`

  const due = await ctx.sql<
    { id: string; ownerId: string | null; reason: string | null; subject: string | null; conversationId: string | null }[]
  >`
    SELECT f.id, f.owner_id AS "ownerId", f.reason, c.subject, f.conversation_id AS "conversationId"
    FROM follow_ups f
    LEFT JOIN conversations c ON c.id = f.conversation_id
    WHERE f.organization_id = ${ctx.organizationId} AND f.deleted_at IS NULL
      AND f.status = 'open' AND f.due_at <= ${now} AND f.owner_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM notifications n
        WHERE n.organization_id = f.organization_id AND n.entity_type = 'follow_up'
          AND n.entity_id = f.id AND n.deleted_at IS NULL
      )
    ORDER BY f.due_at
    LIMIT ${options.limit ?? 200}`

  let surfaced = 0
  for (const row of due) {
    if (!row.ownerId) continue
    await notify(ctx, {
      userId: row.ownerId,
      type: 'follow_up',
      title: 'A follow-up is due',
      body: `${row.subject ? `“${row.subject}” — ` : ''}${row.reason ?? 'No reason was recorded.'}`,
      entityType: 'follow_up',
      entityId: row.id,
      url: row.conversationId ? `/inbox/${row.conversationId}` : '/inbox',
    })
    surfaced += 1
  }

  return { closedByReply: answered.length, surfaced }
}
