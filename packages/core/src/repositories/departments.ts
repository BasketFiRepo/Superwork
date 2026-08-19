import type { TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeActivity, writeAudit } from '../audit.js'
import { calendarInfo } from '../holidays.js'

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
  /** The calendar set on this department itself, or null when it inherits one. */
  holidayCalendar: string | null
  /** What actually governs it, after inheriting from the nearest ancestor that sets one. */
  effectiveHolidayCalendar: string | null
  /** The department the effective calendar came from, when it was not this one. */
  holidayCalendarFrom: string | null
  legalEntityId: string | null
  /**
   * Days ahead that this department does not work and no calendar knows about — its own and
   * every ancestor's, because closures accumulate rather than override (ADR 0051).
   */
  closures: DepartmentClosure[]
  /** What would be orphaned by archiving it, so the refusal can say what it is protecting. */
  counts: { people: number; children: number; tasks: number; projects: number }
  createdAt: Date
}

export interface DepartmentClosure {
  id: string
  /** `YYYY-MM-DD`. A closed day is a date in a place, never an instant (§26.5). */
  date: string
  label: string
  /** The department it was declared on, which is this one when `own`. */
  from: string
  /** False when it was inherited from somewhere above, so the screen can say where. */
  own: boolean
  setBy: string | null
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
           d.holiday_calendar AS "holidayCalendar",
           -- Inherited from the nearest ancestor that sets one, so a company can say
           -- "we are in England and Wales" once instead of on every department (ADR 0036:
           -- the tree's shape is the database's, and so is what hangs off it).
           coalesce(d.holiday_calendar, (
             SELECT a.holiday_calendar FROM departments a
             WHERE a.organization_id = d.organization_id AND a.deleted_at IS NULL
               AND a.holiday_calendar IS NOT NULL
               AND d.path LIKE a.path || ' / %'
             ORDER BY a.depth DESC LIMIT 1
           )) AS "effectiveHolidayCalendar",
           (CASE WHEN d.holiday_calendar IS NOT NULL THEN NULL ELSE (
             SELECT a.name FROM departments a
             WHERE a.organization_id = d.organization_id AND a.deleted_at IS NULL
               AND a.holiday_calendar IS NOT NULL
               AND d.path LIKE a.path || ' / %'
             ORDER BY a.depth DESC LIMIT 1
           ) END) AS "holidayCalendarFrom",
           d.legal_entity_id AS "legalEntityId", d.created_at AS "createdAt",
           -- The days this department does not work that no calendar knows about (ADR 0051).
           -- Its own and every ancestor's, because closures accumulate rather than override,
           -- and only the ones still ahead: a shutdown that has been and gone is not
           -- something anybody needs to read on this screen.
           coalesce((
             SELECT jsonb_agg(jsonb_build_object(
                      'id', c.id, 'date', c.closed_on::text, 'label', c.label,
                      'from', a.name, 'own', a.id = d.id,
                      'setBy', u.name
                    ) ORDER BY c.closed_on)
             FROM department_closures c
             JOIN departments a ON a.id = c.department_id AND a.deleted_at IS NULL
             LEFT JOIN users u ON u.id = c.set_by
             WHERE c.organization_id = d.organization_id AND c.deleted_at IS NULL
               AND c.closed_on >= current_date
               AND (a.id = d.id OR d.path LIKE a.path || ' / %')
           ), '[]'::jsonb) AS closures,
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
  input: {
    id: string
    name?: string
    parentId?: string | null
    timezone?: string | null
    /** `null` clears it, so the department goes back to inheriting. */
    holidayCalendar?: string | null
  },
): Promise<DepartmentView[]> {
  guardWrite(ctx, actor)

  if (input.holidayCalendar !== undefined && input.holidayCalendar !== null) {
    if (!calendarInfo(input.holidayCalendar)) {
      throw new ValidationError('That is not a calendar this product knows how to work out.')
    }
  }

  const [before] = await ctx.sql<
    { name: string; path: string; parentId: string | null; holidayCalendar: string | null }[]
  >`
    SELECT name, path, parent_id AS "parentId", holiday_calendar AS "holidayCalendar" FROM departments
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
        holiday_calendar = ${input.holidayCalendar === undefined ? sql`holiday_calendar` : input.holidayCalendar},
        updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.id}
    RETURNING path`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'department.updated',
    entityType: 'department',
    entityId: input.id,
    before: { name: before.name, path: before.path, parentId: before.parentId, holidayCalendar: before.holidayCalendar },
    after: { name, path: row!.path, parentId, holidayCalendar: input.holidayCalendar ?? before.holidayCalendar },
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

/**
 * A day this department does not work that no calendar knows about (ADR 0051).
 *
 * The four built-in calendars are national ones: they know Christmas Day and Thanksgiving,
 * and they cannot know the week between Christmas and New Year that most of the country
 * takes, the Monday the depot moves, or the public holidays of any country outside England,
 * Wales, and the United States. Without this the only honest answer for a French department
 * was `weekends`, and it was then chased through the fourteenth of July.
 *
 * It only ever *adds* a day nobody works. There is deliberately no way to say "we do work
 * that bank holiday": the promise this whole area makes is that it may only quieten the
 * product, and something that could switch a rest day back on would take that promise away.
 */
export async function closeDepartmentDay(
  ctx: TenantContext,
  actor: Actor,
  input: { departmentId: string; date: string; label: string },
): Promise<DepartmentView[]> {
  guardWrite(ctx, actor)

  const label = input.label.trim()
  if (label.length < 3) {
    throw new ValidationError(
      'Say what the day is. It is shown to the people not working it, and it is the reason a ' +
        'held reminder gives for waiting.',
    )
  }
  if (label.length > 80) throw new ValidationError('That is longer than a day’s name needs to be.')

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new ValidationError('A closed day is a date, as YYYY-MM-DD.')
  }
  // The thirtieth of February parses and is not a day. This is checked here rather than by
  // letting the `date` column reject it, because the column raises a database error — the
  // person typing gets a sentence, not `date/time field value out of range`.
  const [year, month, dayOfMonth] = input.date.split('-').map(Number)
  const probe = new Date(Date.UTC(year!, month! - 1, dayOfMonth!))
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month! - 1 ||
    probe.getUTCDate() !== dayOfMonth
  ) {
    throw new ValidationError('That is not a day on the calendar.')
  }

  const [day] = await ctx.sql<{ past: boolean }[]>`
    -- "Today" is worked out where the person is, never in the server's local time (§26.5).
    -- Today itself is allowed: it has hours left in which to hold something.
    SELECT (${input.date} < (now() AT TIME ZONE ${ctx.timezone})::date::text) AS past`
  if (day?.past) {
    throw new ValidationError(
      'That day has already gone. Closing it now would change nothing: a reminder is only ever ' +
        'held on the day it would have arrived.',
    )
  }

  const [department] = await ctx.sql<{ name: string }[]>`
    SELECT name FROM departments
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.departmentId} AND deleted_at IS NULL`
  if (!department) throw new NotFoundError()

  const [clash] = await ctx.sql<{ label: string }[]>`
    SELECT label FROM department_closures
    WHERE organization_id = ${ctx.organizationId} AND department_id = ${input.departmentId}
      AND closed_on = ${input.date}::date AND deleted_at IS NULL`
  if (clash) {
    throw new ValidationError(
      `${department.name} is already closed on ${input.date} for “${clash.label}”. ` +
        'Reopen that one first if it is wrong.',
    )
  }

  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO department_closures (organization_id, department_id, closed_on, label, set_by, created_by)
    VALUES (${ctx.organizationId}, ${input.departmentId}, ${input.date}::date, ${label},
            ${actor.userId}, ${actor.userId})
    RETURNING id`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'department.closed',
    entityType: 'department',
    entityId: input.departmentId,
    before: null,
    after: { closureId: row!.id, date: input.date, label, department: department.name },
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'closed',
    entityType: 'department',
    entityId: input.departmentId,
    entityLabel: department.name,
    summary: `${department.name} is closed on ${input.date}: ${label}. Nobody there will be chased that day.`,
  })

  return listDepartments(ctx, actor)
}

/**
 * Takes one back off.
 *
 * This is the widening direction — people are chased on a day the company had said it was
 * shut — so the row stays, saying who reopened it and why, rather than disappearing. It does
 * not ask for a password the way raising a limit does (ADRs 0044, 0046, 0050): what it
 * restores is the product's ordinary behaviour rather than a new reach, it is visible on the
 * same screen it was set on, and a closure entered on the wrong date is a mistake somebody
 * should be able to correct without being made to prove themselves.
 */
export async function reopenDepartmentDay(
  ctx: TenantContext,
  actor: Actor,
  input: { closureId: string; reason: string },
): Promise<DepartmentView[]> {
  guardWrite(ctx, actor)

  const reason = input.reason.trim()
  if (reason.length < 4) {
    throw new ValidationError('Say why the day is being worked after all.')
  }

  const [closure] = await ctx.sql<
    { departmentId: string; date: string; label: string; department: string }[]
  >`
    SELECT c.department_id AS "departmentId", c.closed_on::text AS date, c.label, d.name AS department
    FROM department_closures c
    JOIN departments d ON d.id = c.department_id
    WHERE c.organization_id = ${ctx.organizationId} AND c.id = ${input.closureId}
      AND c.deleted_at IS NULL`
  if (!closure) throw new NotFoundError()

  await ctx.sql`
    UPDATE department_closures
    SET deleted_at = now(), reopened_by = ${actor.userId}, reopened_at = now(),
        reopen_reason = ${reason}, updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.closureId}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'department.reopened',
    entityType: 'department',
    entityId: closure.departmentId,
    before: { closureId: input.closureId, date: closure.date, label: closure.label },
    after: { reason },
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'reopened',
    entityType: 'department',
    entityId: closure.departmentId,
    entityLabel: closure.department,
    summary: `${closure.department} is open again on ${closure.date}, which had been ${closure.label}. ${reason}`,
  })

  return listDepartments(ctx, actor)
}
