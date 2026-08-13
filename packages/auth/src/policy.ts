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
    return DENY(explainMissing(actor, resourceType, verb, resource))
  }
  return ALLOW(`Allowed by ${actor.role} role (${resourceType}:${verb}:${best}).`)
}

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
  const sensitivity: Sensitivity = resource.sensitivity ?? 'internal'
  const ceiling = actor.agent
    ? lowerSensitivity(ROLE_MAX_SENSITIVITY[actor.role], actor.agent.maxSensitivity)
    : ROLE_MAX_SENSITIVITY[actor.role]

  if (!sensitivityAtMost(sensitivity, ceiling)) {
    return DENY(
      `This ${resource.type} is classified ${sensitivity}. Your access covers up to ${ceiling}. The document owner or an admin can grant access.`,
    )
  }
  return ALLOW('Within data classification clearance.')
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
