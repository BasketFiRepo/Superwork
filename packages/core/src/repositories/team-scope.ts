import type { Role, Sensitivity, TenantContext } from '@superwork/db'
import { can, ROLE_MAX_SENSITIVITY, SENSITIVITY_RANK, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeActivity, writeAudit } from '../audit.js'
import { getTask } from './tasks.js'
import { getProject } from './projects.js'
import { getDocument } from './documents.js'

/**
 * Putting work in a team, and taking it out again (§4.3, ADR 0064).
 *
 * Migration 0022 gave tasks, projects and documents a `team_id`, indexed all three, and stated
 * the reason: every grant the `guest` role holds is team-scoped, so with no team dimension that
 * role reads nothing. It then left two of the three columns with no writer in the product —
 * `projects.team_id` written by nothing at all, `documents.team_id` by the seed and by tests
 * reaching past the product with an owner connection.
 *
 * So `project:read:team` and `document:read:team` matched no row anybody could produce, the
 * Teams screen's project and document counts could only be zero, retrieval's team filter could
 * never match, and `archiveTeam`'s refusal to disband a team with work still in it was
 * two-thirds decorative.
 *
 * **One act, one door.** Scoping is not a field on an edit form here, it is its own function
 * for all three kinds of thing, because it is not an attribute of the work — it is a change to
 * who can reach it. `tasks.team_id` used to ride along in `updateTask`'s bulk write, with no
 * reason recorded and no check that the team was even in this organization; it comes through
 * here now like the other two.
 *
 * **A reason, and no step-up.** `addTeamMember` requires a reason and no fresh proof, and this
 * is the same access change from the other side — a person joining work, or work joining
 * people. Requiring more of one than the other would only mean somebody routes around the
 * stricter one. Taking work *out* narrows, and asks for a reason anyway, exactly as
 * `removeTeamMember` does: the direction rule is about proof, not about the record.
 *
 * **Three literal statements rather than one interpolated table name.** An identifier passed
 * through `sql()` is invisible to the column detector, which is how a column stays on the
 * "written by nothing" list while being written — the blind spot its own header states. The
 * repetition is the price of the instrument telling the truth.
 */

export type TeamScopedEntity = 'task' | 'project' | 'document'

export interface TeamScopeOption {
  id: string
  name: string
  memberCount: number
  /**
   * How many of those people could actually open this row. A team whose members all read
   * below its classification is a scope that grants nothing, and the person choosing has to
   * be able to see that before they choose rather than afterwards.
   */
  clearedCount: number
}

export interface TeamScopeView {
  entity: TeamScopedEntity
  id: string
  label: string
  sensitivity: Sensitivity
  teamId: string | null
  teamName: string | null
  options: TeamScopeOption[]
  /** Whether this actor may change it — so a page can say why not instead of showing a dead control. */
  canScope: boolean
  refusal: string | null
}

interface ScopedRow {
  label: string
  sensitivity: Sensitivity
  teamId: string | null
  /** The resource as `can()` should see it, assembled the way the owning repository assembles it. */
  resource: Record<string, unknown>
  action: string
}

/**
 * Reads the row through its own repository first, so the read gate that governs it is the one
 * that governs this — a row somebody cannot open is a row they cannot move, and a row in
 * another tenant is a 404 here because it is a 404 there (§3.2).
 *
 * The second query fetches only what the view does not carry. `TaskView` has no `sensitivity`
 * of its own and no `createdBy`; a document has no `createdBy` on its view either.
 */
async function loadScoped(
  ctx: TenantContext,
  actor: Actor,
  entity: TeamScopedEntity,
  id: string,
): Promise<ScopedRow> {
  if (entity === 'task') {
    const task = await getTask(ctx, actor, id)
    const [row] = await ctx.sql<{ sensitivity: Sensitivity }[]>`
      SELECT sensitivity FROM tasks
      WHERE organization_id = ${ctx.organizationId} AND id = ${id} AND deleted_at IS NULL`
    if (!row) throw new NotFoundError()
    return {
      label: task.title,
      sensitivity: row.sensitivity,
      teamId: task.teamId,
      action: 'task:update',
      resource: {
        type: 'task',
        id: task.id,
        organizationId: ctx.organizationId,
        assigneeId: task.assigneeId,
        departmentId: task.departmentId,
        teamIds: task.teamId ? [task.teamId] : [],
        riskTier: 'low',
      },
    }
  }

  if (entity === 'project') {
    const project = await getProject(ctx, actor, id)
    return {
      label: project.name,
      sensitivity: project.sensitivity,
      teamId: project.teamId,
      action: 'project:update',
      resource: {
        type: 'project',
        id: project.id,
        organizationId: ctx.organizationId,
        ownerId: project.ownerId,
        createdBy: project.createdBy,
        departmentId: project.departmentId,
        teamIds: project.teamId ? [project.teamId] : [],
        riskTier: 'low',
      },
    }
  }

  const document = await getDocument(ctx, actor, id)
  return {
    label: document.title,
    sensitivity: document.sensitivity,
    teamId: document.teamId,
    action: 'document:update',
    resource: {
      type: 'document',
      id: document.id,
      organizationId: ctx.organizationId,
      ownerId: document.ownerId,
      departmentId: document.departmentId,
      teamIds: document.teamId ? [document.teamId] : [],
      riskTier: 'low',
    },
  }
}

/**
 * The teams this may be moved to, and how much good each would do.
 *
 * The cleared count is computed here from the policy engine's own `ROLE_MAX_SENSITIVITY`
 * rather than in SQL, deliberately: writing the ceiling table into a query would be a second
 * copy of the rule, and two copies of a rule about who can read what is how they drift. The
 * rows are still SQL's — this only reads the table the policy engine already reads.
 */
async function teamOptions(ctx: TenantContext, sensitivity: Sensitivity): Promise<TeamScopeOption[]> {
  const teams = await ctx.sql<{ id: string; name: string }[]>`
    SELECT id, name FROM teams
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
    ORDER BY name`
  if (teams.length === 0) return []

  const members = await ctx.sql<{ teamId: string; role: Role }[]>`
    SELECT tm.team_id AS "teamId", m.role
    FROM team_members tm
    JOIN memberships m ON m.user_id = tm.user_id AND m.organization_id = tm.organization_id
    WHERE tm.organization_id = ${ctx.organizationId} AND tm.deleted_at IS NULL
      AND m.deleted_at IS NULL AND m.status = 'active'`

  const wanted = SENSITIVITY_RANK[sensitivity]
  return teams.map((team) => {
    const theirs = members.filter((member) => member.teamId === team.id)
    return {
      id: team.id,
      name: team.name,
      memberCount: theirs.length,
      clearedCount: theirs.filter(
        (member) => SENSITIVITY_RANK[ROLE_MAX_SENSITIVITY[member.role]] >= wanted,
      ).length,
    }
  })
}

/** What the control needs to draw itself: where this sits, where it could go, and whether you may move it. */
export async function teamScope(
  ctx: TenantContext,
  actor: Actor,
  entity: TeamScopedEntity,
  id: string,
): Promise<TeamScopeView> {
  const row = await loadScoped(ctx, actor, entity, id)
  const decision = can(actor, row.action, row.resource as never)

  // The picker is only assembled for somebody who could act on it. Where this row sits is
  // part of reading it and is answered either way; the list of teams and how many people are
  // on each is what a person about to move it needs, and nothing a reader is owed.
  const options = decision.allow ? await teamOptions(ctx, row.sensitivity) : []

  const [current] = row.teamId
    ? await ctx.sql<{ name: string }[]>`
        SELECT name FROM teams
        WHERE organization_id = ${ctx.organizationId} AND id = ${row.teamId} AND deleted_at IS NULL`
    : []

  return {
    entity,
    id,
    label: row.label,
    sensitivity: row.sensitivity,
    teamId: row.teamId,
    teamName: current?.name ?? null,
    options,
    canScope: decision.allow,
    refusal: decision.allow ? null : decision.reason,
  }
}

/**
 * Moves it, or takes it out.
 *
 * The team is checked here so somebody is told what is wrong, and again by
 * `sw_team_scope_same_org` so it holds for every writer — including the one that goes round
 * this function. A team that has been disbanded is refused for the same reason a team in
 * another organization is: the work would sit in a scope nobody can open, looking ordinary.
 */
export async function setTeamScope(
  ctx: TenantContext,
  actor: Actor,
  input: { entity: TeamScopedEntity; id: string; teamId: string | null; reason: string },
): Promise<TeamScopeView> {
  const before = await loadScoped(ctx, actor, input.entity, input.id)

  const decision = can(actor, before.action, before.resource as never)
  if (!decision.allow) {
    throw new PermissionError(
      `${decision.reason} Scoping work to a team is a change to who can reach it, so it needs a say ` +
        'over the work rather than a read of it.',
    )
  }

  const reason = input.reason.trim()
  if (reason.length < 4) {
    throw new ValidationError(
      'Say why. Putting work in a team is a grant of access, and access wants a reason — the same ' +
        'one asked for when a person joins the team.',
    )
  }

  if (input.teamId === before.teamId) {
    throw new ValidationError(
      before.teamId ? 'It is already scoped to that team.' : 'It is already scoped to no team.',
    )
  }

  let target: { id: string; name: string } | null = null
  if (input.teamId) {
    const [team] = await ctx.sql<{ id: string; name: string }[]>`
      SELECT id, name FROM teams
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.teamId} AND deleted_at IS NULL`
    if (!team) throw new NotFoundError()
    target = team
  }

  // Three statements, one act. See the module header: an interpolated table name would hide
  // two of these three columns from the detector that found they had no writer.
  if (input.entity === 'task') {
    await ctx.sql`
      UPDATE tasks SET team_id = ${input.teamId}, updated_at = now()
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.id} AND deleted_at IS NULL`
  } else if (input.entity === 'project') {
    await ctx.sql`
      UPDATE projects SET team_id = ${input.teamId}, updated_at = now()
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.id} AND deleted_at IS NULL`
  } else {
    await ctx.sql`
      UPDATE documents SET team_id = ${input.teamId}, updated_at = now()
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.id} AND deleted_at IS NULL`
  }

  const after = await teamScope(ctx, actor, input.entity, input.id)
  const gained = after.options.find((option) => option.id === after.teamId)

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'work.team_scoped',
    entityType: input.entity,
    entityId: input.id,
    before: { teamId: before.teamId },
    after: {
      teamId: input.teamId,
      team: target?.name ?? null,
      reason,
      // What the change is actually worth: people who gain a route to it, and how many of
      // them are cleared to read at its classification.
      reaches: gained?.memberCount ?? 0,
      cleared: gained?.clearedCount ?? 0,
    },
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.agent?.agentName ?? actor.displayName,
    verb: 'scoped',
    entityType: input.entity,
    entityId: input.id,
    entityLabel: before.label,
    summary: target
      ? `“${before.label}” is scoped to ${target.name}, put there by ${actor.displayName}. ${reason}`
      : `“${before.label}” is no longer scoped to a team, taken out by ${actor.displayName}. ${reason}`,
  })

  return after
}
