import type { TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeActivity, writeAudit } from '../audit.js'

/**
 * Teams (§4.3, §12).
 *
 * `teams` and `team_members` were created in migration 0001 and nothing has ever written to
 * either. What that cost is bigger than two empty tables: the `team` scope in the policy
 * engine has never once evaluated true, and every permission the `guest` role holds is
 * team-scoped. A guest has therefore been able to read nothing at all since Phase 0, while
 * the denial says "You need Member access" — which reads like a considered policy rather
 * than a dimension that was never built.
 *
 * A team is deliberately not a department. A department is where somebody sits in the
 * organization and there is exactly one of them per person; a team is what somebody is
 * working on, there can be several, and people join and leave them constantly. The two
 * scopes exist separately in the policy engine for that reason, and this fills in the one
 * that had no data behind it.
 */

export interface TeamMemberView {
  userId: string
  name: string
  role: 'lead' | 'member'
  reason: string | null
  joinedAt: Date
}

export interface TeamView {
  id: string
  name: string
  purpose: string | null
  departmentId: string | null
  departmentName: string | null
  members: TeamMemberView[]
  /** What is scoped to this team right now, so archiving can say what it would orphan. */
  counts: { tasks: number; projects: number; documents: number }
  createdAt: Date
}

/** Creating and disbanding teams is org structure, so it sits with the people who own that. */
function guardWrite(ctx: TenantContext, actor: Actor): void {
  const decision = can(actor, 'member:update', {
    type: 'member',
    organizationId: ctx.organizationId,
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
}

function guardRead(ctx: TenantContext, actor: Actor): void {
  const decision = can(actor, 'member:read', { type: 'member', organizationId: ctx.organizationId })
  if (!decision.allow) throw new PermissionError(decision.reason)
}

export async function listTeams(ctx: TenantContext, actor: Actor): Promise<TeamView[]> {
  guardRead(ctx, actor)
  const sql = ctx.sql

  const teams = await sql<
    {
      id: string
      name: string
      purpose: string | null
      department_id: string | null
      department_name: string | null
      created_at: Date
      tasks: number
      projects: number
      documents: number
    }[]
  >`
    SELECT t.id, t.name, t.purpose, t.department_id, d.name AS department_name, t.created_at,
           (SELECT count(*)::int FROM tasks x
             WHERE x.organization_id = t.organization_id AND x.team_id = t.id AND x.deleted_at IS NULL) AS tasks,
           (SELECT count(*)::int FROM projects x
             WHERE x.organization_id = t.organization_id AND x.team_id = t.id AND x.deleted_at IS NULL) AS projects,
           (SELECT count(*)::int FROM documents x
             WHERE x.organization_id = t.organization_id AND x.team_id = t.id AND x.deleted_at IS NULL) AS documents
    FROM teams t
    LEFT JOIN departments d ON d.id = t.department_id
    WHERE t.organization_id = ${ctx.organizationId} AND t.deleted_at IS NULL
    ORDER BY t.name`

  if (teams.length === 0) return []

  const members = await sql<
    { team_id: string; user_id: string; name: string; role: 'lead' | 'member'; reason: string | null; created_at: Date }[]
  >`
    SELECT tm.team_id, tm.user_id, u.name, tm.role, tm.reason, tm.created_at
    FROM team_members tm JOIN users u ON u.id = tm.user_id
    WHERE tm.organization_id = ${ctx.organizationId} AND tm.deleted_at IS NULL
      AND tm.team_id = ANY(${teams.map((team) => team.id)}::uuid[])
    ORDER BY tm.role, u.name`

  return teams.map((team) => ({
    id: team.id,
    name: team.name,
    purpose: team.purpose,
    departmentId: team.department_id,
    departmentName: team.department_name,
    members: members
      .filter((member) => member.team_id === team.id)
      .map((member) => ({
        userId: member.user_id,
        name: member.name,
        role: member.role,
        reason: member.reason,
        joinedAt: member.created_at,
      })),
    counts: { tasks: team.tasks, projects: team.projects, documents: team.documents },
    createdAt: team.created_at,
  }))
}

export async function createTeam(
  ctx: TenantContext,
  actor: Actor,
  input: { name: string; purpose?: string | null; departmentId?: string | null },
): Promise<TeamView> {
  guardWrite(ctx, actor)
  const name = input.name.trim()
  if (name.length < 2) throw new ValidationError('A team needs a name somebody would recognise.')

  const [existing] = await ctx.sql<{ id: string }[]>`
    SELECT id FROM teams
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
      AND lower(btrim(name)) = lower(${name})`
  if (existing) {
    throw new ValidationError(
      `There is already a team called “${name}”. Two teams with one name is how a document ends up ` +
        'shared with the wrong half of the company.',
    )
  }

  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO teams (organization_id, name, purpose, department_id, created_by)
    VALUES (${ctx.organizationId}, ${name}, ${input.purpose?.trim() || null}, ${input.departmentId ?? null}, ${ctx.userId})
    RETURNING id`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'team.created',
    entityType: 'team',
    entityId: row!.id,
    after: { name, purpose: input.purpose?.trim() ?? null },
  })
  return (await listTeams(ctx, actor)).find((team) => team.id === row!.id)!
}

export async function updateTeam(
  ctx: TenantContext,
  actor: Actor,
  input: { teamId: string; name?: string; purpose?: string | null; departmentId?: string | null },
): Promise<TeamView> {
  guardWrite(ctx, actor)
  const [before] = await ctx.sql<{ name: string }[]>`
    SELECT name FROM teams
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.teamId} AND deleted_at IS NULL`
  if (!before) throw new NotFoundError()

  const name = input.name?.trim() ?? before.name
  if (name.length < 2) throw new ValidationError('A team needs a name somebody would recognise.')

  await ctx.sql`
    UPDATE teams SET
      name = ${name},
      purpose = ${input.purpose !== undefined ? input.purpose?.trim() || null : ctx.sql`purpose`},
      department_id = ${input.departmentId !== undefined ? input.departmentId : ctx.sql`department_id`}
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.teamId}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'team.updated',
    entityType: 'team',
    entityId: input.teamId,
    before: { name: before.name },
    after: { name },
  })
  return (await listTeams(ctx, actor)).find((team) => team.id === input.teamId)!
}

/**
 * Disbands a team.
 *
 * Refused while anything is still scoped to it, because the rows would keep a `team_id`
 * pointing at a team nobody can see — and everybody whose access to that work came through
 * the team would lose it with no visible cause. Move the work first.
 */
export async function archiveTeam(
  ctx: TenantContext,
  actor: Actor,
  input: { teamId: string; reason: string },
): Promise<void> {
  guardWrite(ctx, actor)
  if (input.reason.trim().length < 4) throw new ValidationError('Say why it is being disbanded.')

  const team = (await listTeams(ctx, actor)).find((candidate) => candidate.id === input.teamId)
  if (!team) throw new NotFoundError()

  const scoped = team.counts.tasks + team.counts.projects + team.counts.documents
  if (scoped > 0) {
    throw new ValidationError(
      `${scoped} ${scoped === 1 ? 'thing is' : 'things are'} still scoped to “${team.name}” — ` +
        `${team.counts.tasks} tasks, ${team.counts.projects} projects, ${team.counts.documents} documents. ` +
        'Move them first, or everybody who reached them through this team loses them with no visible reason.',
    )
  }

  await ctx.sql`
    UPDATE team_members SET deleted_at = now()
    WHERE organization_id = ${ctx.organizationId} AND team_id = ${input.teamId} AND deleted_at IS NULL`
  await ctx.sql`
    UPDATE teams SET deleted_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.teamId}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'team.archived',
    entityType: 'team',
    entityId: input.teamId,
    before: { name: team.name, members: team.members.length },
    after: { reason: input.reason.trim() },
  })
}

/**
 * Adds somebody to a team.
 *
 * This is a grant of access, not an org chart edit: everything scoped to the team becomes
 * readable by them on their next request, because `loadActor` reads team membership fresh
 * each time. So it is audited as one, with a reason.
 */
export async function addTeamMember(
  ctx: TenantContext,
  actor: Actor,
  input: { teamId: string; userId: string; role?: 'lead' | 'member'; reason: string },
): Promise<TeamView> {
  guardWrite(ctx, actor)
  if (input.reason.trim().length < 4) {
    throw new ValidationError('Say why they are joining. Membership is access, and access wants a reason.')
  }

  const [team] = await ctx.sql<{ name: string }[]>`
    SELECT name FROM teams
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.teamId} AND deleted_at IS NULL`
  if (!team) throw new NotFoundError()

  const [member] = await ctx.sql<{ name: string }[]>`
    SELECT u.name FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = ${ctx.organizationId} AND m.user_id = ${input.userId}
      AND m.deleted_at IS NULL AND m.status = 'active'`
  if (!member) throw new ValidationError('That person is not a member of this organization.')

  await ctx.sql`
    INSERT INTO team_members (organization_id, team_id, user_id, role, reason, created_by)
    VALUES (${ctx.organizationId}, ${input.teamId}, ${input.userId}, ${input.role ?? 'member'},
            ${input.reason.trim()}, ${ctx.userId})
    ON CONFLICT (team_id, user_id) WHERE deleted_at IS NULL
    DO UPDATE SET role = EXCLUDED.role, reason = EXCLUDED.reason`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'team.member_added',
    entityType: 'team',
    entityId: input.teamId,
    after: { team: team.name, member: member.name, role: input.role ?? 'member', reason: input.reason.trim() },
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'added',
    entityType: 'team',
    entityId: input.teamId,
    entityLabel: team.name,
    summary: `${member.name} joined ${team.name} as ${input.role ?? 'member'}. ${input.reason.trim()}`,
  })

  return (await listTeams(ctx, actor)).find((candidate) => candidate.id === input.teamId)!
}

export async function removeTeamMember(
  ctx: TenantContext,
  actor: Actor,
  input: { teamId: string; userId: string; reason: string },
): Promise<TeamView> {
  guardWrite(ctx, actor)
  if (input.reason.trim().length < 4) throw new ValidationError('Say why they are leaving.')

  const [removed] = await ctx.sql<{ id: string }[]>`
    UPDATE team_members SET deleted_at = now()
    WHERE organization_id = ${ctx.organizationId} AND team_id = ${input.teamId}
      AND user_id = ${input.userId} AND deleted_at IS NULL
    RETURNING id`
  if (!removed) throw new NotFoundError()

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'team.member_removed',
    entityType: 'team',
    entityId: input.teamId,
    before: { member: input.userId },
    after: { reason: input.reason.trim() },
  })
  return (await listTeams(ctx, actor)).find((candidate) => candidate.id === input.teamId)!
}
