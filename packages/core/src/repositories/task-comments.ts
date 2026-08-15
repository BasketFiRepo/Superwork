import type { TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeAudit } from '../audit.js'
import { getTask } from './tasks.js'

/**
 * What people say about a task (§12.1).
 *
 * `task_comments` has been written by exactly one thing since Phase 0: the agent's
 * `comment_on_task@v1` tool, whose own description says the comment is *"attributed to the
 * agent by name. Never post as if a person wrote it."* Nothing read the table. So the agent
 * has been leaving notes on people's tasks that no screen shows, and no person could add one
 * at all — the only writer was a tool.
 *
 * The `mentions` array has been on the row since the first migration and was never
 * populated, so naming somebody in a comment did nothing. It does something now, which is
 * why the database checks that everybody named is a member of this organization.
 *
 * **Commenting needs only a read of the task.** Discussing work you can see is not changing
 * it, and requiring `task:update` would mean the person who most often needs to say
 * something — whoever is waiting on it — could not.
 */

export interface CommentView {
  id: string
  body: string
  actorType: 'user' | 'agent' | 'system' | 'integration'
  authorName: string | null
  /** Named on the row, so a comment the assistant wrote can never read as a colleague's. */
  byAgent: boolean
  mentions: { userId: string; name: string }[]
  canDelete: boolean
  createdAt: Date
}

export async function taskComments(
  ctx: TenantContext,
  actor: Actor,
  taskId: string,
): Promise<CommentView[]> {
  const task = await getTask(ctx, actor, taskId)

  const rows = await ctx.sql<
    {
      id: string
      body: string
      actorType: CommentView['actorType']
      authorName: string | null
      createdBy: string | null
      mentions: string[]
      mentionNames: { userId: string; name: string }[] | null
      createdAt: Date
    }[]
  >`
    SELECT c.id, c.body, c.actor_type AS "actorType",
           u.name AS "authorName", c.created_by AS "createdBy", c.mentions,
           (SELECT coalesce(json_agg(json_build_object('userId', m.id, 'name', m.name)), '[]'::json)
              FROM users m WHERE m.id = ANY(c.mentions)) AS "mentionNames",
           c.created_at AS "createdAt"
    FROM task_comments c
    LEFT JOIN users u ON u.id = c.created_by
    WHERE c.organization_id = ${ctx.organizationId} AND c.task_id = ${taskId} AND c.deleted_at IS NULL
    ORDER BY c.created_at`

  const mayModerate = can(actor, 'task:update', {
    type: 'task',
    id: task.id,
    organizationId: ctx.organizationId,
    assigneeId: task.assigneeId,
    departmentId: task.departmentId,
    teamIds: task.teamId ? [task.teamId] : [],
    riskTier: 'low',
  }).allow

  return rows.map((row) => ({
    id: row.id,
    body: row.body,
    actorType: row.actorType,
    authorName: row.authorName,
    byAgent: row.actorType === 'agent',
    mentions: row.mentionNames ?? [],
    // Your own words are yours to take back; anything else needs a say over the task.
    canDelete: mayModerate || (row.actorType === 'user' && row.createdBy === actor.userId),
    createdAt: row.createdAt,
  }))
}

export interface AddCommentInput {
  taskId: string
  body: string
  mentions?: string[]
}

/**
 * Adds a person's comment, and tells anybody they named.
 *
 * A mention writes a notification, which is what makes naming somebody different from
 * typing their name. It lands on their reminders screen (ADR 0033) rather than emailing
 * them: nothing leaves the company because somebody was mentioned in a comment.
 */
export async function addTaskComment(
  ctx: TenantContext,
  actor: Actor,
  input: AddCommentInput,
): Promise<CommentView[]> {
  const task = await getTask(ctx, actor, input.taskId)

  const body = input.body.trim()
  if (body.length === 0) throw new ValidationError('A comment needs something in it.')
  if (body.length > 4000) throw new ValidationError('That is longer than a comment should be.')

  const mentions = [...new Set(input.mentions ?? [])]
  if (mentions.length > 0) {
    const known = await ctx.sql<{ userId: string }[]>`
      SELECT m.user_id AS "userId" FROM memberships m
      WHERE m.organization_id = ${ctx.organizationId} AND m.user_id = ANY(${mentions}::uuid[])
        AND m.deleted_at IS NULL AND m.status = 'active'`
    if (known.length !== mentions.length) {
      throw new ValidationError('You can only mention people in this organization.')
    }
  }

  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO task_comments (organization_id, task_id, body, actor_type, mentions, created_by)
    VALUES (${ctx.organizationId}, ${input.taskId}, ${body}, 'user', ${mentions}::uuid[], ${actor.userId})
    RETURNING id`

  for (const userId of mentions) {
    if (userId === actor.userId) continue
    await ctx.sql`
      INSERT INTO notifications (
        organization_id, user_id, type, title, body, channel, delivery, entity_type, entity_id, url, created_by
      ) VALUES (
        ${ctx.organizationId}, ${userId}, 'mention', ${`${actor.displayName} mentioned you`},
        ${`On “${task.title}”: ${body.slice(0, 200)}`}, 'in_app', 'immediate',
        'task', ${input.taskId}, ${`/tasks/${input.taskId}`}, ${ctx.userId}
      )`
  }

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'task.commented',
    entityType: 'task',
    entityId: input.taskId,
    after: { commentId: row!.id, mentions: mentions.length },
  })

  return taskComments(ctx, actor, input.taskId)
}

/** Takes a comment back. Your own always; anybody else's needs a say over the task. */
export async function deleteTaskComment(
  ctx: TenantContext,
  actor: Actor,
  input: { taskId: string; commentId: string },
): Promise<CommentView[]> {
  const task = await getTask(ctx, actor, input.taskId)

  const [comment] = await ctx.sql<{ createdBy: string | null; actorType: string }[]>`
    SELECT created_by AS "createdBy", actor_type AS "actorType" FROM task_comments
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.commentId}
      AND task_id = ${input.taskId} AND deleted_at IS NULL`
  if (!comment) throw new NotFoundError()

  const mine = comment.actorType === 'user' && comment.createdBy === actor.userId
  if (!mine) {
    const decision = can(actor, 'task:update', {
      type: 'task',
      id: task.id,
      organizationId: ctx.organizationId,
      assigneeId: task.assigneeId,
      departmentId: task.departmentId,
      teamIds: task.teamId ? [task.teamId] : [],
      riskTier: 'low',
    })
    if (!decision.allow) {
      throw new PermissionError(
        `${decision.reason} You can always remove a comment you wrote yourself; this one is somebody else’s.`,
      )
    }
  }

  await ctx.sql`
    UPDATE task_comments SET deleted_at = now(), updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.commentId}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'task.comment_removed',
    entityType: 'task',
    entityId: input.taskId,
    before: { commentId: input.commentId, author: comment.createdBy, wasAgent: comment.actorType === 'agent' },
  })

  return taskComments(ctx, actor, input.taskId)
}
