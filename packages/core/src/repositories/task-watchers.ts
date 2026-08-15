import type { TenantContext } from '@superwork/db'
import { can, loadActor, type Actor } from '@superwork/auth'
import { NotFoundError } from '../errors.js'
import { writeAudit } from '../audit.js'

/**
 * Task watchers (§12).
 *
 * `task_watchers` was created in migration 0002 and nothing has ever written to it or read
 * it. Until now the only person a task told anything to was its assignee — so the manager who
 * asked for it, the person who raised it and the colleague whose work depends on it all had
 * to go and look. A product where following somebody else's work means remembering to check
 * is a product where nobody follows anything.
 *
 * Two rules hold this to something safe:
 *
 *   **Watching grants nothing.** You may only watch what you can already read, and the watch
 *   never widens that. It is a subscription to changes, not a share.
 *
 *   **The fan-out re-checks at delivery.** Access is not frozen at the moment somebody
 *   pressed Follow: a task can move to a project you are taken off, its sensitivity can rise,
 *   your role can narrow. Every notification is written only after `can()` says that person
 *   could open the task *now*. A stale watch goes quiet rather than leaking.
 *
 * Nobody is ever told about their own change, and this is not a monitoring surface: a watch
 * says something about a task, and the only thing it reports is what that task did.
 */

export interface WatcherView {
  userId: string
  name: string
  /** True for the reader themselves, so the button can say "Following" rather than a name. */
  isYou: boolean
  since: Date
}

interface WatchableTask {
  id: string
  title: string
  assignee_id: string | null
  department_id: string | null
  team_id: string | null
}

async function loadTask(ctx: TenantContext, taskId: string): Promise<WatchableTask> {
  const [task] = await ctx.sql<WatchableTask[]>`
    SELECT id, title, assignee_id, department_id, team_id FROM tasks
    WHERE organization_id = ${ctx.organizationId} AND id = ${taskId} AND deleted_at IS NULL`
  if (!task) throw new NotFoundError()
  return task
}

/** The read that both watching and being notified require. Never a different check. */
function canRead(ctx: TenantContext, actor: Actor, task: WatchableTask): boolean {
  return can(actor, 'task:read', {
    type: 'task',
    id: task.id,
    organizationId: ctx.organizationId,
    assigneeId: task.assignee_id,
    departmentId: task.department_id,
    teamIds: task.team_id ? [task.team_id] : [],
    riskTier: 'read',
  }).allow
}

export async function taskWatchers(
  ctx: TenantContext,
  actor: Actor,
  taskId: string,
): Promise<WatcherView[]> {
  const task = await loadTask(ctx, taskId)
  // Cross-tenant and unreadable look the same from outside (§3.2).
  if (!canRead(ctx, actor, task)) throw new NotFoundError()

  const rows = await ctx.sql<{ userId: string; name: string; since: Date }[]>`
    SELECT w.user_id AS "userId", u.name, w.created_at AS since
    FROM task_watchers w
    JOIN users u ON u.id = w.user_id
    WHERE w.organization_id = ${ctx.organizationId} AND w.task_id = ${taskId}
      AND w.deleted_at IS NULL
    ORDER BY w.created_at`

  return rows.map((row) => ({ ...row, isYou: row.userId === actor.userId }))
}

/**
 * Follows a task.
 *
 * Only your own watch: adding somebody else would be a way of telling a colleague what to pay
 * attention to without asking them, and — worse — of finding out what they are told. If you
 * want a colleague to see something, assign it, comment on it or share it.
 */
export async function watchTask(
  ctx: TenantContext,
  actor: Actor,
  taskId: string,
): Promise<WatcherView[]> {
  const task = await loadTask(ctx, taskId)
  if (!canRead(ctx, actor, task)) throw new NotFoundError()

  await ctx.sql`
    INSERT INTO task_watchers (organization_id, task_id, user_id, created_by)
    VALUES (${ctx.organizationId}, ${taskId}, ${actor.userId}, ${ctx.userId})
    ON CONFLICT (task_id, user_id) WHERE deleted_at IS NULL DO NOTHING`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'task.watched',
    entityType: 'task',
    entityId: taskId,
    after: { title: task.title },
  })

  return taskWatchers(ctx, actor, taskId)
}

export async function unwatchTask(
  ctx: TenantContext,
  actor: Actor,
  taskId: string,
): Promise<WatcherView[]> {
  const task = await loadTask(ctx, taskId)

  // Unfollowing is allowed even when the task has since become unreadable — otherwise the
  // one thing a person can do about a notification they should not be getting is the one
  // thing the product refuses.
  await ctx.sql`
    UPDATE task_watchers SET deleted_at = now()
    WHERE organization_id = ${ctx.organizationId} AND task_id = ${taskId}
      AND user_id = ${actor.userId} AND deleted_at IS NULL`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'task.unwatched',
    entityType: 'task',
    entityId: taskId,
    before: { title: task.title },
  })

  if (!canRead(ctx, actor, task)) return []
  return taskWatchers(ctx, actor, taskId)
}

/** The tasks this person follows, for the `watching` filter on the list. */
export async function watchedTaskIds(ctx: TenantContext, actor: Actor): Promise<string[]> {
  const rows = await ctx.sql<{ taskId: string }[]>`
    SELECT task_id AS "taskId" FROM task_watchers
    WHERE organization_id = ${ctx.organizationId} AND user_id = ${actor.userId}
      AND deleted_at IS NULL`
  return rows.map((row) => row.taskId)
}

export interface WatchedChange {
  taskId: string
  title: string
  /** One sentence: what changed, in the words the activity feed would use. */
  summary: string
}

/**
 * Tells the followers of a task that it changed.
 *
 * Returns how many were told, which is what the tests assert on — a fan-out that silently
 * reaches nobody and one that reaches everybody look identical from the caller otherwise.
 */
export async function notifyWatchers(
  ctx: TenantContext,
  actor: Actor,
  change: WatchedChange,
): Promise<number> {
  const task = await loadTask(ctx, change.taskId)

  const watchers = await ctx.sql<{ userId: string }[]>`
    SELECT user_id AS "userId" FROM task_watchers
    WHERE organization_id = ${ctx.organizationId} AND task_id = ${change.taskId}
      AND deleted_at IS NULL AND user_id <> ${actor.userId}`

  let told = 0
  for (const { userId } of watchers) {
    // The re-check. A watch is not a stored permission, and the moment that matters is now.
    let watcher: Actor
    try {
      watcher = await loadActor(ctx, userId)
    } catch {
      continue // Left the organization, or their membership was suspended.
    }
    if (!canRead(ctx, watcher, task)) continue

    await ctx.sql`
      INSERT INTO notifications (
        organization_id, user_id, type, title, body, entity_type, entity_id, url, delivery, created_by
      ) VALUES (
        ${ctx.organizationId}, ${userId}, 'task_changed',
        ${`“${change.title}” changed`}, ${change.summary},
        'task', ${change.taskId}, ${`/tasks/${change.taskId}`}, 'immediate', ${ctx.userId}
      )`
    told += 1
  }
  return told
}

/**
 * Whether a change is worth a message.
 *
 * Everything a task can have edited is not equally interesting, and a follow that fires on
 * every keystroke-sized edit is one people turn off. Status, who is doing it, when it is due
 * and what it is called are the four a follower would want to be interrupted for; a
 * description tidy-up is not.
 */
export function isMaterialChange(
  before: { status: string; assigneeId: string | null; dueAt: Date | null; title: string },
  after: { status: string; assigneeId: string | null; dueAt: Date | null; title: string },
): boolean {
  if (before.status !== after.status) return true
  if (before.assigneeId !== after.assigneeId) return true
  if (before.title !== after.title) return true
  const beforeDue = before.dueAt ? new Date(before.dueAt).getTime() : null
  const afterDue = after.dueAt ? new Date(after.dueAt).getTime() : null
  return beforeDue !== afterDue
}
