import type { Sensitivity, TenantContext } from '@superwork/db'
import { can, grantedScope, sharedObjectIds, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeAudit } from '../audit.js'
import { calendarDate, startOfDay } from '../time.js'

/**
 * Projects (§17).
 *
 * The list used to be a raw query on the page with no permission check on it at all — RLS
 * kept it inside the organization and nothing else was asked. That is right for every role
 * whose grant is organization-wide and wrong for the two that are narrower: a `guest` holds
 * `project:read:team` and saw every project in the company.
 *
 * So the same shape as tasks and documents: ask which rows this actor may consider, push
 * that into the query, and union in anything shared with them by tuple.
 */

export interface ProjectView {
  id: string
  name: string
  description: string | null
  status: string
  sensitivity: Sensitivity
  ownerId: string | null
  ownerName: string | null
  companyId: string | null
  companyName: string | null
  departmentId: string | null
  departmentName: string | null
  teamId: string | null
  startsOn: Date | null
  targetDate: Date | null
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

const SELECT_PROJECT = (ctx: TenantContext) => ctx.sql`
  SELECT p.id, p.name, p.description, p.status, p.sensitivity,
         p.owner_id AS "ownerId", u.name AS "ownerName",
         p.company_id AS "companyId", c.name AS "companyName",
         p.department_id AS "departmentId", d.path AS "departmentName",
         p.team_id AS "teamId", p.starts_on AS "startsOn", p.target_date AS "targetDate",
         p.created_by AS "createdBy", p.created_at AS "createdAt", p.updated_at AS "updatedAt"
  FROM projects p
  LEFT JOIN users u ON u.id = p.owner_id
  LEFT JOIN companies c ON c.id = p.company_id
  LEFT JOIN departments d ON d.id = p.department_id`

export async function listProjects(ctx: TenantContext, actor: Actor): Promise<ProjectView[]> {
  const scope = grantedScope(actor, 'project:read', 'project')
  const sql = ctx.sql
  const shared = sharedObjectIds(actor, 'project')
  // Being on a project's roster lends a read of it (ADR 0032), so the list has to say so —
  // otherwise "you are on this project" and "it is not in your list of projects" are both
  // true.
  const onRoster = actor.projectIds ?? []

  // A role with no grant of this kind at all can still have been *given* a row, and a gate
  // that throws before any row is considered denies the one thing a tuple exists to allow.
  // Refuse only when there is genuinely nothing to ask about.
  if (scope === null && shared.length === 0 && onRoster.length === 0) {
    const decision = can(actor, 'project:read', { type: 'project', organizationId: ctx.organizationId })
    throw new PermissionError(decision.reason)
  }

  const visible =
    scope === 'org'
      ? sql``
      : sql`AND (
            ${
              scope === null
                ? sql`false`
                : scope === 'department'
                ? sql`p.department_id = ANY(${actor.departmentIds}::uuid[])`
                : scope === 'team'
                  ? sql`p.team_id = ANY(${actor.teamIds}::uuid[])`
                  : sql`(p.owner_id = ${actor.userId} OR p.created_by = ${actor.userId})`
            }
            ${shared.length ? sql`OR p.id = ANY(${shared}::uuid[])` : sql``}
            ${onRoster.length ? sql`OR p.id = ANY(${onRoster}::uuid[])` : sql``}
          )`

  const rows = await sql<ProjectView[]>`
    ${SELECT_PROJECT(ctx)}
    WHERE p.organization_id = ${ctx.organizationId} AND p.deleted_at IS NULL
      ${visible}
    ORDER BY p.status, p.name`

  // Classification is per row, so it cannot be pushed into the scope predicate — a project
  // above the actor's ceiling is dropped here rather than being listed and then refused on
  // open. The list and the page have to agree about what exists.
  return rows.filter((row) => readable(actor, ctx, row).allow)
}

export async function getProject(ctx: TenantContext, actor: Actor, id: string): Promise<ProjectView> {
  const rows = await ctx.sql<ProjectView[]>`
    ${SELECT_PROJECT(ctx)}
    WHERE p.organization_id = ${ctx.organizationId} AND p.id = ${id} AND p.deleted_at IS NULL`
  const project = rows[0]
  if (!project) throw new NotFoundError()

  const decision = readable(actor, ctx, project)
  if (!decision.allow) throw new PermissionError(decision.reason)
  return project
}

function readable(actor: Actor, ctx: TenantContext, project: ProjectView) {
  return can(actor, 'project:read', {
    type: 'project',
    id: project.id,
    organizationId: ctx.organizationId,
    ownerId: project.ownerId,
    createdBy: project.createdBy,
    departmentId: project.departmentId,
    teamIds: project.teamId ? [project.teamId] : [],
    // A project carries a classification, so a share does not raise clearance: being handed
    // a confidential project does not make you cleared to read one.
    sensitivity: project.sensitivity,
  })
}

export interface MilestoneView {
  id: string
  name: string
  dueOn: Date | null
  status: string
  late: boolean
}

/** The milestones of one project. Gated by the caller having read the project itself. */
export async function projectMilestones(ctx: TenantContext, projectId: string): Promise<MilestoneView[]> {
  // "Late" is relative to the organization's today, never the server's (§26.5) — and as a
  // calendar date rather than an instant. `startOfDay(...)::date` is midnight in the
  // organization's timezone cast in a UTC session, which lands on *yesterday* anywhere ahead
  // of UTC: a milestone due yesterday read as not yet late.
  const today = calendarDate(ctx.timezone)
  return ctx.sql<MilestoneView[]>`
    SELECT m.id, m.name, m.due_on AS "dueOn", m.status,
           (m.status <> 'done' AND m.due_on < ${today}::date) AS late
    FROM milestones m
    WHERE m.organization_id = ${ctx.organizationId} AND m.project_id = ${projectId}
      AND m.deleted_at IS NULL
    ORDER BY m.due_on NULLS LAST, m.name`
}

/**
 * Adding, completing and dropping milestones (§17, ADR 0036).
 *
 * They have been displayed on every project page and counted in the health score since
 * Phase 1, written by the seed and by nothing else — so a project could show its milestones
 * and never gain one.
 *
 * Changing them needs a say over the project, because a milestone is a promise the project
 * makes rather than a note about it: the health score reads their dates.
 */
function guardProjectWrite(ctx: TenantContext, actor: Actor, project: ProjectView): void {
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
      `${decision.reason} A milestone is a date the project is judged against, so it needs a say over the project.`,
    )
  }
}

export async function addMilestone(
  ctx: TenantContext,
  actor: Actor,
  input: { projectId: string; name: string; dueOn: Date | null },
): Promise<MilestoneView[]> {
  const project = await getProject(ctx, actor, input.projectId)
  guardProjectWrite(ctx, actor, project)

  const name = input.name.trim()
  if (name.length < 2) throw new ValidationError('A milestone needs a name somebody would recognise.')

  const [clash] = await ctx.sql<{ id: string }[]>`
    SELECT id FROM milestones
    WHERE organization_id = ${ctx.organizationId} AND project_id = ${input.projectId}
      AND deleted_at IS NULL AND lower(btrim(name)) = lower(${name})`
  if (clash) throw new ValidationError('This project already has a milestone with that name.')

  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO milestones (organization_id, project_id, name, due_on, status, created_by)
    VALUES (${ctx.organizationId}, ${input.projectId}, ${name}, ${input.dueOn}, 'open', ${ctx.userId})
    RETURNING id`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'milestone.added',
    entityType: 'project',
    entityId: input.projectId,
    after: { milestoneId: row!.id, name, dueOn: input.dueOn?.toISOString() ?? null },
  })

  return projectMilestones(ctx, input.projectId)
}

/**
 * Marks one reached, or puts it back.
 *
 * `completed_at` moves with the status — the database refuses a `done` row without one —
 * so "when did we hit that" is answerable afterwards rather than inferred from an audit
 * trail somebody has to go and read.
 */
export async function setMilestoneStatus(
  ctx: TenantContext,
  actor: Actor,
  input: { projectId: string; milestoneId: string; status: 'open' | 'done' | 'cancelled' },
): Promise<MilestoneView[]> {
  const project = await getProject(ctx, actor, input.projectId)
  guardProjectWrite(ctx, actor, project)

  const [before] = await ctx.sql<{ name: string; status: string }[]>`
    SELECT name, status FROM milestones
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.milestoneId}
      AND project_id = ${input.projectId} AND deleted_at IS NULL`
  if (!before) throw new NotFoundError()

  await ctx.sql`
    UPDATE milestones
    SET status = ${input.status},
        completed_at = ${input.status === 'done' ? ctx.sql`now()` : null},
        completed_by = ${input.status === 'done' ? actor.userId : null},
        updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.milestoneId}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'milestone.status_changed',
    entityType: 'project',
    entityId: input.projectId,
    before: { milestone: before.name, status: before.status },
    after: { status: input.status },
  })

  return projectMilestones(ctx, input.projectId)
}

/** Moves the date. Slipping a milestone is a decision, and the health score reads it. */
export async function rescheduleMilestone(
  ctx: TenantContext,
  actor: Actor,
  input: { projectId: string; milestoneId: string; dueOn: Date | null },
): Promise<MilestoneView[]> {
  const project = await getProject(ctx, actor, input.projectId)
  guardProjectWrite(ctx, actor, project)

  const [row] = await ctx.sql<{ name: string; dueOn: Date | null }[]>`
    SELECT name, due_on AS "dueOn" FROM milestones
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.milestoneId}
      AND project_id = ${input.projectId} AND deleted_at IS NULL`
  if (!row) throw new NotFoundError()

  await ctx.sql`
    UPDATE milestones SET due_on = ${input.dueOn}, updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.milestoneId}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'milestone.rescheduled',
    entityType: 'project',
    entityId: input.projectId,
    before: { milestone: row.name, dueOn: row.dueOn?.toISOString() ?? null },
    after: { dueOn: input.dueOn?.toISOString() ?? null },
  })

  return projectMilestones(ctx, input.projectId)
}

/** Removes one that should never have been there. Cancelling is the other option, and keeps it. */
export async function removeMilestone(
  ctx: TenantContext,
  actor: Actor,
  input: { projectId: string; milestoneId: string },
): Promise<MilestoneView[]> {
  const project = await getProject(ctx, actor, input.projectId)
  guardProjectWrite(ctx, actor, project)

  const [removed] = await ctx.sql<{ name: string }[]>`
    UPDATE milestones SET deleted_at = now(), updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.milestoneId}
      AND project_id = ${input.projectId} AND deleted_at IS NULL
    RETURNING name`
  if (!removed) throw new NotFoundError()

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'milestone.removed',
    entityType: 'project',
    entityId: input.projectId,
    before: { milestone: removed.name },
  })

  return projectMilestones(ctx, input.projectId)
}
