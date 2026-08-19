import type { TenantContext } from '@superwork/db'
import type { Role, Sensitivity } from '@superwork/db'
import { lowerSensitivity } from './policy.js'
import type { Actor, AgentActorFacet } from './policy.js'

interface ActorRow {
  user_id: string
  name: string
  role: Role
  department_id: string | null
  extra_permissions: string[] | null
  team_ids: string[] | null
}

/** Loads the acting human. Requires a TenantContext — there is no un-scoped path. */
export async function loadActor(ctx: TenantContext, userId = ctx.userId): Promise<Actor> {
  const rows = await ctx.sql<ActorRow[]>`
    SELECT m.user_id,
           u.name,
           m.role,
           m.department_id,
           -- Exceptions this person holds right now (ADR 0055). Read from the grants table
           -- rather than from a column kept in step with it, because an expiry has to be exact:
           -- a permission that lingers until a sweep runs is one that outlives its reason.
           (SELECT array_agg(g.permission)
              FROM permission_grants g
             WHERE g.organization_id = m.organization_id AND g.user_id = m.user_id
               AND g.revoked_at IS NULL AND g.deleted_at IS NULL
               AND (g.expires_at IS NULL OR g.expires_at > now())) AS extra_permissions,
           array_remove(array_agg(tm.team_id), NULL) AS team_ids
    FROM memberships m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN team_members tm ON tm.user_id = m.user_id AND tm.deleted_at IS NULL
    WHERE m.user_id = ${userId}
      AND m.organization_id = ${ctx.organizationId}
      AND m.deleted_at IS NULL
      AND m.status = 'active'
    GROUP BY m.user_id, u.name, m.role, m.department_id, m.organization_id`

  const row = rows[0]
  if (!row) throw new Error('Not found.')

  const departmentIds = row.department_id ? [row.department_id] : []
  const teamIds = row.team_ids ?? []

  // Relation tuples are loaded with the actor, once, so `can()` stays synchronous. The
  // cap is deliberate: an actor holding thousands of individual grants is a modelling
  // problem, and silently loading them all would make every request pay for it (§4.6).
  const tuples = await ctx.sql<{ relation: string; object_type: string; object_id: string }[]>`
    SELECT relation, object_type, object_id FROM relation_tuples
    WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
      AND (expires_at IS NULL OR expires_at > now())
      AND (
        (subject_type = 'user' AND subject_id = ${userId})
        OR (subject_type = 'team' AND subject_id = ANY(${teamIds}::uuid[]))
        OR (subject_type = 'department' AND subject_id = ANY(${departmentIds}::uuid[]))
      )
    LIMIT 1000`

  // The projects this person is on. Read fresh with the actor, like the tuples, so that
  // adding somebody to a project takes effect on their next request rather than whenever a
  // cache expires — and taking them off does the same.
  const roster = await ctx.sql<{ project_id: string }[]>`
    SELECT pm.project_id FROM project_members pm
    JOIN projects p ON p.id = pm.project_id AND p.deleted_at IS NULL
    WHERE pm.organization_id = ${ctx.organizationId} AND pm.user_id = ${userId} AND pm.deleted_at IS NULL
    LIMIT 1000`

  return {
    type: 'user',
    userId: row.user_id,
    organizationId: ctx.organizationId,
    role: row.role,
    displayName: row.name,
    departmentIds,
    teamIds,
    extraPermissions: row.extra_permissions ?? [],
    relations: new Set(tuples.map((tuple) => `${tuple.relation}:${tuple.object_type}:${tuple.object_id}`)),
    projectIds: roster.map((entry) => entry.project_id),
    // Only the actor for *this* request carries the session's proof. Loading somebody
    // else's actor must never hand them this request's step-up.
    steppedUpAt: userId === ctx.userId ? ctx.steppedUpAt : null,
  }
}

export interface AgentFacetInput {
  agentId: string
  agentName: string
  mode: AgentActorFacet['mode']
  toolGrants: string[]
  maxSensitivity: Sensitivity
  capabilityDowngraded?: boolean
}

/**
 * Wraps a human actor as an agent acting on their behalf. The agent can never exceed
 * the human — that is enforced structurally by deriving from their Actor (§4.4).
 */
export async function asAgent(
  ctx: TenantContext,
  principal: Actor,
  input: AgentFacetInput,
): Promise<Actor> {
  const grants = await ctx.sql<
    { capability: string; tool_pattern: string; effect: string; max_sensitivity: Sensitivity }[]
  >`
    SELECT capability, tool_pattern, effect, max_sensitivity
    FROM agent_permissions
    WHERE organization_id = ${ctx.organizationId}
      AND deleted_at IS NULL
      AND (department_id IS NULL OR department_id = ANY(${principal.departmentIds}::uuid[]))`

  // `deny` rows used to be filtered out and dropped, so a deny grant had never denied
  // anything. Deny wins wherever both match, which is the only rule under which writing one
  // down is worth doing.
  const denied = grants.filter((g) => g.effect === 'deny').map((g) => g.tool_pattern)
  const orgGrant = grants
    .filter((g) => g.effect === 'allow')
    .map((g) => g.tool_pattern)
    .filter((pattern) => !denied.includes(pattern))

  // The clearance ceiling on the row was never read either. The lowest of the agent's own
  // limit and every grant that applies to this person wins: a ceiling that a caller's
  // argument could raise is not a ceiling.
  const orgCeiling = grants.reduce<Sensitivity>(
    (lowest, grant) => lowerSensitivity(lowest, grant.max_sensitivity),
    'restricted',
  )

  return {
    ...principal,
    type: 'agent',
    agent: {
      agentId: input.agentId,
      agentName: input.agentName,
      mode: input.mode,
      orgGrant,
      denied,
      toolGrants: input.toolGrants,
      maxSensitivity: lowerSensitivity(input.maxSensitivity, orgCeiling),
      capabilityDowngraded: input.capabilityDowngraded ?? false,
    },
  }
}

export async function killSwitchEngaged(ctx: TenantContext): Promise<boolean> {
  const rows = await ctx.sql<{ agent_kill_switch: boolean }[]>`
    SELECT agent_kill_switch FROM organizations WHERE id = ${ctx.organizationId}`
  return rows[0]?.agent_kill_switch ?? false
}
