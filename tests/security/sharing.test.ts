import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  addTeamMember,
  createTask,
  createTeam,
  getTask,
  listShares,
  listTasks,
  PermissionError,
  share,
  sharedWith,
  unshare,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Sharing, as relation tuples (§4.6).
 *
 * `share`, `unshare`, `listShares` and `sharedWith` were written in Phase 4 and reachable
 * from nothing but the acceptance loops — no route, no screen. Two features shipped on top
 * of them in the meantime: circulation lists union tuples into retrieval, and the scoped
 * task list unions shared rows into a narrow role's view. Both had a branch no user could
 * populate.
 *
 * What is asserted here is the part that makes a tuple safe: it only ever adds, it can
 * never grant more than the granter holds, it is answerable from both ends, and it stops
 * counting the moment it lapses.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let memberSession: { organizationId: string; userId: string; timezone: string }
let taskId: string

beforeAll(async () => {
  org = await createTenant('sharing')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
  memberSession = { organizationId: org.organizationId, userId: org.memberId, timezone: 'Europe/London' }
  taskId = await withTenant(session, async (ctx) => {
    const task = await createTask(ctx, await loadActor(ctx), { title: 'The shared thing' })
    return task.id
  })
})

afterAll(async () => {
  await destroyTenant('sharing')
  await closePools()
})

describe('a task can be shared at all', () => {
  it('was not in the shareable set, while the task list already looked for shared tasks', async () => {
    // The regression this guards: `listTasks` unions `sharedObjectIds(actor, 'task')` into
    // its scope predicate, and `ShareableType` did not include 'task', so that branch could
    // never match anything.
    const view = await withTenant(session, async (ctx) =>
      share(ctx, await loadActor(ctx), {
        subjectType: 'user',
        subjectId: org.viewerId,
        relation: 'viewer',
        objectType: 'task',
        objectId: taskId,
        reason: 'Covering while I am away.',
      }),
    )
    expect(view.objectType).toBe('task')
    // And the label resolves, so a list of shares is readable by a person.
    expect(view.objectLabel).toBe('The shared thing')
  })

  it('reaches the recipient through the scoped list, not only through can()', async () => {
    const viewerSession = { organizationId: org.organizationId, userId: org.viewerId, timezone: 'Europe/London' }
    const seen = await withTenant(viewerSession, async (ctx) => {
      const actor = await loadActor(ctx)
      return {
        one: await getTask(ctx, actor, taskId).then(() => true, () => false),
        listed: (await listTasks(ctx, actor, { limit: 200 })).tasks.some((task) => task.id === taskId),
      }
    })
    // A viewer holds task:read:org, so both would pass anyway — the point is that they agree.
    expect(seen.one).toBe(true)
    expect(seen.listed).toBe(true)
  })
})

describe('a tuple can never manufacture reach', () => {
  it('refuses to grant what the granter does not hold', async () => {
    // A member cannot update this task, so they cannot make somebody else an editor of it.
    await expect(
      withTenant(memberSession, async (ctx) =>
        share(ctx, await loadActor(ctx), {
          subjectType: 'user',
          subjectId: org.viewerId,
          relation: 'editor',
          objectType: 'task',
          objectId: taskId,
          reason: 'Should not be possible.',
        }),
      ),
    ).rejects.toThrow(/only share something you can update yourself/i)
  })
})

describe('answerable from both ends', () => {
  it('lists who an object is shared with, and what a person was given', async () => {
    const onObject = await withTenant(session, async (ctx) =>
      listShares(ctx, await loadActor(ctx), 'task', taskId),
    )
    expect(onObject).toHaveLength(1)
    expect(onObject[0]?.subjectName).toBeTruthy()
    expect(onObject[0]?.grantedByName).toBeTruthy()

    const viewerSession = { organizationId: org.organizationId, userId: org.viewerId, timezone: 'Europe/London' }
    const forPerson = await withTenant(viewerSession, async (ctx) =>
      sharedWith(ctx, await loadActor(ctx), org.viewerId),
    )
    expect(forPerson).toHaveLength(1)
    expect(forPerson[0]?.objectLabel).toBe('The shared thing')
    expect(forPerson[0]?.via).toBe('you')
  })

  it('includes what reaches somebody through a team, not only what names them', async () => {
    // `loadActor` has always resolved user, team and department tuples when it builds the
    // relation set. Listing only the direct ones answered "why can I see this?" wrongly.
    const teamId = await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const team = await createTeam(ctx, actor, { name: 'Sharing crew' })
      await addTeamMember(ctx, actor, { teamId: team.id, userId: org.memberId, reason: 'On the crew.' })
      await share(ctx, actor, {
        subjectType: 'team',
        subjectId: team.id,
        relation: 'viewer',
        objectType: 'task',
        objectId: taskId,
        reason: 'The whole crew needs it.',
      })
      return team.id
    })
    expect(teamId).toBeTruthy()

    const forMember = await withTenant(memberSession, async (ctx) =>
      sharedWith(ctx, await loadActor(ctx), org.memberId),
    )
    expect(forMember).toHaveLength(1)
    expect(forMember[0]?.via).toBe('team')
    expect(forMember[0]?.subjectName).toBe('Sharing crew')
  })

  it('will not show one person’s grants to another', async () => {
    await expect(
      withTenant(memberSession, async (ctx) => sharedWith(ctx, await loadActor(ctx), org.viewerId)),
    ).rejects.toThrow(PermissionError)
  })
})

describe('lapsing and revoking', () => {
  it('stops counting when it expires, without being deleted', async () => {
    const [tuple] = await adminSql()<{ id: string }[]>`
      SELECT id FROM relation_tuples
      WHERE organization_id = ${org.organizationId} AND subject_type = 'user'
        AND subject_id = ${org.viewerId} AND deleted_at IS NULL`
    await adminSql()`
      UPDATE relation_tuples SET expires_at = now() - interval '1 day' WHERE id = ${tuple!.id}`

    const viewerSession = { organizationId: org.organizationId, userId: org.viewerId, timezone: 'Europe/London' }
    const after = await withTenant(viewerSession, async (ctx) => {
      const actor = await loadActor(ctx)
      return {
        relations: actor.relations?.size ?? 0,
        given: await sharedWith(ctx, actor, org.viewerId),
      }
    })
    // The actor no longer carries it, so `can()` cannot be satisfied by it.
    expect(after.relations).toBe(0)
    expect(after.given).toHaveLength(0)

    // But it is still on the object's list, marked — "they lost it on Tuesday" stays
    // answerable, which a delete would have destroyed.
    const onObject = await withTenant(session, async (ctx) =>
      listShares(ctx, await loadActor(ctx), 'task', taskId),
    )
    const lapsed = onObject.find((entry) => entry.id === tuple!.id)
    expect(lapsed).toBeDefined()
    expect(lapsed!.expired).toBe(true)
  })

  it('revokes, and records both the grant and the revocation', async () => {
    const before = await withTenant(session, async (ctx) => listShares(ctx, await loadActor(ctx), 'task', taskId))
    await withTenant(session, async (ctx) =>
      unshare(ctx, await loadActor(ctx), { objectType: 'task', objectId: taskId, tupleId: before[0]!.id }),
    )
    const after = await withTenant(session, async (ctx) => listShares(ctx, await loadActor(ctx), 'task', taskId))
    expect(after).toHaveLength(before.length - 1)

    const actions = await adminSql()<{ action: string }[]>`
      SELECT DISTINCT action FROM audit_logs
      WHERE organization_id = ${org.organizationId} AND action LIKE 'sharing.%'`
    expect(actions.map((row) => row.action).sort()).toEqual(['sharing.granted', 'sharing.revoked'])
  })
})

describe('a share belongs to one organization', () => {
  it('does not reach across tenants', async () => {
    const other = await createTenant('sharing-other')
    const otherSession = { organizationId: other.organizationId, userId: other.ownerId, timezone: 'Europe/London' }

    // Cross-tenant reads report absence, never denial (§3.2) — for a list, absence is an
    // empty list rather than a throw, and the property that matters is that nothing leaks.
    const across = await withTenant(otherSession, async (ctx) =>
      listShares(ctx, await loadActor(ctx), 'task', taskId),
    )
    expect(across).toHaveLength(0)

    const theirs = await withTenant(otherSession, async (ctx) =>
      sharedWith(ctx, await loadActor(ctx), other.ownerId),
    )
    expect(theirs).toHaveLength(0)

    await destroyTenant('sharing-other')
  })
})
