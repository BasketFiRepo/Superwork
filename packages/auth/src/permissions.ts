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

/**
 * The four roles that are a ladder, each one stated as what it adds to the one below.
 *
 * They used to be four independent lists, and four independent lists drift. Twenty-one places
 * had drifted far enough that a *higher* role could do less than a lower one:
 *
 *   A **manager could not log a call.** Their grant is `note:*:department`; a company belongs to
 *   no department, so the scope was never satisfied — while a member's `note:create:org` was.
 *   The refusal said "You need Member access to create this note", which is the product telling
 *   an account manager to be demoted. Nine more went the same way: a manager could not create a
 *   document or a knowledge page they would own, or a task filed against nothing, because their
 *   grants were department-scoped where the member baseline was `own` or `org`.
 *
 *   An **admin could not touch a milestone** that a manager could. The admin list simply never
 *   mentioned `milestone`, and `*:read:org` covers reading and nothing else. Eleven verbs.
 *
 * None of that was decided. It is what four lists maintained by hand look like after eleven
 * increments. So the ladder is now built rather than remembered: a member is a viewer who can
 * write, a manager is a member with a department, an admin is a manager with the organization.
 * `tests/permissions/role-ladder.test.ts` walks every `resource:action` any list mentions,
 * against four shapes of resource, and refuses a rung that takes something away.
 */
const compose = (...lists: string[][]): string[] => [...new Set(lists.flat())]

/** Can look at what the organization holds, and change none of it. */
const VIEWER = [
  'task:read:org', 'project:read:org', 'milestone:read:org', 'document:read:org',
  'knowledge:read:org', 'company:read:org', 'contact:read:org', 'conversation:read:org',
  'insight:read:own', 'agent_run:create:own', 'agent_run:read:own', 'member:read:org',
  'workflow:read:org',
]

/** A viewer who does the work: their own things, and the things anybody here may start. */
const MEMBER = compose(VIEWER, [
  'task:create:org', 'task:update:own', 'task:update:team', 'task:complete:own',
  'document:create:own', 'document:update:own',
  'knowledge:create:own', 'knowledge:update:own',
  'contact:create:org', 'note:create:org', 'note:read:org',
  // Writing down correspondence that reached you another way (ADR 0076). A member who cannot
  // file the email a customer sent them is a member who keeps it in their own mailbox, which is
  // the state this whole subsystem exists to end — and it is the same act as logging a call,
  // which they have had since the ladder was built.
  'conversation:create:org',
  'email:draft:own',
  'approval:request:own', 'insight:update:own', 'agent_run:undo:own',
])

/** A member with a department: everything anybody here may do, plus everything in theirs. */
const MANAGER = compose(MEMBER, [
  '*:read:org',
  'task:*:department', 'task:*:team', 'task:*:own',
  'project:*:department', 'milestone:*:department',
  'document:create:department', 'document:update:department', 'document:share_external:department',
  'knowledge:*:department', 'note:*:department',
  'company:update:org', 'contact:*:org', 'conversation:update:org',
  'email:draft:org', 'email:send:department',
  'approval:decide:department', 'approval:request:org',
  'workflow:create:department', 'workflow:activate:department', 'workflow:simulate:department',
  'insight:*:department', 'agent_run:read:department',
])

/** A manager whose department is the organization, plus what only an administrator sees. */
const ADMIN = compose(MANAGER, [
  'task:*:org', 'project:*:org', 'milestone:*:org', 'document:*:org', 'knowledge:*:org',
  'company:*:org', 'contact:*:org', 'conversation:*:org', 'note:*:org',
  'email:draft:org', 'email:send:org',
  'approval:*:org', 'workflow:*:org', 'insight:*:org',
  'agent:*:org', 'agent_run:*:org', 'member:*:org', 'settings:*:org',
  'audit:read:org', 'billing:read:org', 'integration:*:org',
])

/** Role baselines. Attributes refine these; they never widen them. */
export const ROLE_PERMISSIONS: Record<Role, string[]> = {
  // `audit` is named because a wildcard does not reach it — see `NEVER_BY_WILDCARD` in
  // `policy.ts`. The owner holds everything, but they hold it by having said so.
  owner: ['*:*:org', 'audit:read:org'],
  admin: ADMIN,
  manager: MANAGER,
  member: MEMBER,
  viewer: VIEWER,
  /**
   * Not a rung. A guest is somebody from outside invited to one team, so their grants are
   * team-scoped and narrow by design — and one of them, `note:create:team`, is something a
   * viewer deliberately does not have, because a viewer is the role that means "look, do not
   * write". The two are sideways from each other, not above and below, so the ladder test
   * leaves them out and this comment says why rather than letting the next reader assume it
   * was an oversight.
   */
  guest: [
    'task:read:team', 'project:read:team', 'document:read:team', 'note:create:team',
    'agent_run:create:own', 'agent_run:read:own',
  ],
  /** Whatever was granted to it and nothing by default (ADR 0055). */
  service: [],
}

/** The rungs, weakest first. Exported so the invariant is stated once and tested from it. */
export const ROLE_LADDER: Role[] = ['viewer', 'member', 'manager', 'admin', 'owner']

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
  user: ['password_hash', 'salary', 'bank_details', 'mfa_secret', 'mfa_recovery_hashes'],
  document: ['storage_key'],
  contact: ['phones'],
  integration_credential: ['*'],
}
