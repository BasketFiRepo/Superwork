import type { Role } from '@superwork/db'
import { authSql, withTenant } from '@superwork/db'
import { startSession, type LoginResult } from '@superwork/auth'
import { writeAudit } from './audit.js'

/**
 * Signing in with the directory (§23, ADR 0087).
 *
 * `IdentityProvider.verifyAssertion()` has been on the contract since Phase 3 with a mock and
 * **no consumer**. Nothing in the product ever called it, which is why three columns on
 * `identity_settings` decided nothing: `sso_enabled` was a switch with no sign-in to allow,
 * `jit_provisioning` had no first sign-in to act on, and `sso_metadata_url` had no writer because
 * nothing would have read one. This is the consumer.
 *
 * ### What an assertion is, and what it is not
 *
 * It is a claim by the directory that this person is who they say. It is **not** a claim about
 * what they may do here: the role comes from the membership, or from `default_role` when the
 * person is arriving for the first time, and never from anything in the assertion. §23 says the
 * directory is a mirror, and this is the sentence that makes that true at the door.
 *
 * ### Four ways in are refused
 *
 * - **The organization has not turned it on.** `sso_enabled` is finally a decision.
 * - **The domain is not verified.** Without this, anybody the directory will vouch for — which,
 *   for a public IdP, is anybody at all — is a colleague here.
 * - **They are not a member, and the organization does not create people on first sign-in.**
 * - **Their membership was deactivated.** The directory sync deactivates people who have left
 *   (§23.2), and a sign-in that quietly reactivated them would undo the leaving.
 *
 * ### What it does not do
 *
 * It does not skip the second factor. A directory assertion proves the first thing; if this person
 * has enrolled a factor here, the session it mints is half-authenticated exactly as a password
 * sign-in's is, and resolves to nothing until the code is given (ADR 0043).
 */

export interface AssertionVerifier {
  verifyAssertion(assertion: string): Promise<{ email: string; externalId: string } | null>
}

export type SsoRefusal =
  | 'not_accepted'
  | 'no_organization'
  | 'not_a_member'
  | 'deactivated'
  /** The organization's own settings would have to mint a role this door cannot mint. */
  | 'misconfigured'

export interface SsoOutcome {
  ok: boolean
  reason: string
  refusal?: SsoRefusal
  session?: LoginResult
  /** True when this sign-in created the person, so a caller can say so rather than imply it. */
  provisioned?: boolean
  organizationId?: string
}

interface Candidate {
  organizationId: string
  name: string
  timezone: string
  jitProvisioning: boolean
  defaultRole: Role
}

/** Whether any organization here accepts a directory sign-in, for a screen deciding what to offer. */
export async function directorySignInOffered(): Promise<boolean> {
  const [row] = await authSql()<{ any: boolean }[]>`
    SELECT EXISTS (
      SELECT 1 FROM identity_settings s
      JOIN organizations o ON o.id = s.organization_id AND o.deleted_at IS NULL
      WHERE s.deleted_at IS NULL AND s.sso_enabled = true
    ) AS "any"`
  return row?.any ?? false
}

export async function signInWithAssertion(
  assertion: string,
  provider: AssertionVerifier,
  meta: { userAgent?: string } = {},
): Promise<SsoOutcome> {
  const verified = await provider.verifyAssertion(assertion)
  // Not "no such person" and not "wrong signature" — the same sentence for both. Which of the two
  // it was is a fact about the directory that somebody at the sign-in screen has not earned.
  if (!verified) {
    return { ok: false, refusal: 'not_accepted', reason: 'That directory sign-in was not accepted.' }
  }

  const email = verified.email.trim().toLowerCase()
  const domain = email.split('@')[1] ?? ''
  const sql = authSql()

  const candidates = await sql<Candidate[]>`
    SELECT s.organization_id AS "organizationId", o.name, o.timezone,
           s.jit_provisioning AS "jitProvisioning", s.default_role AS "defaultRole"
    FROM identity_settings s
    JOIN organizations o ON o.id = s.organization_id AND o.deleted_at IS NULL
    WHERE s.deleted_at IS NULL AND s.sso_enabled = true
      AND ${domain} = ANY (s.verified_domains)
    ORDER BY o.name`

  if (candidates.length === 0) {
    return {
      ok: false,
      refusal: 'no_organization',
      reason:
        `The directory accepted that sign-in, and no organization here takes one from ${domain || 'that address'}. ` +
        'An administrator turns it on, and names the domain, in Settings → Identity.',
    }
  }

  const [existing] = await sql<
    { id: string; email: string; name: string; timezone: string; mfaEnabled: boolean }[]
  >`
    SELECT id, email, name, timezone, mfa_enabled AS "mfaEnabled"
    FROM users WHERE lower(email) = lower(${email}) AND deleted_at IS NULL`

  // Every organization this person is already in, whatever its state — an inactive membership has
  // to be told apart from an absent one, because they mean opposite things about the same person.
  const memberships = existing
    ? await sql<{ organizationId: string; status: string }[]>`
        SELECT organization_id AS "organizationId", status
        FROM memberships
        WHERE user_id = ${existing.id} AND deleted_at IS NULL`
    : []
  const statusByOrg = new Map(memberships.map((row) => [row.organizationId, row.status]))

  const alreadyIn = candidates.filter((candidate) => statusByOrg.get(candidate.organizationId) === 'active')
  const deactivated = candidates.filter((candidate) => {
    const status = statusByOrg.get(candidate.organizationId)
    return status !== undefined && status !== 'active'
  })

  if (alreadyIn.length === 0 && deactivated.length > 0) {
    // Named rather than treated as "not a member": somebody who was here and was deactivated is
    // owed the difference, and reactivating them is the directory sync's decision to make, not a
    // side effect of them trying the door.
    return {
      ok: false,
      refusal: 'deactivated',
      reason:
        `Your access to ${deactivated[0]!.name} was deactivated. Signing in with the directory does not ` +
        'restore it — somebody there has to.',
    }
  }

  let user = existing
  let provisioned = false
  const provisionable = alreadyIn.length === 0 ? candidates.filter((candidate) => candidate.jitProvisioning) : []

  if (alreadyIn.length === 0) {
    const into = provisionable[0]
    if (!into) {
      return {
        ok: false,
        refusal: 'not_a_member',
        reason:
          `You are not a member of ${candidates[0]!.name}, and it does not create people on first sign-in. ` +
          'Ask somebody there to invite you.',
      }
    }

    if (!user) {
      const [created] = await sql<
        { id: string; email: string; name: string; timezone: string; mfaEnabled: boolean }[]
      >`
        INSERT INTO users (email, name, password_hash, timezone)
        VALUES (${email}, ${displayNameFor(email)}, ${'sso-only'}, ${into.timezone})
        RETURNING id, email, name, timezone, mfa_enabled AS "mfaEnabled"`
      user = created!
    }

    // `created_by` is the person themselves: they arrived, nobody added them, and a row claiming an
    // administrator did it would be the wrong answer to "who let them in".
    //
    // The role can only be what the organization set as its default, and migration 0076's policy
    // refuses an owner or an admin from this role whatever this line says. Asked here as well, for
    // the reason a guarantee is not an error message: the policy produces a database error, and
    // somebody at a sign-in screen is owed a sentence about what is wrong and who can fix it.
    if (into.defaultRole === 'owner' || into.defaultRole === 'admin') {
      return {
        ok: false,
        refusal: 'misconfigured',
        reason:
          `${into.name} is set to create new people as ${into.defaultRole}s, and a directory sign-in ` +
          'never mints one. Somebody there has to lower the default role, or invite you.',
      }
    }

    try {
      await sql`
        INSERT INTO memberships (organization_id, user_id, role, status, created_by)
        VALUES (${into.organizationId}, ${user.id}, ${into.defaultRole}::sw_role, 'active', ${user.id})`
    } catch {
      // The policy refused it. Whatever the row said, nobody was added — and the person at the
      // screen gets the same sentence as the check above rather than a failed request.
      return {
        ok: false,
        refusal: 'misconfigured',
        reason:
          `${into.name} could not add you automatically. Its directory settings ask for something a ` +
          'sign-in is not allowed to create; somebody there has to invite you.',
      }
    }
    provisioned = true
    alreadyIn.push(into)
  }

  const organizationId = alreadyIn[0]!.organizationId
  const organizations = await sql<{ id: string; name: string; slug: string; isDemo: boolean }[]>`
    SELECT o.id, o.name, o.slug, o.is_demo AS "isDemo"
    FROM memberships m JOIN organizations o ON o.id = m.organization_id
    WHERE m.user_id = ${user!.id} AND m.deleted_at IS NULL AND m.status = 'active'
    ORDER BY o.name`

  const session = await startSession(
    {
      id: user!.id,
      email: user!.email,
      name: user!.name,
      timezone: user!.timezone,
      mfaEnabled: user!.mfaEnabled,
    },
    organizations,
    meta,
    { organizationId },
  )

  // Written inside the organization that accepted the sign-in, by the person who signed in, which
  // is the only actor there is: the directory said who they are and nobody here decided anything.
  await withTenant({ organizationId, userId: user!.id, timezone: user!.timezone }, (ctx) =>
    writeAudit(ctx, {
      actorType: 'user',
      actorId: user!.id,
      action: provisioned ? 'identity.sso_provisioned' : 'identity.sso_signed_in',
      entityType: 'user',
      entityId: user!.id,
      after: {
        email: user!.email,
        externalId: verified.externalId,
        domain,
        ...(provisioned ? { role: alreadyIn[0]!.defaultRole, jitProvisioning: true } : {}),
        secondFactorPending: session.mfaRequired,
      },
    }),
  )

  return {
    ok: true,
    reason: provisioned
      ? `Signed in and added to ${alreadyIn[0]!.name} as a ${alreadyIn[0]!.defaultRole}.`
      : `Signed in to ${alreadyIn[0]!.name}.`,
    session,
    provisioned,
    organizationId,
  }
}

/**
 * A name to start from, taken from the address rather than from the assertion.
 *
 * The directory sync uses the display name the directory gives it; this path has only what the
 * assertion carried, and an attacker-controlled display name is how a "Maya Ellison" that is not
 * her ends up on a task list. The person can correct it, and the sync will.
 */
function displayNameFor(email: string): string {
  const local = email.split('@')[0] ?? email
  return (
    local
      .split(/[._-]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ') || email
  )
}
