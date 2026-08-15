import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { can, loadActor } from '@superwork/auth'
import {
  createTask,
  getProject,
  getTask,
  listProjects,
  listShares,
  listTasks,
  NotFoundError,
  PermissionError,
  share,
  shareableRelations,
  unshare,
  updateTask,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Sharing a project (§4.6, §17).
 *
 * A project tuple grants `project:read` through `can()`, which opens the project's page —
 * and nothing else. The tasks inside it are separate rows with their own scope, so without
 * a container rule "I shared the project with you" and "you can see none of its work" were
 * both true. That is the hole circulation lists had before ADR 0023, in a new place.
 *
 * The rule under test: a container share lends a read of what is inside, never a say over
 * it, and never more clearance than the recipient already had.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let memberSession: { organizationId: string; userId: string; timezone: string }
let guestSession: { organizationId: string; userId: string; timezone: string }
let guestId: string
let projectId: string
let secretProjectId: string
let projectTaskId: string
let looseTaskId: string

beforeAll(async () => {
  org = await createTenant('project-sharing')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
  memberSession = { organizationId: org.organizationId, userId: org.memberId, timezone: 'Europe/London' }

  // A guest: every grant it holds is team-scoped, so it is the role that shows whether a
  // share reaches anything at all.
  await adminSql()`DELETE FROM users WHERE lower(email) = 'guest.project-sharing@fixture.example'`
  const [user] = await adminSql()<{ id: string }[]>`
    INSERT INTO users (email, name, timezone, is_demo)
    VALUES ('guest.project-sharing@fixture.example', 'Guest Projects', 'Europe/London', true) RETURNING id`
  guestId = user!.id
  await adminSql()`
    INSERT INTO memberships (organization_id, user_id, role, is_demo)
    VALUES (${org.organizationId}, ${guestId}, 'guest', true)`
  guestSession = { organizationId: org.organizationId, userId: guestId, timezone: 'Europe/London' }

  await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const [project] = await ctx.sql<{ id: string }[]>`
      INSERT INTO projects (organization_id, name, status, sensitivity, owner_id, is_demo, created_by)
      VALUES (${org.organizationId}, 'Halden renewal', 'active', 'public', ${org.ownerId}, true, ${org.ownerId})
      RETURNING id`
    projectId = project!.id

    // Above a guest's ceiling, to prove a share does not raise clearance.
    const [secret] = await ctx.sql<{ id: string }[]>`
      INSERT INTO projects (organization_id, name, status, sensitivity, owner_id, is_demo, created_by)
      VALUES (${org.organizationId}, 'Project Ravenscar', 'active', 'confidential', ${org.ownerId}, true, ${org.ownerId})
      RETURNING id`
    secretProjectId = secret!.id

    const inside = await createTask(ctx, actor, { title: 'Draft the renewal terms' })
    const outside = await createTask(ctx, actor, { title: 'Something else entirely' })
    projectTaskId = inside.id
    looseTaskId = outside.id
    await ctx.sql`
      UPDATE tasks SET project_id = ${projectId} WHERE id = ${projectTaskId}`
  })
})

afterAll(async () => {
  await destroyTenant('project-sharing')
  await adminSql()`DELETE FROM users WHERE id = ${guestId}`
  await closePools()
})

describe('the project list is a permission check, not just RLS', () => {
  it('showed every project in the company to a team-scoped role', async () => {
    // The regression: the page ran a raw query gated on organization_id alone.
    const seen = await withTenant(guestSession, async (ctx) => listProjects(ctx, await loadActor(ctx)))
    expect(seen).toHaveLength(0)
  })

  it('still shows everything to a role whose grant is organization-wide', async () => {
    const seen = await withTenant(session, async (ctx) => listProjects(ctx, await loadActor(ctx)))
    expect(seen.map((project) => project.id).sort()).toEqual([projectId, secretProjectId].sort())
  })

  it('drops a project above the reader’s clearance rather than listing then refusing it', async () => {
    // Classification is per row, so it cannot ride in the scope predicate. The list and the
    // page have to agree about what exists.
    const seen = await withTenant(memberSession, async (ctx) => listProjects(ctx, await loadActor(ctx)))
    expect(seen.map((project) => project.id)).toEqual([projectId])
    await expect(
      withTenant(memberSession, async (ctx) => getProject(ctx, await loadActor(ctx), secretProjectId)),
    ).rejects.toThrow(PermissionError)
  })
})

describe('a share of a project reaches the work inside it', () => {
  it('gives a guest nothing before it is shared', async () => {
    const before = await withTenant(guestSession, async (ctx) => {
      const actor = await loadActor(ctx)
      return {
        project: await getProject(ctx, actor, projectId).then(() => true, () => false),
        tasks: (await listTasks(ctx, actor, { limit: 200 })).tasks.length,
      }
    })
    expect(before.project).toBe(false)
    expect(before.tasks).toBe(0)
  })

  it('opens the project and the tasks in it, in both the list and the row', async () => {
    await withTenant(session, async (ctx) =>
      share(ctx, await loadActor(ctx), {
        subjectType: 'user',
        subjectId: guestId,
        relation: 'viewer',
        objectType: 'project',
        objectId: projectId,
        reason: 'Reviewing the renewal with us.',
      }),
    )

    const after = await withTenant(guestSession, async (ctx) => {
      const actor = await loadActor(ctx)
      const listed = await listTasks(ctx, actor, { limit: 200 })
      return {
        projectName: (await getProject(ctx, actor, projectId)).name,
        listed: listed.tasks.map((task) => task.id),
        // The list and the page must agree: a task the list surfaces must open.
        opened: await getTask(ctx, actor, projectTaskId).then((task) => task.title, () => null),
      }
    })
    expect(after.projectName).toBe('Halden renewal')
    expect(after.listed).toEqual([projectTaskId])
    expect(after.opened).toBe('Draft the renewal terms')
  })

  it('reaches only what is actually inside it', async () => {
    await expect(
      withTenant(guestSession, async (ctx) => getTask(ctx, await loadActor(ctx), looseTaskId)),
    ).rejects.toThrow(PermissionError)
  })

  it('lends a read, never a say — the container grant does not carry update', async () => {
    // Refused twice over, deliberately: `updateTask` never passes the containers at all,
    // and the policy would refuse a container relation for any verb but read even if it
    // did. A container share is coarse — the set of rows inside it changes without the
    // granter looking — so it can never be the thing that authorises a write.
    await expect(
      withTenant(guestSession, async (ctx) =>
        updateTask(ctx, await loadActor(ctx), { id: projectTaskId, title: 'Renamed by an outsider' }),
      ),
    ).rejects.toThrow(PermissionError)

    const asOwner = await withTenant(guestSession, async (ctx) => {
      const actor = await loadActor(ctx)
      return can(actor, 'task:update', {
        type: 'task',
        id: projectTaskId,
        organizationId: ctx.organizationId,
        containers: [{ type: 'project', id: projectId }],
      })
    })
    expect(asOwner.allow).toBe(false)
  })

  it('does not raise the recipient’s clearance', async () => {
    // A guest reads up to `public`. Being handed a confidential project does not make them
    // cleared to read one — the classification check runs after the permission check.
    await withTenant(session, async (ctx) =>
      share(ctx, await loadActor(ctx), {
        subjectType: 'user',
        subjectId: guestId,
        relation: 'viewer',
        objectType: 'project',
        objectId: secretProjectId,
        reason: 'Should not be enough on its own.',
      }),
    )
    const refusal = await withTenant(guestSession, async (ctx) =>
      getProject(ctx, await loadActor(ctx), secretProjectId).then(
        () => null,
        (error: Error) => error.message,
      ),
    )
    expect(refusal).toMatch(/classified confidential/i)
  })

  it('does not reach inside a project it cannot open', async () => {
    // Found by the acceptance loop, not by this file: the project stayed shut and its tasks
    // opened anyway, because a task carries no classification of its own. A container the
    // recipient cannot open lends nothing — a locked door with the window left ajar.
    const insideId = await withTenant(session, async (ctx) => {
      const task = await createTask(ctx, await loadActor(ctx), { title: 'Inside the classified project' })
      await ctx.sql`UPDATE tasks SET project_id = ${secretProjectId} WHERE id = ${task.id}`
      return task.id
    })

    const reach = await withTenant(guestSession, async (ctx) => {
      const actor = await loadActor(ctx)
      return {
        listed: (await listTasks(ctx, actor, { limit: 200 })).tasks.map((task) => task.id),
        opened: await getTask(ctx, actor, insideId).then(() => true, () => false),
      }
    })
    expect(reach.listed).not.toContain(insideId)
    expect(reach.opened).toBe(false)
    // The share on the readable project still works, so this narrows nothing else.
    expect(reach.listed).toContain(projectTaskId)
  })
})

describe('what a person may hand on', () => {
  it('offers only the relations they could actually grant', async () => {
    const asOwner = await withTenant(session, async (ctx) =>
      shareableRelations(await loadActor(ctx), 'project', projectId, ctx.organizationId),
    )
    expect(asOwner).toEqual(['viewer', 'editor', 'approver', 'owner'])

    // A member holds `project:read:org` and no `project:update` — so exactly one relation,
    // rather than four buttons of which three are refused after the form is filled in.
    const asMember = await withTenant(memberSession, async (ctx) =>
      shareableRelations(await loadActor(ctx), 'project', projectId, ctx.organizationId),
    )
    expect(asMember).toEqual(['viewer'])
  })

  it('refuses a relation above what the granter holds', async () => {
    await expect(
      withTenant(memberSession, async (ctx) =>
        share(ctx, await loadActor(ctx), {
          subjectType: 'user',
          subjectId: org.viewerId,
          relation: 'editor',
          objectType: 'project',
          objectId: projectId,
          reason: 'Should not be possible.',
        }),
      ),
    ).rejects.toThrow(/only share something you can update yourself/i)
  })
})

describe('you can take back what you gave', () => {
  it('lets the granter revoke without holding update on the object', async () => {
    // A member can share a project as a viewer because they hold `project:read`. Requiring
    // `project:update` to undo it meant they could make a grant they could not withdraw.
    const tupleId = await withTenant(memberSession, async (ctx) => {
      const view = await share(ctx, await loadActor(ctx), {
        subjectType: 'user',
        subjectId: org.viewerId,
        relation: 'viewer',
        objectType: 'project',
        objectId: projectId,
        reason: 'Handing it on to somebody who needs a look.',
      })
      return view.id
    })

    await withTenant(memberSession, async (ctx) =>
      unshare(ctx, await loadActor(ctx), { objectType: 'project', objectId: projectId, tupleId }),
    )
    const remaining = await withTenant(session, async (ctx) =>
      listShares(ctx, await loadActor(ctx), 'project', projectId),
    )
    expect(remaining.map((entry) => entry.id)).not.toContain(tupleId)
  })

  it('will not let somebody revoke a grant that is neither theirs nor their object', async () => {
    const ownersGrant = await withTenant(session, async (ctx) =>
      listShares(ctx, await loadActor(ctx), 'project', projectId),
    )
    const target = ownersGrant.find((entry) => entry.grantedById === org.ownerId)
    expect(target).toBeDefined()
    await expect(
      withTenant(memberSession, async (ctx) =>
        unshare(ctx, await loadActor(ctx), {
          objectType: 'project',
          objectId: projectId,
          tupleId: target!.id,
        }),
      ),
    ).rejects.toThrow(/granted by somebody else/i)
  })

  it('marks each row with whether this reader may revoke it', async () => {
    const asOwner = await withTenant(session, async (ctx) =>
      listShares(ctx, await loadActor(ctx), 'project', projectId),
    )
    expect(asOwner.every((entry) => entry.canRevoke)).toBe(true)

    const asMember = await withTenant(memberSession, async (ctx) =>
      listShares(ctx, await loadActor(ctx), 'project', projectId),
    )
    // Everything here was granted by the owner and the member cannot update the project.
    expect(asMember.some((entry) => entry.canRevoke)).toBe(false)
  })
})

describe('a project belongs to one organization', () => {
  it('reports absence, never denial, across tenants', async () => {
    const other = await createTenant('project-sharing-other')
    const otherSession = { organizationId: other.organizationId, userId: other.ownerId, timezone: 'Europe/London' }

    await expect(
      withTenant(otherSession, async (ctx) => getProject(ctx, await loadActor(ctx), projectId)),
    ).rejects.toThrow(NotFoundError)

    const listed = await withTenant(otherSession, async (ctx) => listProjects(ctx, await loadActor(ctx)))
    expect(listed.map((project) => project.id)).not.toContain(projectId)

    await destroyTenant('project-sharing-other')
  })
})
