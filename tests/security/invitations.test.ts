import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor, login } from '@superwork/auth'
import {
  acceptInvitation,
  invitationOffer,
  inviteMember,
  listInvitations,
  NotFoundError,
  PermissionError,
  revokeInvitation,
  seatCheck,
  seatsInUse,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Invitations (§4.1, §23.2).
 *
 * `invitations` was created in migration 0001 and never read or written, which made this the
 * largest single gap in the product: there was no way to add a person to an organization
 * except by running the seed or connecting a directory sync.
 *
 * An invitation is a credential, so most of what matters here is adversarial: it is shown
 * once, it works once, it expires, it can be withdrawn, and it cannot be used to hand out
 * more than the sender holds.
 */

let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let adminSession: { organizationId: string; userId: string; timezone: string }
let memberSession: { organizationId: string; userId: string; timezone: string }
let adminId: string

const invited: string[] = []

beforeAll(async () => {
  org = await createTenant('invitations')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: 'Europe/London' }
  memberSession = { organizationId: org.organizationId, userId: org.memberId, timezone: 'Europe/London' }

  await adminSql()`DELETE FROM users WHERE lower(email) = 'admin.invitations@fixture.example'`
  const [user] = await adminSql()<{ id: string }[]>`
    INSERT INTO users (email, name, timezone, is_demo)
    VALUES ('admin.invitations@fixture.example', 'Admin Invitations', 'Europe/London', true) RETURNING id`
  adminId = user!.id
  await adminSql()`
    INSERT INTO memberships (organization_id, user_id, role, is_demo)
    VALUES (${org.organizationId}, ${adminId}, 'admin', true)`
  adminSession = { organizationId: org.organizationId, userId: adminId, timezone: 'Europe/London' }

  // A fixture organization has no subscription, so it falls back to the free tier's three
  // seats — and it already has four people. That is the seat check working; a real
  // organization has a plan, so this one gets one.
  await adminSql()`
    INSERT INTO subscriptions (organization_id, tier, seats_purchased, created_by)
    VALUES (${org.organizationId}, 'business', 25, ${org.ownerId})`
})

afterAll(async () => {
  await destroyTenant('invitations')
  await adminSql()`DELETE FROM users WHERE id = ${adminId}`
  for (const email of invited) await adminSql()`DELETE FROM users WHERE lower(email) = lower(${email})`
  await closePools()
})

describe('sending one', () => {
  it('returns the token once and stores only a hash of it', async () => {
    const issued = await withTenant(session, async (ctx) =>
      inviteMember(ctx, await loadActor(ctx), {
        email: 'Jordan@Northwind.Example',
        role: 'member',
        reason: 'Joining the renewals team on Monday.',
      }),
    )
    invited.push('jordan@northwind.example')
    expect(issued.token.length).toBeGreaterThan(30)
    expect(issued.invitation.email).toBe('jordan@northwind.example')
    expect(issued.invitation.state).toBe('pending')

    const [row] = await adminSql()<{ tokenHash: string }[]>`
      SELECT token_hash AS "tokenHash" FROM invitations WHERE id = ${issued.invitation.id}`
    // The token itself is nowhere in the row — there is no screen that could show it again.
    expect(row!.tokenHash).not.toContain(issued.token)
    expect(row!.tokenHash).toHaveLength(64)
  })

  it('will not send one without a reason', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        inviteMember(ctx, await loadActor(ctx), {
          email: 'nobody@northwind.example',
          role: 'member',
          reason: '  ',
        }),
      ),
    ).rejects.toThrow(ValidationError)
  })

  it('refuses a second open invitation for the same address', async () => {
    // Two racing invitations means whichever link they happen to open decides their role.
    await expect(
      withTenant(session, async (ctx) =>
        inviteMember(ctx, await loadActor(ctx), {
          email: 'jordan@northwind.example',
          role: 'admin',
          reason: 'Trying to upgrade them by sending a second one.',
        }),
      ),
    ).rejects.toThrow(/already an open invitation/i)
  })

  it('refuses somebody who is already a member', async () => {
    const [existing] = await adminSql()<{ email: string }[]>`
      SELECT email FROM users WHERE id = ${org.memberId}`
    await expect(
      withTenant(session, async (ctx) =>
        inviteMember(ctx, await loadActor(ctx), {
          email: existing!.email,
          role: 'admin',
          reason: 'They are already here.',
        }),
      ),
    ).rejects.toThrow(/already a member/i)
  })

  it('will not let anybody invite above their own role', async () => {
    // An admin inviting an owner is a privilege escalation with a form on it.
    await expect(
      withTenant(adminSession, async (ctx) =>
        inviteMember(ctx, await loadActor(ctx), {
          email: 'escalation@northwind.example',
          role: 'owner',
          reason: 'Attempting to mint an owner.',
        }),
      ),
    ).rejects.toThrow(/above your own role/i)
  })

  it('refuses when every seat is taken, counting invitations nobody has accepted', async () => {
    // Seats are a hard limit: an organization bought a number. An outstanding invitation
    // holds one, or somebody can invite a hundred people onto twenty-five seats and find
    // out when they arrive.
    const used = await withTenant(session, async (ctx) => seatsInUse(ctx))
    await adminSql()`
      UPDATE subscriptions SET seats_purchased = ${used}
      WHERE organization_id = ${org.organizationId}`

    await expect(
      withTenant(session, async (ctx) =>
        inviteMember(ctx, await loadActor(ctx), {
          email: 'overflow@northwind.example',
          role: 'member',
          reason: 'One person too many.',
        }),
      ),
    ).rejects.toThrow(/seats are taken/i)

    // And the refusal does the arithmetic rather than saying "no seats".
    const check = await withTenant(session, async (ctx) => seatCheck(ctx))
    expect(check.allow).toBe(false)
    expect(check.reason).toMatch(new RegExp(`All ${used} seats`))

    await adminSql()`
      UPDATE subscriptions SET seats_purchased = 25 WHERE organization_id = ${org.organizationId}`
  })

  it('is not something an ordinary member can do', async () => {
    await expect(
      withTenant(memberSession, async (ctx) =>
        inviteMember(ctx, await loadActor(ctx), {
          email: 'friend@northwind.example',
          role: 'member',
          reason: 'Bringing a friend in.',
        }),
      ),
    ).rejects.toThrow(PermissionError)
  })
})

describe('accepting one', () => {
  it('says nothing at all about a token that is not live', async () => {
    // A wrong token, a used one and a lapsed one are indistinguishable: telling them apart
    // tells somebody probing which addresses were invited.
    expect(await invitationOffer('not-a-real-token-but-long-enough')).toBeNull()
    expect(await invitationOffer('')).toBeNull()
    expect(await invitationOffer('short')).toBeNull()
  })

  it('creates the user, the membership and the audit entry', async () => {
    const issued = await withTenant(session, async (ctx) =>
      inviteMember(ctx, await loadActor(ctx), {
        email: 'rae@northwind.example',
        role: 'manager',
        reason: 'Taking over the Halden account.',
      }),
    )
    invited.push('rae@northwind.example')

    const offer = await invitationOffer(issued.token)
    expect(offer?.role).toBe('manager')
    expect(offer?.email).toBe('rae@northwind.example')

    const accepted = await acceptInvitation(issued.token, { name: 'Rae Lindqvist', password: 'a-good-password' })
    expect(accepted?.email).toBe('rae@northwind.example')

    const [membership] = await adminSql()<{ role: string; status: string }[]>`
      SELECT m.role, m.status FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.organization_id = ${org.organizationId} AND lower(u.email) = 'rae@northwind.example'`
    expect(membership?.role).toBe('manager')
    expect(membership?.status).toBe('active')

    const [entry] = await adminSql()<{ action: string }[]>`
      SELECT action FROM audit_logs
      WHERE organization_id = ${org.organizationId} AND action = 'member.invitation_accepted'`
    expect(entry?.action).toBe('member.invitation_accepted')

    // And they can sign in with what they chose.
    expect(await login('rae@northwind.example', 'a-good-password')).not.toBeNull()
  })

  it('works exactly once', async () => {
    const issued = await withTenant(session, async (ctx) =>
      inviteMember(ctx, await loadActor(ctx), {
        email: 'once@northwind.example',
        role: 'viewer',
        reason: 'One use only.',
      }),
    )
    invited.push('once@northwind.example')
    expect(await acceptInvitation(issued.token, { name: 'Once', password: 'a-good-password' })).not.toBeNull()
    // A single-use credential that works twice is a shared one.
    expect(await acceptInvitation(issued.token, { name: 'Again', password: 'a-good-password' })).toBeNull()
    expect(await invitationOffer(issued.token)).toBeNull()
  })

  it('refuses a password too weak to be one', async () => {
    const issued = await withTenant(session, async (ctx) =>
      inviteMember(ctx, await loadActor(ctx), {
        email: 'weak@northwind.example',
        role: 'viewer',
        reason: 'Checking the password rule.',
      }),
    )
    invited.push('weak@northwind.example')
    await expect(acceptInvitation(issued.token, { name: 'Weak', password: 'short' })).rejects.toThrow(
      ValidationError,
    )
    // And the invitation is still usable afterwards — a refused attempt does not burn it.
    expect(await invitationOffer(issued.token)).not.toBeNull()
  })

  it('stops working the moment it is withdrawn', async () => {
    const issued = await withTenant(session, async (ctx) =>
      inviteMember(ctx, await loadActor(ctx), {
        email: 'gone@northwind.example',
        role: 'member',
        reason: 'They may not be joining.',
      }),
    )
    await withTenant(session, async (ctx) =>
      revokeInvitation(ctx, await loadActor(ctx), {
        invitationId: issued.invitation.id,
        reason: 'They are not joining after all.',
      }),
    )
    expect(await invitationOffer(issued.token)).toBeNull()
    expect(await acceptInvitation(issued.token, { name: 'Gone', password: 'a-good-password' })).toBeNull()

    const list = await withTenant(session, async (ctx) => listInvitations(ctx, await loadActor(ctx)))
    const revoked = list.find((row) => row.id === issued.invitation.id)
    expect(revoked?.state).toBe('revoked')
    expect(revoked?.revokedReason).toMatch(/not joining/i)
  })

  it('stops working once it lapses', async () => {
    const issued = await withTenant(session, async (ctx) =>
      inviteMember(ctx, await loadActor(ctx), {
        email: 'late@northwind.example',
        role: 'member',
        reason: 'Checking the expiry.',
      }),
    )
    await adminSql()`
      UPDATE invitations SET expires_at = now() - interval '1 day' WHERE id = ${issued.invitation.id}`
    expect(await invitationOffer(issued.token)).toBeNull()

    const list = await withTenant(session, async (ctx) => listInvitations(ctx, await loadActor(ctx)))
    // Reads as lapsed rather than as still open — a stale invitation on a list somebody is
    // reviewing is one they will wrongly believe is live.
    expect(list.find((row) => row.id === issued.invitation.id)?.state).toBe('expired')
  })

  it('cannot be withdrawn after it has been accepted', async () => {
    const list = await withTenant(session, async (ctx) => listInvitations(ctx, await loadActor(ctx)))
    const accepted = list.find((row) => row.state === 'accepted')
    await expect(
      withTenant(session, async (ctx) =>
        revokeInvitation(ctx, await loadActor(ctx), {
          invitationId: accepted!.id,
          reason: 'Trying to undo it this way.',
        }),
      ),
    ).rejects.toThrow(/already accepted/i)
  })

  it('refuses to withdraw one that does not exist', async () => {
    await expect(
      withTenant(session, async (ctx) =>
        revokeInvitation(ctx, await loadActor(ctx), {
          invitationId: '00000000-0000-0000-0000-000000000000',
          reason: 'Nothing there.',
        }),
      ),
    ).rejects.toThrow(NotFoundError)
  })
})

describe('an invitation belongs to one organization', () => {
  it('does not appear on another tenant’s list', async () => {
    const other = await createTenant('invitations-other')
    const theirs = await withTenant(
      { organizationId: other.organizationId, userId: other.ownerId, timezone: 'Europe/London' },
      async (ctx) => listInvitations(ctx, await loadActor(ctx)),
    )
    expect(theirs).toHaveLength(0)
    await destroyTenant('invitations-other')
  })

  it('grants membership only of the organization that sent it', async () => {
    const [rows] = await adminSql()<{ count: number }[]>`
      SELECT count(*)::int FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE lower(u.email) = 'rae@northwind.example'`
    expect(rows?.count).toBe(1)
  })
})
