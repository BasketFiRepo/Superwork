import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import { listInteractions, logInteraction, updateTask } from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Two narrower grants the broader one had been answering for (ADR 0080).
 *
 * Both were found by `scripts/permission-coverage.ts`, which asks the audit-log question one
 * layer up: which permissions does the ladder grant that nothing ever checks? A grant that is
 * never checked is not merely unimplemented — it has never been evaluated, so nobody has ever
 * seen whether it says what the list implies.
 *
 *   * `note:read:org` starts at member. Reading a company's notes rode in on `company:read:org`,
 *     which a **viewer** holds — and the demo's viewer is a board observer.
 *   * `task:complete:own` has been in the member's list since the ladder was built. Completion
 *     arrived as `status = 'completed'` through an ordinary update, so `task:update:team`
 *     answered for it and a member could close a teammate's work.
 *
 * Same shape both times: a specific grant sitting underneath a broader one, where the broader
 * one is what the code actually asks about.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let owner: { organizationId: string; userId: string; timezone: string }
let member: { organizationId: string; userId: string; timezone: string }
let viewer: { organizationId: string; userId: string; timezone: string }
/** A second member, on the same team as the task but not assigned it. */
let teammate: { organizationId: string; userId: string; timezone: string }
let teamTaskId: string

beforeAll(async () => {
  org = await createTenant('narrower-grant')
  owner = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  member = { organizationId: org.organizationId, userId: org.memberId, timezone: TZ }
  viewer = { organizationId: org.organizationId, userId: org.viewerId, timezone: TZ }

  const sql = adminSql()
  // Cleared first, the way `createTenant` clears its own: a run that dies before teardown must
  // not make every run after it fail on a unique email.
  await sql`DELETE FROM users WHERE email = 'teammate.narrower-grant@fixture.example'`
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, name, password_hash, timezone, is_demo)
    VALUES ('teammate.narrower-grant@fixture.example', 'Teammate', 'x', ${TZ}, true) RETURNING id`
  await sql`
    INSERT INTO memberships (organization_id, user_id, role, is_demo)
    VALUES (${org.organizationId}, ${user!.id}, 'member', true)`
  teammate = { organizationId: org.organizationId, userId: user!.id, timezone: TZ }

  await withTenant(owner, async (ctx) => {
    const [team] = await ctx.sql<{ id: string }[]>`
      INSERT INTO teams (organization_id, name, is_demo, created_by)
      VALUES (${org.organizationId}, 'Narrower Grant Team', true, ${org.ownerId}) RETURNING id`
    for (const userId of [org.memberId, teammate.userId]) {
      await ctx.sql`
        INSERT INTO team_members (organization_id, team_id, user_id, is_demo, created_by)
        VALUES (${org.organizationId}, ${team!.id}, ${userId}, true, ${org.ownerId})`
    }
    // Assigned to the member, on a team the teammate is also on. So `task:update:team` reaches
    // it for both of them, and `task:complete:own` reaches it for only one.
    const [task] = await ctx.sql<{ id: string }[]>`
      INSERT INTO tasks (organization_id, title, status, priority, assignee_id, team_id, is_demo, created_by)
      VALUES (${org.organizationId}, 'Team task', 'todo', 'medium', ${org.memberId}, ${team!.id}, true, ${org.ownerId})
      RETURNING id`
    teamTaskId = task!.id

    await logInteraction(ctx, await loadActor(ctx), {
      companyId: org.companyId,
      kind: 'call',
      summary: 'They are unhappy about the March invoice and want a call with the board.',
    })
  })
})

afterAll(async () => {
  // The organization first: the teammate has activity rows that reference them, and those go
  // when the organization does.
  await destroyTenant('narrower-grant')
  await adminSql()`DELETE FROM users WHERE email = 'teammate.narrower-grant@fixture.example'`
  await closePools()
})

describe('what was said on the calls', () => {
  it('a member may read it, which is what the ladder has always said', async () => {
    const notes = await withTenant(member, async (ctx) =>
      listInteractions(ctx, await loadActor(ctx), org.companyId, 10),
    )
    expect(notes.length).toBeGreaterThan(0)
    expect(notes.some((note) => /March invoice/.test(note.summary))).toBe(true)
  })

  it('and a viewer may not, though they can see the company it is about', async () => {
    await expect(
      withTenant(viewer, async (ctx) => listInteractions(ctx, await loadActor(ctx), org.companyId, 10)),
    ).rejects.toThrow(/Member access/i)
  })

  it('and the refusal is about the notes, not about the company', async () => {
    // The distinction the ladder draws: you may see that we have this customer; you may not
    // read what was said to them. A refusal that talked about the company would describe a
    // different product from the one this is.
    const refusal = await withTenant(viewer, async (ctx) =>
      listInteractions(ctx, await loadActor(ctx), org.companyId, 10).then(
        () => '',
        (error: Error) => error.message,
      ),
    )
    expect(refusal).toMatch(/note/i)
    expect(refusal).not.toMatch(/company/i)
  })

  it('and never across a tenant boundary', async () => {
    const other = await createTenant('narrower-grant-b')
    try {
      await expect(
        withTenant(
          { organizationId: other.organizationId, userId: other.ownerId, timezone: TZ },
          async (ctx) => listInteractions(ctx, await loadActor(ctx), org.companyId, 10),
        ),
      ).resolves.toHaveLength(0)
    } finally {
      await destroyTenant('narrower-grant-b')
    }
  })
})

describe('closing somebody else’s work', () => {
  it('the person it is assigned to may complete it', async () => {
    const done = await withTenant(member, async (ctx) =>
      updateTask(ctx, await loadActor(ctx), { id: teamTaskId, status: 'completed' }),
    )
    expect(done.status).toBe('completed')
  })

  it('but a teammate may not, even though they may edit it', async () => {
    const [task] = await withTenant(owner, async (ctx) => {
      return ctx.sql<{ id: string }[]>`
        INSERT INTO tasks (organization_id, title, status, priority, assignee_id, team_id, is_demo, created_by)
        VALUES (${org.organizationId}, 'Second team task', 'todo', 'medium', ${org.memberId},
                (SELECT team_id FROM tasks WHERE id = ${teamTaskId}), true, ${org.ownerId})
        RETURNING id`
    })

    // The edit goes through, which is the whole point: the two are not the same act, and until
    // this ADR the product had only ever asked about the first one.
    const edited = await withTenant(teammate, async (ctx) =>
      updateTask(ctx, await loadActor(ctx), { id: task!.id, title: 'Second team task, renamed' }),
    )
    expect(edited.title).toBe('Second team task, renamed')

    await expect(
      withTenant(teammate, async (ctx) =>
        updateTask(ctx, await loadActor(ctx), { id: task!.id, status: 'completed' }),
      ),
    ).rejects.toThrow()
  })

  it('and the owner may, because a rung above never loses what one below has', async () => {
    const [task] = await withTenant(owner, async (ctx) => {
      return ctx.sql<{ id: string }[]>`
        INSERT INTO tasks (organization_id, title, status, priority, assignee_id, is_demo, created_by)
        VALUES (${org.organizationId}, 'Owner closes it', 'todo', 'medium', ${org.memberId}, true, ${org.ownerId})
        RETURNING id`
    })
    const done = await withTenant(owner, async (ctx) =>
      updateTask(ctx, await loadActor(ctx), { id: task!.id, status: 'completed' }),
    )
    expect(done.status).toBe('completed')
  })

  it('and re-saving an already-completed task is still an edit, not a second completion', async () => {
    /**
     * The check is on the transition and not on the state, which matters more than it looks:
     * a teammate tidying the title of finished work is editing, and refusing that would make
     * the completed half of the board read-only to everybody but the assignee.
     */
    const renamed = await withTenant(teammate, async (ctx) =>
      updateTask(ctx, await loadActor(ctx), {
        id: teamTaskId,
        status: 'completed',
        title: 'Team task, tidied after the fact',
      }),
    )
    expect(renamed.title).toBe('Team task, tidied after the fact')
  })
})

describe('the instrument that found them', () => {
  it('reads a permission out of a tool declaration, because that becomes a check too', async () => {
    /**
     * `email:draft` was reported as granted-and-unchecked on the detector's first run. It is
     * checked — by every tool declaring `requiredPermissions: ['email:draft:org']`, which the
     * registry and the gate both turn into a `can()` call built out of the array. A detector
     * that only read `can()` call sites would have sent somebody to build a control that was
     * already there.
     */
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../scripts/permission-coverage.ts', import.meta.url), 'utf8'),
    )
    expect(source).toMatch(/requiredPermissions/)
  })

  it('and does not read one out of a comment', async () => {
    /**
     * It did, on the first run: `sharing.ts` carries a comment explaining that
     * `can(actor, 'knowledge_space:read')` used to match no grant, and the detector recorded
     * the explanation as the check. Asserted against the real file rather than a synthetic
     * string, because a synthetic one would pass with the stripper deleted.
     */
    const { withoutComments } = await import('../../scripts/permission-coverage.js')
    const sharing = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../packages/core/src/repositories/sharing.ts', import.meta.url), 'utf8'),
    )
    expect(sharing).toMatch(/'knowledge_space:read'/)
    expect(withoutComments(sharing)).not.toMatch(/'knowledge_space:read'/)
  })
})
