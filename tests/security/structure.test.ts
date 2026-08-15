import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  addMilestone,
  archiveDepartment,
  archiveSpace,
  computeProjectHealth,
  createDepartment,
  createSpace,
  listDepartments,
  listSpaces,
  NotFoundError,
  PermissionError,
  projectMilestones,
  removeMilestone,
  rescheduleMilestone,
  setMilestoneStatus,
  updateDepartment,
  updateSpace,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Three things the product showed and could not create (§4.3, §8.1, §17).
 *
 * `departments` is one of the four permission scopes, routes the queue's fair share and
 * scopes agent grants. `milestones` are on every project page and counted in the health
 * score. `knowledge_spaces` are listed, shared, filed into and cited. All three were written
 * by the seed and by nothing else.
 *
 * The department tree's `path` and `depth` are derived, and the seed wrote them by hand.
 * They are the database's now: a move rewrites everything underneath, because a path that is
 * stale one level down is worse than no path at all.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let memberSession: { organizationId: string; userId: string; timezone: string }
let managerSession: { organizationId: string; userId: string; timezone: string }
let managerId: string
let managerDepartmentId: string
let projectId: string

beforeAll(async () => {
  org = await createTenant('structure')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
  memberSession = { organizationId: org.organizationId, userId: org.memberId, timezone: 'Europe/London' }

  // A manager: the role whose clearance stops at `confidential`, which is what makes the
  // "you cannot open it yourself" refusal testable at all.
  await adminSql()`DELETE FROM users WHERE lower(email) = 'manager.structure@fixture.example'`
  const [manager] = await adminSql()<{ id: string }[]>`
    INSERT INTO users (email, name, timezone, is_demo)
    VALUES ('manager.structure@fixture.example', 'Manager Structure', 'Europe/London', true) RETURNING id`
  managerId = manager!.id
  const [department] = await adminSql()<{ id: string }[]>`
    INSERT INTO departments (organization_id, name, timezone, is_demo)
    VALUES (${org.organizationId}, 'Managed', 'Europe/London', true) RETURNING id`
  managerDepartmentId = department!.id
  await adminSql()`
    INSERT INTO memberships (organization_id, user_id, role, department_id, is_demo)
    VALUES (${org.organizationId}, ${managerId}, 'manager', ${managerDepartmentId}, true)`
  managerSession = { organizationId: org.organizationId, userId: managerId, timezone: 'Europe/London' }

  await withTenant(session, async (ctx) => {
    const [project] = await ctx.sql<{ id: string }[]>`
      INSERT INTO projects (organization_id, name, status, sensitivity, owner_id, is_demo, created_by)
      VALUES (${org.organizationId}, 'Customs uplift', 'active', 'public', ${org.ownerId}, true, ${org.ownerId})
      RETURNING id`
    projectId = project!.id
  })
})

afterAll(async () => {
  await destroyTenant('structure')
  await adminSql()`DELETE FROM users WHERE id = ${managerId}`
  await closePools()
})

describe('a department tree that can be built', () => {
  it('creates one, and the database writes its path', async () => {
    const after = await withTenant(session, async (ctx) =>
      createDepartment(ctx, await loadActor(ctx), { name: 'Operations' }),
    )
    const operations = after.find((row) => row.name === 'Operations')
    expect(operations?.path).toBe('Operations')
    expect(operations?.depth).toBe(0)
  })

  it('nests one, and the path says where it sits', async () => {
    const parentId = (await withTenant(session, async (ctx) => listDepartments(ctx, await loadActor(ctx))))
      .find((row) => row.name === 'Operations')!.id
    const after = await withTenant(session, async (ctx) =>
      createDepartment(ctx, await loadActor(ctx), { name: 'Customs', parentId }),
    )
    const customs = after.find((row) => row.name === 'Customs')
    expect(customs?.path).toBe('Operations / Customs')
    expect(customs?.depth).toBe(1)
  })

  it('rewrites everything underneath when the parent is renamed', async () => {
    // The seed wrote `path` by hand and nothing kept it true, so a rename would have left the
    // tree describing where things used to be.
    const operations = (await withTenant(session, async (ctx) => listDepartments(ctx, await loadActor(ctx))))
      .find((row) => row.name === 'Operations')!
    const after = await withTenant(session, async (ctx) =>
      updateDepartment(ctx, await loadActor(ctx), { id: operations.id, name: 'Ops' }),
    )
    expect(after.find((row) => row.name === 'Customs')?.path).toBe('Ops / Customs')
  })

  it('refuses to put a department underneath itself', async () => {
    const departments = await withTenant(session, async (ctx) => listDepartments(ctx, await loadActor(ctx)))
    const parent = departments.find((row) => row.name === 'Ops')!
    const child = departments.find((row) => row.name === 'Customs')!
    await expect(
      withTenant(session, async (ctx) =>
        updateDepartment(ctx, await loadActor(ctx), { id: parent.id, parentId: child.id }),
      ),
    ).rejects.toThrow(/underneath itself/i)
  })

  it('refuses two departments with the same name in the same place', async () => {
    await expect(
      withTenant(session, async (ctx) => createDepartment(ctx, await loadActor(ctx), { name: 'ops' })),
    ).rejects.toThrow(/already a department with that name/i)
  })

  it('refuses a name with a slash in it, because the path uses one', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        createDepartment(ctx, await loadActor(ctx), { name: 'Ops / Customs' }),
      ),
    ).rejects.toThrow(ValidationError)
  })

  it('will not archive one with anything still in it, and says what', async () => {
    const departments = await withTenant(session, async (ctx) => listDepartments(ctx, await loadActor(ctx)))
    const parent = departments.find((row) => row.name === 'Ops')!
    await expect(
      withTenant(session, async (ctx) =>
        archiveDepartment(ctx, await loadActor(ctx), { id: parent.id, reason: 'Reorganising.' }),
      ),
    ).rejects.toThrow(/1 sub-departments/i)
  })

  it('archives an empty one', async () => {
    const departments = await withTenant(session, async (ctx) => listDepartments(ctx, await loadActor(ctx)))
    const child = departments.find((row) => row.name === 'Customs')!
    const after = await withTenant(session, async (ctx) =>
      archiveDepartment(ctx, await loadActor(ctx), { id: child.id, reason: 'Folded into Ops.' }),
    )
    expect(after.some((row) => row.name === 'Customs')).toBe(false)
  })

  it('is refused to somebody who does not run the org structure', async () => {
    await expect(
      withTenant(memberSession, async (ctx) =>
        createDepartment(ctx, await loadActor(ctx), { name: 'Shadow department' }),
      ),
    ).rejects.toThrow(PermissionError)
  })

  it('refuses a parent in another organization', async () => {
    const other = await createTenant('structure-other')
    const [theirs] = await adminSql()<{ id: string }[]>`
      INSERT INTO departments (organization_id, name, path, depth, timezone, is_demo)
      VALUES (${other.organizationId}, 'Theirs', 'Theirs', 0, 'Europe/London', true) RETURNING id`
    await expect(
      withTenant(session, async (ctx) =>
        createDepartment(ctx, await loadActor(ctx), { name: 'Smuggled', parentId: theirs!.id }),
      ),
    ).rejects.toThrow(/same organization/i)
    await destroyTenant('structure-other')
  })
})

describe('milestones a project can actually gain', () => {
  it('adds one, and the health score sees it', async () => {
    const before = await withTenant(session, async (ctx) => computeProjectHealth(ctx, projectId))
    await withTenant(session, async (ctx) =>
      addMilestone(ctx, await loadActor(ctx), {
        projectId,
        name: 'Broker decision',
        dueOn: new Date(Date.now() - 86_400_000),
      }),
    )
    const after = await withTenant(session, async (ctx) => computeProjectHealth(ctx, projectId))
    // A milestone past its date costs the score; that is the point of setting one.
    expect(after.score).toBeLessThan(before.score)
  })

  it('marks the date it was reached, which nothing recorded before', async () => {
    const [milestone] = await withTenant(session, async (ctx) => projectMilestones(ctx, projectId))
    const after = await withTenant(session, async (ctx) =>
      setMilestoneStatus(ctx, await loadActor(ctx), {
        projectId,
        milestoneId: milestone!.id,
        status: 'done',
      }),
    )
    expect(after[0]?.status).toBe('done')
    const [row] = await adminSql()<{ completedAt: Date | null; completedBy: string | null }[]>`
      SELECT completed_at AS "completedAt", completed_by AS "completedBy" FROM milestones
      WHERE id = ${milestone!.id}`
    expect(row?.completedAt).not.toBeNull()
    expect(row?.completedBy).toBe(org.ownerId)
  })

  it('clears the completion when it goes back to open', async () => {
    const [milestone] = await withTenant(session, async (ctx) => projectMilestones(ctx, projectId))
    await withTenant(session, async (ctx) =>
      setMilestoneStatus(ctx, await loadActor(ctx), {
        projectId,
        milestoneId: milestone!.id,
        status: 'open',
      }),
    )
    const [row] = await adminSql()<{ completedAt: Date | null }[]>`
      SELECT completed_at AS "completedAt" FROM milestones WHERE id = ${milestone!.id}`
    expect(row?.completedAt).toBeNull()
  })

  it('moves the date', async () => {
    const [milestone] = await withTenant(session, async (ctx) => projectMilestones(ctx, projectId))
    const target = new Date(Date.now() + 30 * 86_400_000)
    const after = await withTenant(session, async (ctx) =>
      rescheduleMilestone(ctx, await loadActor(ctx), {
        projectId,
        milestoneId: milestone!.id,
        dueOn: target,
      }),
    )
    expect(after[0]?.late).toBe(false)
  })

  it('refuses two milestones with the same name on one project', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        addMilestone(ctx, await loadActor(ctx), { projectId, name: 'broker decision', dueOn: null }),
      ),
    ).rejects.toThrow(/already has a milestone with that name/i)
  })

  it('needs a say over the project, not just a read of it', async () => {
    await expect(
      withTenant(memberSession, async (ctx) =>
        addMilestone(ctx, await loadActor(ctx), { projectId, name: 'Sneaked in', dueOn: null }),
      ),
    ).rejects.toThrow(/say over the project/i)
  })

  it('reports absence for a milestone on another project', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        removeMilestone(ctx, await loadActor(ctx), {
          projectId,
          milestoneId: '00000000-0000-0000-0000-000000000000',
        }),
      ),
    ).rejects.toThrow(NotFoundError)
  })
})

describe('shelves that can be made', () => {
  it('creates one with a slug a link can carry', async () => {
    const after = await withTenant(session, async (ctx) =>
      createSpace(ctx, await loadActor(ctx), {
        name: 'Customs procedures',
        description: 'Everything the broker asks for.',
      }),
    )
    const space = after.find((row) => row.name === 'Customs procedures')
    expect(space?.slug).toBe('customs-procedures')
    expect(space?.documentCount).toBe(0)
  })

  it('refuses a second shelf with the same name', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        createSpace(ctx, await loadActor(ctx), { name: 'customs procedures' }),
      ),
    ).rejects.toThrow(/already a space with that name/i)
  })

  it('will not default documents above what the person can read themselves', async () => {
    // A manager reads up to `confidential`. A shelf that started its documents at
    // `restricted` would be one they could make and never open.
    await expect(
      withTenant(managerSession, async (ctx) =>
        createSpace(ctx, await loadActor(ctx), {
          name: 'Board papers',
          defaultSensitivity: 'restricted',
          departmentId: managerDepartmentId,
        }),
      ),
    ).rejects.toThrow(/could not open yourself/i)
  })

  it('renames one, and the slug follows', async () => {
    const spaces = await withTenant(session, async (ctx) => listSpaces(ctx, await loadActor(ctx)))
    const space = spaces.find((row) => row.name === 'Customs procedures')!
    const after = await withTenant(session, async (ctx) =>
      updateSpace(ctx, await loadActor(ctx), { id: space.id, name: 'Customs paperwork' }),
    )
    expect(after.find((row) => row.id === space.id)?.slug).toBe('customs-paperwork')
  })

  it('will not archive a shelf with documents still on it', async () => {
    const spaces = await withTenant(session, async (ctx) => listSpaces(ctx, await loadActor(ctx)))
    const space = spaces.find((row) => row.name === 'Customs paperwork')!
    await adminSql()`
      INSERT INTO documents (organization_id, title, doc_type, sensitivity, index_status, space_id, is_demo, created_by)
      VALUES (${org.organizationId}, 'A filed document', 'policy', 'internal', 'indexed', ${space.id}, true, ${org.ownerId})`

    await expect(
      withTenant(session, async (ctx) =>
        archiveSpace(ctx, await loadActor(ctx), { id: space.id, reason: 'Tidying up.' }),
      ),
    ).rejects.toThrow(/still filed on/i)
  })

  it('archives an empty one', async () => {
    const after = await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const made = await createSpace(ctx, actor, { name: 'Temporary shelf' })
      const space = made.find((row) => row.name === 'Temporary shelf')!
      return archiveSpace(ctx, actor, { id: space.id, reason: 'Made it by mistake.' })
    })
    expect(after.some((row) => row.name === 'Temporary shelf')).toBe(false)
  })

  it('reports absence for another tenant’s shelf', async () => {
    const other = await createTenant('structure-absent')
    const [theirs] = await adminSql()<{ id: string }[]>`
      INSERT INTO knowledge_spaces (organization_id, name, slug, default_sensitivity, is_demo, created_by)
      VALUES (${other.organizationId}, 'Theirs', 'theirs', 'internal', true, ${other.ownerId}) RETURNING id`
    await expect(
      withTenant(session, async (ctx) =>
        updateSpace(ctx, await loadActor(ctx), { id: theirs!.id, name: 'Mine now' }),
      ),
    ).rejects.toThrow(NotFoundError)
    await destroyTenant('structure-absent')
  })
})
