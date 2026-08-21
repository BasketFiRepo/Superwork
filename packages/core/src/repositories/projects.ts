import type { Sensitivity, TenantContext } from '@superwork/db'
import {
  can,
  grantedScope,
  readCeiling,
  SENSITIVITY_RANK,
  sharedObjectIds,
  type Actor,
} from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeActivity, writeAudit } from '../audit.js'
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

/**
 * Whether this actor may read this project.
 *
 * Exported because a project is a container: the things filed against it — its decisions, for
 * one (ADR 0065) — have no classification of their own and take the project's. Two places
 * deciding separately whether a project is readable is two places that will disagree, so this
 * is the one place, and it takes the fields rather than a whole `ProjectView` because a caller
 * that has joined `projects` for four columns should not have to assemble a view to ask.
 */
export function canReadProject(
  actor: Actor,
  organizationId: string,
  project: {
    id: string
    ownerId: string | null
    createdBy: string | null
    departmentId: string | null
    teamId: string | null
    sensitivity: Sensitivity
  },
) {
  return can(actor, 'project:read', {
    type: 'project',
    id: project.id,
    organizationId,
    ownerId: project.ownerId,
    createdBy: project.createdBy,
    departmentId: project.departmentId,
    teamIds: project.teamId ? [project.teamId] : [],
    // A project carries a classification, so a share does not raise clearance: being handed
    // a confidential project does not make you cleared to read one.
    sensitivity: project.sensitivity,
  })
}

function readable(actor: Actor, ctx: TenantContext, project: ProjectView) {
  return canReadProject(actor, ctx.organizationId, project)
}

export interface MilestoneView {
  id: string
  name: string
  dueOn: Date | null
  status: string
  late: boolean
  /** The work filed against it — the answer `tasks.milestone_id` existed for (ADR 0048). */
  taskCount: number
  openCount: number
  /** Open work already past its own due date. */
  overdueCount: number
  /** Open work due after the milestone itself, which is the milestone saying it will slip. */
  dueAfterCount: number
}

/**
 * Starting a project (§17, ADR 0049).
 *
 * `projects` has been read on every screen since Phase 1 and written by the seed alone, so a
 * company using Superwork could work on exactly the projects a demo fixture happened to
 * invent — and the milestones, health scores and rosters built on top of them all described
 * somebody else's work.
 *
 * The create is asked about the project that is *about to exist*: its owner and its department
 * are on the resource, so a `project:create:department` grant means what the role table says
 * it means (ADR 0045).
 */
export async function createProject(
  ctx: TenantContext,
  actor: Actor,
  input: {
    name: string
    description?: string | null
    ownerUserId?: string | null
    departmentId?: string | null
    companyId?: string | null
    sensitivity?: Sensitivity
    startsOn?: string | null
    targetDate?: string | null
    status?: 'planning' | 'active'
  },
): Promise<ProjectView> {
  const ownerId = input.ownerUserId ?? actor.userId
  const decision = can(actor, 'project:create', {
    type: 'project',
    organizationId: ctx.organizationId,
    departmentId: input.departmentId ?? null,
    ownerId,
    createdBy: actor.userId,
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const name = input.name.trim()
  if (name.length < 2) throw new ValidationError('A project needs a name somebody would recognise.')

  const sensitivity = input.sensitivity ?? 'internal'
  const ceiling = readCeiling(actor)
  if (SENSITIVITY_RANK[sensitivity] > SENSITIVITY_RANK[ceiling]) {
    throw new ValidationError(
      `You can read up to ${ceiling}, so a ${sensitivity} project would be one you could not open ` +
        'the moment you made it. Somebody who can read at that level can start it.',
    )
  }

  // A name is how people refer to a project in a sentence — "put it on the Halden one" — so
  // two open ones cannot share it. The index says the same thing to any writer; this says it
  // to the person, and names what already holds the name.
  const [clash] = await ctx.sql<{ name: string; status: string }[]>`
    SELECT name, status FROM projects
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
      AND status NOT IN ('completed', 'cancelled')
      AND lower(btrim(name)) = lower(${name})`
  if (clash) {
    throw new ValidationError(
      `“${clash.name}” is already open. Two live projects with the same name make "put it on the ` +
        '“ ” one" mean nothing — finish or rename the other first.',
    )
  }

  if (input.startsOn && input.targetDate && input.targetDate < input.startsOn) {
    throw new ValidationError(
      `A target of ${input.targetDate} is before the start of ${input.startsOn}. The health score ` +
        'reads both dates, so it has to be a date somebody could actually work towards.',
    )
  }

  if (input.ownerUserId) {
    const [member] = await ctx.sql<{ id: string }[]>`
      SELECT user_id AS id FROM memberships
      WHERE organization_id = ${ctx.organizationId} AND user_id = ${input.ownerUserId}
        AND deleted_at IS NULL AND status = 'active'`
    if (!member) throw new ValidationError('That person is not an active member of this organization.')
  }
  if (input.departmentId) {
    const [department] = await ctx.sql<{ id: string }[]>`
      SELECT id FROM departments
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.departmentId} AND deleted_at IS NULL`
    if (!department) throw new NotFoundError()
  }
  if (input.companyId) {
    const [company] = await ctx.sql<{ id: string }[]>`
      SELECT id FROM companies
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.companyId} AND deleted_at IS NULL`
    if (!company) throw new NotFoundError()
  }

  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO projects (
      organization_id, name, description, status, sensitivity, owner_id, department_id,
      company_id, starts_on, target_date, created_by
    ) VALUES (
      ${ctx.organizationId}, ${name}, ${input.description?.trim() || null},
      ${input.status ?? 'planning'}, ${sensitivity}, ${ownerId}, ${input.departmentId ?? null},
      ${input.companyId ?? null}, ${input.startsOn ?? null}, ${input.targetDate ?? null}, ${ctx.userId}
    ) RETURNING id`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'project.created',
    entityType: 'project',
    entityId: row!.id,
    after: {
      name,
      status: input.status ?? 'planning',
      sensitivity,
      ownerId,
      departmentId: input.departmentId ?? null,
      companyId: input.companyId ?? null,
      startsOn: input.startsOn ?? null,
      targetDate: input.targetDate ?? null,
    },
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'started',
    entityType: 'project',
    entityId: row!.id,
    entityLabel: name,
    summary:
      `${actor.displayName} started “${name}”` +
      (input.targetDate ? `, targeting ${input.targetDate}` : '') +
      '. The owner is on its roster from the first moment, by trigger.',
  })

  // The roster gains its owner by trigger (ADR 0032), so the read below already shows them.
  return getProject(ctx, actor, row!.id)
}

/**
 * Putting a project on hold, finishing it, or abandoning it.
 *
 * Creating something with no way to close it is half a feature: a list that can only grow is
 * how a project screen stops being read at all. The rule mirrors a milestone's (ADR 0048) —
 * `completed` is a claim about the work and is refused while the work is open, `cancelled` is
 * a decision about the project and is always available.
 */
export async function setProjectStatus(
  ctx: TenantContext,
  actor: Actor,
  input: {
    projectId: string
    status: 'planning' | 'active' | 'on_hold' | 'completed' | 'cancelled'
    reason: string
  },
): Promise<ProjectView> {
  const project = await getProject(ctx, actor, input.projectId)
  guardProjectWrite(ctx, actor, project)

  const reason = input.reason.trim()
  if (reason.length < 4) {
    throw new ValidationError('Say why. A project that changed state for no stated reason is one nobody can review.')
  }

  if (input.status === 'completed') {
    const [open] = await ctx.sql<{ tasks: number; milestones: number; title: string | null }[]>`
      SELECT
        (SELECT count(*)::int FROM tasks t
          WHERE t.organization_id = ${ctx.organizationId} AND t.project_id = ${input.projectId}
            AND t.deleted_at IS NULL AND t.status NOT IN ('completed', 'cancelled')) AS tasks,
        (SELECT count(*)::int FROM milestones m
          WHERE m.organization_id = ${ctx.organizationId} AND m.project_id = ${input.projectId}
            AND m.deleted_at IS NULL AND m.status = 'open') AS milestones,
        (SELECT title FROM tasks t
          WHERE t.organization_id = ${ctx.organizationId} AND t.project_id = ${input.projectId}
            AND t.deleted_at IS NULL AND t.status NOT IN ('completed', 'cancelled')
          ORDER BY t.created_at LIMIT 1) AS title`
    if ((open?.tasks ?? 0) > 0 || (open?.milestones ?? 0) > 0) {
      const parts: string[] = []
      if (open!.tasks > 0) {
        parts.push(`${open!.tasks} ${open!.tasks === 1 ? 'task' : 'tasks'} open, starting with “${open!.title}”`)
      }
      if (open!.milestones > 0) {
        parts.push(`${open!.milestones} ${open!.milestones === 1 ? 'milestone' : 'milestones'} not reached`)
      }
      throw new ValidationError(
        `“${project.name}” still has ${parts.join(' and ')}. Finish them, or mark the project ` +
          'cancelled instead — a project called complete with work still open is a status nobody ' +
          'can trust afterwards.',
      )
    }
  }

  await ctx.sql`
    UPDATE projects SET status = ${input.status}, updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.projectId}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'project.status_changed',
    entityType: 'project',
    entityId: input.projectId,
    before: { status: project.status },
    after: { status: input.status, reason },
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'restated',
    entityType: 'project',
    entityId: input.projectId,
    entityLabel: project.name,
    summary: `“${project.name}” is ${input.status.replace(/_/g, ' ')}, set by ${actor.displayName}. ${reason}`,
  })

  return getProject(ctx, actor, input.projectId)
}

/** The milestones of one project. Gated by the caller having read the project itself. */
export async function projectMilestones(ctx: TenantContext, projectId: string): Promise<MilestoneView[]> {
  // "Late" is relative to the organization's today, never the server's (§26.5) — and as a
  // calendar date rather than an instant. `startOfDay(...)::date` is midnight in the
  // organization's timezone cast in a UTC session, which lands on *yesterday* anywhere ahead
  // of UTC: a milestone due yesterday read as not yet late.
  const today = calendarDate(ctx.timezone)
  // The counts are SQL's, not the caller's: a milestone that says "3 of 7, one already late"
  // is reading the work, and a number assembled in TypeScript from a second query would be a
  // number two screens could disagree about (§9.1).
  return ctx.sql<MilestoneView[]>`
    SELECT m.id, m.name, m.due_on AS "dueOn", m.status,
           (m.status <> 'done' AND m.due_on < ${today}::date) AS late,
           coalesce(work.total, 0)::int AS "taskCount",
           coalesce(work.open, 0)::int AS "openCount",
           coalesce(work.overdue, 0)::int AS "overdueCount",
           coalesce(work.due_after, 0)::int AS "dueAfterCount"
    FROM milestones m
    LEFT JOIN LATERAL (
      SELECT count(*) AS total,
             count(*) FILTER (WHERE t.status NOT IN ('completed', 'cancelled')) AS open,
             count(*) FILTER (
               WHERE t.status NOT IN ('completed', 'cancelled') AND t.due_at < ${today}::date
             ) AS overdue,
             count(*) FILTER (
               WHERE t.status NOT IN ('completed', 'cancelled')
                 AND m.due_on IS NOT NULL AND t.due_at::date > m.due_on
             ) AS due_after
      FROM tasks t
      WHERE t.organization_id = m.organization_id AND t.milestone_id = m.id AND t.deleted_at IS NULL
    ) work ON true
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

  // Reaching a milestone with work still open on it would make "done" mean "somebody pressed
  // the button". The two honest ways out are both offered by name: finish the work, or take
  // it off the milestone — and "not doing it" is still available with work attached, because
  // abandoning a milestone with unfinished work is exactly what abandoning one looks like.
  // The same shape as refusing to disband a team that still has work scoped to it (ADR 0036).
  if (input.status === 'done') {
    const [open] = await ctx.sql<{ count: number; title: string | null }[]>`
      SELECT count(*)::int AS count, min(title) AS title FROM tasks
      WHERE organization_id = ${ctx.organizationId} AND milestone_id = ${input.milestoneId}
        AND deleted_at IS NULL AND status NOT IN ('completed', 'cancelled')`
    if ((open?.count ?? 0) > 0) {
      throw new ValidationError(
        `“${before.name}” still has ${open!.count} ${open!.count === 1 ? 'task' : 'tasks'} open on it, ` +
          `starting with “${open!.title}”. Finish them, cancel them, or take them off this milestone — ` +
          'a milestone marked reached with work still on it is a date nobody can trust afterwards.',
      )
    }
  }

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
