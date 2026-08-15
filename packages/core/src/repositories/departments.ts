import type { TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeActivity, writeAudit } from '../audit.js'

/**
 * Departments (§4.3).
 *
 * `departments` is one of the four permission scopes, it routes the run queue's fair share,
 * it scopes agent grants, and every person has one. It has been written by the seed and by
 * nothing else since Phase 0 — so a real organization could see the tree, be governed by it,
 * and never make a department.
 *
 * The tree carries two derived columns, `path` and `depth`, which the seed wrote by hand and
 * nothing kept true. They are the database's now (ADR 0036): a rename or a move rewrites the
 * row and everything under it, because a path that is stale one level down is worse than no
 * path at all.
 *
 * **A department is not a team.** A department is where somebody sits — one per person, and
 * it decides what `department`-scoped permissions reach. A team is what somebody is working
 * on, several at a time, joined and left constantly. The two scopes exist separately in the
 * policy engine and this is the one that is closer to an employment fact than to a project.
 */

export interface DepartmentView {
  id: string
  name: string
  path: string
  depth: number
  parentId: string | null
  timezone: string | null
  legalEntityId: string | null
  /** What would be orphaned by archiving it, so the refusal can say what it is protecting. */
  counts: { people: number; children: number; tasks: number; projects: number }
  createdAt: Date
}

/** Org structure, so it sits with the people who own that — the same gate teams use. */
function guardWrite(ctx: TenantContext, actor: Actor): void {
  const decision = can(actor, 'member:update', {
    type: 'member',
    organizationId: ctx.organizationId,
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
}

export async function listDepartments(ctx: TenantContext, actor: Actor): Promise<DepartmentView[]> {
  const decision = can(actor, 'member:read', { type: 'member', organizationId: ctx.organizationId })
  if (!decision.allow) throw new PermissionError(decision.reason)

  return ctx.sql<DepartmentView[]>`
    SELECT d.id, d.name, d.path, d.depth, d.parent_id AS "parentId", d.timezone,
           d.legal_entity_id AS "legalEntityId", d.created_at AS "createdAt",
           json_build_object(
             'people', (SELECT count(*)::int FROM memberships m
                         WHERE m.department_id = d.id AND m.deleted_at IS NULL AND m.status = 'active'),
             'children', (SELECT count(*)::int FROM departments c
                           WHERE c.parent_id = d.id AND c.deleted_at IS NULL),
             'tasks', (SELECT count(*)::int FROM tasks t
                        WHERE t.department_id = d.id AND t.deleted_at IS NULL),
             'projects', (SELECT count(*)::int FROM projects p
                           WHERE p.department_id = d.id AND p.deleted_at IS NULL)
           ) AS counts
    FROM departments d
    WHERE d.organization_id = ${ctx.organizationId} AND d.deleted_at IS NULL
    ORDER BY d.path`
}

export interface CreateDepartmentInput {
  name: string
  parentId?: string | null
  timezone?: string | null
  legalEntityId?: string | null
}

export async function createDepartment(
  ctx: TenantContext,
  actor: Actor,
  input: CreateDepartmentInput,
): Promise<DepartmentView[]> {
  guardWrite(ctx, actor)
  const name = input.name.trim()
  if (name.length < 2) throw new ValidationError('A department needs a name somebody would recognise.')
  if (name.includes('/')) {
    throw new ValidationError('A department name cannot contain a slash: that is how the path shows where it sits.')
  }

  const [existing] = await ctx.sql<{ id: string }[]>`
    SELECT id FROM departments
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
      AND coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = coalesce(${input.parentId ?? null}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
      AND lower(btrim(name)) = lower(${name})`
  if (existing) throw new ValidationError('There is already a department with that name in the same place.')

  const [row] = await ctx.sql<{ id: string; path: string }[]>`
    INSERT INTO departments (organization_id, parent_id, name, timezone, legal_entity_id, created_by)
    VALUES (${ctx.organizationId}, ${input.parentId ?? null}, ${name}, ${input.timezone ?? null},
            ${input.legalEntityId ?? null}, ${ctx.userId})
    RETURNING id, path`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'department.created',
    entityType: 'department',
    entityId: row!.id,
    after: { name, path: row!.path, parentId: input.parentId ?? null },
  })

  return listDepartments(ctx, actor)
}

/**
 * Renames or moves one.
 *
 * Both rewrite the path of everything underneath, which is why the database does it: a
 * caller that forgot would leave a tree describing where things used to be.
 */
export async function updateDepartment(
  ctx: TenantContext,
  actor: Actor,
  input: { id: string; name?: string; parentId?: string | null; timezone?: string | null },
): Promise<DepartmentView[]> {
  guardWrite(ctx, actor)

  const [before] = await ctx.sql<{ name: string; path: string; parentId: string | null }[]>`
    SELECT name, path, parent_id AS "parentId" FROM departments
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.id} AND deleted_at IS NULL`
  if (!before) throw new NotFoundError()

  const name = input.name?.trim() ?? before.name
  if (name.length < 2) throw new ValidationError('A department needs a name somebody would recognise.')
  if (name.includes('/')) {
    throw new ValidationError('A department name cannot contain a slash: that is how the path shows where it sits.')
  }

  const parentId = input.parentId === undefined ? before.parentId : input.parentId
  const sql = ctx.sql
  const [row] = await sql<{ path: string }[]>`
    UPDATE departments
    SET name = ${name}, parent_id = ${parentId},
        timezone = ${input.timezone === undefined ? sql`timezone` : input.timezone},
        updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.id}
    RETURNING path`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'department.updated',
    entityType: 'department',
    entityId: input.id,
    before: { name: before.name, path: before.path, parentId: before.parentId },
    after: { name, path: row!.path, parentId },
  })

  return listDepartments(ctx, actor)
}

/**
 * Archives one.
 *
 * Refused while anybody sits in it or anything is scoped to it — the rows would keep a
 * `department_id` pointing at something the screens no longer show, and the `department`
 * permission scope would resolve against a department that is not there. Same rule as
 * disbanding a team.
 */
export async function archiveDepartment(
  ctx: TenantContext,
  actor: Actor,
  input: { id: string; reason: string },
): Promise<DepartmentView[]> {
  guardWrite(ctx, actor)
  if (input.reason.trim().length < 4) throw new ValidationError('Say why it is going.')

  const all = await listDepartments(ctx, actor)
  const department = all.find((row) => row.id === input.id)
  if (!department) throw new NotFoundError()

  const { people, children, tasks, projects } = department.counts
  if (people + children + tasks + projects > 0) {
    throw new ValidationError(
      `${people + children + tasks + projects} things still sit in “${department.name}” — ` +
        `${people} people, ${children} sub-departments, ${tasks} tasks, ${projects} projects. ` +
        'Move them first: archiving it would leave them pointing at a department nobody can see.',
    )
  }

  await ctx.sql`
    UPDATE departments SET deleted_at = now(), updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.id}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'department.archived',
    entityType: 'department',
    entityId: input.id,
    before: { name: department.name, path: department.path },
    after: { reason: input.reason.trim() },
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'archived',
    entityType: 'department',
    entityId: input.id,
    entityLabel: department.name,
    summary: `${department.name} was archived. ${input.reason.trim()}`,
  })

  return listDepartments(ctx, actor)
}
