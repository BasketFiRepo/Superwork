import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  addProjectMember,
  createTask,
  getProject,
  getTask,
  listProjects,
  listTasks,
  NotFoundError,
  PermissionError,
  personalRecord,
  projectRoster,
  removeProjectMember,
  updateTask,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * The project roster (§17, ADR 0032).
 *
 * `project_members` has existed since migration 0002, is written by the seed alone, and is
 * read by nothing — so being on a project was a row in a table and nothing else, while the
 * page answered "who is doing this?" with one chip naming the owner.
 *
 * Two decisions under test. **Being on a project lends a read of it and of the work inside
 * it, and nothing else** — the same rule a container share follows, for the same reason.
 * And **who owns a project is a property of the project**: the roster's owner row is
 * derived by the database, so the two statements of that fact cannot drift.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let guestSession: { organizationId: string; userId: string; timezone: string }
let memberSession: { organizationId: string; userId: string; timezone: string }
let guestId: string
let projectId: string
let secretProjectId: string
let insideId: string
let outsideId: string

beforeAll(async () => {
  org = await createTenant('project-roster')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
  memberSession = { organizationId: org.organizationId, userId: org.memberId, timezone: 'Europe/London' }

  // A guest holds nothing but team-scoped grants, so it is the role that shows whether
  // being on a project reaches anything at all.
  await adminSql()`DELETE FROM users WHERE lower(email) = 'guest.project-roster@fixture.example'`
  const [user] = await adminSql()<{ id: string }[]>`
    INSERT INTO users (email, name, timezone, is_demo)
    VALUES ('guest.project-roster@fixture.example', 'Guest Roster', 'Europe/London', true) RETURNING id`
  guestId = user!.id
  await adminSql()`
    INSERT INTO memberships (organization_id, user_id, role, is_demo)
    VALUES (${org.organizationId}, ${guestId}, 'guest', true)`
  guestSession = { organizationId: org.organizationId, userId: guestId, timezone: 'Europe/London' }

  await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const [project] = await ctx.sql<{ id: string }[]>`
      INSERT INTO projects (organization_id, name, status, sensitivity, owner_id, is_demo, created_by)
      VALUES (${org.organizationId}, 'Customs uplift', 'active', 'public', ${org.ownerId}, true, ${org.ownerId})
      RETURNING id`
    projectId = project!.id

    // Above a guest's ceiling, to prove a roster does not raise clearance.
    const [secret] = await ctx.sql<{ id: string }[]>`
      INSERT INTO projects (organization_id, name, status, sensitivity, owner_id, is_demo, created_by)
      VALUES (${org.organizationId}, 'Project Ravenscar', 'active', 'confidential', ${org.ownerId}, true, ${org.ownerId})
      RETURNING id`
    secretProjectId = secret!.id

    const inside = await createTask(ctx, actor, { title: 'Compare the brokers' })
    const outside = await createTask(ctx, actor, { title: 'Something else entirely' })
    insideId = inside.id
    outsideId = outside.id
    await ctx.sql`UPDATE tasks SET project_id = ${projectId} WHERE id = ${insideId}`
  })
})

afterAll(async () => {
  await destroyTenant('project-roster')
  await adminSql()`DELETE FROM users WHERE id = ${guestId}`
  await closePools()
})

describe('the owner is the project’s, not the roster’s', () => {
  it('puts the owner on the roster the moment the project exists', async () => {
    const roster = await withTenant(session, async (ctx) => projectRoster(ctx, await loadActor(ctx), projectId))
    expect(roster).toHaveLength(1)
    expect(roster[0]?.role).toBe('owner')
    expect(roster[0]?.derived).toBe(true)
  })

  it('follows the project when it changes hands, and leaves the old owner on it', async () => {
    // Two statements of one fact is what was wrong here. The database keeps the derived one
    // true rather than trusting whoever writes the other to remember.
    await withTenant(session, async (ctx) => {
      await ctx.sql`UPDATE projects SET owner_id = ${org.memberId} WHERE id = ${projectId}`
    })
    const roster = await withTenant(session, async (ctx) => projectRoster(ctx, await loadActor(ctx), projectId))
    expect(roster.find((row) => row.userId === org.memberId)?.role).toBe('owner')
    // Handing a project over does not take the previous owner off the work.
    expect(roster.find((row) => row.userId === org.ownerId)?.role).toBe('contributor')

    await withTenant(session, async (ctx) => {
      await ctx.sql`UPDATE projects SET owner_id = ${org.ownerId} WHERE id = ${projectId}`
    })
    const back = await withTenant(session, async (ctx) => projectRoster(ctx, await loadActor(ctx), projectId))
    expect(back.find((row) => row.userId === org.ownerId)?.role).toBe('owner')
  })

  it('refuses to make somebody the owner through the roster', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        addProjectMember(ctx, await loadActor(ctx), {
          projectId,
          userId: guestId,
          role: 'owner' as 'lead',
          reason: 'Trying to take the project.',
        }),
      ),
    ).rejects.toThrow(/property of the project/i)
  })

  it('refuses to take the owner off their own project', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        removeProjectMember(ctx, await loadActor(ctx), {
          projectId,
          userId: org.ownerId,
          reason: 'Trying to unstaff the owner.',
        }),
      ),
    ).rejects.toThrow(/cannot be taken off/i)
  })

  it('will not hold two owner rows for one project', async () => {
    await expect(
      adminSql()`
        INSERT INTO project_members (organization_id, project_id, user_id, role, is_demo)
        VALUES (${org.organizationId}, ${projectId}, ${guestId}, 'owner', true)`,
    ).rejects.toThrow(/project_members_one_owner|duplicate key/i)
  })
})

describe('being on a project lends a read of it and of its work', () => {
  it('shows a team-scoped role nothing until they are on it', async () => {
    const before = await withTenant(guestSession, async (ctx) => listProjects(ctx, await loadActor(ctx)))
    expect(before).toHaveLength(0)
    await expect(
      withTenant(guestSession, async (ctx) => getProject(ctx, await loadActor(ctx), projectId)),
    ).rejects.toThrow(PermissionError)
  })

  it('opens the project, and the work inside it, once they are', async () => {
    await withTenant(session, async (ctx) =>
      addProjectMember(ctx, await loadActor(ctx), {
        projectId,
        userId: guestId,
        role: 'contributor',
        reason: 'Doing the broker comparison with us.',
      }),
    )

    const seen = await withTenant(guestSession, async (ctx) => listProjects(ctx, await loadActor(ctx)))
    expect(seen.map((project) => project.id)).toEqual([projectId])

    const opened = await withTenant(guestSession, async (ctx) => getProject(ctx, await loadActor(ctx), projectId))
    expect(opened.id).toBe(projectId)

    // "You are on this project" and "you can see none of its tasks" cannot both be true.
    const tasks = await withTenant(guestSession, async (ctx) => listTasks(ctx, await loadActor(ctx), { limit: 50 }))
    expect(tasks.tasks.map((task) => task.id)).toContain(insideId)
    const task = await withTenant(guestSession, async (ctx) => getTask(ctx, await loadActor(ctx), insideId))
    expect(task.id).toBe(insideId)
  })

  it('says which of the two it was, because a roster is not a share', async () => {
    const decision = await withTenant(guestSession, async (ctx) => {
      const actor = await loadActor(ctx)
      const { can } = await import('@superwork/auth')
      return can(actor, 'project:read', {
        type: 'project',
        id: projectId,
        organizationId: ctx.organizationId,
        sensitivity: 'public',
      })
    })
    expect(decision.allow).toBe(true)
    expect(decision.reason).toMatch(/you are on this project/i)
  })

  it('lends no say over the project or the work', async () => {
    await expect(
      withTenant(guestSession, async (ctx) =>
        updateTask(ctx, await loadActor(ctx), { id: insideId, title: 'Renamed by somebody on the project' }),
      ),
    ).rejects.toThrow(PermissionError)

    await expect(
      withTenant(guestSession, async (ctx) =>
        addProjectMember(ctx, await loadActor(ctx), {
          projectId,
          userId: org.viewerId,
          role: 'contributor',
          reason: 'Bringing somebody else along.',
        }),
      ),
    ).rejects.toThrow(/say over the project/i)
  })

  it('reaches nothing outside the project', async () => {
    await expect(
      withTenant(guestSession, async (ctx) => getTask(ctx, await loadActor(ctx), outsideId)),
    ).rejects.toThrow(PermissionError)
  })

  it('does not raise anybody’s clearance', async () => {
    // A guest reads `public` and no further. Being put on a confidential project must not
    // change that — a locked door is not opened by being told to work behind it.
    await withTenant(session, async (ctx) =>
      addProjectMember(ctx, await loadActor(ctx), {
        projectId: secretProjectId,
        userId: guestId,
        role: 'reviewer',
        reason: 'Reviewing the parts they are cleared for.',
      }),
    )
    const seen = await withTenant(guestSession, async (ctx) => listProjects(ctx, await loadActor(ctx)))
    expect(seen.map((project) => project.id)).toEqual([projectId])
    await expect(
      withTenant(guestSession, async (ctx) => getProject(ctx, await loadActor(ctx), secretProjectId)),
    ).rejects.toThrow(PermissionError)
  })

  it('takes the read away again when they come off it', async () => {
    await withTenant(session, async (ctx) =>
      removeProjectMember(ctx, await loadActor(ctx), {
        projectId,
        userId: guestId,
        reason: 'The comparison is finished.',
      }),
    )
    const seen = await withTenant(guestSession, async (ctx) => listProjects(ctx, await loadActor(ctx)))
    expect(seen).toHaveLength(0)
    await expect(
      withTenant(guestSession, async (ctx) => getTask(ctx, await loadActor(ctx), insideId)),
    ).rejects.toThrow(PermissionError)
  })
})

describe('what the roster asks for, and what it records', () => {
  it('will not put somebody on a project without saying why', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        addProjectMember(ctx, await loadActor(ctx), { projectId, userId: guestId, reason: '   ' }),
      ),
    ).rejects.toThrow(ValidationError)
  })

  it('refuses somebody who is not in the organization', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        addProjectMember(ctx, await loadActor(ctx), {
          projectId,
          userId: '00000000-0000-0000-0000-000000000000',
          reason: 'Somebody who does not exist.',
        }),
      ),
    ).rejects.toThrow(/not a member of this organization/i)
  })

  it('counts one row per person however many times they are added', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await addProjectMember(ctx, actor, { projectId, userId: guestId, role: 'contributor', reason: 'First pass.' })
      await addProjectMember(ctx, actor, { projectId, userId: guestId, role: 'reviewer', reason: 'Reviewing instead.' })
    })
    const roster = await withTenant(session, async (ctx) => projectRoster(ctx, await loadActor(ctx), projectId))
    const rows = roster.filter((row) => row.userId === guestId)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.role).toBe('reviewer')
    expect(rows[0]?.reason).toBe('Reviewing instead.')
  })

  it('records who put them on it and why, in the audit trail', async () => {
    // Selected by what it says rather than by time: both adds above ran in one transaction,
    // and `now()` is the transaction's, so "the latest row" is not a thing here.
    const [entry] = await adminSql()<{ diff: Record<string, { to: unknown }>; actorId: string }[]>`
      SELECT diff, actor_id AS "actorId" FROM audit_logs
      WHERE organization_id = ${org.organizationId} AND action = 'project.member_added'
        AND diff -> 'reason' ->> 'to' = 'Reviewing instead.'`
    expect(entry?.diff['reason']?.to).toBe('Reviewing instead.')
    expect(entry?.diff['role']?.to).toBe('reviewer')
    expect(entry?.actorId).toBe(org.ownerId)
  })

  it('reports absence for a person who was never on it', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        removeProjectMember(ctx, await loadActor(ctx), {
          projectId,
          userId: org.viewerId,
          reason: 'They were never on it.',
        }),
      ),
    ).rejects.toThrow(NotFoundError)
  })

  it('tells the person themselves, on their own record', async () => {
    // Access somebody has that their own record does not mention is access nobody can
    // audit. The share list alone would answer "why can I see that?" incompletely.
    const record = await withTenant(guestSession, async (ctx) =>
      personalRecord(ctx, await loadActor(ctx), guestId),
    )
    expect(record.projects.map((project) => project.name)).toContain('Customs uplift')
    expect(record.projects.find((project) => project.name === 'Customs uplift')?.reason).toBe('Reviewing instead.')
  })
})

describe('a roster belongs to one organization', () => {
  it('refuses a row naming another tenant’s project', async () => {
    const other = await createTenant('project-roster-other')
    const [theirs] = await adminSql()<{ id: string }[]>`
      INSERT INTO projects (organization_id, name, status, owner_id, is_demo, created_by)
      VALUES (${other.organizationId}, 'Theirs', 'active', ${other.ownerId}, true, ${other.ownerId})
      RETURNING id`

    await expect(
      adminSql()`
        INSERT INTO project_members (organization_id, project_id, user_id, role, is_demo)
        VALUES (${org.organizationId}, ${theirs!.id}, ${org.ownerId}, 'contributor', true)`,
    ).rejects.toThrow(/same organization/i)

    await expect(
      adminSql()`
        INSERT INTO project_members (organization_id, project_id, user_id, role, is_demo)
        VALUES (${org.organizationId}, ${projectId}, ${other.ownerId}, 'contributor', true)`,
    ).rejects.toThrow(/member of the same organization/i)

    await destroyTenant('project-roster-other')
  })

  it('reports absence for another tenant’s project rather than refusal', async () => {
    const other = await createTenant('project-roster-absent')
    const [theirs] = await adminSql()<{ id: string }[]>`
      INSERT INTO projects (organization_id, name, status, owner_id, is_demo, created_by)
      VALUES (${other.organizationId}, 'Theirs', 'active', ${other.ownerId}, true, ${other.ownerId})
      RETURNING id`

    await expect(
      withTenant(session, async (ctx) => projectRoster(ctx, await loadActor(ctx), theirs!.id)),
    ).rejects.toThrow(NotFoundError)

    await destroyTenant('project-roster-absent')
  })
})
