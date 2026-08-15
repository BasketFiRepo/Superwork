import type { AgentMode, RiskTier, Role, Sensitivity } from '@superwork/db'
import {
  ROLE_MAX_SENSITIVITY,
  ROLE_PERMISSIONS,
  SCOPE_RANK,
  parsePermission,
  sensitivityAtMost,
  type PermissionScope,
} from './permissions.js'

export interface Actor {
  type: 'user' | 'agent' | 'system' | 'integration'
  userId: string
  organizationId: string
  role: Role
  displayName: string
  departmentIds: string[]
  teamIds: string[]
  /** Explicit grants layered on top of the role baseline. */
  extraPermissions: string[]
  /**
   * Relation tuples this actor holds, as `relation:object_type:object_id` (§4.6). Loaded
   * once with the actor so a permission check stays synchronous and in-memory — the
   * §26.9 budget for a check is 10 ms, and a query per check would not make it.
   */
  relations?: ReadonlySet<string>
  /**
   * When this actor's session last re-proved its identity (§4.1), or null.
   *
   * Deliberately *not* an input to `can()`. A permission answers "may this person do this
   * at all"; step-up answers "is the person who may do it still the one at the keyboard".
   * Folding the second into the first would make a clean, synchronous, cacheable decision
   * depend on the freshness of a cookie.
   */
  steppedUpAt?: Date | null
  /** Present when the actor is an agent acting on behalf of `userId`. */
  agent?: AgentActorFacet
}

export interface AgentActorFacet {
  agentId: string
  agentName: string
  mode: AgentMode
  /** Admin-configured ceiling for the organization/department (§4.4). */
  orgGrant: string[]
  toolGrants: string[]
  maxSensitivity: Sensitivity
  /** True when the run's context contains untrusted external content (§5.9.3). */
  capabilityDowngraded: boolean
}

export interface Resource {
  type: string
  id?: string
  organizationId: string
  ownerId?: string | null
  assigneeId?: string | null
  createdBy?: string | null
  departmentId?: string | null
  teamIds?: string[]
  sensitivity?: Sensitivity
  /**
   * What this row belongs to — a task's project, say (§4.6).
   *
   * A share of a container reaches what the container holds, for *reading only*. Without
   * it, "I shared the project with you" and "you can see none of its work" are both true,
   * which is the same hole circulation lists had before ADR 0023.
   *
   * `sensitivity` is the *container's* classification, and it is not optional in spirit: a
   * container the actor is not cleared to open cannot lend a read of what is inside it,
   * or a classification becomes a door with a window next to it.
   */
  containers?: Array<{ type: string; id: string; sensitivity?: Sensitivity }>
  /** For tool authorization: the risk tier of the operation being attempted. */
  riskTier?: RiskTier
}

export interface PolicyContext {
  /** Kill switch halts every agent action within the organization (§4.4). */
  killSwitch?: boolean
  now?: Date
}

export interface Decision {
  allow: boolean
  /** Human-readable and surfaced in the UI. Never a bare 403 (§4.2). */
  reason: string
  redactions?: string[]
  /** Set when the action is permitted but policy requires a human decision first. */
  requiresApproval?: boolean
}

const ALLOW = (reason: string, extra: Partial<Decision> = {}): Decision => ({ allow: true, reason, ...extra })
const DENY = (reason: string, extra: Partial<Decision> = {}): Decision => ({ allow: false, reason, ...extra })

/**
 * The single authorization function (§4.2). The API layer, the UI and the agent tool
 * layer all call this — one implementation, three consumers.
 */
export function can(actor: Actor, action: string, resource: Resource, context: PolicyContext = {}): Decision {
  if (actor.organizationId !== resource.organizationId) {
    // Cross-tenant attempts are indistinguishable from "does not exist" (§3.2).
    return DENY('Not found.')
  }

  if (actor.agent && context.killSwitch) {
    return DENY('Agent execution is halted organization-wide by the admin kill switch.')
  }

  const [resourceType, verb] = splitAction(action, resource.type)

  const humanDecision = checkHumanPermissions(actor, resourceType, verb, resource)
  if (!humanDecision.allow) return humanDecision

  const clearance = checkClearance(actor, resource)
  if (!clearance.allow) return clearance

  if (!actor.agent) {
    return ALLOW(humanDecision.reason, clearance.redactions ? { redactions: clearance.redactions } : {})
  }

  // The agent's capability is the intersection of everything above with its own limits.
  return intersectAgent(actor, actor.agent, resourceType, verb, resource, clearance.redactions)
}

function splitAction(action: string, resourceType: string): [string, string] {
  if (action.includes(':')) {
    const [a, b] = action.split(':')
    return [a ?? resourceType, b ?? 'read']
  }
  return [resourceType, action]
}

function checkHumanPermissions(actor: Actor, resourceType: string, verb: string, resource: Resource): Decision {
  const grants = [...ROLE_PERMISSIONS[actor.role], ...actor.extraPermissions]
  let best: PermissionScope | null = null

  for (const raw of grants) {
    let grant
    try {
      grant = parsePermission(raw)
    } catch {
      continue
    }
    if (grant.resource !== '*' && grant.resource !== resourceType) continue
    if (grant.action !== '*' && grant.action !== verb) continue
    if (!scopeSatisfied(grant.scope, actor, resource)) continue
    if (best === null || SCOPE_RANK[grant.scope] > SCOPE_RANK[best]) best = grant.scope
  }

  if (best === null) {
    // Roles say what a kind of person may do. A relation tuple says what *this* person may
    // do with *this* thing — which is how sharing works without changing anybody's role.
    const granted = relationGrant(actor, resourceType, verb, resource)
    if (granted) return ALLOW(granted)
    return DENY(explainMissing(actor, resourceType, verb, resource))
  }
  return ALLOW(`Allowed by ${actor.role} role (${resourceType}:${verb}:${best}).`)
}

/** The weakest relation that satisfies a verb. Ordered, so `owner` satisfies everything. */
const RELATION_FOR_VERB: Record<string, string[]> = {
  read: ['viewer', 'editor', 'approver', 'owner'],
  create: ['editor', 'owner'],
  update: ['editor', 'owner'],
  complete: ['editor', 'owner'],
  share_external: ['owner'],
  delete: ['owner'],
  decide: ['approver', 'owner'],
  approve: ['approver', 'owner'],
}

function relationGrant(actor: Actor, resourceType: string, verb: string, resource: Resource): string | null {
  if (!actor.relations || actor.relations.size === 0) return null
  const accepted = RELATION_FOR_VERB[verb]
  if (!accepted) return null

  // A tuple names the *object*, and the object's kind is not always the word the permission
  // catalogue uses for its domain: a knowledge space is `knowledge_space` as a row and
  // `knowledge` as a permission. Looking a tuple up under the action's prefix alone meant a
  // shared knowledge space could never satisfy `knowledge:read`. Both are checked, and the
  // object's own type is the one that matters.
  const objectTypes = resourceType === resource.type ? [resource.type] : [resource.type, resourceType]
  if (resource.id) {
    for (const relation of accepted) {
      for (const type of objectTypes) {
        if (actor.relations.has(`${relation}:${type}:${resource.id}`)) {
          return `Allowed because this ${type.replace(/_/g, ' ')} is shared with you as ${relation}.`
        }
      }
    }
  }

  // A container grant is deliberately read-only, whatever relation it carries. Sharing a
  // project is a coarse act — the set of tasks inside it changes daily and the granter
  // cannot see what they are handing over — so it lends the ability to look, never the
  // ability to change. Write access is granted on the row itself, where it can be seen.
  if (verb !== 'read') return null
  for (const container of resource.containers ?? []) {
    // Being handed a container you are not cleared to open lends you nothing inside it.
    // Without this, a project classified above the recipient stayed shut while its tasks
    // opened — a locked door with the window left ajar.
    if (container.sensitivity !== undefined && !sensitivityAtMost(container.sensitivity, readCeiling(actor))) {
      continue
    }
    for (const relation of ALL_RELATIONS) {
      if (actor.relations.has(`${relation}:${container.type}:${container.id}`)) {
        return `Allowed because the ${container.type.replace(/_/g, ' ')} it belongs to is shared with you as ${relation}. That lends you a read of what is inside it, not a say over it.`
      }
    }
  }
  return null
}

const ALL_RELATIONS = ['viewer', 'editor', 'approver', 'owner'] as const

function scopeSatisfied(scope: PermissionScope, actor: Actor, resource: Resource): boolean {
  switch (scope) {
    case 'org':
      return true
    case 'department':
      return !!resource.departmentId && actor.departmentIds.includes(resource.departmentId)
    case 'team':
      return (resource.teamIds ?? []).some((t) => actor.teamIds.includes(t))
    case 'own':
      return (
        resource.ownerId === actor.userId ||
        resource.assigneeId === actor.userId ||
        resource.createdBy === actor.userId
      )
  }
}

function explainMissing(actor: Actor, resourceType: string, verb: string, resource: Resource): string {
  const needed = requiredRoleFor(resourceType, verb)
  const where = resource.departmentId ? ' in this department' : ''
  return `You need ${needed} access${where} to ${verb.replace(/_/g, ' ')} this ${resourceType.replace(/_/g, ' ')}. An organization admin can grant it in Settings → Members.`
}

function requiredRoleFor(resourceType: string, verb: string): string {
  for (const role of ['member', 'manager', 'admin'] as Role[]) {
    const grants = ROLE_PERMISSIONS[role]
    if (
      grants.some((raw) => {
        const g = parsePermission(raw)
        return (g.resource === '*' || g.resource === resourceType) && (g.action === '*' || g.action === verb)
      })
    ) {
      return role.charAt(0).toUpperCase() + role.slice(1)
    }
  }
  return 'Admin'
}

function checkClearance(actor: Actor, resource: Resource): Decision {
  // Only a resource that actually carries a classification is checked against one. This
  // used to default an absent classification to `internal`, which silently put every
  // unclassified resource — tasks, projects and notes have no classification column at all
  // — above the guest ceiling of `public`. That was the fourth independent reason the guest
  // role could read nothing, and the least visible: the denial talked about classification
  // for a resource that has none.
  //
  // The blast radius is exactly the guest role. Every other role's ceiling is `internal` or
  // higher, so the old default was already satisfied for them. Anything that does carry a
  // classification — documents, chunks — still passes it and is still checked.
  if (resource.sensitivity === undefined) return ALLOW('This resource carries no data classification.')
  const sensitivity: Sensitivity = resource.sensitivity
  const ceiling = readCeiling(actor)

  if (!sensitivityAtMost(sensitivity, ceiling)) {
    return DENY(
      `This ${resource.type} is classified ${sensitivity}. Your access covers up to ${ceiling}. The document owner or an admin can grant access.`,
    )
  }
  return ALLOW('Within data classification clearance.')
}

/**
 * The highest classification this actor may read — their role's ceiling, lowered again by
 * the agent's own limit when one is acting. Exported because a list query needs the same
 * answer as `can()` does, and two implementations of it would drift.
 */
export function readCeiling(actor: Actor): Sensitivity {
  return actor.agent
    ? lowerSensitivity(ROLE_MAX_SENSITIVITY[actor.role], actor.agent.maxSensitivity)
    : ROLE_MAX_SENSITIVITY[actor.role]
}

function lowerSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  const rank: Sensitivity[] = ['public', 'internal', 'confidential', 'restricted']
  return rank.indexOf(a) <= rank.indexOf(b) ? a : b
}

/** Capability ceiling implied by each agent mode (§5.10). */
const MODE_CEILING: Record<AgentMode, RiskTier | 'none'> = {
  ask: 'read',
  assist: 'read', // may propose; drafts and writes need Execute
  execute: 'low',
  autopilot: 'low',
}

function intersectAgent(
  actor: Actor,
  agent: AgentActorFacet,
  resourceType: string,
  verb: string,
  resource: Resource,
  redactions: string[] | undefined,
): Decision {
  const risk: RiskTier = resource.riskTier ?? 'read'
  const ceiling = MODE_CEILING[agent.mode]

  if (agent.orgGrant.length > 0) {
    const covered = agent.orgGrant.some((raw) => matchesGrant(raw, resourceType, verb))
    if (!covered) {
      return DENY(
        `${agent.agentName} has no organization grant for ${resourceType}:${verb}. An admin can add it in Settings → AI Governance.`,
      )
    }
  }

  if (risk === 'read') {
    return ALLOW(`${agent.agentName} may read this.`, redactions ? { redactions } : {})
  }

  if (ceiling === 'read') {
    return DENY(
      `${agent.agentName} is in ${agent.mode} mode, which can propose but not change anything. Switch to Execute to let it act.`,
    )
  }

  if (risk === 'high') {
    if (agent.mode === 'autopilot') {
      // Irreversible or externally-visible actions can never be granted to Autopilot in v1 (§5.7).
      return DENY('Autopilot cannot take irreversible or externally visible actions. This needs a person.')
    }
    if (agent.capabilityDowngraded) {
      return ALLOW(
        'This run read untrusted external content, so high-risk actions require explicit approval.',
        { requiresApproval: true, ...(redactions ? { redactions } : {}) },
      )
    }
    return ALLOW('High-risk action — drafted and held for approval.', {
      requiresApproval: true,
      ...(redactions ? { redactions } : {}),
    })
  }

  // execute:low — reversible internal writes.
  if (agent.capabilityDowngraded && (resource.type === 'email_draft' || resource.type === 'email')) {
    return ALLOW('This run read untrusted external content, so outbound content requires approval.', {
      requiresApproval: true,
    })
  }
  return ALLOW(`${agent.agentName} may perform this reversible change.`, redactions ? { redactions } : {})
}

function matchesGrant(raw: string, resourceType: string, verb: string): boolean {
  const [r, a] = raw.split(':')
  return (r === '*' || r === resourceType) && (a === undefined || a === '*' || a === verb)
}

/**
 * Plain-language summary of what an agent may do, rendered on the grant surface (§27.2).
 */
/**
 * The broadest scope this actor holds for an action, ignoring any particular resource.
 *
 * `can()` answers "may this person touch *this* row", which a list query cannot ask before
 * it has the rows. This answers the question a list query actually has — "which rows am I
 * allowed to consider" — so the predicate can be pushed into SQL rather than the gate
 * being taken at organization level and quietly denying every role whose grant is narrower.
 *
 * That is what made the `guest` role unusable: all five of its grants are team-scoped, and
 * every list gated on an organization-level resource, so the answer was always no.
 */
export function grantedScope(actor: Actor, action: string, resourceType?: string): PermissionScope | null {
  const [type, verb] = splitAction(action, resourceType ?? '')
  const grants = [...ROLE_PERMISSIONS[actor.role], ...actor.extraPermissions]
  let best: PermissionScope | null = null

  for (const raw of grants) {
    let grant
    try {
      grant = parsePermission(raw)
    } catch {
      continue
    }
    if (grant.resource !== '*' && grant.resource !== type) continue
    if (grant.action !== '*' && grant.action !== verb) continue
    if (best === null || SCOPE_RANK[grant.scope] > SCOPE_RANK[best]) best = grant.scope
  }
  return best
}

/** The ids of objects of one type shared with this actor by relation tuple. */
export function sharedObjectIds(actor: Actor, resourceType: string): string[] {
  const ids: string[] = []
  for (const relation of actor.relations ?? []) {
    const [, type, id] = relation.split(':')
    if (type === resourceType && id) ids.push(id)
  }
  return [...new Set(ids)]
}

export function describeEffectiveCapability(actor: Actor): string {
  if (!actor.agent) return 'Acting as a person, not an agent.'
  const { agent } = actor
  const modeText: Record<AgentMode, string> = {
    ask: 'answer questions with citations and change nothing',
    assist: 'answer questions and propose plans, but execute nothing',
    execute: 'create and update internal records directly; anything irreversible or outbound is drafted for approval',
    autopilot: 'run pre-approved workflows on schedule, limited to reversible internal changes',
  }
  return [
    `${agent.agentName} can ${modeText[agent.mode]}.`,
    `It reads data classified up to ${lowerSensitivity(ROLE_MAX_SENSITIVITY[actor.role], agent.maxSensitivity)}.`,
    `It never exceeds the permissions of ${actor.displayName}, on whose behalf it acts.`,
  ].join(' ')
}
