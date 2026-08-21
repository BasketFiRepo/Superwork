import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  archiveTeam,
  addTeamMember,
  createProject,
  createTeam,
  getProject,
  listProjects,
  NotFoundError,
  PermissionError,
  setTeamScope,
  teamScope,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Work a team can hold (ADR 0064).
 *
 * Migration 0022 gave tasks, projects and documents a `team_id` because every grant the
 * `guest` role holds is team-scoped, then left two of the three columns with no writer in the
 * product. `projects.team_id` was written by nothing at all — so `project:read:team` matched
 * no row anybody could produce, and the Teams screen's project count could only be zero.
 *
 * The headline here is the project, because that is the one the product could never scope.
 * The rest are the ways it could go wrong: a team in another tenant, a team that has been
 * disbanded, a scope that grants nothing because nobody on the team reads that high.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let owner: { organizationId: string; userId: string; timezone: string }
let member: { organizationId: string; userId: string; timezone: string }
let guest: { organizationId: string; userId: string; timezone: string }
let guestId: string
let teamId: string
let publicProjectId: string
let internalProjectId: string

beforeAll(async () => {
  org = await createTenant('team-scope')
  owner = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  member = { organizationId: org.organizationId, userId: org.memberId, timezone: TZ }

  await adminSql()`DELETE FROM users WHERE lower(email) = 'guest.scope@fixture.example'`
  const [user] = await adminSql()<{ id: string }[]>`
    INSERT INTO users (email, name, timezone, is_demo)
    VALUES ('guest.scope@fixture.example', 'Guest Scope', ${TZ}, true) RETURNING id`
  guestId = user!.id
  await adminSql()`
    INSERT INTO memberships (organization_id, user_id, role, is_demo)
    VALUES (${org.organizationId}, ${guestId}, 'guest', true)`
  guest = { organizationId: org.organizationId, userId: guestId, timezone: TZ }

  await withTenant(owner, async (ctx) => {
    const actor = await loadActor(ctx)
    const team = await createTeam(ctx, actor, { name: 'Halden delivery', purpose: 'The 2026 build.' })
    teamId = team.id
    await addTeamMember(ctx, actor, {
      teamId,
      userId: guestId,
      reason: 'Contractor on the delivery.',
    })
    publicProjectId = (
      await createProject(ctx, actor, { name: 'Halden delivery plan', sensitivity: 'public' })
    ).id
    internalProjectId = (await createProject(ctx, actor, { name: 'Halden commercials' })).id
  })
})

afterAll(async () => {
  await destroyTenant('team-scope')
  await adminSql()`DELETE FROM users WHERE id = ${guestId}`
  await closePools()
})

describe('a project the product could never put in a team', () => {
  it('is invisible to a guest on the team, because the scope had nothing to match', async () => {
    const before = await withTenant(guest, async (ctx) => {
      const actor = await loadActor(ctx)
      expect(actor.teamIds).toEqual([teamId])
      return listProjects(ctx, actor).then((rows) => rows.map((row) => row.id))
    })
    expect(before).not.toContain(publicProjectId)
  })

  it('is theirs the moment somebody puts it in their team', async () => {
    const scoped = await withTenant(owner, async (ctx) =>
      setTeamScope(ctx, await loadActor(ctx), {
        entity: 'project',
        id: publicProjectId,
        teamId,
        reason: 'They are building it, so they should be able to see the plan.',
      }),
    )
    expect(scoped.teamId).toBe(teamId)
    expect(scoped.teamName).toBe('Halden delivery')

    const after = await withTenant(guest, async (ctx) => {
      const actor = await loadActor(ctx)
      return {
        list: await listProjects(ctx, actor).then((rows) => rows.map((row) => row.id)),
        opens: await getProject(ctx, actor, publicProjectId).then(() => true, () => false),
        // The point of a scope is what it excludes.
        other: await getProject(ctx, actor, internalProjectId).then(() => true, () => false),
      }
    })
    expect(after.list).toEqual([publicProjectId])
    expect(after.opens).toBe(true)
    expect(after.other).toBe(false)
  })

  it('says who put it there, what it reached, and why', async () => {
    const [entry] = await adminSql()<{ action: string; diff: Record<string, { from: unknown; to: unknown }> }[]>`
      SELECT action, diff FROM audit_logs
      WHERE organization_id = ${org.organizationId} AND entity_id = ${publicProjectId}
        AND action = 'work.team_scoped'
      ORDER BY occurred_at DESC LIMIT 1`
    expect(entry!.action).toBe('work.team_scoped')
    const diff = entry!.diff
    expect(diff.teamId).toEqual({ from: null, to: teamId })
    expect(diff.team!.to).toBe('Halden delivery')
    expect(diff.reason!.to).toMatch(/building it/)
    // A count of what the change is worth, not only that it happened.
    expect(diff.reaches!.to).toBe(1)
    expect(diff.cleared!.to).toBe(1)
  })
})

describe('a scope that would grant nothing', () => {
  /**
   * The contrast with ADR 0063, which refuses to hand a thread to one named person who could
   * not open it. A team roster changes, so the count is reported rather than the act refused —
   * but it is reported before the choice is made, not discovered later by nobody mentioning
   * the file.
   */
  it('is offered with the number of people it would actually reach', async () => {
    const view = await withTenant(owner, async (ctx) =>
      teamScope(ctx, await loadActor(ctx), 'project', internalProjectId),
    )
    const option = view.options.find((candidate) => candidate.id === teamId)!
    expect(view.sensitivity).toBe('internal')
    expect(option.memberCount).toBe(1)
    // A guest reads up to `public`, so the one person on this team cannot open an internal row.
    expect(option.clearedCount).toBe(0)
  })

  it('and the warning was true: scoping it changes nothing for them', async () => {
    await withTenant(owner, async (ctx) =>
      setTeamScope(ctx, await loadActor(ctx), {
        entity: 'project',
        id: internalProjectId,
        teamId,
        reason: 'Proving that the count meant what it said.',
      }),
    )
    const seen = await withTenant(guest, async (ctx) =>
      getProject(ctx, await loadActor(ctx), internalProjectId).then(() => true, () => false),
    )
    expect(seen).toBe(false)
  })

  it('is not offered at all to somebody who could not move it', async () => {
    const view = await withTenant(member, async (ctx) =>
      teamScope(ctx, await loadActor(ctx), 'project', publicProjectId),
    )
    expect(view.canScope).toBe(false)
    expect(view.refusal).not.toBeNull()
    expect(view.options).toEqual([])
    // Where it sits is part of reading it, and is still answered.
    expect(view.teamName).toBe('Halden delivery')
  })
})

describe('the team it names', () => {
  it('cannot belong to another organization, in the repository or by another door', async () => {
    const other = await createTenant('team-scope-other')
    try {
      const theirTeam = await withTenant(
        { organizationId: other.organizationId, userId: other.ownerId, timezone: TZ },
        async (ctx) => createTeam(ctx, await loadActor(ctx), { name: 'Somebody else’s team' }),
      )

      await withTenant(owner, async (ctx) => {
        const actor = await loadActor(ctx)
        await expect(
          setTeamScope(ctx, actor, {
            entity: 'project',
            id: publicProjectId,
            teamId: theirTeam.id,
            reason: 'This should not be possible.',
          }),
        ).rejects.toThrow(NotFoundError)
      })

      // A foreign key to `teams` says the team exists and nothing about which organization it
      // is in, so the trigger is what makes this true of every writer.
      await expect(
        adminSql()`
          UPDATE projects SET team_id = ${theirTeam.id}
          WHERE organization_id = ${org.organizationId} AND id = ${publicProjectId}`,
      ).rejects.toThrow(/live team in the same organization/i)
      await expect(
        adminSql()`
          UPDATE documents SET team_id = ${theirTeam.id}
          WHERE organization_id = ${org.organizationId} AND id = ${org.documentId}`,
      ).rejects.toThrow(/live team in the same organization/i)
      await expect(
        adminSql()`
          UPDATE tasks SET team_id = ${theirTeam.id}
          WHERE organization_id = ${org.organizationId} AND id = ${org.taskId}`,
      ).rejects.toThrow(/live team in the same organization/i)
    } finally {
      await destroyTenant('team-scope-other')
    }
  })

  it('cannot be one that has been disbanded', async () => {
    const gone = await withTenant(owner, async (ctx) => {
      const actor = await loadActor(ctx)
      const team = await createTeam(ctx, actor, { name: 'Disbanded already' })
      await archiveTeam(ctx, actor, { teamId: team.id, reason: 'Never got going.' })
      return team.id
    })

    await withTenant(owner, async (ctx) => {
      await expect(
        setTeamScope(ctx, await loadActor(ctx), {
          entity: 'project',
          id: publicProjectId,
          teamId: gone,
          reason: 'Should be refused.',
        }),
      ).rejects.toThrow(NotFoundError)
    })
    await expect(
      adminSql()`
        UPDATE projects SET team_id = ${gone}
        WHERE organization_id = ${org.organizationId} AND id = ${publicProjectId}`,
    ).rejects.toThrow(/live team in the same organization/i)
  })

  it('is another tenant’s 404, never their 403', async () => {
    const other = await createTenant('team-scope-other-2')
    try {
      const theirs = await withTenant(
        { organizationId: other.organizationId, userId: other.ownerId, timezone: TZ },
        async (ctx) => createProject(ctx, await loadActor(ctx), { name: 'Their own plan' }),
      )
      await withTenant(owner, async (ctx) => {
        await expect(
          setTeamScope(ctx, await loadActor(ctx), {
            entity: 'project',
            id: theirs.id,
            teamId,
            reason: 'Should not be findable.',
          }),
        ).rejects.toThrow(NotFoundError)
      })
    } finally {
      await destroyTenant('team-scope-other-2')
    }
  })
})

describe('what it asks for', () => {
  it('wants a reason, the same one asked for when a person joins a team', async () => {
    await withTenant(owner, async (ctx) => {
      await expect(
        setTeamScope(ctx, await loadActor(ctx), {
          entity: 'project',
          id: publicProjectId,
          teamId: null,
          reason: 'x',
        }),
      ).rejects.toThrow(ValidationError)
    })
  })

  it('refuses a change that is not one', async () => {
    await withTenant(owner, async (ctx) => {
      await expect(
        setTeamScope(ctx, await loadActor(ctx), {
          entity: 'project',
          id: publicProjectId,
          teamId,
          reason: 'It is already there.',
        }),
      ).rejects.toThrow(/already scoped to that team/i)
    })
  })

  it('is not something a reader may do, and the refusal says what it needs', async () => {
    await withTenant(member, async (ctx) => {
      await expect(
        setTeamScope(ctx, await loadActor(ctx), {
          entity: 'project',
          id: publicProjectId,
          teamId: null,
          reason: 'A member should not be able to do this.',
        }),
      ).rejects.toThrow(PermissionError)
      await expect(
        setTeamScope(ctx, await loadActor(ctx), {
          entity: 'project',
          id: publicProjectId,
          teamId: null,
          reason: 'A member should not be able to do this.',
        }),
      ).rejects.toThrow(/who can reach it/i)
    })
  })
})

describe('disbanding the team afterwards', () => {
  it('is refused while a project is still in it — a guard that could never fire before', async () => {
    await withTenant(owner, async (ctx) => {
      await expect(
        archiveTeam(ctx, await loadActor(ctx), { teamId, reason: 'Delivery finished.' }),
      ).rejects.toThrow(/2 things are still scoped to/i)
    })
  })

  it('goes through once the work is moved out, through the product', async () => {
    await withTenant(owner, async (ctx) => {
      const actor = await loadActor(ctx)
      for (const id of [publicProjectId, internalProjectId]) {
        await setTeamScope(ctx, actor, {
          entity: 'project',
          id,
          teamId: null,
          reason: 'Delivery finished, the work moves back to the department.',
        })
      }
      await archiveTeam(ctx, actor, { teamId, reason: 'Delivery finished, work moved.' })
    })

    const left = await withTenant(guest, async (ctx) =>
      listProjects(ctx, await loadActor(ctx)).then(
        (rows) => rows.length,
        () => 0,
      ),
    )
    expect(left).toBe(0)
  })
})
