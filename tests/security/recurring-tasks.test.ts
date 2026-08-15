import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  createTask,
  getTask,
  listTasks,
  NotFoundError,
  PermissionError,
  setRecurrence,
  taskRecurrence,
  updateTask,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Recurring tasks (ADR 0041).
 *
 * `tasks.recurrence_rule` has existed since migration 0002 and nothing has ever written to it
 * or read it, so every recurring obligation was retyped or forgotten.
 *
 * Two properties carry the feature. **One open occurrence at a time**, held by a partial
 * unique index rather than by the code that creates the next one — so a double completion
 * cannot produce two. And **the grammar is the one the product already has**: the same cron
 * module the workflow schedules use, refusing the same things in the same words.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let viewerSession: { organizationId: string; userId: string; timezone: string }
let taskId: string

async function makeTask(title: string, dueAt: Date | null): Promise<string> {
  return withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const task = await createTask(ctx, actor, { title, assigneeId: org.memberId, dueAt })
    return task.id
  })
}

beforeAll(async () => {
  org = await createTenant('recurring-tasks')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  viewerSession = { organizationId: org.organizationId, userId: org.viewerId, timezone: TZ }
  taskId = await makeTask('File the weekly temperature logs', new Date('2026-08-17T09:00:00Z'))
})

afterAll(async () => {
  await destroyTenant('recurring-tasks')
  await closePools()
})

describe('a repeat is set in the grammar the product already has', () => {
  it('refuses what the automations screen refuses, in the same words', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(setRecurrence(ctx, actor, { taskId, rule: '@reboot' })).rejects.toThrow(
        /not a schedule/i,
      )
      await expect(setRecurrence(ctx, actor, { taskId, rule: 'every monday' })).rejects.toThrow(
        ValidationError,
      )
      await expect(setRecurrence(ctx, actor, { taskId, rule: '0 9 * *' })).rejects.toThrow(
        /five fields/i,
      )
    })
  })

  it('refuses a repeat on a task with no date to count from', async () => {
    const undated = await makeTask('Something with no date', null)
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(setRecurrence(ctx, actor, { taskId: undated, rule: '@weekly' })).rejects.toThrow(
        /has to repeat from something/i,
      )
    })
  })

  it('needs a say over the task, not a read of it', async () => {
    await withTenant(viewerSession, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(setRecurrence(ctx, actor, { taskId, rule: '@weekly' })).rejects.toThrow(PermissionError)
    })
  })

  it('reads the schedule back in English, with the next date', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const view = await setRecurrence(ctx, actor, { taskId, rule: '0 9 * * 1' })
      expect(view!.description).toMatch(/monday/i)
      expect(view!.nextDueAt).not.toBeNull()
      expect(view!.seriesId).toBeTruthy()
    })
  })
})

describe('finishing one makes the next one', () => {
  it('carries the owner, project and estimate rather than inventing them', async () => {
    const before = await withTenant(session, async (ctx) => getTask(ctx, await loadActor(ctx), taskId))

    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await updateTask(ctx, actor, { id: taskId, status: 'completed' })
    })

    const [next] = await adminSql()<
      { id: string; title: string; assigneeId: string | null; dueAt: Date; rule: string | null }[]
    >`
      SELECT id, title, assignee_id AS "assigneeId", due_at AS "dueAt", recurrence_rule AS rule
      FROM tasks
      WHERE organization_id = ${org.organizationId} AND id <> ${taskId}
        AND title = 'File the weekly temperature logs'`

    expect(next).toBeDefined()
    expect(next!.assigneeId).toBe(before.assigneeId)
    expect(next!.rule).toBe('0 9 * * 1')
    expect(next!.dueAt.getTime()).toBeGreaterThan(Date.now())
    taskId = next!.id
  })

  it('moves the rule onto the open occurrence, so a finished one cannot be “stopped”', async () => {
    const [finished] = await adminSql()<{ rule: string | null }[]>`
      SELECT recurrence_rule AS rule FROM tasks
      WHERE organization_id = ${org.organizationId} AND status = 'completed'
        AND title = 'File the weekly temperature logs'`
    expect(finished!.rule).toBeNull()
  })

  it('links the new one back to the one it came from', async () => {
    const [edge] = await adminSql()<{ relation: string }[]>`
      SELECT relation FROM links
      WHERE organization_id = ${org.organizationId} AND from_type = 'task' AND from_id = ${taskId}`
    expect(edge!.relation).toBe('supersedes')
  })

  it('leaves exactly one open occurrence, which the database holds', async () => {
    const [count] = await adminSql()<{ open: string }[]>`
      SELECT count(*)::text AS open FROM tasks t
      WHERE t.organization_id = ${org.organizationId}
        AND t.recurrence_series_id = (SELECT recurrence_series_id FROM tasks WHERE id = ${taskId})
        AND t.deleted_at IS NULL AND t.status NOT IN ('completed', 'cancelled')`
    expect(Number(count!.open)).toBe(1)

    // The invariant is the index's, not the caller's: a second open occurrence is refused
    // however it is written.
    const [series] = await adminSql()<{ seriesId: string }[]>`
      SELECT recurrence_series_id AS "seriesId" FROM tasks WHERE id = ${taskId}`
    await expect(
      adminSql()`
        INSERT INTO tasks (organization_id, title, status, priority, due_at,
                           recurrence_rule, recurrence_series_id, is_demo, created_by)
        VALUES (${org.organizationId}, 'A second open one', 'todo', 'medium', now(),
                '@weekly', ${series!.seriesId}, true, ${org.ownerId})`,
    ).rejects.toThrow(/tasks_one_open_occurrence/)
  })

  it('cancelling rolls forward too — “nothing this week” is not “stop”', async () => {
    const seriesBefore = await adminSql()<{ id: string }[]>`
      SELECT id FROM tasks WHERE organization_id = ${org.organizationId}
        AND recurrence_series_id = (SELECT recurrence_series_id FROM tasks WHERE id = ${taskId})`

    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await updateTask(ctx, actor, { id: taskId, status: 'cancelled' })
    })

    const seriesAfter = await adminSql()<{ id: string; status: string }[]>`
      SELECT id, status::text AS status FROM tasks
      WHERE organization_id = ${org.organizationId}
        AND recurrence_series_id = (SELECT recurrence_series_id FROM tasks WHERE id = ${taskId})`
    expect(seriesAfter.length).toBe(seriesBefore.length + 1)
    expect(seriesAfter.filter((row) => !['completed', 'cancelled'].includes(row.status))).toHaveLength(1)
    taskId = seriesAfter.find((row) => !['completed', 'cancelled'].includes(row.status))!.id
  })

  it('never produces a next occurrence that is already overdue', async () => {
    const stale = await makeTask('Long-overdue weekly thing', new Date('2026-01-05T09:00:00Z'))
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await setRecurrence(ctx, actor, { taskId: stale, rule: '0 9 * * 1' })
      await updateTask(ctx, actor, { id: stale, status: 'completed' })
    })

    const [next] = await adminSql()<{ dueAt: Date }[]>`
      SELECT due_at AS "dueAt" FROM tasks
      WHERE organization_id = ${org.organizationId} AND title = 'Long-overdue weekly thing'
        AND status NOT IN ('completed', 'cancelled')`
    // Counted from now rather than from a date months past, or the product would apologise
    // for its own arithmetic with a brand-new overdue task.
    expect(next!.dueAt.getTime()).toBeGreaterThan(Date.now())
  })
})

describe('stopping is a separate act', () => {
  it('ends the series and leaves the occurrences already made', async () => {
    const countBefore = await adminSql()<{ id: string }[]>`
      SELECT id FROM tasks WHERE organization_id = ${org.organizationId}
        AND recurrence_series_id = (SELECT recurrence_series_id FROM tasks WHERE id = ${taskId})`

    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      expect(await setRecurrence(ctx, actor, { taskId, rule: null })).toBeNull()
      await updateTask(ctx, actor, { id: taskId, status: 'completed' })
    })

    const countAfter = await adminSql()<{ id: string }[]>`
      SELECT id FROM tasks WHERE organization_id = ${org.organizationId}
        AND recurrence_series_id = (SELECT recurrence_series_id FROM tasks WHERE id = ${taskId})`
    expect(countAfter.length).toBe(countBefore.length)
  })
})

describe('the repeat is visible where the work is', () => {
  it('shows on the task list, so a repeating one is not mistaken for a one-off', async () => {
    const repeating = await makeTask('Monthly reconciliation', new Date('2026-09-01T09:00:00Z'))
    await withTenant(session, async (ctx) => {
      await setRecurrence(ctx, await loadActor(ctx), { taskId: repeating, rule: '0 9 1 * *' })
    })

    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const { tasks } = await listTasks(ctx, actor, { limit: 200 })
      const found = tasks.find((task) => task.id === repeating)
      expect(found?.recurrenceRule).toBe('0 9 1 * *')
    })
  })

  it('is not readable across tenants', async () => {
    const other = await createTenant('recurring-tasks-b')
    await withTenant(
      { organizationId: other.organizationId, userId: other.ownerId, timezone: TZ },
      async (ctx) => {
        const actor = await loadActor(ctx)
        await expect(taskRecurrence(ctx, actor, taskId)).rejects.toThrow(NotFoundError)
      },
    )
    await destroyTenant('recurring-tasks-b')
  })
})
