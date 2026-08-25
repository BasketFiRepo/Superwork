import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor, resolveSession, resolvePendingSession } from '@superwork/auth'
import {
  assertMetadataUrl,
  directorySignInOffered,
  identitySettings,
  signInWithAssertion,
  updateIdentitySettings,
  ValidationError,
} from '@superwork/core'
import { MockIdentityProvider } from '@superwork/integrations'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Somebody who signed in with the directory (ADR 0087).
 *
 * `IdentityProvider.verifyAssertion()` had a mock and no consumer, so `sso_enabled` was a switch
 * with no sign-in to allow, `jit_provisioning` had no first sign-in to act on, and
 * `sso_metadata_url` had no writer because nothing would have read one.
 *
 * The four refusals are the substance of this pack. An assertion says who somebody is; it never
 * says what they may do, and it must not be a way past a decision somebody here already made —
 * not the domain list, not the invitation, and not a deactivation.
 */

const TZ = 'Europe/London'
const DOMAIN = 'sso-fixture.example'
let org: TenantFixture
let owner: { organizationId: string; userId: string; timezone: string; steppedUpAt?: Date }
let provider: MockIdentityProvider

const METADATA = 'https://idp.example.com/app/exk1/sso/saml/metadata'

async function settings(patch: Record<string, unknown>): Promise<void> {
  await withTenant(owner, async (ctx) => {
    const actor = await loadActor(ctx)
    await updateIdentitySettings(ctx, actor, {
      ssoEnabled: true,
      ssoMetadataUrl: METADATA,
      verifiedDomains: [DOMAIN],
      jitProvisioning: false,
      defaultRole: 'member',
      scimEnabled: false,
      ...patch,
    } as never)
  })
}

/** A member of this organization whose address is on the verified domain. */
async function aColleague(email: string): Promise<string> {
  const [user] = await adminSql()<{ id: string }[]>`
    INSERT INTO users (email, name, password_hash, timezone, is_demo)
    VALUES (${email}, 'Directory Colleague', 'sso-only', ${TZ}, true)
    RETURNING id`
  await adminSql()`
    INSERT INTO memberships (organization_id, user_id, role, status, is_demo)
    VALUES (${org.organizationId}, ${user!.id}, 'member', 'active', true)`
  return user!.id
}

beforeAll(async () => {
  org = await createTenant('sso-sign-in')
  owner = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ, steppedUpAt: new Date() }
  provider = new MockIdentityProvider()
})

/**
 * Everybody this pack let in, removed in the order the foreign keys allow.
 *
 * A signed-in person leaves an audit row behind them, and that row references them on purpose:
 * §25 keeps the trail attributable, which is exactly why a person is deactivated rather than
 * deleted in the product. A test that creates people has to take the trail with them.
 */
async function clearDirectoryPeople(): Promise<void> {
  const sql = adminSql()
  const people = await sql<{ id: string }[]>`SELECT id FROM users WHERE email LIKE ${`%@${DOMAIN}`}`
  if (people.length === 0) return
  const ids = people.map((person) => person.id)
  await sql`DELETE FROM audit_logs WHERE principal_user_id = ANY (${ids})`
  await sql`DELETE FROM sessions WHERE user_id = ANY (${ids})`
  await sql`DELETE FROM memberships WHERE user_id = ANY (${ids})`
  await sql`DELETE FROM users WHERE id = ANY (${ids})`
}

beforeEach(async () => {
  await clearDirectoryPeople()
  await settings({})
})

afterAll(async () => {
  await clearDirectoryPeople()
  await destroyTenant('sso-sign-in')
  await closePools()
})

describe('the switch that had nothing behind it', () => {
  it('cannot be turned on without saying where the assertions come from', async () => {
    await expect(
      withTenant(owner, async (ctx) =>
        updateIdentitySettings(ctx, await loadActor(ctx), {
          ssoEnabled: true,
          ssoMetadataUrl: null,
          verifiedDomains: [DOMAIN],
          jitProvisioning: false,
          defaultRole: 'member',
          scimEnabled: false,
        }),
      ),
    ).rejects.toThrow(/metadata URL/i)
  })

  it('is refused by the database too, not only by the repository', async () => {
    await expect(
      adminSql()`
        UPDATE identity_settings SET sso_metadata_url = NULL
        WHERE organization_id = ${org.organizationId}`,
    ).rejects.toThrow(/identity_sso_needs_metadata/)
  })

  it('will not take a metadata URL that is not https, or that points inside', () => {
    expect(() => assertMetadataUrl('http://idp.example.com/metadata')).toThrow(ValidationError)
    expect(() => assertMetadataUrl('https://127.0.0.1/metadata')).toThrow(/private or link-local/)
    expect(() => assertMetadataUrl('https://idp.internal/metadata')).toThrow(/private or link-local/)
    expect(() => assertMetadataUrl('not a url')).toThrow(/is not a URL/)
    expect(() => assertMetadataUrl(METADATA)).not.toThrow()
  })

  it('is what the sign-in screen offers a way in for', async () => {
    expect(await directorySignInOffered()).toBe(true)
    await settings({ ssoEnabled: false, ssoMetadataUrl: METADATA })
    // The demo organization is seeded without identity settings, so with this one off there is
    // nothing here that accepts a directory sign-in and the screen offers none.
    expect(await directorySignInOffered()).toBe(false)
  })

  it('is stored, and read back onto the screen', async () => {
    const view = await withTenant(owner, async (ctx) => identitySettings(ctx, await loadActor(ctx)))
    expect(view.ssoMetadataUrl).toBe(METADATA)
  })
})

describe('signing in', () => {
  it('lets a colleague in, and lands them in the organization that accepted it', async () => {
    const email = `priya@${DOMAIN}`
    const userId = await aColleague(email)

    const outcome = await signInWithAssertion(`mock-sso:${email}`, provider)
    expect(outcome.ok).toBe(true)
    expect(outcome.provisioned).toBe(false)
    expect(outcome.organizationId).toBe(org.organizationId)

    const identity = await resolveSession(outcome.session!.token)
    expect(identity?.userId).toBe(userId)
    expect(identity?.organizationId).toBe(org.organizationId)
    // A fresh sign-in is not a step-up, whichever door it came through.
    expect(identity?.steppedUpAt).toBeNull()
  })

  it('records it where the organization can see it, as the person themselves', async () => {
    const email = `omar@${DOMAIN}`
    await aColleague(email)
    await signInWithAssertion(`mock-sso:${email}`, provider)

    const [audit] = await adminSql()<{ action: string; actor_type: string; diff: Record<string, unknown> }[]>`
      SELECT action, actor_type, diff FROM audit_logs
      WHERE organization_id = ${org.organizationId} AND action LIKE 'identity.sso%'
      ORDER BY occurred_at DESC LIMIT 1`
    expect(audit!.action).toBe('identity.sso_signed_in')
    expect(audit!.actor_type).toBe('user')
    expect(JSON.stringify(audit!.diff)).toContain(DOMAIN)
  })

  it('refuses an assertion the directory did not accept', async () => {
    const outcome = await signInWithAssertion('not-an-assertion', provider)
    expect(outcome.ok).toBe(false)
    expect(outcome.refusal).toBe('not_accepted')
    // The same sentence whether the signature was wrong or the person does not exist.
    expect(outcome.reason).toBe('That directory sign-in was not accepted.')
  })

  it('refuses a domain nobody verified, however good the assertion is', async () => {
    const outcome = await signInWithAssertion('mock-sso:stranger@elsewhere.example', provider)
    expect(outcome.ok).toBe(false)
    expect(outcome.refusal).toBe('no_organization')
  })

  it('refuses somebody who is not a member when nobody is created on first sign-in', async () => {
    const outcome = await signInWithAssertion(`mock-sso:nobody@${DOMAIN}`, provider)
    expect(outcome.ok).toBe(false)
    expect(outcome.refusal).toBe('not_a_member')
    expect(outcome.reason).toMatch(/does not create people on first sign-in/)
  })

  it('refuses somebody the organization deactivated, rather than quietly restoring them', async () => {
    const email = `left@${DOMAIN}`
    const userId = await aColleague(email)
    await adminSql()`
      UPDATE memberships SET status = 'inactive'
      WHERE organization_id = ${org.organizationId} AND user_id = ${userId}`
    // Even with just-in-time provisioning on: a deactivation is a decision somebody made, and
    // arriving through a different door does not undo it.
    await settings({ jitProvisioning: true })

    const outcome = await signInWithAssertion(`mock-sso:${email}`, provider)
    expect(outcome.ok).toBe(false)
    expect(outcome.refusal).toBe('deactivated')

    const [row] = await adminSql()<{ status: string }[]>`
      SELECT status FROM memberships WHERE organization_id = ${org.organizationId} AND user_id = ${userId}`
    expect(row!.status).toBe('inactive')
  })
})

describe('the first time somebody arrives', () => {
  it('creates them, at the role the organization chose', async () => {
    await settings({ jitProvisioning: true, defaultRole: 'viewer' })
    const email = `newcomer@${DOMAIN}`

    const outcome = await signInWithAssertion(`mock-sso:${email}`, provider)
    expect(outcome.ok).toBe(true)
    expect(outcome.provisioned).toBe(true)

    const [row] = await adminSql()<{ role: string; status: string; created_by: string; user_id: string }[]>`
      SELECT m.role, m.status, m.created_by, m.user_id
      FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ${org.organizationId} AND lower(u.email) = ${email}`
    expect(row!.role).toBe('viewer')
    expect(row!.status).toBe('active')
    // They arrived; nobody added them. A row naming an administrator would answer "who let them
    // in" with somebody who was not there.
    expect(row!.created_by).toBe(row!.user_id)
  })

  it('gives them a password that cannot be used', async () => {
    await settings({ jitProvisioning: true })
    const email = `passwordless@${DOMAIN}`
    await signInWithAssertion(`mock-sso:${email}`, provider)

    const { login } = await import('@superwork/auth')
    expect(await login(email, 'sso-only')).toBeNull()
    expect(await login(email, '')).toBeNull()
  })

  it('never mints an owner or an admin, whatever the row says', async () => {
    await settings({ jitProvisioning: true })
    // The repository refuses to store either as the default role, so the only way to ask this
    // question is to put one there behind its back — and the database still refuses the write.
    await adminSql()`
      UPDATE identity_settings SET default_role = 'admin'::sw_role
      WHERE organization_id = ${org.organizationId}`

    const outcome = await signInWithAssertion(`mock-sso:climber@${DOMAIN}`, provider)
    expect(outcome.ok).toBe(false)
    expect(outcome.refusal).toBe('misconfigured')

    const [row] = await adminSql()<{ count: number }[]>`
      SELECT count(*)::int AS count FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ${org.organizationId} AND lower(u.email) = ${`climber@${DOMAIN}`}`
    expect(row!.count).toBe(0)
  })
})

describe('the second factor', () => {
  it('is still asked for: a directory proved the first thing, not both', async () => {
    const email = `guarded@${DOMAIN}`
    const userId = await aColleague(email)
    await adminSql()`
      UPDATE users SET mfa_enabled = true, mfa_secret = 'JBSWY3DPEHPK3PXP', mfa_confirmed_at = now()
      WHERE id = ${userId}`

    const outcome = await signInWithAssertion(`mock-sso:${email}`, provider)
    expect(outcome.ok).toBe(true)
    expect(outcome.session!.mfaRequired).toBe(true)
    // The session exists and is revocable, and resolves to nothing until the code is given.
    expect(await resolveSession(outcome.session!.token)).toBeNull()
    expect((await resolvePendingSession(outcome.session!.token))?.userId).toBe(userId)
  })
})
