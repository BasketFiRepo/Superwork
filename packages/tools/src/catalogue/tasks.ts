import { z } from 'zod'
import { createTask, deleteTask, getTask, updateTask, type PreviewLine } from '@superwork/core'
import { register, type ToolContext } from '../registry.js'

/**
 * Reversible internal writes (`execute:low`). Each declares its inverse so an entire
 * run can be undone in reverse order (§5.7), and a preview so an approver sees the
 * exact diff before anything happens (§6.1).
 */

const dateish = z.union([z.string().datetime(), z.string().date(), z.null()]).optional()

function toDate(value: unknown): Date | null {
  if (!value || typeof value !== 'string') return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Previews are read by people, so dates render in the viewing user's timezone. */
function readableDate(value: Date | null, timeZone: string): string {
  if (!value) return 'no date'
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(value)
}

export const createTaskTool = register({
  name: 'create_task@v1',
  description: 'Create a task with an owner and a due date. Always link it back to the email, meeting or document it came from.',
  inputSchema: z.object({
    title: z.string().min(1).max(300),
    description: z.string().max(4000).nullish(),
    assigneeId: z.string().uuid().nullish(),
    projectId: z.string().uuid().nullish(),
    priority: z.enum(['urgent', 'high', 'medium', 'low']).default('medium'),
    dueAt: dateish,
    derivedFrom: z.object({ type: z.string(), id: z.string().uuid() }).nullish(),
  }),
  outputSchema: z.object({ id: z.string(), title: z.string(), assigneeName: z.string().nullable(), dueAt: z.string().nullable() }),
  riskTier: 'low' as const,
  requiredPermissions: ['task:create:org'],
  reversible: true,
  inverse: 'delete_task@v1',
  rateLimit: { perRun: 50, perOrgPerHour: 2000 },
  timeoutMs: 8000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    const task = await createTask(ctx.tenantDb, ctx.policy, {
      title: input.title,
      description: input.description ?? null,
      assigneeId: input.assigneeId ?? null,
      projectId: input.projectId ?? null,
      priority: input.priority ?? 'medium',
      dueAt: toDate(input.dueAt),
      ...(input.derivedFrom ? { derivedFrom: input.derivedFrom } : {}),
      agentRunId: ctx.agentRunId,
    })
    return {
      ok: true as const,
      value: {
        id: task.id,
        title: task.title,
        assigneeName: task.assigneeName,
        dueAt: task.dueAt ? task.dueAt.toISOString() : null,
      },
    }
  },
  async preview(input, ctx: ToolContext): Promise<PreviewLine[]> {
    let assignee = 'unassigned'
    if (input.assigneeId) {
      const [row] = await ctx.tenantDb.sql<{ name: string }[]>`SELECT name FROM users WHERE id = ${input.assigneeId}`
      assignee = row?.name ?? 'unknown user'
    }
    const due = toDate(input.dueAt)
    return [
      {
        operation: 'Create task',
        entityType: 'task',
        entityLabel: input.title,
        changes: [
          { field: 'Title', to: input.title, editable: { arg: 'title' } },
          // The assignee is not editable here: changing who owns a task is a change of
          // responsibility, and it goes through the task itself where the person is told.
          { field: 'Assignee', to: assignee },
          {
            field: 'Due',
            to: readableDate(due, ctx.tenantDb.timezone),
            editable: { arg: 'dueAt', help: 'A date, or words like "next Tuesday".' },
          },
          { field: 'Priority', to: input.priority, editable: { arg: 'priority', help: 'urgent, high, medium or low.' } },
        ],
        riskTier: 'low',
        reversible: true,
      },
    ]
  },
  buildUndo(_input, output) {
    return {
      tool: 'delete_task@v1',
      input: { id: output.id },
      entityType: 'task',
      entityId: output.id,
      description: `Remove the task "${output.title}"`,
    }
  },
})

export const deleteTaskTool = register({
  name: 'delete_task@v1',
  description: 'Soft-delete a task. This is the inverse of create_task and is used when undoing a run.',
  inputSchema: z.object({ id: z.string().uuid() }),
  outputSchema: z.object({ id: z.string(), deleted: z.boolean() }),
  riskTier: 'low' as const,
  requiredPermissions: ['task:update:org'],
  reversible: false,
  rateLimit: { perRun: 50, perOrgPerHour: 2000 },
  timeoutMs: 8000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    await deleteTask(ctx.tenantDb, ctx.policy, input.id, ctx.agentRunId)
    return { ok: true as const, value: { id: input.id, deleted: true } }
  },
})

export const updateTaskTool = register({
  name: 'update_task@v1',
  description: 'Update a task’s title, status, priority, assignee or due date. A blocked task must state why; a waiting task must name who it waits on.',
  inputSchema: z.object({
    id: z.string().uuid(),
    title: z.string().max(300).optional(),
    status: z.enum(['backlog', 'todo', 'in_progress', 'waiting', 'blocked', 'review', 'completed', 'cancelled']).optional(),
    priority: z.enum(['urgent', 'high', 'medium', 'low']).optional(),
    assigneeId: z.string().uuid().nullish(),
    dueAt: dateish,
    waitingOn: z.string().nullish(),
    blockedReason: z.string().nullish(),
  }),
  outputSchema: z.object({ id: z.string(), title: z.string(), status: z.string() }),
  riskTier: 'low' as const,
  requiredPermissions: ['task:update:org'],
  reversible: true,
  inverse: 'update_task@v1',
  rateLimit: { perRun: 50, perOrgPerHour: 2000 },
  timeoutMs: 8000,
  idempotent: false,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    const task = await updateTask(ctx.tenantDb, ctx.policy, {
      id: input.id,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId ?? null } : {}),
      ...(input.dueAt !== undefined ? { dueAt: toDate(input.dueAt) } : {}),
      ...(input.waitingOn !== undefined ? { waitingOn: input.waitingOn ?? null } : {}),
      ...(input.blockedReason !== undefined ? { blockedReason: input.blockedReason ?? null } : {}),
      agentRunId: ctx.agentRunId,
    })
    return { ok: true as const, value: { id: task.id, title: task.title, status: task.status } }
  },
  async preview(input, ctx: ToolContext): Promise<PreviewLine[]> {
    const before = await getTask(ctx.tenantDb, ctx.policy, input.id)
    const changes: PreviewLine['changes'] = []
    if (input.status && input.status !== before.status) changes.push({ field: 'Status', from: before.status, to: input.status })
    if (input.priority && input.priority !== before.priority) changes.push({ field: 'Priority', from: before.priority, to: input.priority })
    if (input.dueAt !== undefined) {
      changes.push({
        field: 'Due',
        from: readableDate(before.dueAt, ctx.tenantDb.timezone),
        to: readableDate(toDate(input.dueAt), ctx.tenantDb.timezone),
      })
    }
    if (input.assigneeId !== undefined) changes.push({ field: 'Assignee', from: before.assigneeName, to: input.assigneeId ?? 'unassigned' })
    if (input.title && input.title !== before.title) changes.push({ field: 'Title', from: before.title, to: input.title })
    return [
      {
        operation: 'Update task',
        entityType: 'task',
        entityLabel: before.title,
        changes: changes.length ? changes : [{ field: 'No effective change', to: 'none' }],
        riskTier: 'low',
        reversible: true,
      },
    ]
  },
})

export const assignTask = register({
  name: 'assign_task@v1',
  description: 'Assign a task to a person. Use search_entities first if the name is ambiguous.',
  inputSchema: z.object({ id: z.string().uuid(), assigneeId: z.string().uuid() }),
  outputSchema: z.object({ id: z.string(), assigneeName: z.string().nullable() }),
  riskTier: 'low' as const,
  requiredPermissions: ['task:update:org'],
  reversible: true,
  inverse: 'assign_task@v1',
  rateLimit: { perRun: 50, perOrgPerHour: 2000 },
  timeoutMs: 8000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    const task = await updateTask(ctx.tenantDb, ctx.policy, {
      id: input.id,
      assigneeId: input.assigneeId,
      agentRunId: ctx.agentRunId,
    })
    return { ok: true as const, value: { id: task.id, assigneeName: task.assigneeName } }
  },
  buildUndo(input, _output) {
    return {
      tool: 'update_task@v1',
      input: { id: input.id, assigneeId: null },
      entityType: 'task',
      entityId: input.id,
      description: 'Restore the previous assignee',
    }
  },
})

export const completeTask = register({
  name: 'complete_task@v1',
  description: 'Mark a task complete. Use cancel semantics instead when work is dropped rather than finished — reporting depends on the difference.',
  inputSchema: z.object({ id: z.string().uuid() }),
  outputSchema: z.object({ id: z.string(), status: z.string() }),
  riskTier: 'low' as const,
  requiredPermissions: ['task:update:org'],
  reversible: true,
  inverse: 'update_task@v1',
  rateLimit: { perRun: 50, perOrgPerHour: 2000 },
  timeoutMs: 8000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    const task = await updateTask(ctx.tenantDb, ctx.policy, { id: input.id, status: 'completed', agentRunId: ctx.agentRunId })
    return { ok: true as const, value: { id: task.id, status: task.status } }
  },
  buildUndo(input) {
    return {
      tool: 'update_task@v1',
      input: { id: input.id, status: 'todo' },
      entityType: 'task',
      entityId: input.id,
      description: 'Reopen the task',
    }
  },
})

export const setDueDate = register({
  name: 'set_due_date@v1',
  description: 'Set or clear a task’s due date. Renegotiating a date in advance is a success, not a failure — record it rather than letting work sit silently late.',
  inputSchema: z.object({ id: z.string().uuid(), dueAt: z.union([z.string(), z.null()]) }),
  outputSchema: z.object({ id: z.string(), dueAt: z.string().nullable() }),
  riskTier: 'low' as const,
  requiredPermissions: ['task:update:org'],
  reversible: true,
  inverse: 'set_due_date@v1',
  rateLimit: { perRun: 50, perOrgPerHour: 2000 },
  timeoutMs: 8000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    const before = await getTask(ctx.tenantDb, ctx.policy, input.id)
    const task = await updateTask(ctx.tenantDb, ctx.policy, {
      id: input.id,
      dueAt: toDate(input.dueAt),
      agentRunId: ctx.agentRunId,
    })
    return {
      ok: true as const,
      value: { id: task.id, dueAt: task.dueAt ? task.dueAt.toISOString() : null, previous: before.dueAt?.toISOString() ?? null } as never,
    }
  },
})

export const commentOnTask = register({
  name: 'comment_on_task@v1',
  description: 'Add a comment to a task, attributed to the agent by name. Never post as if a person wrote it.',
  inputSchema: z.object({ taskId: z.string().uuid(), body: z.string().min(1).max(4000) }),
  outputSchema: z.object({ id: z.string() }),
  riskTier: 'low' as const,
  requiredPermissions: ['task:update:org'],
  reversible: true,
  inverse: 'delete_comment@v1',
  rateLimit: { perRun: 30, perOrgPerHour: 2000 },
  timeoutMs: 8000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    // Which agent, not just "an agent". The description has always promised the comment is
    // "attributed to the agent by name", and `agent_id` was never filled in — which was
    // survivable only while nothing displayed the row.
    const [row] = await ctx.tenantDb.sql<{ id: string }[]>`
      INSERT INTO task_comments (organization_id, task_id, body, actor_type, agent_id, created_by)
      VALUES (${ctx.organizationId}, ${input.taskId}, ${input.body}, 'agent',
              ${ctx.policy.agent?.agentId ?? null}, ${ctx.principalUserId})
      RETURNING id`
    return { ok: true as const, value: { id: row!.id } }
  },
  buildUndo(_input, output) {
    return {
      tool: 'delete_comment@v1',
      input: { id: output.id },
      entityType: 'task_comment',
      entityId: output.id,
      description: 'Remove the comment',
    }
  },
})

export const deleteComment = register({
  name: 'delete_comment@v1',
  description: 'Remove a comment. Inverse of comment_on_task, used when undoing a run.',
  inputSchema: z.object({ id: z.string().uuid() }),
  outputSchema: z.object({ id: z.string(), deleted: z.boolean() }),
  riskTier: 'low' as const,
  requiredPermissions: ['task:update:org'],
  reversible: false,
  rateLimit: { perRun: 30, perOrgPerHour: 2000 },
  timeoutMs: 8000,
  idempotent: true,
  redactions: [],
  async execute(input, ctx: ToolContext) {
    await ctx.tenantDb.sql`
      UPDATE task_comments SET deleted_at = now()
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.id}`
    return { ok: true as const, value: { id: input.id, deleted: true } }
  },
})
