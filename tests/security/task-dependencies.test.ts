import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  addDependency,
  composeBriefingFacts,
  createTask,
  removeDependency,
  taskDependencies,
  updateTask,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Task dependencies (§12.1).
 *
 * `task_dependencies` was created in migration 0002 and never written to, while the daily
 * briefing ran an EXISTS against it on every generation — so "your work is blocking other
 * people" has been structurally empty since Phase 2.
 *
 * The properties worth asserting are the ones that make a dependency more than a note: that
 * a cycle is refused by the database rather than by a check somebody can route around, that
 * a task cannot be completed past its prerequisites, that finishing one tells the people it
 * was holding up — and only those whose last prerequisite it was — and that the briefing
 * section that has always been empty now has something in it.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }

async function newTask(title: string, assigneeId: string | null = null): Promise<string> {
  return withTenant(session, async (ctx) => {
    const task = await createTask(ctx, await loadActor(ctx), { title, assigneeId })
    return task.id
  })
}

beforeAll(async () => {
  org = await createTenant('deps')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
})

afterAll(async () => {
  await destroyTenant('deps')
  await closePools()
})

describe('recording one', () => {
  it('refuses a task waiting for itself', async () => {
    const task = await newTask('Ship the thing')
    await expect(
      withTenant(session, async (ctx) =>
        addDependency(ctx, await loadActor(ctx), { taskId: task, dependsOnTaskId: task }),
      ),
    ).rejects.toThrow(/cannot wait for itself/i)
  })

  it('records both directions from one edge', async () => {
    const ship = await newTask('Ship the thing')
    const sign = await newTask('Get the contract signed')

    const after = await withTenant(session, async (ctx) =>
      addDependency(ctx, await loadActor(ctx), {
        taskId: ship,
        dependsOnTaskId: sign,
        reason: 'Cannot ship before the paperwork exists.',
      }),
    )
    expect(after.blockedBy).toHaveLength(1)
    expect(after.blockedBy[0]?.taskTitle).toBe('Get the contract signed')
    expect(after.blockedBy[0]?.reason).toMatch(/paperwork/)
    expect(after.isBlocked).toBe(true)

    const other = await withTenant(session, async (ctx) => taskDependencies(ctx, await loadActor(ctx), sign))
    expect(other.blocking).toHaveLength(1)
    expect(other.blocking[0]?.taskTitle).toBe('Ship the thing')
    // Being depended on is not being blocked.
    expect(other.isBlocked).toBe(false)
  })

  it('is idempotent, and removable', async () => {
    const a = await newTask('A')
    const b = await newTask('B')
    await withTenant(session, async (ctx) =>
      addDependency(ctx, await loadActor(ctx), { taskId: a, dependsOnTaskId: b }),
    )
    const twice = await withTenant(session, async (ctx) =>
      addDependency(ctx, await loadActor(ctx), { taskId: a, dependsOnTaskId: b }),
    )
    expect(twice.blockedBy).toHaveLength(1)

    const removed = await withTenant(session, async (ctx) =>
      removeDependency(ctx, await loadActor(ctx), { taskId: a, dependencyId: twice.blockedBy[0]!.id }),
    )
    expect(removed.blockedBy).toHaveLength(0)
  })
})

describe('cycles', () => {
  it('are refused by the database, not by a check a bulk import could skip', async () => {
    const a = await newTask('First')
    const b = await newTask('Second')
    const c = await newTask('Third')

    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await addDependency(ctx, actor, { taskId: a, dependsOnTaskId: b })
      await addDependency(ctx, actor, { taskId: b, dependsOnTaskId: c })
    })

    // Straight through the repository: a friendly message naming both tasks.
    await expect(
      withTenant(session, async (ctx) =>
        addDependency(ctx, await loadActor(ctx), { taskId: c, dependsOnTaskId: a }),
      ),
    ).rejects.toThrow(/neither could ever be completed/i)

    // And around it, straight at the table. The trigger is the authority, so this is the
    // assertion that matters: nothing that writes rows can create a deadlock.
    await expect(
      withTenant(session, async (ctx) => {
        await ctx.sql`
          INSERT INTO task_dependencies (organization_id, task_id, depends_on_task_id, created_by)
          VALUES (${ctx.organizationId}, ${c}, ${a}, ${org.ownerId})`
      }),
    ).rejects.toThrow(/loop/i)

    // A direct two-task loop is caught by the same walk at depth zero.
    await expect(
      withTenant(session, async (ctx) =>
        addDependency(ctx, await loadActor(ctx), { taskId: b, dependsOnTaskId: a }),
      ),
    ).rejects.toThrow(/already waits for/i)
  })

  it('cannot be built across organizations', async () => {
    const other = await createTenant('deps-other')
    const theirs = await withTenant(
      { organizationId: other.organizationId, userId: other.ownerId, timezone: 'Europe/London' },
      async (ctx) => (await createTask(ctx, await loadActor(ctx), { title: 'Their task' })).id,
    )
    const mine = await newTask('My task')

    // RLS stops one tenant reading another's rows; nothing stopped a row *referencing*
    // across the boundary, because the foreign keys are to tasks(id) with no tenant in them.
    await expect(
      withTenant(session, async (ctx) => {
        await ctx.sql`
          INSERT INTO task_dependencies (organization_id, task_id, depends_on_task_id, created_by)
          VALUES (${ctx.organizationId}, ${mine}, ${theirs}, ${org.ownerId})`
      }),
    ).rejects.toThrow(/same organization/i)

    await destroyTenant('deps-other')
  })
})

describe('what a dependency actually does', () => {
  it('refuses to complete a task while a prerequisite is unfinished, and names it', async () => {
    const ship = await newTask('Ship the order')
    const pack = await newTask('Pack the pallet', org.memberId)
    await withTenant(session, async (ctx) =>
      addDependency(ctx, await loadActor(ctx), { taskId: ship, dependsOnTaskId: pack }),
    )

    await expect(
      withTenant(session, async (ctx) =>
        updateTask(ctx, await loadActor(ctx), { id: ship, status: 'completed' }),
      ),
    ).rejects.toThrow(/waiting on “Pack the pallet”/i)

    // Finishing the prerequisite frees it.
    await withTenant(session, async (ctx) =>
      updateTask(ctx, await loadActor(ctx), { id: pack, status: 'completed' }),
    )
    const done = await withTenant(session, async (ctx) =>
      updateTask(ctx, await loadActor(ctx), { id: ship, status: 'completed' }),
    )
    expect(done.status).toBe('completed')
  })

  it('counts a cancelled prerequisite as finished', async () => {
    const build = await newTask('Build it')
    const scoped = await newTask('Scope it')
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await addDependency(ctx, actor, { taskId: build, dependsOnTaskId: scoped })
      await updateTask(ctx, actor, { id: scoped, status: 'cancelled' })
      // Cancelled work is not going to happen, so waiting for it forever is the wrong
      // reading of "unfinished".
      return updateTask(ctx, actor, { id: build, status: 'completed' })
    })
    const after = await withTenant(session, async (ctx) => taskDependencies(ctx, await loadActor(ctx), build))
    expect(after.isBlocked).toBe(false)
  })

  it('tells the person it was holding up — and only when it was the last thing', async () => {
    const first = await newTask('First prerequisite')
    const second = await newTask('Second prerequisite')
    const waiting = await newTask('The waiting work', org.memberId)

    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await addDependency(ctx, actor, { taskId: waiting, dependsOnTaskId: first })
      await addDependency(ctx, actor, { taskId: waiting, dependsOnTaskId: second })
      await updateTask(ctx, actor, { id: first, status: 'completed' })
    })

    const countFor = async () => {
      const [row] = await adminSql()<{ count: string }[]>`
        SELECT count(*)::text AS count FROM notifications
        WHERE organization_id = ${org.organizationId} AND user_id = ${org.memberId}
          AND type = 'task_unblocked' AND entity_id = ${waiting}`
      return Number(row?.count ?? 0)
    }

    // One of two done is not unblocked. Saying so would train people to ignore it.
    expect(await countFor()).toBe(0)

    await withTenant(session, async (ctx) =>
      updateTask(ctx, await loadActor(ctx), { id: second, status: 'completed' }),
    )
    expect(await countFor()).toBe(1)

    const [notification] = await adminSql()<{ body: string; url: string }[]>`
      SELECT body, url FROM notifications
      WHERE organization_id = ${org.organizationId} AND entity_id = ${waiting} AND type = 'task_unblocked'`
    expect(notification?.body).toMatch(/Second prerequisite/)
    expect(notification?.url).toContain(waiting)
  })

  it('does not notify somebody about their own completion', async () => {
    const prerequisite = await newTask('Mine to finish')
    const dependent = await newTask('Also mine', org.ownerId)
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await addDependency(ctx, actor, { taskId: dependent, dependsOnTaskId: prerequisite })
      return updateTask(ctx, actor, { id: prerequisite, status: 'completed' })
    })

    const [row] = await adminSql()<{ count: string }[]>`
      SELECT count(*)::text AS count FROM notifications
      WHERE organization_id = ${org.organizationId} AND user_id = ${org.ownerId} AND type = 'task_unblocked'`
    expect(Number(row?.count ?? 0)).toBe(0)
  })
})

describe('the briefing section that was always empty', () => {
  it('now says how many people your work is holding up', async () => {
    const mine = await newTask('The thing everyone needs', org.ownerId)
    const theirs = await newTask('Waiting on it', org.memberId)
    await withTenant(session, async (ctx) =>
      addDependency(ctx, await loadActor(ctx), { taskId: theirs, dependsOnTaskId: mine }),
    )

    const facts = await withTenant(session, async (ctx) => composeBriefingFacts(ctx, await loadActor(ctx), 'daily'))
    const blocking = facts.blockingOthers.find((entry) => entry.id === mine)
    expect(blocking).toBeDefined()
    expect(blocking!.waitingCount).toBe(1)
  })
})
