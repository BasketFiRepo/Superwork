import type { TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeActivity, writeAudit } from '../audit.js'

/**
 * Task dependencies (§12.1).
 *
 * `task_dependencies` was created in migration 0002 and nothing has ever written to it. The
 * daily briefing reads it: the "your work is blocking other people" section runs an EXISTS
 * against this table every time a briefing is generated, so that section has been
 * structurally empty since Phase 2 — for every user, every day, without ever failing.
 *
 * A dependency is only worth recording if it changes what happens, so it does two things
 * rather than sitting in a sidebar:
 *
 *   Completing a task whose prerequisites are unfinished is refused, naming them. A
 *   dependency that can be walked past is a comment.
 *
 *   Completing a prerequisite tells the people it was holding up. That is the other half of
 *   the briefing's "you are blocking three people" — otherwise the only person who ever
 *   learns the blockage cleared is the one who cleared it.
 */

export interface DependencyEdge {
  id: string
  taskId: string
  taskTitle: string
  taskStatus: string
  assigneeName: string | null
  reason: string | null
  createdAt: Date
}

export interface TaskDependencies {
  taskId: string
  /** Prerequisites: this task waits for these. */
  blockedBy: DependencyEdge[]
  /** Dependents: these wait for this task. */
  blocking: DependencyEdge[]
  /** True while any prerequisite is unfinished. */
  isBlocked: boolean
}

const DONE = ['completed', 'cancelled']

function guardRead(ctx: TenantContext, actor: Actor, taskId: string): void {
  const decision = can(actor, 'task:read', {
    type: 'task',
    id: taskId,
    organizationId: ctx.organizationId,
    riskTier: 'read',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
}

async function loadTask(
  ctx: TenantContext,
  taskId: string,
): Promise<{ id: string; title: string; status: string; assignee_id: string | null; department_id: string | null }> {
  const [task] = await ctx.sql<
    { id: string; title: string; status: string; assignee_id: string | null; department_id: string | null }[]
  >`
    SELECT id, title, status::text, assignee_id, department_id FROM tasks
    WHERE organization_id = ${ctx.organizationId} AND id = ${taskId} AND deleted_at IS NULL`
  if (!task) throw new NotFoundError()
  return task
}

export async function taskDependencies(
  ctx: TenantContext,
  actor: Actor,
  taskId: string,
): Promise<TaskDependencies> {
  guardRead(ctx, actor, taskId)
  const sql = ctx.sql

  const edges = await sql<(DependencyEdge & { direction: 'blocked_by' | 'blocking' })[]>`
    SELECT d.id, t.id AS "taskId", t.title AS "taskTitle", t.status::text AS "taskStatus",
           u.name AS "assigneeName", d.reason, d.created_at AS "createdAt",
           'blocked_by' AS direction
    FROM task_dependencies d
    JOIN tasks t ON t.id = d.depends_on_task_id AND t.deleted_at IS NULL
    LEFT JOIN users u ON u.id = t.assignee_id
    WHERE d.organization_id = ${ctx.organizationId} AND d.task_id = ${taskId} AND d.deleted_at IS NULL

    UNION ALL

    SELECT d.id, t.id AS "taskId", t.title AS "taskTitle", t.status::text AS "taskStatus",
           u.name AS "assigneeName", d.reason, d.created_at AS "createdAt",
           'blocking' AS direction
    FROM task_dependencies d
    JOIN tasks t ON t.id = d.task_id AND t.deleted_at IS NULL
    LEFT JOIN users u ON u.id = t.assignee_id
    WHERE d.organization_id = ${ctx.organizationId} AND d.depends_on_task_id = ${taskId} AND d.deleted_at IS NULL

    ORDER BY "createdAt"`

  const blockedBy = edges.filter((edge) => edge.direction === 'blocked_by')
  return {
    taskId,
    blockedBy,
    blocking: edges.filter((edge) => edge.direction === 'blocking'),
    isBlocked: blockedBy.some((edge) => !DONE.includes(edge.taskStatus)),
  }
}

/**
 * Records that one task waits for another.
 *
 * Permission is checked on the *dependent* task, because that is the one whose completion
 * this constrains. Saying "my task waits for yours" is a statement about my work; it does
 * not need your permission, and requiring it would mean nobody ever records a dependency
 * across a team boundary — which is where all the interesting ones are.
 */
export async function addDependency(
  ctx: TenantContext,
  actor: Actor,
  input: { taskId: string; dependsOnTaskId: string; reason?: string },
): Promise<TaskDependencies> {
  if (input.taskId === input.dependsOnTaskId) {
    throw new ValidationError('A task cannot wait for itself.')
  }

  const task = await loadTask(ctx, input.taskId)
  const prerequisite = await loadTask(ctx, input.dependsOnTaskId)

  const decision = can(actor, 'task:update', {
    type: 'task',
    id: task.id,
    organizationId: ctx.organizationId,
    assigneeId: task.assignee_id,
    departmentId: task.department_id,
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  try {
    await ctx.sql`
      INSERT INTO task_dependencies (organization_id, task_id, depends_on_task_id, reason, created_by)
      VALUES (${ctx.organizationId}, ${input.taskId}, ${input.dependsOnTaskId}, ${input.reason?.trim() || null}, ${ctx.userId})
      ON CONFLICT (task_id, depends_on_task_id) WHERE deleted_at IS NULL DO NOTHING`
  } catch (error) {
    // The trigger from 0021 is the authority on this, not a check up here that a bulk
    // import could route around. What this does is turn its message into one naming the
    // two tasks a person is actually looking at.
    const message = error instanceof Error ? error.message : String(error)
    if (/loop/i.test(message)) {
      throw new ValidationError(
        `“${prerequisite.title}” already waits for “${task.title}”, directly or through another task. ` +
          'Recording this as well would mean neither could ever be completed.',
      )
    }
    throw error
  }

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.agent?.agentId ?? actor.userId,
    principalUserId: actor.userId,
    action: 'task.dependency_added',
    entityType: 'task',
    entityId: input.taskId,
    after: { dependsOn: input.dependsOnTaskId, title: prerequisite.title, reason: input.reason?.trim() ?? null },
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorAgentId: actor.agent?.agentId ?? null,
    actorLabel: actor.agent?.agentName ?? actor.displayName,
    verb: 'linked',
    entityType: 'task',
    entityId: input.taskId,
    entityLabel: task.title,
    summary: `Waits for “${prerequisite.title}”.${input.reason ? ` ${input.reason.trim()}` : ''}`,
  })

  return taskDependencies(ctx, actor, input.taskId)
}

export async function removeDependency(
  ctx: TenantContext,
  actor: Actor,
  input: { taskId: string; dependencyId: string },
): Promise<TaskDependencies> {
  const task = await loadTask(ctx, input.taskId)
  const decision = can(actor, 'task:update', {
    type: 'task',
    id: task.id,
    organizationId: ctx.organizationId,
    assigneeId: task.assignee_id,
    departmentId: task.department_id,
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const [removed] = await ctx.sql<{ depends_on_task_id: string }[]>`
    UPDATE task_dependencies SET deleted_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.dependencyId}
      AND task_id = ${input.taskId} AND deleted_at IS NULL
    RETURNING depends_on_task_id`
  if (!removed) throw new NotFoundError()

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.agent?.agentId ?? actor.userId,
    principalUserId: actor.userId,
    action: 'task.dependency_removed',
    entityType: 'task',
    entityId: input.taskId,
    before: { dependsOn: removed.depends_on_task_id },
  })
  return taskDependencies(ctx, actor, input.taskId)
}

/**
 * The prerequisites standing between a task and being finished. Empty when it is free to
 * complete; `updateTask` calls this before allowing a completion.
 */
export async function unfinishedPrerequisites(
  ctx: TenantContext,
  taskId: string,
): Promise<{ id: string; title: string; status: string; assigneeName: string | null }[]> {
  return ctx.sql<{ id: string; title: string; status: string; assigneeName: string | null }[]>`
    SELECT t.id, t.title, t.status::text, u.name AS "assigneeName"
    FROM task_dependencies d
    JOIN tasks t ON t.id = d.depends_on_task_id AND t.deleted_at IS NULL
    LEFT JOIN users u ON u.id = t.assignee_id
    WHERE d.organization_id = ${ctx.organizationId} AND d.task_id = ${taskId} AND d.deleted_at IS NULL
      AND t.status NOT IN ('completed', 'cancelled')
    ORDER BY t.title`
}

/**
 * Tells the people a just-finished task was holding up.
 *
 * Only those whose *last* prerequisite this was: a task waiting on three things is not
 * unblocked by one of them finishing, and saying so would train people to ignore the
 * message. Nobody is told about their own completion.
 */
export async function notifyUnblocked(
  ctx: TenantContext,
  actor: Actor,
  completedTaskId: string,
  completedTitle: string,
): Promise<number> {
  const sql = ctx.sql
  const freed = await sql<{ id: string; title: string; assignee_id: string | null }[]>`
    SELECT t.id, t.title, t.assignee_id
    FROM task_dependencies d
    JOIN tasks t ON t.id = d.task_id AND t.deleted_at IS NULL
    WHERE d.organization_id = ${ctx.organizationId} AND d.depends_on_task_id = ${completedTaskId}
      AND d.deleted_at IS NULL
      AND t.status NOT IN ('completed', 'cancelled')
      AND NOT EXISTS (
        SELECT 1 FROM task_dependencies other
        JOIN tasks prereq ON prereq.id = other.depends_on_task_id AND prereq.deleted_at IS NULL
        WHERE other.organization_id = d.organization_id AND other.task_id = t.id
          AND other.deleted_at IS NULL
          AND prereq.status NOT IN ('completed', 'cancelled')
      )`

  let told = 0
  for (const task of freed) {
    if (!task.assignee_id || task.assignee_id === actor.userId) continue
    await sql`
      INSERT INTO notifications (
        organization_id, user_id, type, title, body, entity_type, entity_id, url, delivery, created_by
      ) VALUES (
        ${ctx.organizationId}, ${task.assignee_id}, 'task_unblocked', 'You can start this now',
        ${`“${completedTitle}” is done, so “${task.title}” is no longer waiting on anything.`},
        'task', ${task.id}, ${`/tasks/${task.id}`}, 'immediate', ${ctx.userId}
      )`
    told += 1
  }
  return told
}
