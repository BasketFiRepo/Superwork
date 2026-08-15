import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { adminSql, type Role, type TenantContext } from '@superwork/db'
import { can, hashPassword, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeActivity, writeAudit } from '../audit.js'
import { seatCheck } from '../subscription.js'

/**
 * Invitations (§4.1, §23.2).
 *
 * `invitations` was created in migration 0001 and never read or written, which made this the
 * largest single gap in the product: there was **no way to add a person to an organization**
 * except by running the seed or connecting a directory sync. A product whose first act is
 * "invite your colleagues" could not do it.
 *
 * An invitation is a credential, so it is built like one:
 *
 *   • the token is random, stored as a hash, and shown exactly once — there is no screen
 *     that can show it again, because the database does not have it;
 *   • it expires, it is single-use, and it can be withdrawn;
 *   • accepting it is compared in constant time, because the lookup is on a page anybody
 *     can reach.
 *
 * And the rule that keeps it from being an escalation: **you cannot invite somebody to a
 * role above your own.** An admin inviting an owner is a privilege escalation with a
 * friendly form on it — the same shape as "you can only share what you already hold"
 * (ADR 0023), applied to membership.
 */

const ROLE_RANK: Record<Role, number> = {
  service: 0,
  guest: 1,
  viewer: 2,
  member: 3,
  manager: 4,
  admin: 5,
  owner: 6,
}

/** Fourteen days. Long enough to survive a holiday, short enough to not be a standing key. */
export const INVITATION_TTL_DAYS = 14

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export interface InvitationView {
  id: string
  email: string
  role: Role
  departmentId: string | null
  departmentName: string | null
  reason: string | null
  invitedByName: string | null
  expiresAt: Date
  acceptedAt: Date | null
  acceptedUserName: string | null
  revokedAt: Date | null
  revokedByName: string | null
  revokedReason: string | null
  createdAt: Date
  /** Derived, so a lapsed invitation reads as lapsed rather than as still open. */
  state: 'pending' | 'accepted' | 'revoked' | 'expired'
}

const SELECT_INVITE = (ctx: TenantContext) => ctx.sql`
  SELECT i.id, i.email, i.role, i.department_id AS "departmentId", d.path AS "departmentName",
         i.reason, u.name AS "invitedByName", i.expires_at AS "expiresAt",
         i.accepted_at AS "acceptedAt", a.name AS "acceptedUserName",
         i.revoked_at AS "revokedAt", r.name AS "revokedByName", i.revoked_reason AS "revokedReason",
         i.created_at AS "createdAt",
         CASE
           WHEN i.accepted_at IS NOT NULL THEN 'accepted'
           WHEN i.revoked_at IS NOT NULL THEN 'revoked'
           WHEN i.expires_at <= now() THEN 'expired'
           ELSE 'pending'
         END AS state
  FROM invitations i
  LEFT JOIN departments d ON d.id = i.department_id
  LEFT JOIN users u ON u.id = i.invited_by
  LEFT JOIN users a ON a.id = i.accepted_user_id
  LEFT JOIN users r ON r.id = i.revoked_by`

export async function listInvitations(ctx: TenantContext, actor: Actor): Promise<InvitationView[]> {
  const decision = can(actor, 'member:read', { type: 'member', organizationId: ctx.organizationId })
  if (!decision.allow) throw new PermissionError(decision.reason)
  return ctx.sql<InvitationView[]>`
    ${SELECT_INVITE(ctx)}
    WHERE i.organization_id = ${ctx.organizationId} AND i.deleted_at IS NULL
    ORDER BY i.created_at DESC
    LIMIT 200`
}

/**
 * Writes the invitation and returns the token once.
 *
 * The token is the return value and nothing else keeps it. Nothing is emailed — no provider
 * in this product calls out of the process — so the interface shows the link and says it is
 * the caller's job to deliver it, rather than claiming a message was sent.
 */
export async function inviteMember(
  ctx: TenantContext,
  actor: Actor,
  input: { email: string; role: Role; departmentId?: string | null; reason: string },
): Promise<{ invitation: InvitationView; token: string }> {
  const decision = can(actor, 'member:update', {
    type: 'member',
    organizationId: ctx.organizationId,
    riskTier: 'high',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const email = input.email?.trim().toLowerCase()
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new ValidationError('That does not look like an email address.')
  }
  if (!input.reason?.trim()) {
    throw new ValidationError(
      'Say why this person needs access. It is the first thing an access review asks, and reconstructing it later from an audit log is not the same answer.',
    )
  }
  // You cannot hand out more than you hold. An admin inviting an owner is a privilege
  // escalation with a form on it.
  if (ROLE_RANK[input.role] > ROLE_RANK[actor.role]) {
    throw new ValidationError(
      `You cannot invite somebody as ${input.role} — that is above your own role. Ask an ${input.role} to send it.`,
    )
  }

  const [existing] = await ctx.sql<{ id: string }[]>`
    SELECT m.id FROM memberships m JOIN users u ON u.id = m.user_id
    WHERE m.organization_id = ${ctx.organizationId} AND m.deleted_at IS NULL
      AND lower(u.email) = ${email}`
  if (existing) {
    throw new ValidationError('That person is already a member of this organization.')
  }

  // Seats are a hard limit: an organization bought a number, and an outstanding invitation
  // holds one. Counting only accepted invitations lets somebody invite a hundred people
  // onto twenty-five seats and find out when they arrive (ADR 0030).
  const seats = await seatCheck(ctx)
  if (!seats.allow) throw new ValidationError(seats.reason)

  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + INVITATION_TTL_DAYS * 86_400_000)

  let created: { id: string }
  try {
    const [row] = await ctx.sql<{ id: string }[]>`
      INSERT INTO invitations (
        organization_id, email, role, department_id, token_hash, expires_at,
        reason, invited_by, created_by
      ) VALUES (
        ${ctx.organizationId}, ${email}, ${input.role}::sw_role, ${input.departmentId ?? null},
        ${hashToken(token)}, ${expiresAt}, ${input.reason.trim()}, ${actor.userId}, ${ctx.userId}
      ) RETURNING id`
    created = row!
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/invitations_pending_email/.test(message)) {
      throw new ValidationError(
        'There is already an open invitation for that address. Withdraw it first — two invitations racing each other means whichever link they happen to open decides their role.',
      )
    }
    throw error
  }

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'member.invited',
    entityType: 'invitation',
    entityId: created.id,
    after: { email, role: input.role, reason: input.reason.trim(), expiresAt: expiresAt.toISOString() },
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'invited',
    entityType: 'invitation',
    entityId: created.id,
    entityLabel: email,
    summary: `Invited ${email} as ${input.role}. ${input.reason.trim()}`,
  })

  const [invitation] = await ctx.sql<InvitationView[]>`${SELECT_INVITE(ctx)} WHERE i.id = ${created.id}`
  return { invitation: invitation!, token }
}

export async function revokeInvitation(
  ctx: TenantContext,
  actor: Actor,
  input: { invitationId: string; reason: string },
): Promise<void> {
  const decision = can(actor, 'member:update', {
    type: 'member',
    organizationId: ctx.organizationId,
    riskTier: 'low',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
  if (!input.reason?.trim()) throw new ValidationError('Say why this invitation is being withdrawn.')

  const [before] = await ctx.sql<{ email: string; acceptedAt: Date | null }[]>`
    SELECT email, accepted_at AS "acceptedAt" FROM invitations
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.invitationId} AND deleted_at IS NULL`
  if (!before) throw new NotFoundError()
  if (before.acceptedAt) {
    throw new ValidationError(
      'That invitation was already accepted. Withdrawing it now would change nothing — remove their membership instead.',
    )
  }

  await ctx.sql`
    UPDATE invitations
    SET revoked_at = now(), revoked_by = ${actor.userId}, revoked_reason = ${input.reason.trim()},
        updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.invitationId}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'member.invitation_revoked',
    entityType: 'invitation',
    entityId: input.invitationId,
    after: { email: before.email, reason: input.reason.trim() },
  })
}

export interface InvitationOffer {
  organizationName: string
  email: string
  role: Role
  invitedByName: string | null
  reason: string | null
  expiresAt: Date
}

/**
 * What the person holding the link is being offered.
 *
 * Runs on the owner connection, without a tenant: whoever opens this is not signed in, and
 * the whole point of the token is that it identifies the organization. A wrong or lapsed
 * token reports the same nothing as an unknown one — an invitation link is a credential, and
 * distinguishing "expired" from "never existed" tells an attacker which addresses were
 * invited.
 */
export async function invitationOffer(token: string): Promise<InvitationOffer | null> {
  const row = await findLiveInvitation(token)
  if (!row) return null
  const [detail] = await adminSql()<
    { organizationName: string; invitedByName: string | null; reason: string | null }[]
  >`
    SELECT o.name AS "organizationName", u.name AS "invitedByName", i.reason
    FROM invitations i
    JOIN organizations o ON o.id = i.organization_id
    LEFT JOIN users u ON u.id = i.invited_by
    WHERE i.id = ${row.id}`
  return {
    organizationName: detail?.organizationName ?? 'an organization',
    email: row.email,
    role: row.role,
    invitedByName: detail?.invitedByName ?? null,
    reason: detail?.reason ?? null,
    expiresAt: row.expiresAt,
  }
}

/**
 * Accepts it: makes or finds the user, gives them the membership the invitation names, and
 * closes the invitation. Returns the email to sign in with.
 *
 * Not idempotent by design — `accepted_at IS NULL` is part of the lookup, so a second use of
 * the same link finds nothing. A single-use credential that works twice is a shared one.
 */
export async function acceptInvitation(
  token: string,
  input: { name: string; password: string },
): Promise<{ email: string; organizationId: string } | null> {
  const row = await findLiveInvitation(token)
  if (!row) return null

  const name = input.name?.trim()
  if (!name) throw new ValidationError('Superwork needs a name to put on your work.')
  if (!input.password || input.password.length < 8) {
    throw new ValidationError('Choose a password of at least 8 characters.')
  }

  const sql = adminSql()
  const passwordHash = await hashPassword(input.password)

  // `users` is not a tenant table, and the person may already exist from another
  // organization — in which case they keep the account they have and gain a membership.
  // The unique index on users is `lower(email) WHERE deleted_at IS NULL` — a partial,
  // expression index. `ON CONFLICT (email)` matches no constraint at all and raises; the
  // arbiter has to name the expression *and* repeat the predicate.
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, name, password_hash, timezone)
    VALUES (${row.email}, ${name}, ${passwordHash}, 'UTC')
    ON CONFLICT (lower(email)) WHERE deleted_at IS NULL
    DO UPDATE SET name = users.name
    RETURNING id`

  // Claim the invitation first and let the unique index decide the race: two tabs opening
  // the same link cannot both produce a membership.
  const claimed = await sql<{ id: string }[]>`
    UPDATE invitations
    SET accepted_at = now(), accepted_user_id = ${user!.id}, updated_at = now()
    WHERE id = ${row.id} AND accepted_at IS NULL AND revoked_at IS NULL AND deleted_at IS NULL
    RETURNING id`
  if (claimed.length === 0) return null

  await sql`
    INSERT INTO memberships (organization_id, user_id, role, status, department_id, created_by)
    VALUES (${row.organizationId}, ${user!.id}, ${row.role}::sw_role, 'active',
            ${row.departmentId}, ${row.invitedBy})
    ON CONFLICT DO NOTHING`

  // Audited on the owner connection: the person accepting has no tenant context yet, and an
  // invitation acceptance that is not on the record is a membership that appeared by itself.
  await sql`
    INSERT INTO audit_logs (
      organization_id, actor_type, actor_id, principal_user_id, action, entity_type, entity_id, diff
    ) VALUES (
      ${row.organizationId}, 'user', ${user!.id}, ${user!.id}, 'member.invitation_accepted',
      'invitation', ${row.id},
      ${sql.json({ email: { from: null, to: row.email }, role: { from: null, to: row.role } })}
    )`

  return { email: row.email, organizationId: row.organizationId }
}

interface LiveInvitation {
  id: string
  organizationId: string
  email: string
  role: Role
  departmentId: string | null
  invitedBy: string | null
  expiresAt: Date
}

/**
 * Looks the token up, in constant time against the candidate.
 *
 * The hash is indexed, so the lookup is by hash rather than a scan — but the comparison is
 * still done with `timingSafeEqual` rather than left to the index, because the shape of this
 * function is what somebody will copy the next time a token is checked.
 */
async function findLiveInvitation(token: string): Promise<LiveInvitation | null> {
  if (!token || token.length < 16) return null
  const hashed = hashToken(token)
  const [row] = await adminSql()<(LiveInvitation & { tokenHash: string })[]>`
    SELECT id, organization_id AS "organizationId", email, role,
           department_id AS "departmentId", invited_by AS "invitedBy",
           expires_at AS "expiresAt", token_hash AS "tokenHash"
    FROM invitations
    WHERE token_hash = ${hashed} AND deleted_at IS NULL
      AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()`
  if (!row) return null

  const expected = Buffer.from(row.tokenHash, 'hex')
  const actual = Buffer.from(hashed, 'hex')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
  return row
}
