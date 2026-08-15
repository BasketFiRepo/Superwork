import { randomUUID } from 'node:crypto'
import type { TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeActivity, writeAudit } from '../audit.js'
import { link } from '../links.js'
import { cronProblem, describeCron, nextOccurrence, normalizeCron } from '../cron.js'
import { nonWorkingReason } from '../holidays.js'
import { calendarDate } from '../time.js'
import { workingCalendarFor } from '../working-days.js'

/**
 * Recurring tasks (§12.1).
 *
 * `tasks.recurrence_rule` has existed since migration 0002 and nothing has ever written to it
 * or read it, so every recurring obligation an operations team has was retyped by a person
 * each time or forgotten — the weekly temperature logs, the monthly reconciliation, the
 * quarterly audit booking. The seed's own task list is full of them.
 *
 * **The grammar is the one the product already has.** Workflow schedules are cron, evaluated
 * in a timezone, with aliases and named refusals (`@reboot` is not a schedule). Recurrence
 * reuses that module rather than inventing a second grammar, so "every weekday at 9" means
 * the same thing on a task as it does on a workflow, and says so in the same words.
 *
 * **One open occurrence at a time.** A rule that materialises a year of rows floods every
 * list and makes the overdue count meaningless. The next occurrence is created when the
 * current one reaches a terminal state, and the database holds the invariant rather than this
 * module remembering to.
 *
 * **Cancelling an occurrence does not end the series.** "Nothing to file this week" is not
 * "stop filing"; ending it is a separate act, which is clearing the rule.
 */

export interface RecurrenceView {
  rule: string
  /** Plain English, from the same describer the workflow schedules use. */
  description: string
  seriesId: string
  /** When the next occurrence would fall, computed from this one's date. */
  nextDueAt: Date | null
  /**
   * Set when that date is not a working day where the assignee is. The date is not moved —
   * a due date is a promise, not a delivery — but nobody is chased on it either (ADR 0039).
   */
  nextIsNonWorking: string | null
  timezone: string
  /** Earlier occurrences of the same series, most recent first. */
  history: { id: string; title: string; status: string; dueAt: Date | null; completedAt: Date | null }[]
}

interface RecurringTask {
  id: string
  title: string
  description: string | null
  status: string
  priority: string
  assignee_id: string | null
  project_id: string | null
  department_id: string | null
  team_id: string | null
  milestone_id: string | null
  estimate_minutes: number | null
  sensitivity: string
  due_at: Date | null
  recurrence_rule: string | null
  recurrence_series_id: string | null
}

const SELECT_TASK = `
  id, title, description, status::text AS status, priority::text AS priority, assignee_id,
  project_id, department_id, team_id, milestone_id, estimate_minutes, sensitivity::text AS sensitivity,
  due_at, recurrence_rule, recurrence_series_id`

async function loadTask(ctx: TenantContext, taskId: string): Promise<RecurringTask> {
  const [task] = await ctx.sql<RecurringTask[]>`
    SELECT ${ctx.sql.unsafe(SELECT_TASK)} FROM tasks
    WHERE organization_id = ${ctx.organizationId} AND id = ${taskId} AND deleted_at IS NULL`
  if (!task) throw new NotFoundError()
  return task
}

function guardWrite(ctx: TenantContext, actor: Actor, task: RecurringTask): void {
  const decision = can(actor, 'task:update', {
    type: 'task',
    id: task.id,
    organizationId: ctx.organizationId,
    assigneeId: task.assignee_id,
    departmentId: task.department_id,
    teamIds: task.team_id ? [task.team_id] : [],
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
}

/**
 * The timezone a recurrence means.
 *
 * The assignee's, through their department, falling back to the organization's — the same
 * resolution the working calendar uses. "Every Monday at nine" is nine o'clock where the
 * person doing it is, not where the server is or where whoever is looking at it happens to be
 * (§26.5).
 */
async function timezoneFor(ctx: TenantContext, task: RecurringTask): Promise<string> {
  if (!task.assignee_id) {
    const [org] = await ctx.sql<{ timezone: string }[]>`
      SELECT timezone FROM organizations WHERE id = ${ctx.organizationId}`
    return org?.timezone ?? ctx.timezone
  }
  const calendar = await workingCalendarFor(ctx, task.assignee_id)
  return calendar.timezone
}

async function describe(ctx: TenantContext, task: RecurringTask): Promise<RecurrenceView | null> {
  if (!task.recurrence_rule || !task.recurrence_series_id) return null
  const timezone = await timezoneFor(ctx, task)

  // Counted from the later of this occurrence's date and now. A weekly task completed three
  // weeks late would otherwise produce a "next" occurrence already two weeks overdue, which
  // is a product apologising for its own arithmetic.
  const from = task.due_at && task.due_at.getTime() > Date.now() ? task.due_at : new Date()
  const nextDueAt = nextOccurrence(task.recurrence_rule, timezone, from)

  const calendar = task.assignee_id ? await workingCalendarFor(ctx, task.assignee_id) : null
  const nextIsNonWorking =
    nextDueAt && calendar?.calendarId
      ? nonWorkingReason(calendar.calendarId, calendarDate(timezone, nextDueAt))
      : null

  const history = await ctx.sql<
    { id: string; title: string; status: string; dueAt: Date | null; completedAt: Date | null }[]
  >`
    SELECT id, title, status::text AS status, due_at AS "dueAt", completed_at AS "completedAt"
    FROM tasks
    WHERE organization_id = ${ctx.organizationId} AND recurrence_series_id = ${task.recurrence_series_id}
      AND id <> ${task.id} AND deleted_at IS NULL
    ORDER BY due_at DESC NULLS LAST
    LIMIT 10`

  return {
    rule: task.recurrence_rule,
    description: describeCron(task.recurrence_rule, timezone),
    seriesId: task.recurrence_series_id,
    nextDueAt,
    nextIsNonWorking,
    timezone,
    history,
  }
}

export async function taskRecurrence(
  ctx: TenantContext,
  actor: Actor,
  taskId: string,
): Promise<RecurrenceView | null> {
  const task = await loadTask(ctx, taskId)
  const decision = can(actor, 'task:read', {
    type: 'task',
    id: task.id,
    organizationId: ctx.organizationId,
    assigneeId: task.assignee_id,
    departmentId: task.department_id,
    teamIds: task.team_id ? [task.team_id] : [],
    riskTier: 'read',
  })
  if (!decision.allow) throw new NotFoundError()
  return describe(ctx, task)
}

/**
 * Sets, changes or ends a repeat.
 *
 * `rule: null` ends it. The occurrences already created stay — they were real work — and the
 * series simply stops producing new ones.
 */
export async function setRecurrence(
  ctx: TenantContext,
  actor: Actor,
  input: { taskId: string; rule: string | null },
): Promise<RecurrenceView | null> {
  const task = await loadTask(ctx, input.taskId)
  guardWrite(ctx, actor, task)

  if (input.rule === null) {
    if (!task.recurrence_rule) return null
    await ctx.sql`
      UPDATE tasks SET recurrence_rule = NULL, updated_at = now()
      WHERE organization_id = ${ctx.organizationId} AND id = ${task.id}`
    await writeAudit(ctx, {
      actorType: actor.type,
      actorId: actor.userId,
      action: 'task.recurrence_cleared',
      entityType: 'task',
      entityId: task.id,
      before: { recurrenceRule: task.recurrence_rule },
    })
    await writeActivity(ctx, {
      actorType: actor.type,
      actorUserId: actor.userId,
      actorLabel: actor.displayName,
      verb: 'updated',
      entityType: 'task',
      entityId: task.id,
      entityLabel: task.title,
      summary: `“${task.title}” no longer repeats. The occurrences already made stay where they are.`,
    })
    return null
  }

  // The same refusals the workflow schedules give, in the same words: one grammar, one
  // explanation of what is wrong with it.
  const problem = cronProblem(input.rule)
  if (problem) throw new ValidationError(problem)

  if (!task.due_at) {
    throw new ValidationError(
      'Give it a date first. “Every Monday” has to repeat from something, and a task with no due date has nothing to count from.',
    )
  }
  if (['completed', 'cancelled'].includes(task.status)) {
    throw new ValidationError(
      'This one is already finished. Set the repeat on the occurrence that is still open, or make a new task.',
    )
  }

  const rule = normalizeCron(input.rule)
  const seriesId = task.recurrence_series_id ?? randomUUID()

  await ctx.sql`
    UPDATE tasks SET recurrence_rule = ${rule}, recurrence_series_id = ${seriesId}, updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${task.id}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'task.recurrence_set',
    entityType: 'task',
    entityId: task.id,
    before: { recurrenceRule: task.recurrence_rule },
    after: { recurrenceRule: rule, seriesId },
  })

  const updated = await loadTask(ctx, task.id)
  const view = await describe(ctx, updated)
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'updated',
    entityType: 'task',
    entityId: task.id,
    entityLabel: task.title,
    summary: `“${task.title}” now repeats ${view?.description ?? rule}.`,
  })
  return view
}

export interface RollForwardOutcome {
  created: boolean
  taskId: string | null
  dueAt: Date | null
  /** Why nothing was created, when nothing was. */
  reason: string | null
}

/**
 * Creates the next occurrence when one finishes.
 *
 * Called from `updateTask` the moment a task reaches a terminal state, rather than by a
 * background sweep: there is only ever one open occurrence, so there is nothing for a sweep to
 * find, and the person who just ticked it off is the one who wants to see the next date.
 *
 * Cancelling rolls forward too. "Nothing to file this week" is not "stop filing" — ending the
 * series is clearing the rule, which is a different act with its own audit line.
 */
export async function rollForwardRecurrence(
  ctx: TenantContext,
  actor: Actor,
  taskId: string,
): Promise<RollForwardOutcome> {
  const task = await loadTask(ctx, taskId)
  if (!task.recurrence_rule || !task.recurrence_series_id) {
    return { created: false, taskId: null, dueAt: null, reason: null }
  }

  const timezone = await timezoneFor(ctx, task)
  const from = task.due_at && task.due_at.getTime() > Date.now() ? task.due_at : new Date()
  const nextDueAt = nextOccurrence(task.recurrence_rule, timezone, from)
  if (!nextDueAt) {
    return {
      created: false,
      taskId: null,
      dueAt: null,
      reason: 'That rule has no date left in it, so the series has run out rather than repeating.',
    }
  }

  // The unique index is the authority on this; the check is here so a double completion
  // reads as "already done" rather than as a constraint violation.
  const [open] = await ctx.sql<{ id: string }[]>`
    SELECT id FROM tasks
    WHERE organization_id = ${ctx.organizationId} AND recurrence_series_id = ${task.recurrence_series_id}
      AND deleted_at IS NULL AND status NOT IN ('completed', 'cancelled')
    LIMIT 1`
  if (open) {
    return { created: false, taskId: open.id, dueAt: null, reason: 'The next one already exists.' }
  }

  const [next] = await ctx.sql<{ id: string }[]>`
    INSERT INTO tasks (
      organization_id, project_id, milestone_id, department_id, team_id, title, description,
      status, priority, assignee_id, due_at, estimate_minutes, sensitivity,
      recurrence_rule, recurrence_series_id, created_by_actor_type, is_demo, created_by
    )
    SELECT organization_id, project_id, milestone_id, department_id, team_id, title, description,
           'todo', priority, assignee_id, ${nextDueAt}, estimate_minutes, sensitivity,
           recurrence_rule, recurrence_series_id, 'system', is_demo, ${ctx.userId}
    FROM tasks WHERE organization_id = ${ctx.organizationId} AND id = ${task.id}
    RETURNING id`

  // The rule now lives on the open occurrence. Leaving it on the finished one would make the
  // series look like two rules, and would let somebody "stop" a repeat by editing a task that
  // is already done.
  await ctx.sql`
    UPDATE tasks SET recurrence_rule = NULL, updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${task.id}`

  await link(ctx, { type: 'task', id: next!.id }, { type: 'task', id: task.id }, 'supersedes')

  await writeActivity(ctx, {
    actorType: 'system',
    actorLabel: 'Superwork',
    verb: 'created',
    entityType: 'task',
    entityId: next!.id,
    entityLabel: task.title,
    summary:
      `“${task.title}” repeats, so the next one is due ` +
      `${calendarDate(timezone, nextDueAt)}. Nothing was invented — it carries the same owner, ` +
      'project and estimate as the one just finished.',
  })
  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'task.recurrence_rolled',
    entityType: 'task',
    entityId: next!.id,
    after: { from: task.id, dueAt: nextDueAt, rule: task.recurrence_rule },
  })

  return { created: true, taskId: next!.id, dueAt: nextDueAt, reason: null }
}
