import type { Sensitivity, TenantContext } from '@superwork/db'
import { can, grantedScope, sharedObjectIds, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError } from '../errors.js'
import { startOfDay } from '../time.js'

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
  // "Late" is relative to the organization's today, never the server's (§26.5).
  const today = startOfDay(new Date(), ctx.timezone)
  return ctx.sql<MilestoneView[]>`
    SELECT m.id, m.name, m.due_on AS "dueOn", m.status,
           (m.status <> 'done' AND m.due_on < ${today}::date) AS late
    FROM milestones m
    WHERE m.organization_id = ${ctx.organizationId} AND m.project_id = ${projectId}
      AND m.deleted_at IS NULL
    ORDER BY m.due_on NULLS LAST, m.name`
}
