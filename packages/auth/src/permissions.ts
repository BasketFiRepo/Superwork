import type { Role, Sensitivity } from '@superwork/db'

/**
 * Permission strings are `resource:action:scope` (§4.2).
 * `*` is a wildcard in the resource and action positions only — never in the scope
 * position, because a wildcard scope is how "manager of one team" quietly becomes
 * "manager of everything".
 */
export type PermissionScope = 'own' | 'team' | 'department' | 'org'

export const SCOPE_RANK: Record<PermissionScope, number> = { own: 0, team: 1, department: 2, org: 3 }

export interface Permission {
  resource: string
  action: string
  scope: PermissionScope
}

export function parsePermission(value: string): Permission {
  const [resource, action, scope] = value.split(':')
  if (!resource || !action || !scope) {
    throw new Error(`Malformed permission "${value}" — expected resource:action:scope`)
  }
  if (!(scope in SCOPE_RANK)) {
    throw new Error(`Unknown permission scope "${scope}" in "${value}"`)
  }
  return { resource, action, scope: scope as PermissionScope }
}

export function formatPermission(p: Permission): string {
  return `${p.resource}:${p.action}:${p.scope}`
}

/** Role baselines. Attributes refine these; they never widen them. */
export const ROLE_PERMISSIONS: Record<Role, string[]> = {
  owner: ['*:*:org'],
  admin: [
    '*:read:org',
    'task:*:org', 'project:*:org', 'document:*:org', 'knowledge:*:org',
    'company:*:org', 'contact:*:org', 'conversation:*:org', 'note:*:org',
    'email:draft:org', 'email:send:org',
    'approval:*:org', 'workflow:*:org', 'insight:*:org',
    'agent:*:org', 'agent_run:*:org', 'member:*:org', 'settings:*:org',
    'audit:read:org', 'billing:read:org', 'integration:*:org',
  ],
  manager: [
    '*:read:org',
    'task:*:department', 'task:*:team', 'task:*:own',
    'project:*:department', 'project:update:department', 'milestone:*:department',
    'document:create:department', 'document:update:department', 'document:share_external:department',
    'knowledge:*:department', 'note:*:department',
    'company:update:org', 'contact:*:org', 'conversation:update:org',
    'email:draft:org', 'email:send:department',
    'approval:decide:department', 'approval:request:org',
    'workflow:create:department', 'workflow:activate:department', 'workflow:simulate:department',
    'insight:*:department', 'agent_run:read:department', 'agent_run:create:own', 'agent_run:undo:own',
    'member:read:org',
  ],
  member: [
    'task:read:org', 'task:create:org', 'task:update:own', 'task:update:team', 'task:complete:own',
    'project:read:org', 'milestone:read:org',
    'document:read:org', 'document:create:own', 'document:update:own',
    'knowledge:read:org', 'knowledge:create:own', 'knowledge:update:own',
    'company:read:org', 'contact:read:org', 'contact:create:org', 'note:create:org', 'note:read:org',
    'conversation:read:org', 'email:draft:own',
    'approval:request:own', 'insight:read:own', 'insight:update:own',
    'agent_run:create:own', 'agent_run:read:own', 'agent_run:undo:own',
    'member:read:org', 'workflow:read:org',
  ],
  viewer: [
    'task:read:org', 'project:read:org', 'milestone:read:org', 'document:read:org',
    'knowledge:read:org', 'company:read:org', 'contact:read:org', 'conversation:read:org',
    'insight:read:own', 'agent_run:create:own', 'agent_run:read:own', 'member:read:org',
    'workflow:read:org',
  ],
  guest: [
    'task:read:team', 'project:read:team', 'document:read:team', 'note:create:team',
    'agent_run:create:own', 'agent_run:read:own',
  ],
  service: [],
}

/** Highest data classification each role may read at all (§4.3). */
export const ROLE_MAX_SENSITIVITY: Record<Role, Sensitivity> = {
  owner: 'restricted',
  admin: 'restricted',
  manager: 'confidential',
  member: 'internal',
  viewer: 'internal',
  guest: 'public',
  service: 'internal',
}

export const SENSITIVITY_RANK: Record<Sensitivity, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
}

export function sensitivityAtMost(value: Sensitivity, ceiling: Sensitivity): boolean {
  return SENSITIVITY_RANK[value] <= SENSITIVITY_RANK[ceiling]
}

/** Fields stripped from responses, prompts and logs when the actor lacks clearance. */
export const SENSITIVE_FIELDS: Record<string, string[]> = {
  user: ['password_hash', 'salary', 'bank_details'],
  document: ['storage_key'],
  contact: ['phones'],
  integration_credential: ['*'],
}
