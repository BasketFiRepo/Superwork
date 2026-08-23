import type { Priority, Sensitivity, TaskStatus, TenantContext } from '@superwork/db'
import { can, grantedScope, readCeiling, sharedObjectIds, type Actor } from '@superwork/auth'
import { ConflictError, NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeActivity, writeAudit } from '../audit.js'
import { link } from '../links.js'
import { startOfDay } from '../time.js'
import { notifyUnblocked, unfinishedPrerequisites } from './task-dependencies.js'
import { isMaterialChange, notifyWatchers, watchedTaskIds } from './task-watchers.js'
import { rollForwardRecurrence } from './task-recurrence.js'

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
  /**
   * Who wrote it down. Read only by the completion check (ADR 0080), because the policy's `own`
   * scope means owner *or* assignee *or* creator, and a member who raised a task they are not
   * assigned is inside that word.
   *
   * Deliberately not added to the `task:update` check beside it. That check has never resolved
   * `own` through the creator, and starting now would widen who may edit a task rather than
   * narrow it — the direction that asks for a reason nobody has given.
   */
  createdBy: string | null
  aiConfidence: number | null
  /** Set while this occurrence is the open one in a repeating series (ADR 0041). */
  recurrenceRule: string | null
  /** The milestone of its project this work is filed against (ADR 0048). */
  milestoneId: string | null
  milestoneName: string | null
  milestoneDueOn: string | null
  milestoneStatus: string | null
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
         t.created_by AS "createdBy",
         t.ai_confidence AS "aiConfidence", t.recurrence_rule AS "recurrenceRule",
         t.milestone_id AS "milestoneId", ms.name AS "milestoneName",
         ms.due_on::text AS "milestoneDueOn", ms.status AS "milestoneStatus",
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
  LEFT JOIN milestones ms ON ms.id = t.milestone_id AND ms.deleted_at IS NULL
  LEFT JOIN companies c ON c.id = p.company_id`

export interface ListTasksFilter {
  status?: TaskStatus[]
  assigneeId?: string | 'me' | 'unassigned'
  projectId?: string
  companyId?: string
  overdueOnly?: boolean
  dueBefore?: Date
  search?: string
  /**
   * Narrows to the tasks this person follows. A narrowing only: the visibility clause below
   * still applies, so a watch on something you may no longer read shows nothing rather than
   * becoming a way in.
   */
  watching?: boolean
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
  // Being on a project reaches its work for the same reason a project share does: "you are
  // on this project" and "you can see none of its tasks" cannot both be true (ADR 0032).
  const rosterProjects = actor.projectIds ?? []

  // A role with no grant of this kind at all can still have been *given* a row, and a gate
  // that throws before any row is considered denies the one thing a tuple exists to allow.
  // Refuse only when there is genuinely nothing to ask about.
  if (scope === null && shared.length === 0 && sharedProjects.length === 0 && rosterProjects.length === 0) {
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
            ${
              rosterProjects.length
                ? sql`OR (t.project_id = ANY(${rosterProjects}::uuid[])
                          AND p.sensitivity <= ${readCeiling(actor)}::sw_sensitivity)`
                : sql``
            }
          )`
  const assignee =
    filter.assigneeId === 'me' ? actor.userId : filter.assigneeId === 'unassigned' ? null : filter.assigneeId

  const watched = filter.watching ? await watchedTaskIds(ctx, actor) : null

  const rows = await sql<TaskView[]>`
    ${SELECT_TASK(ctx)}
    WHERE t.organization_id = ${ctx.organizationId}
      AND t.deleted_at IS NULL
      ${watched ? sql`AND t.id = ANY(${watched}::uuid[])` : sql``}
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
  /**
   * No `teamId`. It used to ride along in this bulk write with no reason recorded and no check
   * that the team was even in this organization — `setTeamScope` owns it now, because scoping
   * work to a team is a change to who can reach it rather than an attribute of the work
   * (ADR 0064).
   *
   * The milestone of this task's own project, or null to take it off one (ADR 0048).
   * Through `updateTask` rather than a control of its own, so filing work against a date goes
   * past the same version check, the same watchers and the same audit as every other change.
   */
  milestoneId?: string | null
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

  /**
   * Closing somebody's work is not the same act as editing it (ADR 0080).
   *
   * `task:complete:own` has been in the member's grant list since the ladder was built and was
   * never checked once: completion arrived as `status = 'completed'` through an ordinary update,
   * so `task:update:team` answered for it. A member could mark a teammate's task done — stopping
   * its nudges, closing the commitment behind it and changing what the briefing says about
   * somebody else's week — while the ladder said they could only complete their own.
   *
   * Checked on the transition, not on the state: re-saving an already-completed task is an edit.
   * A manager still passes on `task:*:department`, so this narrows exactly one rung, which is
   * the rung the ladder always described.
   */
  if (status === 'completed' && before.status !== 'completed') {
    const closing = can(actor, 'task:complete', {
      type: 'task',
      id: before.id,
      organizationId: ctx.organizationId,
      assigneeId: before.assigneeId,
      createdBy: before.createdBy,
      departmentId: before.departmentId,
      teamIds: before.teamId ? [before.teamId] : [],
      riskTier: 'low',
    })
    if (!closing.allow) throw new PermissionError(closing.reason)

    // A dependency that can be walked past is a comment. This is where it stops being one.
    const waiting = await unfinishedPrerequisites(ctx, input.id)
    if (waiting.length > 0) {
      throw new ValidationError(
        `“${before.title}” is waiting on ${waiting.length === 1 ? '' : `${waiting.length} things, starting with `}` +
          `“${waiting[0]!.title}”${waiting[0]!.assigneeName ? ` (${waiting[0]!.assigneeName})` : ''}. ` +
          'Finish that first, or remove the dependency if it no longer holds.',
      )
    }
  }

  // Filing work against a date the project is judged by. The database refuses a milestone
  // belonging to another project whatever writes the row; this is where somebody is told why,
  // and told what they can do instead.
  const milestoneId = input.milestoneId !== undefined ? input.milestoneId : before.milestoneId
  if (milestoneId && milestoneId !== before.milestoneId) {
    if (!before.projectId) {
      throw new ValidationError(
        'A milestone belongs to a project, and this task is not on one. Put it on the project first.',
      )
    }
    const [milestone] = await ctx.sql<{ name: string; status: string; projectId: string }[]>`
      SELECT name, status, project_id AS "projectId" FROM milestones
      WHERE organization_id = ${ctx.organizationId} AND id = ${milestoneId} AND deleted_at IS NULL`
    if (!milestone || milestone.projectId !== before.projectId) {
      throw new ValidationError(
        'That milestone belongs to another project. A milestone is a promise one project makes, ' +
          'so only its own work can be filed against it.',
      )
    }
    if (milestone.status !== 'open') {
      throw new ValidationError(
        `“${milestone.name}” is ${milestone.status === 'done' ? 'already reached' : 'cancelled'}. ` +
          'Reopen it or choose another — filing new work against a milestone that is finished ' +
          'changes what it said when it was finished.',
      )
    }
  }

  const sql = ctx.sql
  await sql`
    UPDATE tasks SET
      milestone_id = ${milestoneId},
      title = ${input.title ?? before.title},
      description = ${input.description !== undefined ? input.description : before.description},
      status = ${status},
      priority = ${input.priority ?? before.priority},
      assignee_id = ${input.assigneeId !== undefined ? input.assigneeId : before.assigneeId},
      due_at = ${input.dueAt !== undefined ? input.dueAt : before.dueAt},
      waiting_on = ${waitingOn},
      blocked_reason = ${blockedReason},
      completed_at = ${status === 'completed' ? new Date() : null},
      cancelled_at = ${status === 'cancelled' ? new Date() : null}
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.id} AND deleted_at IS NULL`

  const after = await getTask(ctx, actor, input.id)

  // The other half of the briefing's "you are blocking three people": tell them when you
  // stop. Only those whose last prerequisite this was — see `notifyUnblocked`.
  if (status === 'completed' && before.status !== 'completed') {
    await notifyUnblocked(ctx, actor, after.id, after.title)
  }

  // Work that comes back: finishing an occurrence is what creates the next one. Cancelling
  // counts as finishing it — "nothing to file this week" is not "stop filing" (ADR 0041).
  if (['completed', 'cancelled'].includes(status) && !['completed', 'cancelled'].includes(before.status)) {
    await rollForwardRecurrence(ctx, actor, after.id)
  }

  // Followers hear about the four changes worth interrupting somebody for, and only after
  // `can()` confirms each of them could still open the task — see `notifyWatchers`.
  if (isMaterialChange(before, after)) {
    await notifyWatchers(ctx, actor, {
      taskId: after.id,
      title: after.title,
      summary: describeChange(before, after),
    })
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
  if (before.milestoneId !== after.milestoneId) {
    parts.push(after.milestoneName ? `filed against “${after.milestoneName}”` : 'taken off its milestone')
  }
  return parts.length ? `Updated "${after.title}": ${parts.join(', ')}` : `Updated "${after.title}"`
}
