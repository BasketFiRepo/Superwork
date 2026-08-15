import type { TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeActivity, writeAudit } from '../audit.js'
import { getProject } from './projects.js'

/**
 * The project roster (§17).
 *
 * `project_members` was created in migration 0002 and written by exactly one thing — the
 * seed, which puts the owner on every project. Nothing read it. So being on a project was a
 * row in a table and nothing else, while the project page answered "who is doing this?" with
 * a single chip naming the owner and a list of who it had been *shared* with.
 *
 * Those are not the same question. A share is what you give somebody outside the work; a
 * roster is the work's own answer to who is doing it. The product could express the first
 * and not the second.
 *
 * **Being on a project lends a read of it and of the work inside it, and nothing else**
 * (ADR 0032). That is the same rule a container share follows (ADR 0024) and for the same
 * reason: the set of tasks in a project changes daily, so whoever adds somebody cannot see
 * what they are handing over. A contributor who needs to change the project itself needs
 * that granted on the project, where it can be seen.
 *
 * Who *owns* a project is not settable here. `projects.owner_id` is the fact — the list, the
 * page and the `own` scope all resolve against it — and the roster's owner row is derived
 * from it by the database. A roster edit that appeared to change the owner would change one
 * of two statements of the same fact, which is exactly the bug this table was part of.
 */

export type ProjectRole = 'owner' | 'lead' | 'contributor' | 'reviewer'

/** The roles somebody can be *given* here. `owner` comes from the project (ADR 0032). */
export const ASSIGNABLE_ROLES: ProjectRole[] = ['lead', 'contributor', 'reviewer']

export interface ProjectMemberView {
  userId: string
  name: string
  role: ProjectRole
  reason: string | null
  /** True for the row the database derives from `projects.owner_id`. */
  derived: boolean
  addedByName: string | null
  joinedAt: Date
}

/**
 * Changing who is on a project is a say over the project, so it needs one.
 *
 * Deliberately `project:update` rather than `member:update`: this is not org structure, it
 * is the work. A manager who runs a project can staff it without being able to edit the
 * company's teams.
 */
function guardWrite(
  ctx: TenantContext,
  actor: Actor,
  project: { id: string; ownerId: string | null; createdBy: string | null; departmentId: string | null; teamId: string | null; sensitivity: string },
): void {
  const decision = can(actor, 'project:update', {
    type: 'project',
    id: project.id,
    organizationId: ctx.organizationId,
    ownerId: project.ownerId,
    createdBy: project.createdBy,
    departmentId: project.departmentId,
    teamIds: project.teamId ? [project.teamId] : [],
    riskTier: 'low',
  })
  if (!decision.allow) {
    throw new PermissionError(
      `${decision.reason} Adding somebody to a project lets them read its work, so it needs a say over the project.`,
    )
  }
}

/**
 * Everybody on one project.
 *
 * The gate is `getProject` and nothing further. The roster is part of the project rather
 * than a slice of the staff directory — a contractor working on it should see who else is
 * working on it — so it is not gated on `member:read`, which is withheld from a guest
 * precisely so they cannot enumerate the company.
 */
export async function projectRoster(
  ctx: TenantContext,
  actor: Actor,
  projectId: string,
): Promise<ProjectMemberView[]> {
  await getProject(ctx, actor, projectId)

  const rows = await ctx.sql<
    {
      userId: string
      name: string
      role: ProjectRole
      reason: string | null
      addedByName: string | null
      joinedAt: Date
    }[]
  >`
    SELECT pm.user_id AS "userId", u.name, pm.role, pm.reason,
           (SELECT x.name FROM users x WHERE x.id = pm.created_by) AS "addedByName",
           pm.created_at AS "joinedAt"
    FROM project_members pm
    JOIN users u ON u.id = pm.user_id
    JOIN memberships m ON m.user_id = pm.user_id AND m.organization_id = pm.organization_id
      AND m.deleted_at IS NULL AND m.status = 'active'
    WHERE pm.organization_id = ${ctx.organizationId} AND pm.project_id = ${projectId}
      AND pm.deleted_at IS NULL
    ORDER BY CASE pm.role WHEN 'owner' THEN 0 WHEN 'lead' THEN 1 WHEN 'contributor' THEN 2 ELSE 3 END, u.name`

  return rows.map((row) => ({ ...row, derived: row.role === 'owner' }))
}

/** Every project one person is on, for their own record and for the roster's own reads. */
export async function projectsFor(ctx: TenantContext, userId: string): Promise<
  { projectId: string; projectName: string; role: ProjectRole; reason: string | null; sensitivity: string }[]
> {
  return ctx.sql`
    SELECT pm.project_id AS "projectId", p.name AS "projectName", pm.role, pm.reason,
           p.sensitivity::text AS sensitivity
    FROM project_members pm
    JOIN projects p ON p.id = pm.project_id AND p.deleted_at IS NULL
    WHERE pm.organization_id = ${ctx.organizationId} AND pm.user_id = ${userId} AND pm.deleted_at IS NULL
    ORDER BY p.name`
}

export interface AddMemberInput {
  projectId: string
  userId: string
  role?: ProjectRole
  reason: string
}

/**
 * Puts somebody on a project.
 *
 * Audited as a grant of access, because that is what it is: on their next request the
 * project and its open work become readable to them, up to their own clearance — being put
 * on a confidential project does not make somebody cleared to read one.
 */
export async function addProjectMember(
  ctx: TenantContext,
  actor: Actor,
  input: AddMemberInput,
): Promise<ProjectMemberView[]> {
  const project = await getProject(ctx, actor, input.projectId)
  guardWrite(ctx, actor, project)

  const role = input.role ?? 'contributor'
  if (role === 'owner') {
    throw new ValidationError(
      'Who owns a project is a property of the project, not of its roster. Change the owner on the project and the roster follows.',
    )
  }
  if (!ASSIGNABLE_ROLES.includes(role)) throw new ValidationError('That is not a role on a project.')
  if (input.reason.trim().length < 4) {
    throw new ValidationError('Say why they are joining. Being on a project makes its work readable, and access wants a reason.')
  }

  const [member] = await ctx.sql<{ name: string }[]>`
    SELECT u.name FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = ${ctx.organizationId} AND m.user_id = ${input.userId}
      AND m.deleted_at IS NULL AND m.status = 'active'`
  if (!member) throw new ValidationError('That person is not a member of this organization.')

  // Somebody already on it has their role and reason updated rather than a second row: the
  // roster answers "who is on this", and one person is on it once.
  await ctx.sql`
    INSERT INTO project_members (organization_id, project_id, user_id, role, reason, created_by)
    VALUES (${ctx.organizationId}, ${input.projectId}, ${input.userId}, ${role}, ${input.reason.trim()}, ${ctx.userId})
    ON CONFLICT (project_id, user_id) WHERE deleted_at IS NULL
    DO UPDATE SET
      -- The owner's row is the database's, not this caller's: a roster edit must not be a
      -- way to quietly take a project off the person who owns it.
      role = CASE WHEN project_members.role = 'owner' THEN 'owner' ELSE EXCLUDED.role END,
      reason = EXCLUDED.reason,
      updated_at = now()`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'project.member_added',
    entityType: 'project',
    entityId: input.projectId,
    after: { project: project.name, member: member.name, role, reason: input.reason.trim() },
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'added',
    entityType: 'project',
    entityId: input.projectId,
    entityLabel: project.name,
    summary: `${member.name} joined ${project.name} as ${role}. ${input.reason.trim()}`,
  })

  return projectRoster(ctx, actor, input.projectId)
}

/** Takes somebody off a project, and with it the read that being on it lent them. */
export async function removeProjectMember(
  ctx: TenantContext,
  actor: Actor,
  input: { projectId: string; userId: string; reason: string },
): Promise<ProjectMemberView[]> {
  const project = await getProject(ctx, actor, input.projectId)
  guardWrite(ctx, actor, project)
  if (input.reason.trim().length < 4) throw new ValidationError('Say why they are leaving.')

  if (project.ownerId === input.userId) {
    throw new ValidationError(
      'The owner cannot be taken off their own project. Hand the project to somebody else and the roster follows.',
    )
  }

  const [removed] = await ctx.sql<{ id: string; role: ProjectRole }[]>`
    UPDATE project_members SET deleted_at = now(), updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND project_id = ${input.projectId}
      AND user_id = ${input.userId} AND deleted_at IS NULL AND role <> 'owner'
    RETURNING id, role`
  if (!removed) throw new NotFoundError()

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'project.member_removed',
    entityType: 'project',
    entityId: input.projectId,
    before: { project: project.name, member: input.userId, role: removed.role },
    after: { reason: input.reason.trim() },
  })

  return projectRoster(ctx, actor, input.projectId)
}
