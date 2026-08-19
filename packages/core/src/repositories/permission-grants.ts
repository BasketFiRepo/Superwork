import type { TenantContext } from '@superwork/db'
import {
  can,
  parsePermission,
  ROLE_PERMISSIONS,
  SCOPE_RANK,
  type Actor,
  type PermissionScope,
} from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeActivity, writeAudit } from '../audit.js'
import { assertSteppedUp } from '../step-up.js'
import { notify } from '../notify.js'

/**
 * One capability, for one person, that their role does not carry (§4.2, ADR 0055).
 *
 * `checkHumanPermissions` has always ended with
 * `[...ROLE_PERMISSIONS[actor.role], ...actor.extraPermissions]`, and nothing has ever written
 * the second half. The escape hatch was designed into the function that decides every `can()`
 * call and had no door: an administrator who needed to give one person one extra capability had
 * to change their role, which hands them everything else that role carries.
 *
 * The rules here are what keep an exception an exception:
 *
 *   - **You cannot give away what you do not have.** The grant is refused unless the granter
 *     could perform it themselves. Otherwise the door is a way to mint capability out of the
 *     ability to open the door.
 *   - **One capability, not a wildcard.** `*:*:org` is not an exception; it is making somebody
 *     an owner without saying so.
 *   - **Not something the role already carries**, because that is not an exception either — it
 *     is a row that will still be there, unreviewed, after the role changes.
 *   - **It says who, why, and until when.** A permanent, unattributed exception is a quiet
 *     promotion.
 */

export interface PermissionGrantView {
  id: string
  userId: string
  userName: string
  role: string
  permission: string
  reason: string
  grantedByName: string | null
  grantedAt: Date
  expiresAt: Date | null
  /** True while it is doing something: not revoked, not expired. */
  live: boolean
  revokedAt: Date | null
  revokedByName: string | null
  revokeReason: string | null
}

/** How long a dated exception may run for. Longer than this is a role, not an exception. */
export const MAX_GRANT_DAYS = 365

function guardRead(ctx: TenantContext, actor: Actor): void {
  const decision = can(actor, 'member:read', { type: 'member', organizationId: ctx.organizationId })
  if (!decision.allow) throw new PermissionError(decision.reason)
}

function guardWrite(ctx: TenantContext, actor: Actor): void {
  const decision = can(actor, 'member:update', {
    type: 'member',
    organizationId: ctx.organizationId,
    riskTier: 'high',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
}

export async function listPermissionGrants(
  ctx: TenantContext,
  actor: Actor,
): Promise<PermissionGrantView[]> {
  guardRead(ctx, actor)

  return ctx.sql<PermissionGrantView[]>`
    SELECT g.id, g.user_id AS "userId", u.name AS "userName", m.role::text AS role,
           g.permission, g.reason, granter.name AS "grantedByName",
           g.granted_at AS "grantedAt", g.expires_at AS "expiresAt",
           (g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())) AS live,
           g.revoked_at AS "revokedAt", revoker.name AS "revokedByName",
           g.revoke_reason AS "revokeReason"
    FROM permission_grants g
    JOIN users u ON u.id = g.user_id
    LEFT JOIN memberships m ON m.user_id = g.user_id AND m.organization_id = g.organization_id
      AND m.deleted_at IS NULL
    LEFT JOIN users granter ON granter.id = g.granted_by
    LEFT JOIN users revoker ON revoker.id = g.revoked_by
    WHERE g.organization_id = ${ctx.organizationId} AND g.deleted_at IS NULL
    ORDER BY (g.revoked_at IS NULL) DESC, g.expires_at NULLS LAST, g.granted_at DESC`
}

/**
 * Grants one.
 *
 * Asks for a fresh proof of identity, because this is the widening direction and what it widens
 * is what a person may do (ADRs 0044, 0046, 0050). Revoking does not.
 */
export async function grantPermission(
  ctx: TenantContext,
  actor: Actor,
  input: { userId: string; permission: string; reason: string; expiresAt?: Date | null },
): Promise<PermissionGrantView[]> {
  guardWrite(ctx, actor)

  const reason = input.reason.trim()
  if (reason.length < 12) {
    throw new ValidationError(
      'Say why this person needs this, in a sentence somebody reviewing it in six months could ' +
        'act on. An exception without a reason is a role change nobody wrote down.',
    )
  }

  let parsed
  try {
    parsed = parsePermission(input.permission.trim())
  } catch (error) {
    throw new ValidationError(
      `${error instanceof Error ? error.message : String(error)} — it looks like ` +
        '`document:update:department`: a thing, a verb, and how far it reaches.',
    )
  }
  if (parsed.resource === '*' || parsed.action === '*') {
    throw new ValidationError(
      'An exception is for one capability. A wildcard here is not an exception — it is making ' +
        'somebody an administrator without saying so, which is what the role is for.',
    )
  }

  const [subject] = await ctx.sql<{ id: string; name: string; role: string }[]>`
    SELECT u.id, u.name, m.role::text AS role
    FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = ${ctx.organizationId} AND m.user_id = ${input.userId}
      AND m.deleted_at IS NULL AND m.status = 'active'`
  if (!subject) throw new NotFoundError()

  // You cannot give away what you do not have. Without this, the ability to open the door is a
  // way to mint capability out of nothing.
  const granterHolds = holds(actor, parsed)
  if (!granterHolds) {
    throw new ValidationError(
      `You cannot grant ${input.permission}, because you do not have it yourself. Somebody who ` +
        'does can grant it, or it can be added to a role.',
    )
  }

  // Already theirs by role: not an exception, and a row that would still be here — unreviewed —
  // after their role changed.
  const roleGrants = ROLE_PERMISSIONS[subject.role as keyof typeof ROLE_PERMISSIONS] ?? []
  if (coveredByRole(roleGrants, parsed)) {
    throw new ValidationError(
      `${subject.name} already has ${input.permission} from their ${subject.role} role. ` +
        'Nothing to grant.',
    )
  }

  const expiresAt = input.expiresAt ?? null
  if (expiresAt) {
    if (expiresAt.getTime() <= Date.now()) {
      throw new ValidationError('An exception that has already ended does nothing. Pick a date ahead.')
    }
    const days = (expiresAt.getTime() - Date.now()) / 86_400_000
    if (days > MAX_GRANT_DAYS) {
      throw new ValidationError(
        `An exception may run for at most ${MAX_GRANT_DAYS} days. Longer than that is a role, ` +
          'not an exception — and nobody reviews what never comes up.',
      )
    }
  }

  const permission = `${parsed.resource}:${parsed.action}:${parsed.scope}`
  const [clash] = await ctx.sql<{ reason: string }[]>`
    SELECT reason FROM permission_grants
    WHERE organization_id = ${ctx.organizationId} AND user_id = ${input.userId}
      AND permission = ${permission} AND revoked_at IS NULL AND deleted_at IS NULL`
  if (clash) {
    throw new ValidationError(
      `${subject.name} already has that exception: “${clash.reason}”. Take that one off first if ` +
        'it should be replaced.',
    )
  }

  assertSteppedUp(actor, 'member.grant_permission')

  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO permission_grants (
      organization_id, user_id, permission, granted_by, reason, expires_at, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.userId}, ${permission}, ${actor.userId}, ${reason},
      ${expiresAt}, ${actor.userId}
    ) RETURNING id`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'member.permission_granted',
    entityType: 'member',
    entityId: input.userId,
    before: null,
    after: { grantId: row!.id, permission, reason, expiresAt: expiresAt?.toISOString() ?? null },
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'granted',
    entityType: 'member',
    entityId: input.userId,
    entityLabel: subject.name,
    summary:
      `${subject.name} was given ${permission}, which their ${subject.role} role does not carry. ` +
      `${reason}${expiresAt ? ` It ends on ${expiresAt.toISOString().slice(0, 10)}.` : ' It has no end date.'}`,
  })

  // Nothing about a person reaches anybody before it reaches them (§29.3). A capability somebody
  // did not ask for is exactly the kind of change they should hear about first.
  await notify(ctx, {
    userId: input.userId,
    type: 'disclosure',
    title: `You were given ${permission}`,
    body:
      `${actor.displayName} gave you this because: ${reason}` +
      `${expiresAt ? ` It ends on ${expiresAt.toISOString().slice(0, 10)}.` : ' It has no end date.'}`,
    entityType: 'member',
    entityId: input.userId,
  })

  return listPermissionGrants(ctx, actor)
}

/**
 * Takes one back.
 *
 * The narrowing direction, so it does not ask for a password: somebody removing a capability in
 * a hurry — because a person has left the team, or the reason has gone — is the case that should
 * be easy. The row stays, saying who took it and why.
 */
export async function revokePermissionGrant(
  ctx: TenantContext,
  actor: Actor,
  input: { grantId: string; reason: string },
): Promise<PermissionGrantView[]> {
  guardWrite(ctx, actor)

  const reason = input.reason.trim()
  if (reason.length < 4) throw new ValidationError('Say why it is being taken off.')

  const [grant] = await ctx.sql<{ userId: string; permission: string; userName: string }[]>`
    SELECT g.user_id AS "userId", g.permission, u.name AS "userName"
    FROM permission_grants g JOIN users u ON u.id = g.user_id
    WHERE g.organization_id = ${ctx.organizationId} AND g.id = ${input.grantId}
      AND g.revoked_at IS NULL AND g.deleted_at IS NULL`
  if (!grant) throw new NotFoundError()

  await ctx.sql`
    UPDATE permission_grants
    SET revoked_at = now(), revoked_by = ${actor.userId}, revoke_reason = ${reason}, updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.grantId}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'member.permission_revoked',
    entityType: 'member',
    entityId: grant.userId,
    before: { grantId: input.grantId, permission: grant.permission },
    after: { reason },
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'took back',
    entityType: 'member',
    entityId: grant.userId,
    entityLabel: grant.userName,
    summary: `${grant.userName} no longer has ${grant.permission}. ${reason}`,
  })
  await notify(ctx, {
    userId: grant.userId,
    type: 'disclosure',
    title: `${grant.permission} was taken off your account`,
    body: `${actor.displayName} removed it because: ${reason}`,
    entityType: 'member',
    entityId: grant.userId,
  })

  return listPermissionGrants(ctx, actor)
}

/** Whether the actor could do this themselves, by role or by an exception of their own. */
function holds(actor: Actor, wanted: { resource: string; action: string; scope: PermissionScope }): boolean {
  const grants = [...ROLE_PERMISSIONS[actor.role], ...actor.extraPermissions]
  return grants.some((raw) => {
    let grant
    try {
      grant = parsePermission(raw)
    } catch {
      return false
    }
    if (grant.resource !== '*' && grant.resource !== wanted.resource) return false
    if (grant.action !== '*' && grant.action !== wanted.action) return false
    // Reaching further than you do is giving away something you have not got.
    return SCOPE_RANK[grant.scope] >= SCOPE_RANK[wanted.scope]
  })
}

/** Whether a role already carries this, at this reach or wider. */
function coveredByRole(
  roleGrants: readonly string[],
  wanted: { resource: string; action: string; scope: PermissionScope },
): boolean {
  return roleGrants.some((raw) => {
    let grant
    try {
      grant = parsePermission(raw)
    } catch {
      return false
    }
    if (grant.resource !== '*' && grant.resource !== wanted.resource) return false
    if (grant.action !== '*' && grant.action !== wanted.action) return false
    return SCOPE_RANK[grant.scope] >= SCOPE_RANK[wanted.scope]
  })
}
