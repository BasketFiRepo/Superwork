import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  createTask,
  deleteSavedView,
  listSavedViews,
  listTasks,
  NotFoundError,
  PermissionError,
  sanitizeQuery,
  saveView,
  taskWatchers,
  unwatchTask,
  updateTask,
  ValidationError,
  watchTask,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Saved views and task watchers (ADR 0037).
 *
 * Both tables were created in migration 0002 and neither has ever been written to or read.
 * Two claims are under test.
 *
 * **A saved view is a question, not a grant.** The query is a jsonb blob a screen would
 * otherwise have to trust; it is whitelisted on the way in *and* on the way out, and a shared
 * view runs the same scope-aware read for whoever opens it.
 *
 * **A watch grants nothing and is re-checked at delivery.** You may only follow what you can
 * already read, and every notification is written only after `can()` says that person could
 * open the task now — so a watch that outlives the access it was made under goes quiet
 * instead of leaking.
 */

let org: TenantFixture
let other: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let memberSession: { organizationId: string; userId: string; timezone: string }
let guestSession: { organizationId: string; userId: string; timezone: string }
let guestId: string
let teamId: string
let sharedTaskId: string
let privateTaskId: string

const GUEST_EMAIL = 'guest.views-watchers@fixture.example'

async function countTaskChanged(userId: string): Promise<number> {
  const [row] = await adminSql()<{ count: string }[]>`
    SELECT count(*)::text AS count FROM notifications
    WHERE organization_id = ${org.organizationId} AND user_id = ${userId} AND type = 'task_changed'`
  return Number(row!.count)
}

beforeAll(async () => {
  org = await createTenant('views-watchers')
  other = await createTenant('views-watchers-b')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
  memberSession = { organizationId: org.organizationId, userId: org.memberId, timezone: 'Europe/London' }

  // A guest reads tasks only through a team, which is the smallest lever for taking a read
  // away from somebody who already has it.
  await adminSql()`DELETE FROM users WHERE lower(email) = ${GUEST_EMAIL}`
  const [user] = await adminSql()<{ id: string }[]>`
    INSERT INTO users (email, name, timezone, is_demo)
    VALUES (${GUEST_EMAIL}, 'Guest Watcher', 'Europe/London', true) RETURNING id`
  guestId = user!.id
  await adminSql()`
    INSERT INTO memberships (organization_id, user_id, role, is_demo)
    VALUES (${org.organizationId}, ${guestId}, 'guest', true)`
  guestSession = { organizationId: org.organizationId, userId: guestId, timezone: 'Europe/London' }

  await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const [team] = await ctx.sql<{ id: string }[]>`
      INSERT INTO teams (organization_id, name, is_demo, created_by)
      VALUES (${org.organizationId}, 'Customs', true, ${org.ownerId}) RETURNING id`
    teamId = team!.id
    await ctx.sql`
      INSERT INTO team_members (organization_id, team_id, user_id, is_demo, created_by)
      VALUES (${org.organizationId}, ${teamId}, ${guestId}, true, ${org.ownerId})`

    const shared = await createTask(ctx, actor, { title: 'Rewrite the broker brief' })
    const priv = await createTask(ctx, actor, { title: 'Something the guest cannot see' })
    sharedTaskId = shared.id
    privateTaskId = priv.id
    await ctx.sql`UPDATE tasks SET team_id = ${teamId} WHERE id = ${sharedTaskId}`
  })
})

afterAll(async () => {
  await destroyTenant('views-watchers')
  await destroyTenant('views-watchers-b')
  await adminSql()`DELETE FROM users WHERE id = ${guestId}`
  await closePools()
})

describe('a saved view carries only what the list understands', () => {
  it('drops unknown keys and unknown filters rather than storing them', () => {
    expect(
      sanitizeQuery({ filter: 'mine', q: '  brokers  ', assigneeId: 'somebody-else', limit: 100_000 }),
    ).toEqual({ filter: 'mine', q: 'brokers' })
    expect(sanitizeQuery({ filter: 'everything' })).toEqual({})
    expect(sanitizeQuery('not an object at all')).toEqual({})
    expect(sanitizeQuery(null)).toEqual({})
  })

  it('sanitises on read, so a row edited outside the product cannot widen a list', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await ctx.sql`
        INSERT INTO saved_views (organization_id, user_id, name, entity, query, is_demo, created_by)
        VALUES (${org.organizationId}, ${org.ownerId}, 'Tampered', 'task',
                ${ctx.sql.json({ filter: 'mine', organizationId: 'somebody-elses-org', limit: 5000 })},
                true, ${org.ownerId})`

      const views = await listSavedViews(ctx, actor, 'task')
      const tampered = views.find((view) => view.name === 'Tampered')
      expect(tampered?.query).toEqual({ filter: 'mine' })
    })
  })

  it('refuses a view with no question in it', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(saveView(ctx, actor, { name: 'Empty', entity: 'task', query: {} })).rejects.toThrow(
        ValidationError,
      )
    })
  })

  it('saving the same name twice replaces the question rather than duplicating the menu entry', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await saveView(ctx, actor, { name: 'My work', entity: 'task', query: { filter: 'mine' } })
      const views = await saveView(ctx, actor, {
        name: '  my WORK ',
        entity: 'task',
        query: { filter: 'overdue' },
      })

      const named = views.filter((view) => view.name.toLowerCase().trim() === 'my work')
      expect(named).toHaveLength(1)
      expect(named[0]!.query).toEqual({ filter: 'overdue' })
    })
  })
})

describe('a shared view is a question, not access', () => {
  it('is offered to a colleague, while a private one is not', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await saveView(ctx, actor, { name: 'Everything overdue', entity: 'task', query: { filter: 'overdue' }, shared: true })
      await saveView(ctx, actor, { name: 'Just for me', entity: 'task', query: { filter: 'blocked' } })
    })

    await withTenant(memberSession, async (ctx) => {
      const actor = await loadActor(ctx)
      const views = await listSavedViews(ctx, actor, 'task')
      const names = views.map((view) => view.name)
      expect(names).toContain('Everything overdue')
      expect(names).not.toContain('Just for me')
      expect(views.find((view) => view.name === 'Everything overdue')?.mine).toBe(false)
    })
  })

  it('belongs to whoever made it: a colleague cannot delete it', async () => {
    const [view] = await adminSql()<{ id: string }[]>`
      SELECT id FROM saved_views
      WHERE organization_id = ${org.organizationId} AND name = 'Everything overdue' AND deleted_at IS NULL`

    await withTenant(memberSession, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(deleteSavedView(ctx, actor, { id: view!.id })).rejects.toThrow(PermissionError)
    })

    const [still] = await adminSql()<{ count: string }[]>`
      SELECT count(*)::text AS count FROM saved_views WHERE id = ${view!.id} AND deleted_at IS NULL`
    expect(Number(still!.count)).toBe(1)
  })

  it('is invisible across tenants, and asking for one by id is a 404 rather than a 403', async () => {
    const [view] = await adminSql()<{ id: string }[]>`
      SELECT id FROM saved_views
      WHERE organization_id = ${org.organizationId} AND name = 'Everything overdue' AND deleted_at IS NULL`

    await withTenant(
      { organizationId: other.organizationId, userId: other.ownerId, timezone: 'Europe/London' },
      async (ctx) => {
        const actor = await loadActor(ctx)
        expect(await listSavedViews(ctx, actor, 'task')).toEqual([])
        await expect(deleteSavedView(ctx, actor, { id: view!.id })).rejects.toThrow(NotFoundError)
      },
    )
  })
})

describe('you may only follow what you can already read', () => {
  it('refuses a watch on a task the person cannot open, and says nothing about it existing', async () => {
    await withTenant(guestSession, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(watchTask(ctx, actor, privateTaskId)).rejects.toThrow(NotFoundError)
    })

    const [row] = await adminSql()<{ count: string }[]>`
      SELECT count(*)::text AS count FROM task_watchers
      WHERE task_id = ${privateTaskId} AND user_id = ${guestId} AND deleted_at IS NULL`
    expect(Number(row!.count)).toBe(0)
  })

  it('accepts one on a task they can, and following twice is still one row', async () => {
    await withTenant(guestSession, async (ctx) => {
      const actor = await loadActor(ctx)
      await watchTask(ctx, actor, sharedTaskId)
      const watchers = await watchTask(ctx, actor, sharedTaskId)
      expect(watchers.filter((row) => row.userId === guestId)).toHaveLength(1)
      expect(watchers.find((row) => row.userId === guestId)?.isYou).toBe(true)
    })
  })

  it('does not let a watch reach a row the reader could not otherwise see', async () => {
    await withTenant(guestSession, async (ctx) => {
      const actor = await loadActor(ctx)
      const { tasks } = await listTasks(ctx, actor, { watching: true })
      expect(tasks.map((task) => task.id)).toEqual([sharedTaskId])
    })
  })
})

describe('the fan-out', () => {
  it('tells followers about a material change and not about a description tidy-up', async () => {
    const before = await countTaskChanged(guestId)

    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await updateTask(ctx, actor, { id: sharedTaskId, description: 'Tidied up the wording.' })
    })
    expect(await countTaskChanged(guestId)).toBe(before)

    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await updateTask(ctx, actor, { id: sharedTaskId, status: 'in_progress' })
    })
    expect(await countTaskChanged(guestId)).toBe(before + 1)

    const [latest] = await adminSql()<{ title: string; body: string; url: string }[]>`
      SELECT title, body, url FROM notifications
      WHERE organization_id = ${org.organizationId} AND user_id = ${guestId} AND type = 'task_changed'
      ORDER BY created_at DESC LIMIT 1`
    expect(latest!.title).toContain('Rewrite the broker brief')
    expect(latest!.body).toContain('in_progress')
    expect(latest!.url).toBe(`/tasks/${sharedTaskId}`)
  })

  it('never tells the person who made the change', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await watchTask(ctx, actor, sharedTaskId)
      await updateTask(ctx, actor, { id: sharedTaskId, status: 'review' })
    })
    expect(await countTaskChanged(org.ownerId)).toBe(0)
  })

  it('goes quiet when the follower has lost the read the watch was made under', async () => {
    const before = await countTaskChanged(guestId)

    // The task leaves the guest's team. The watch row is untouched — this is the case where
    // a stored subscription would otherwise keep delivering.
    await withTenant(session, async (ctx) => {
      await ctx.sql`UPDATE tasks SET team_id = NULL WHERE id = ${sharedTaskId}`
      const actor = await loadActor(ctx)
      await updateTask(ctx, actor, { id: sharedTaskId, status: 'blocked', blockedReason: 'Waiting on the broker.' })
    })

    expect(await countTaskChanged(guestId)).toBe(before)
    const [row] = await adminSql()<{ count: string }[]>`
      SELECT count(*)::text AS count FROM task_watchers
      WHERE task_id = ${sharedTaskId} AND user_id = ${guestId} AND deleted_at IS NULL`
    expect(Number(row!.count)).toBe(1)
  })

  it('lets somebody stop following a task they can no longer open', async () => {
    await withTenant(guestSession, async (ctx) => {
      const actor = await loadActor(ctx)
      expect(await unwatchTask(ctx, actor, sharedTaskId)).toEqual([])
    })

    const [row] = await adminSql()<{ count: string }[]>`
      SELECT count(*)::text AS count FROM task_watchers
      WHERE task_id = ${sharedTaskId} AND user_id = ${guestId} AND deleted_at IS NULL`
    expect(Number(row!.count)).toBe(0)
  })
})

describe('the database refuses a watch that spans two organizations', () => {
  it('will not record one, whatever wrote it', async () => {
    await expect(
      adminSql()`
        INSERT INTO task_watchers (organization_id, task_id, user_id, is_demo)
        VALUES (${org.organizationId}, ${org.taskId}, ${other.ownerId}, true)`,
    ).rejects.toThrow(/same organization/)

    await expect(
      adminSql()`
        INSERT INTO task_watchers (organization_id, task_id, user_id, is_demo)
        VALUES (${org.organizationId}, ${other.taskId}, ${org.ownerId}, true)`,
    ).rejects.toThrow(/same organization/)
  })
})

describe('the watchers list', () => {
  it('is a 404 for somebody who cannot open the task, not a list of names', async () => {
    await withTenant(guestSession, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(taskWatchers(ctx, actor, privateTaskId)).rejects.toThrow(NotFoundError)
    })
  })
})
