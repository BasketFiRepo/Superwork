import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { can, grantedScope, loadActor } from '@superwork/auth'
import {
  addTeamMember,
  archiveTeam,
  createTeam,
  createTask,
  getTask,
  hybridSearch,
  ingestDocument,
  getDocument,
  listDocuments,
  listTasks,
  listTeams,
  removeTeamMember,
  setTeamScope,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Teams (§4.3).
 *
 * `teams` and `team_members` were created in migration 0001 and never written to. The cost
 * was not two empty tables: the `team` scope in the policy engine had never evaluated true,
 * and every permission the `guest` role holds is team-scoped — so a guest could read
 * nothing at all, while the denial said "You need Member access", which reads like a
 * decision rather than a missing dimension.
 *
 * The headline assertion here is that the guest role now works, and works *only* for its
 * own team. The rest are the ways that could go wrong: a list gate that denies before any
 * row is considered, a search that disagrees with the detail view, a team disbanded out
 * from under the work that was scoped to it.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let guestSession: { organizationId: string; userId: string; timezone: string }
let guestId: string
let teamId: string
let teamTaskId: string
let otherTaskId: string
let teamDocId: string

beforeAll(async () => {
  org = await createTenant('teams')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }

  // A guest: the role whose every grant is team-scoped.
  await adminSql()`DELETE FROM users WHERE lower(email) = 'guest.teams@fixture.example'`
  const [user] = await adminSql()<{ id: string }[]>`
    INSERT INTO users (email, name, timezone, is_demo)
    VALUES ('guest.teams@fixture.example', 'Guest Teams', 'Europe/London', true) RETURNING id`
  guestId = user!.id
  await adminSql()`
    INSERT INTO memberships (organization_id, user_id, role, is_demo)
    VALUES (${org.organizationId}, ${guestId}, 'guest', true)`
  guestSession = { organizationId: org.organizationId, userId: guestId, timezone: 'Europe/London' }

  await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const team = await createTeam(ctx, actor, { name: 'Halden renewal', purpose: 'The 2026 renewal.' })
    teamId = team.id

    const scoped = await createTask(ctx, actor, { title: 'Draft the renewal terms' })
    const unscoped = await createTask(ctx, actor, { title: 'Something else entirely' })
    teamTaskId = scoped.id
    otherTaskId = unscoped.id
    // Through the product, which is what ADR 0064 built. This used to be raw SQL here
    // because there was no other way to put a value in the column.
    await setTeamScope(ctx, actor, {
      entity: 'task',
      id: teamTaskId,
      teamId,
      reason: 'The renewal terms are the team’s work.',
    })

    const [doc] = await ctx.sql<{ id: string }[]>`
      INSERT INTO documents (organization_id, title, doc_type, sensitivity, index_status, is_demo, created_by)
      VALUES (${ctx.organizationId}, 'Renewal briefing', 'policy', 'public', 'pending', true, ${org.ownerId})
      RETURNING id`
    teamDocId = doc!.id
    await setTeamScope(ctx, actor, {
      entity: 'document',
      id: teamDocId,
      teamId,
      reason: 'The briefing is for the renewal team.',
    })
    await ingestDocument(ctx, {
      documentId: teamDocId,
      title: 'Renewal briefing',
      docType: 'policy',
      body: '# Renewal\n\n## Terms\n\nThe quinoxaline renewal window closes in March.\n',
      sensitivityHint: 'public',
    })
  })
})

afterAll(async () => {
  // The tenant goes first: the guest's searches left rows referencing them, and those
  // cascade away with the organization rather than blocking the user delete.
  await destroyTenant('teams')
  await adminSql()`DELETE FROM users WHERE id = ${guestId}`
  await closePools()
})

describe('the role that could do nothing', () => {
  it('is refused everything while it belongs to no team', async () => {
    // Not a quirk of one call site: every grant the role holds is team-scoped, so with no
    // team the answer is no everywhere.
    const before = await withTenant(guestSession, async (ctx) => {
      const actor = await loadActor(ctx)
      expect(actor.teamIds).toHaveLength(0)
      return {
        tasks: await listTasks(ctx, actor).then((r) => r.tasks.length),
        documents: await listDocuments(ctx, actor).then((r) => r.length),
        one: await getTask(ctx, actor, teamTaskId).then(() => true, () => false),
      }
    })
    expect(before.tasks).toBe(0)
    expect(before.documents).toBe(0)
    expect(before.one).toBe(false)
  })

  it('still applies every other filter alongside the scope predicate', async () => {
    // The scope is interpolated as a nested fragment beside the status array, the search
    // term and the cursor. Composing those is where parameter binding goes wrong, and it
    // goes wrong as a malformed array literal at runtime rather than at compile time.
    for (const who of [session, guestSession]) {
      await expect(
        withTenant(who, async (ctx) =>
          listTasks(ctx, await loadActor(ctx), {
            status: ['backlog', 'todo', 'in_progress', 'waiting', 'blocked', 'review'],
            overdueOnly: true,
            search: 'the',
            limit: 50,
          }),
        ),
      ).resolves.toBeDefined()
    }
  })

  it('sees exactly its team’s work once it joins, and nothing else', async () => {
    await withTenant(session, async (ctx) =>
      addTeamMember(ctx, await loadActor(ctx), {
        teamId,
        userId: guestId,
        reason: 'Contractor on the renewal.',
      }),
    )

    const after = await withTenant(guestSession, async (ctx) => {
      const actor = await loadActor(ctx)
      // Membership is read fresh with the actor, so it takes effect on the next request.
      expect(actor.teamIds).toEqual([teamId])
      return {
        tasks: (await listTasks(ctx, actor)).tasks.map((task) => task.id),
        documents: (await listDocuments(ctx, actor)).map((doc) => doc.id),
        theirs: await getTask(ctx, actor, teamTaskId).then(() => true, () => false),
        notTheirs: await getTask(ctx, actor, otherTaskId).then(() => true, () => false),
        // `DocumentView` declared `teamId` and the select never fetched it, so this arrived
        // undefined and `getDocument` passed an empty `teamIds` — refusing the very row the
        // list had just shown. Listing a thing you cannot open is worse than not listing it.
        opensTheirDocument: await getDocument(ctx, actor, teamDocId).then((doc) => doc.teamId, () => null),
      }
    })

    expect(after.tasks).toEqual([teamTaskId])
    expect(after.documents).toEqual([teamDocId])
    expect(after.theirs).toBe(true)
    expect(after.opensTheirDocument).toBe(teamId)
    // The point of a scope is what it excludes.
    expect(after.notTheirs).toBe(false)
  })

  it('retrieves only its team’s documents, so search and the detail view agree', async () => {
    const found = await withTenant(guestSession, async (ctx) => {
      const result = await hybridSearch(ctx, await loadActor(ctx), 'quinoxaline renewal window')
      return result.chunks.map((chunk) => chunk.documentId)
    })
    expect(found).toContain(teamDocId)

    // Take the document out of the team: search must stop returning it at the same moment
    // `getDocument` starts refusing it, or the two are telling different stories.
    await withTenant(session, async (ctx) =>
      setTeamScope(ctx, await loadActor(ctx), {
        entity: 'document',
        id: teamDocId,
        teamId: null,
        reason: 'Checking that retrieval and the page agree.',
      }),
    )
    const afterward = await withTenant(guestSession, async (ctx) => {
      const result = await hybridSearch(ctx, await loadActor(ctx), 'quinoxaline renewal window')
      return {
        search: result.chunks.map((chunk) => chunk.documentId),
        list: (await listDocuments(ctx, await loadActor(ctx))).map((doc) => doc.id),
      }
    })
    expect(afterward.search).not.toContain(teamDocId)
    expect(afterward.list).not.toContain(teamDocId)
    await withTenant(session, async (ctx) =>
      setTeamScope(ctx, await loadActor(ctx), {
        entity: 'document',
        id: teamDocId,
        teamId,
        reason: 'Putting it back where it was.',
      }),
    )
  })

  it('loses it again when it leaves', async () => {
    await withTenant(session, async (ctx) =>
      removeTeamMember(ctx, await loadActor(ctx), {
        teamId,
        userId: guestId,
        reason: 'Contract finished.',
      }),
    )
    const after = await withTenant(guestSession, async (ctx) => {
      const actor = await loadActor(ctx)
      return (await listTasks(ctx, actor)).tasks.length
    })
    expect(after).toBe(0)
  })
})

describe('the scope itself', () => {
  it('is what a list asks about, rather than "may you read everything"', async () => {
    // The distinction this whole change rests on. `can()` at organization level answers
    // no for a guest; the scope answers "team", which a query can act on.
    const guest = await withTenant(guestSession, (ctx) => loadActor(ctx))
    expect(grantedScope(guest, 'task:read', 'task')).toBe('team')
    expect(can(guest, 'task:read', { type: 'task', organizationId: org.organizationId }).allow).toBe(false)

    const owner = await withTenant(session, (ctx) => loadActor(ctx))
    expect(grantedScope(owner, 'task:read', 'task')).toBe('org')
  })
})

describe('managing them', () => {
  it('refuses a second team with the same name', async () => {
    await expect(
      withTenant(session, async (ctx) => createTeam(ctx, await loadActor(ctx), { name: 'halden RENEWAL' })),
    ).rejects.toThrow(/already a team called/i)
  })

  it('will not add somebody without a reason, or somebody who is not a member here', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        addTeamMember(ctx, await loadActor(ctx), { teamId, userId: org.memberId, reason: 'x' }),
      ),
    ).rejects.toThrow(ValidationError)

    await expect(
      withTenant(session, async (ctx) =>
        addTeamMember(ctx, await loadActor(ctx), {
          teamId,
          userId: '00000000-0000-0000-0000-000000000000',
          reason: 'Should not be possible.',
        }),
      ),
    ).rejects.toThrow(/not a member of this organization/i)
  })

  it('refuses to disband a team while work is still scoped to it', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        archiveTeam(ctx, await loadActor(ctx), { teamId, reason: 'Renewal done.' }),
      ),
    ).rejects.toThrow(/still scoped to/i)

    // Move the work, then it disbands — and everybody who reached that work through the
    // team keeps a visible reason for losing it.
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await setTeamScope(ctx, actor, {
        entity: 'task',
        id: teamTaskId,
        teamId: null,
        reason: 'The renewal is finished.',
      })
      await setTeamScope(ctx, actor, {
        entity: 'document',
        id: teamDocId,
        teamId: null,
        reason: 'The renewal is finished.',
      })
    })
    await withTenant(session, async (ctx) =>
      archiveTeam(ctx, await loadActor(ctx), { teamId, reason: 'Renewal done, work reassigned.' }),
    )

    const left = await withTenant(session, async (ctx) => listTeams(ctx, await loadActor(ctx)))
    expect(left.some((team) => team.id === teamId)).toBe(false)
  })

  it('records every membership change in the audit trail', async () => {
    const actions = await adminSql()<{ action: string }[]>`
      SELECT DISTINCT action FROM audit_logs
      WHERE organization_id = ${org.organizationId} AND action LIKE 'team.%'`
    expect(actions.map((row) => row.action).sort()).toEqual([
      'team.archived',
      'team.created',
      'team.member_added',
      'team.member_removed',
    ])
  })
})
