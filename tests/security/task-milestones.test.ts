import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  addMilestone,
  createTask,
  getTask,
  projectMilestones,
  setMilestoneStatus,
  setRecurrence,
  updateTask,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * The work a milestone is made of (ADR 0048).
 *
 * `tasks.milestone_id` has existed since migration 0002 and nothing ever wrote it. Milestones
 * became real in ADR 0036 — a project can add one, reschedule it, reach it — but each was a
 * date with a name on it and nothing underneath: "what is this milestone waiting on" had no
 * answer, and "is it going to make it" had none either.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let projectId: string
let otherProjectId: string
let milestoneId: string
let otherMilestoneId: string

const inDays = (days: number) => new Date(Date.now() + days * 86_400_000)
const dayOf = (date: Date) => date.toISOString().slice(0, 10)

beforeAll(async () => {
  org = await createTenant('task-milestones')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }

  await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    // Projects themselves are still seed-written — nothing in the product creates one, which
    // is its own gap and not this one's.
    const [project] = await ctx.sql<{ id: string }[]>`
      INSERT INTO projects (organization_id, name, key, status, owner_id, is_demo, created_by)
      VALUES (${ctx.organizationId}, 'Cold chain uplift', 'CCU', 'active', ${org.ownerId}, true, ${org.ownerId})
      RETURNING id`
    projectId = project!.id
    const [other] = await ctx.sql<{ id: string }[]>`
      INSERT INTO projects (organization_id, name, key, status, owner_id, is_demo, created_by)
      VALUES (${ctx.organizationId}, 'Customs rework', 'CRW', 'active', ${org.ownerId}, true, ${org.ownerId})
      RETURNING id`
    otherProjectId = other!.id

    const milestones = await addMilestone(ctx, actor, {
      projectId,
      name: 'Depot pilot live',
      dueOn: inDays(14),
    })
    milestoneId = milestones[0]!.id
    const others = await addMilestone(ctx, actor, {
      projectId: otherProjectId,
      name: 'Broker onboarded',
      dueOn: inDays(21),
    })
    otherMilestoneId = others[0]!.id
  })
})

afterAll(async () => {
  await destroyTenant('task-milestones')
  await closePools()
})

describe('filing work against a date', () => {
  it('starts with a milestone that has nothing underneath it', async () => {
    await withTenant(session, async (ctx) => {
      const [milestone] = await projectMilestones(ctx, projectId)
      expect(milestone!.taskCount).toBe(0)
      expect(milestone!.openCount).toBe(0)
    })
  })

  it('files a task against a milestone of its own project', async () => {
    const task = await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const created = await createTask(ctx, actor, {
        title: 'Fit the depot probes',
        projectId,
        dueAt: inDays(7),
      })
      return updateTask(ctx, actor, { id: created.id, milestoneId })
    })
    expect(task.milestoneId).toBe(milestoneId)
    expect(task.milestoneName).toBe('Depot pilot live')

    await withTenant(session, async (ctx) => {
      const [milestone] = await projectMilestones(ctx, projectId)
      expect(milestone!.taskCount).toBe(1)
      expect(milestone!.openCount).toBe(1)
    })
  })

  it('refuses a milestone belonging to another project', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const created = await createTask(ctx, actor, { title: 'Not for that one', projectId })
      await expect(
        updateTask(ctx, actor, { id: created.id, milestoneId: otherMilestoneId }),
      ).rejects.toThrow(/belongs to another project/i)
    })
  })

  it('refuses a task that is on no project at all', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const loose = await createTask(ctx, actor, { title: 'Belongs to nothing' })
      await expect(updateTask(ctx, actor, { id: loose.id, milestoneId })).rejects.toThrow(
        /not on one/i,
      )
    })
  })

  it('cannot be filed across projects whatever writes the row', async () => {
    const [task] = await adminSql()<{ id: string }[]>`
      SELECT id FROM tasks WHERE organization_id = ${org.organizationId} AND title = 'Not for that one'`
    await expect(
      adminSql()`UPDATE tasks SET milestone_id = ${otherMilestoneId} WHERE id = ${task!.id}`,
    ).rejects.toThrow(/belongs to another project/i)
    // And a milestone on a task with no project is refused by the constraint, not by a caller.
    await expect(
      adminSql()`
        UPDATE tasks SET project_id = NULL WHERE organization_id = ${org.organizationId}
          AND milestone_id IS NOT NULL`,
    ).rejects.toThrow(/tasks_milestone_needs_project|belongs to another project/i)
  })

  it('can be taken off again, and the counts follow', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const created = await createTask(ctx, actor, { title: 'Briefly on it', projectId })
      await updateTask(ctx, actor, { id: created.id, milestoneId })
      expect((await projectMilestones(ctx, projectId))[0]!.taskCount).toBe(2)

      const off = await updateTask(ctx, actor, { id: created.id, milestoneId: null })
      expect(off.milestoneId).toBeNull()
      expect((await projectMilestones(ctx, projectId))[0]!.taskCount).toBe(1)
    })
  })
})

describe('what the milestone can then say', () => {
  it('says how much of its work is done, from SQL', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const second = await createTask(ctx, actor, { title: 'Wire the alarms', projectId })
      await updateTask(ctx, actor, { id: second.id, milestoneId })
      await updateTask(ctx, actor, { id: second.id, status: 'completed' })

      const [milestone] = await projectMilestones(ctx, projectId)
      expect(milestone!.taskCount).toBe(2)
      expect(milestone!.openCount).toBe(1)
    })
  })

  it('says when its own work is due after it is, which is the slip stated in advance', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const late = await createTask(ctx, actor, {
        title: 'Sign off the pilot',
        projectId,
        dueAt: inDays(30),
      })
      await updateTask(ctx, actor, { id: late.id, milestoneId })

      const [milestone] = await projectMilestones(ctx, projectId)
      expect(milestone!.dueAfterCount).toBe(1)
      expect(dayOf(new Date(milestone!.dueOn!))).toBe(dayOf(inDays(14)))
    })
  })

  it('counts what is already late separately from what is merely open', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const overdue = await createTask(ctx, actor, {
        title: 'Chase the depot',
        projectId,
        dueAt: inDays(-3),
      })
      await updateTask(ctx, actor, { id: overdue.id, milestoneId })

      const [milestone] = await projectMilestones(ctx, projectId)
      expect(milestone!.overdueCount).toBe(1)
      expect(milestone!.openCount).toBeGreaterThan(milestone!.overdueCount)
    })
  })
})

describe('reaching it means something', () => {
  it('refuses “reached” while work on it is still open, and names what is left', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        setMilestoneStatus(ctx, actor, { projectId, milestoneId, status: 'done' }),
      ).rejects.toThrow(ValidationError)
      await expect(
        setMilestoneStatus(ctx, actor, { projectId, milestoneId, status: 'done' }),
      ).rejects.toThrow(/still has 3 tasks open/i)
    })
  })

  it('still allows abandoning it with work on it, because that is what abandoning looks like', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const [after] = await setMilestoneStatus(ctx, actor, { projectId, milestoneId, status: 'cancelled' })
      expect(after!.status).toBe('cancelled')
      await setMilestoneStatus(ctx, actor, { projectId, milestoneId, status: 'open' })
    })
  })

  it('accepts it once the work is finished or taken off', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const open = await ctx.sql<{ id: string }[]>`
        SELECT id FROM tasks
        WHERE organization_id = ${ctx.organizationId} AND milestone_id = ${milestoneId}
          AND deleted_at IS NULL AND status NOT IN ('completed', 'cancelled')`
      for (const task of open) await updateTask(ctx, actor, { id: task.id, status: 'completed' })

      const [reached] = await setMilestoneStatus(ctx, actor, { projectId, milestoneId, status: 'done' })
      expect(reached!.status).toBe('done')
      expect(reached!.openCount).toBe(0)
    })
  })

  it('refuses new work filed against a milestone that is already reached', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const fresh = await createTask(ctx, actor, { title: 'Too late for that one', projectId })
      await expect(updateTask(ctx, actor, { id: fresh.id, milestoneId })).rejects.toThrow(
        /already reached/i,
      )
    })
  })
})

describe('work that comes back', () => {
  it('carries the milestone while it is open, and stops when the milestone is abandoned', async () => {
    const { second, third } = await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const milestones = await addMilestone(ctx, actor, {
        projectId,
        name: 'Weekly audit run',
        dueOn: inDays(60),
      })
      const audit = milestones.find((milestone) => milestone.name === 'Weekly audit run')!

      const first = await createTask(ctx, actor, {
        title: 'Audit the pre-cool log',
        projectId,
        dueAt: inDays(1),
      })
      await updateTask(ctx, actor, { id: first.id, milestoneId: audit.id })
      await setRecurrence(ctx, actor, { taskId: first.id, rule: '0 9 * * 1' })
      await updateTask(ctx, actor, { id: first.id, status: 'completed' })

      const openOne = async () => {
        const [row] = await ctx.sql<{ id: string }[]>`
          SELECT id FROM tasks
          WHERE organization_id = ${ctx.organizationId} AND title = 'Audit the pre-cool log'
            AND status NOT IN ('completed', 'cancelled') AND deleted_at IS NULL`
        return getTask(ctx, actor, row!.id)
      }
      const second = await openOne()

      // Abandoning a milestone is allowed with work still on it — that is what abandoning one
      // looks like — and it is the reachable way a live occurrence ends up on a closed
      // milestone. The occurrence after it starts unfiled.
      await setMilestoneStatus(ctx, actor, { projectId, milestoneId: audit.id, status: 'cancelled' })
      await updateTask(ctx, actor, { id: second.id, status: 'completed' })
      const third = await openOne()
      return { second, third }
    })

    expect(second.milestoneName).toBe('Weekly audit run')
    expect(third.milestoneId).toBeNull()
  })
})
