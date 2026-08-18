import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor, ROLE_PERMISSIONS } from '@superwork/auth'
import {
  addMilestone,
  createProject,
  createTask,
  getProject,
  listProjects,
  PermissionError,
  setMilestoneStatus,
  setProjectStatus,
  updateTask,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * A project somebody started (ADR 0049).
 *
 * `projects` has been read on every screen since Phase 1 — the list, the health score, the
 * classification a task inherits, the milestones filed against it — and written by the seed
 * alone. There was no `createProject` anywhere in the product, so a company could work on
 * exactly the projects a demo fixture happened to invent.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let memberSession: { organizationId: string; userId: string; timezone: string }

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)

beforeAll(async () => {
  org = await createTenant('project-lifecycle')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  memberSession = { organizationId: org.organizationId, userId: org.memberId, timezone: TZ }
})

afterAll(async () => {
  await destroyTenant('project-lifecycle')
  await closePools()
})

describe('starting one', () => {
  it('lands with an owner, a roster and a status, and is in the list', async () => {
    const project = await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      return createProject(ctx, actor, {
        name: 'Halden peak season readiness 2027',
        description: 'What has to be true before the peak.',
        startsOn: day(1),
        targetDate: day(60),
      })
    })

    expect(project.status).toBe('planning')
    expect(project.ownerId).toBe(org.ownerId)

    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      expect((await listProjects(ctx, actor)).some((row) => row.id === project.id)).toBe(true)
      // The owner is on the roster from the first moment, by the trigger from ADR 0032 —
      // not by this repository remembering to write a second row.
      const [member] = await ctx.sql<{ role: string }[]>`
        SELECT role FROM project_members
        WHERE organization_id = ${ctx.organizationId} AND project_id = ${project.id}
          AND user_id = ${org.ownerId} AND deleted_at IS NULL`
      expect(member?.role).toBe('owner')
    })
  })

  it('refuses a member, and names what they would need', async () => {
    // The role table has never granted a member `project:create`; the refusal says so rather
    // than failing somewhere further in.
    expect(ROLE_PERMISSIONS.member.some((grant) => grant.startsWith('project:create'))).toBe(false)
    await withTenant(memberSession, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(createProject(ctx, actor, { name: 'Not mine to start' })).rejects.toThrow(
        PermissionError,
      )
    })
  })

  it('refuses a second open project with the same name', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        createProject(ctx, actor, { name: 'halden peak season readiness 2027  ' }),
      ).rejects.toThrow(/already open/i)
    })
  })

  it('refuses a target date before the start', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        createProject(ctx, actor, { name: 'Backwards', startsOn: day(30), targetDate: day(10) }),
      ).rejects.toThrow(ValidationError)
    })
  })

  it('refuses a classification the person could not open afterwards', async () => {
    // An owner reads everything, so this needs somebody who does not: a manager stops at
    // confidential, and their create grant is scoped to their own department.
    const [department] = await adminSql()<{ id: string }[]>`
      INSERT INTO departments (organization_id, name, path, is_demo, created_by)
      VALUES (${org.organizationId}, 'Operations', 'Operations', true, ${org.ownerId})
      RETURNING id`
    await adminSql()`
      UPDATE memberships SET role = 'manager', department_id = ${department!.id}
      WHERE organization_id = ${org.organizationId} AND user_id = ${org.viewerId}`

    await withTenant({ ...session, userId: org.viewerId }, async (ctx) => {
      const actor = await loadActor(ctx)
      expect(actor.role).toBe('manager')
      await expect(
        createProject(ctx, actor, {
          name: 'Above my own reach',
          departmentId: department!.id,
          sensitivity: 'restricted',
        }),
      ).rejects.toThrow(/could not open/i)

      // And the same manager can start one at a level they can read.
      const theirs = await createProject(ctx, actor, {
        name: 'Within my own reach',
        departmentId: department!.id,
        sensitivity: 'confidential',
      })
      expect(theirs.sensitivity).toBe('confidential')
    })
  })

  it('cannot be given dates in the wrong order whatever writes the row', async () => {
    await expect(
      adminSql()`
        UPDATE projects SET starts_on = ${day(40)}, target_date = ${day(5)}
        WHERE organization_id = ${org.organizationId} AND name = 'Halden peak season readiness 2027'`,
    ).rejects.toThrow(/projects_dates_in_order/)
  })

  it('cannot hold a name a live project already holds, whatever writes the row', async () => {
    const [other] = await adminSql()<{ id: string }[]>`
      INSERT INTO projects (organization_id, name, status, is_demo, created_by)
      VALUES (${org.organizationId}, 'Something else entirely', 'active', true, ${org.ownerId})
      RETURNING id`
    await expect(
      adminSql()`
        UPDATE projects SET name = 'Halden peak season readiness 2027' WHERE id = ${other!.id}`,
    ).rejects.toThrow(/projects_one_open_name/)
    await adminSql()`DELETE FROM projects WHERE id = ${other!.id}`
  })
})

describe('closing one', () => {
  it('refuses “completed” while its work is still open, and says what is left', async () => {
    const { projectId } = await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const project = await createProject(ctx, actor, { name: 'Depot rewire', status: 'active' })
      const task = await createTask(ctx, actor, { title: 'Pull the old panel', projectId: project.id })
      expect(task.projectId).toBe(project.id)
      return { projectId: project.id }
    })

    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        setProjectStatus(ctx, actor, { projectId, status: 'completed', reason: 'Calling it done.' }),
      ).rejects.toThrow(/1 task open, starting with “Pull the old panel”/)
    })
  })

  it('counts an unreached milestone as work too', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const project = await createProject(ctx, actor, { name: 'Broker onboarding', status: 'active' })
      await addMilestone(ctx, actor, { projectId: project.id, name: 'Contract signed', dueOn: null })
      await expect(
        setProjectStatus(ctx, actor, { projectId: project.id, status: 'completed', reason: 'Finished.' }),
      ).rejects.toThrow(/1 milestone not reached/)

      const milestones = await addMilestone(ctx, actor, {
        projectId: project.id,
        name: 'Kick-off held',
        dueOn: null,
      })
      for (const milestone of milestones) {
        await setMilestoneStatus(ctx, actor, {
          projectId: project.id,
          milestoneId: milestone.id,
          status: 'done',
        })
      }
      const done = await setProjectStatus(ctx, actor, {
        projectId: project.id,
        status: 'completed',
        reason: 'Both milestones reached and nothing else open.',
      })
      expect(done.status).toBe('completed')
    })
  })

  it('always allows cancelling, and frees the name it was using', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const [open] = await ctx.sql<{ id: string }[]>`
        SELECT id FROM projects
        WHERE organization_id = ${ctx.organizationId} AND name = 'Depot rewire' AND deleted_at IS NULL`
      const cancelled = await setProjectStatus(ctx, actor, {
        projectId: open!.id,
        status: 'cancelled',
        reason: 'The depot is being sold instead.',
      })
      expect(cancelled.status).toBe('cancelled')

      // The name is free again, which is the whole reason the index covers open projects only.
      const again = await createProject(ctx, actor, { name: 'Depot rewire' })
      expect(again.id).not.toBe(open!.id)
    })
  })

  it('refuses a change nobody explained', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const [project] = await ctx.sql<{ id: string }[]>`
        SELECT id FROM projects
        WHERE organization_id = ${ctx.organizationId} AND name = 'Broker onboarding'`
      await expect(
        setProjectStatus(ctx, actor, { projectId: project!.id, status: 'on_hold', reason: 'x' }),
      ).rejects.toThrow(ValidationError)
    })
  })

  it('needs a say over the project, not a read of it', async () => {
    await withTenant(memberSession, async (ctx) => {
      const actor = await loadActor(ctx)
      const [project] = await ctx.sql<{ id: string }[]>`
        SELECT id FROM projects
        WHERE organization_id = ${ctx.organizationId} AND name = 'Broker onboarding'`
      await expect(
        setProjectStatus(ctx, actor, {
          projectId: project!.id,
          status: 'on_hold',
          reason: 'Trying it on.',
        }),
      ).rejects.toThrow(PermissionError)
    })
  })
})

describe('what a started project then carries', () => {
  it('lends its classification to the work filed on it', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      const project = await createProject(ctx, actor, {
        name: 'Confidential lane review',
        sensitivity: 'confidential',
        status: 'active',
      })
      const task = await createTask(ctx, actor, { title: 'Read the rate card', projectId: project.id })
      const loaded = await getProject(ctx, actor, project.id)
      expect(loaded.sensitivity).toBe('confidential')
      expect(task.projectSensitivity).toBe('confidential')
      await updateTask(ctx, actor, { id: task.id, status: 'cancelled' })
      return project.id
    })

    // Out of the transaction that made it: a member cannot reach it, which is the
    // classification working rather than a bug.
    await withTenant(memberSession, async (ctx) => {
      const member = await loadActor(ctx)
      const [project] = await ctx.sql<{ id: string }[]>`
        SELECT id FROM projects
        WHERE organization_id = ${ctx.organizationId} AND name = 'Confidential lane review'`
      await expect(getProject(ctx, member, project!.id)).rejects.toThrow(PermissionError)
    })
  })
})
