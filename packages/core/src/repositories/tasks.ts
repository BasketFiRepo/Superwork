import type { Priority, Sensitivity, TaskStatus, TenantContext } from '@superwork/db'
import { can, grantedScope, readCeiling, sharedObjectIds, type Actor } from '@superwork/auth'
import { ConflictError, NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeActivity, writeAudit } from '../audit.js'
import { link } from '../links.js'
import { startOfDay } from '../time.js'
import { notifyUnblocked, unfinishedPrerequisites } from './task-dependencies.js'

export interface TaskView {
  id: string
  title: string
  description: string | null
  status: TaskStatus
  priority: Priority
  assigneeId: string | null
  assigneeName: string | null
  projectId: string | null
  projectName: string | null
  /** The project's classification, so a share of it cannot reach past that classification. */
  projectSensitivity: Sensitivity | null
  companyId: string | null
  companyName: string | null
  departmentId: string | null
  teamId: string | null
  dueAt: Date | null
  waitingOn: string | null
  blockedReason: string | null
  createdByActorType: string
  createdByAgentRunId: string | null
  aiConfidence: number | null
  /** Unfinished prerequisites. Non-zero means this cannot be completed yet. */
  blockedByCount: number
  /** Tasks waiting on this one. Non-zero means finishing it frees somebody. */
  blockingCount: number
  version: number
  createdAt: Date
  updatedAt: Date
}

const SELECT_TASK = (ctx: TenantContext) => ctx.sql`
  SELECT t.id, t.title, t.description, t.status, t.priority,
         t.assignee_id AS "assigneeId", u.name AS "assigneeName",
         t.project_id AS "projectId", p.name AS "projectName", p.sensitivity AS "projectSensitivity",
         p.company_id AS "companyId", c.name AS "companyName",
         t.department_id AS "departmentId", t.team_id AS "teamId",
         t.due_at AS "dueAt", t.waiting_on AS "waitingOn", t.blocked_reason AS "blockedReason",
         t.created_by_actor_type AS "createdByActorType",
         t.created_by_agent_run_id AS "createdByAgentRunId",
         t.ai_confidence AS "aiConfidence",
         -- Both served by the two indexes on task_dependencies; the blocking side needed
         -- the one added in 0021, without which this was a sequential scan per row.
         (SELECT count(*)::int FROM task_dependencies d
           JOIN tasks pre ON pre.id = d.depends_on_task_id AND pre.deleted_at IS NULL
           WHERE d.organization_id = t.organization_id AND d.task_id = t.id AND d.deleted_at IS NULL
             AND pre.status NOT IN ('completed', 'cancelled')) AS "blockedByCount",
         (SELECT count(*)::int FROM task_dependencies d
           WHERE d.organization_id = t.organization_id AND d.depends_on_task_id = t.id
             AND d.deleted_at IS NULL) AS "blockingCount",
         t.version, t.created_at AS "createdAt", t.updated_at AS "updatedAt"
  FROM tasks t
  LEFT JOIN users u ON u.id = t.assignee_id
  LEFT JOIN projects p ON p.id = t.project_id
  LEFT JOIN companies c ON c.id = p.company_id`

export interface ListTasksFilter {
  status?: TaskStatus[]
  assigneeId?: string | 'me' | 'unassigned'
  projectId?: string
  companyId?: string
  overdueOnly?: boolean
  dueBefore?: Date
  search?: string
  limit?: number
  /** Keyset pagination (§26.2): never OFFSET. */
  cursor?: { updatedAt: Date; id: string }
}

export async function listTasks(
  ctx: TenantContext,
  actor: Actor,
  filter: ListTasksFilter = {},
): Promise<{ tasks: TaskView[]; nextCursor: { updatedAt: Date; id: string } | null }> {
  // Not an organization-level gate: that asks "may you read every task", which is false
  // for any role whose grant is narrower and is why the guest role could list nothing at
  // all. Ask instead which rows this actor may consider, and push that into the query.
  const scope = grantedScope(actor, 'task:read', 'task')
  const limit = Math.min(filter.limit ?? 50, 200)
  const sql = ctx.sql
  const shared = sharedObjectIds(actor, 'task')
  // A project shared with somebody reaches the work inside it, or "I shared the project
  // with you" and "you can see none of its tasks" are both true (ADR 0024). Read only —
  // `can()` refuses a container relation for any verb but read.
  const sharedProjects = sharedObjectIds(actor, 'project')

  // A role with no grant of this kind at all can still have been *given* a row, and a gate
  // that throws before any row is considered denies the one thing a tuple exists to allow.
  // Refuse only when there is genuinely nothing to ask about.
  if (scope === null && shared.length === 0 && sharedProjects.length === 0) {
    const decision = can(actor, 'task:read', { type: 'task', organizationId: ctx.organizationId })
    throw new PermissionError(decision.reason)
  }

  // A tuple grants one row regardless of scope, so it is unioned in rather than narrowing.
  const visible =
    scope === 'org'
      ? sql``
      : sql`AND (
            ${
              scope === null
                ? sql`false`
                : scope === 'department'
                ? sql`t.department_id = ANY(${actor.departmentIds}::uuid[])`
                : scope === 'team'
                  ? sql`t.team_id = ANY(${actor.teamIds}::uuid[])`
                  : sql`(t.assignee_id = ${actor.userId} OR t.created_by = ${actor.userId})`
            }
            ${shared.length ? sql`OR t.id = ANY(${shared}::uuid[])` : sql``}
            ${
              sharedProjects.length
                ? sql`OR (t.project_id = ANY(${sharedProjects}::uuid[])
                          AND p.sensitivity <= ${readCeiling(actor)}::sw_sensitivity)`
                : sql``
            }
          )`
  const assignee =
    filter.assigneeId === 'me' ? actor.userId : filter.assigneeId === 'unassigned' ? null : filter.assigneeId

  const rows = await sql<TaskView[]>`
    ${SELECT_TASK(ctx)}
    WHERE t.organization_id = ${ctx.organizationId}
      AND t.deleted_at IS NULL
      ${filter.status?.length ? sql`AND t.status = ANY(${filter.status}::sw_task_status[])` : sql``}
      ${filter.assigneeId === 'unassigned' ? sql`AND t.assignee_id IS NULL` : assignee ? sql`AND t.assignee_id = ${assignee}` : sql``}
      ${filter.projectId ? sql`AND t.project_id = ${filter.projectId}` : sql``}
      ${filter.companyId ? sql`AND p.company_id = ${filter.companyId}` : sql``}
      ${
        filter.overdueOnly
          ? sql`AND t.due_at < ${startOfDay(new Date(), ctx.timezone)} AND t.status NOT IN ('completed', 'cancelled')`
          : sql``
      }
      ${filter.dueBefore ? sql`AND t.due_at < ${filter.dueBefore}` : sql``}
      ${filter.search ? sql`AND t.title ILIKE ${'%' + filter.search + '%'}` : sql``}
      ${filter.cursor ? sql`AND (t.updated_at, t.id) < (${filter.cursor.updatedAt}, ${filter.cursor.id})` : sql``}
      ${visible}
    ORDER BY t.updated_at DESC, t.id DESC
    LIMIT ${limit + 1}`

  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return {
    tasks: page,
    nextCursor: rows.length > limit && last ? { updatedAt: last.updatedAt, id: last.id } : null,
  }
}

export async function getTask(ctx: TenantContext, actor: Actor, id: string): Promise<TaskView> {
  const rows = await ctx.sql<TaskView[]>`
    ${SELECT_TASK(ctx)}
    WHERE t.organization_id = ${ctx.organizationId} AND t.id = ${id} AND t.deleted_at IS NULL`
  const task = rows[0]
  if (!task) throw new NotFoundError()

  const decision = can(actor, 'task:read', {
    type: 'task',
    id: task.id,
    organizationId: ctx.organizationId,
    assigneeId: task.assigneeId,
    departmentId: task.departmentId,
    teamIds: task.teamId ? [task.teamId] : [],
    // So the list and the page agree: a project share puts the task in the list, and this
    // is what lets the same person open it.
    containers: task.projectId
      ? [{ type: 'project', id: task.projectId, sensitivity: task.projectSensitivity ?? undefined }]
      : [],
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
  return task
}

export interface CreateTaskInput {
  title: string
  description?: string | null
  status?: TaskStatus
  priority?: Priority
  assigneeId?: string | null
  projectId?: string | null
  departmentId?: string | null
  dueAt?: Date | null
  waitingOn?: string | null
  blockedReason?: string | null
  /** Provenance for agent-created work (§3.4). */
  derivedFrom?: { type: string; id: string }
  agentRunId?: string | null
  aiConfidence?: number | null
  actorLabel?: string
}

export async function createTask(ctx: TenantContext, actor: Actor, input: CreateTaskInput): Promise<TaskView> {
  const decision = can(
    actor,
    'task:create',
    {
      type: 'task',
      organizationId: ctx.organizationId,
      departmentId: input.departmentId ?? null,
      assigneeId: input.assigneeId ?? null,
      riskTier: 'low',
    },
  )
  if (!decision.allow) throw new PermissionError(decision.reason)

  if (!input.title?.trim()) throw new ValidationError('A task needs a title.')
  if (input.status === 'waiting' && !input.waitingOn) {
    throw new ValidationError('A waiting task must name who or what it is waiting on.')
  }
  if (input.status === 'blocked' && !input.blockedReason) {
    throw new ValidationError('A blocked task must state why it is blocked.')
  }

  const rows = await ctx.sql<{ id: string }[]>`
    INSERT INTO tasks (
      organization_id, title, description, status, priority, assignee_id, project_id,
      department_id, due_at, waiting_on, blocked_reason,
      created_by_actor_type, created_by_agent_run_id, ai_confidence, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.title.trim()}, ${input.description ?? null},
      ${input.status ?? 'todo'}, ${input.priority ?? 'medium'}, ${input.assigneeId ?? null},
      ${input.projectId ?? null}, ${input.departmentId ?? null}, ${input.dueAt ?? null},
      ${input.waitingOn ?? null}, ${input.blockedReason ?? null},
      ${actor.type}, ${input.agentRunId ?? null}, ${input.aiConfidence ?? null}, ${ctx.userId}
    ) RETURNING id`

  const id = rows[0]!.id

  if (input.derivedFrom) {
    await link(ctx, { type: 'task', id }, input.derivedFrom, 'derived_from')
  }

  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorAgentId: actor.agent?.agentId ?? null,
    actorLabel: actor.agent?.agentName ?? actor.displayName,
    verb: 'created',
    entityType: 'task',
    entityId: id,
    entityLabel: input.title.trim(),
    summary: `Created task "${input.title.trim()}"`,
    agentRunId: input.agentRunId ?? null,
  })
  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.agent?.agentId ?? actor.userId,
    principalUserId: actor.userId,
    action: 'task.create',
    entityType: 'task',
    entityId: id,
    after: { title: input.title, status: input.status ?? 'todo', assignee_id: input.assigneeId ?? null },
    agentRunId: input.agentRunId ?? null,
  })

  return getTask(ctx, actor, id)
}

export interface UpdateTaskInput {
  id: string
  /** Optimistic concurrency (§15.2). Omit only for agent-authored writes that just read the row. */
  expectedVersion?: number
  title?: string
  description?: string | null
  status?: TaskStatus
  priority?: Priority
  assigneeId?: string | null
  dueAt?: Date | null
  waitingOn?: string | null
  blockedReason?: string | null
  teamId?: string | null
  agentRunId?: string | null
}

export async function updateTask(ctx: TenantContext, actor: Actor, input: UpdateTaskInput): Promise<TaskView> {
  const before = await getTask(ctx, actor, input.id)

  const decision = can(actor, 'task:update', {
    type: 'task',
    id: before.id,
    organizationId: ctx.organizationId,
    assigneeId: before.assigneeId,
    departmentId: before.departmentId,
    teamIds: before.teamId ? [before.teamId] : [],
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  if (input.expectedVersion !== undefined && input.expectedVersion !== before.version) {
    throw new ConflictError('This task changed while you were editing.', {
      currentVersion: before.version,
      yourVersion: input.expectedVersion,
    })
  }

  const status = input.status ?? before.status
  const waitingOn = input.waitingOn !== undefined ? input.waitingOn : before.waitingOn
  const blockedReason = input.blockedReason !== undefined ? input.blockedReason : before.blockedReason
  if (status === 'waiting' && !waitingOn) throw new ValidationError('A waiting task must name who or what it is waiting on.')
  if (status === 'blocked' && !blockedReason) throw new ValidationError('A blocked task must state why it is blocked.')

  // A dependency that can be walked past is a comment. This is where it stops being one.
  if (status === 'completed' && before.status !== 'completed') {
    const waiting = await unfinishedPrerequisites(ctx, input.id)
    if (waiting.length > 0) {
      throw new ValidationError(
        `“${before.title}” is waiting on ${waiting.length === 1 ? '' : `${waiting.length} things, starting with `}` +
          `“${waiting[0]!.title}”${waiting[0]!.assigneeName ? ` (${waiting[0]!.assigneeName})` : ''}. ` +
          'Finish that first, or remove the dependency if it no longer holds.',
      )
    }
  }

  const sql = ctx.sql
  await sql`
    UPDATE tasks SET
      title = ${input.title ?? before.title},
      description = ${input.description !== undefined ? input.description : before.description},
      status = ${status},
      priority = ${input.priority ?? before.priority},
      assignee_id = ${input.assigneeId !== undefined ? input.assigneeId : before.assigneeId},
      due_at = ${input.dueAt !== undefined ? input.dueAt : before.dueAt},
      waiting_on = ${waitingOn},
      blocked_reason = ${blockedReason},
      team_id = ${input.teamId !== undefined ? input.teamId : before.teamId},
      completed_at = ${status === 'completed' ? new Date() : null},
      cancelled_at = ${status === 'cancelled' ? new Date() : null}
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.id} AND deleted_at IS NULL`

  const after = await getTask(ctx, actor, input.id)

  // The other half of the briefing's "you are blocking three people": tell them when you
  // stop. Only those whose last prerequisite this was — see `notifyUnblocked`.
  if (status === 'completed' && before.status !== 'completed') {
    await notifyUnblocked(ctx, actor, after.id, after.title)
  }

  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorAgentId: actor.agent?.agentId ?? null,
    actorLabel: actor.agent?.agentName ?? actor.displayName,
    verb: 'updated',
    entityType: 'task',
    entityId: after.id,
    entityLabel: after.title,
    summary: describeChange(before, after),
    agentRunId: input.agentRunId ?? null,
  })
  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.agent?.agentId ?? actor.userId,
    principalUserId: actor.userId,
    action: 'task.update',
    entityType: 'task',
    entityId: after.id,
    before: { title: before.title, status: before.status, assignee_id: before.assigneeId, due_at: before.dueAt },
    after: { title: after.title, status: after.status, assignee_id: after.assigneeId, due_at: after.dueAt },
    agentRunId: input.agentRunId ?? null,
  })

  return after
}

/** Soft delete. The inverse of `create_task` for undo purposes (§5.7). */
export async function deleteTask(
  ctx: TenantContext,
  actor: Actor,
  id: string,
  agentRunId?: string | null,
): Promise<void> {
  const before = await getTask(ctx, actor, id)
  const decision = can(actor, 'task:update', {
    type: 'task',
    id,
    organizationId: ctx.organizationId,
    assigneeId: before.assigneeId,
    departmentId: before.departmentId,
    teamIds: before.teamId ? [before.teamId] : [],
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  await ctx.sql`
    UPDATE tasks SET deleted_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${id} AND deleted_at IS NULL`

  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.agent?.agentName ?? actor.displayName,
    verb: 'deleted',
    entityType: 'task',
    entityId: id,
    entityLabel: before.title,
    summary: `Removed task "${before.title}"`,
    agentRunId: agentRunId ?? null,
  })
  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.agent?.agentId ?? actor.userId,
    principalUserId: actor.userId,
    action: 'task.delete',
    entityType: 'task',
    entityId: id,
    before: { deleted_at: null },
    after: { deleted_at: new Date().toISOString() },
    agentRunId: agentRunId ?? null,
  })
}

function describeChange(before: TaskView, after: TaskView): string {
  const parts: string[] = []
  if (before.status !== after.status) parts.push(`status ${before.status} → ${after.status}`)
  if (before.assigneeId !== after.assigneeId) parts.push(`assigned to ${after.assigneeName ?? 'nobody'}`)
  if (before.priority !== after.priority) parts.push(`priority ${before.priority} → ${after.priority}`)
  if (before.dueAt?.getTime() !== after.dueAt?.getTime()) parts.push('due date changed')
  if (before.title !== after.title) parts.push('renamed')
  return parts.length ? `Updated "${after.title}": ${parts.join(', ')}` : `Updated "${after.title}"`
}
