import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { can, loadActor } from '@superwork/auth'
import {
  grantPermission,
  listPermissionGrants,
  MAX_GRANT_DAYS,
  NotFoundError,
  PermissionError,
  revokePermissionGrant,
  StepUpRequiredError,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * One capability, for one person (ADR 0055).
 *
 * `checkHumanPermissions` has always ended with
 * `[...ROLE_PERMISSIONS[actor.role], ...actor.extraPermissions]`, and nothing ever wrote the
 * second half. The escape hatch was designed into the function that decides every `can()` call
 * and had no door.
 *
 * The tests that matter are the ceilings — what an exception may *not* be — and the one that
 * proves the grant reaches the engine at all.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let stepped: { organizationId: string; userId: string; timezone: string; steppedUpAt: Date }
let memberSession: { organizationId: string; userId: string; timezone: string }

beforeAll(async () => {
  org = await createTenant('permission-grants')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  stepped = { ...session, steppedUpAt: new Date() }
  memberSession = { organizationId: org.organizationId, userId: org.memberId, timezone: TZ }
})

afterAll(async () => {
  await destroyTenant('permission-grants')
  await closePools()
})

async function clearGrants(): Promise<void> {
  await adminSql()`DELETE FROM permission_grants WHERE organization_id = ${org.organizationId}`
}

describe('an exception reaches the engine that decides every check', () => {
  it('lets one person do one thing their role does not carry', async () => {
    // A member cannot update a document they do not own. That is the whole role.
    const before = await withTenant(memberSession, async (ctx) => {
      const actor = await loadActor(ctx)
      return can(actor, 'document:update', {
        type: 'document',
        organizationId: ctx.organizationId,
        createdBy: org.ownerId,
      })
    })
    expect(before.allow).toBe(false)

    await withTenant(stepped, async (ctx) => {
      const actor = await loadActor(ctx)
      await grantPermission(ctx, actor, {
        userId: org.memberId,
        permission: 'document:update:org',
        reason: 'Covering the Felixstowe desk while Omar is on leave.',
      })
    })

    const after = await withTenant(memberSession, async (ctx) => {
      const actor = await loadActor(ctx)
      expect(actor.extraPermissions).toContain('document:update:org')
      return can(actor, 'document:update', {
        type: 'document',
        organizationId: ctx.organizationId,
        createdBy: org.ownerId,
      })
    })
    expect(after.allow).toBe(true)
    // And the decision says which of the two allowed it, rather than crediting the role.
    expect(after.reason).toMatch(/exception granted to you/i)

    await clearGrants()
  })

  it('stops the moment it is taken back', async () => {
    let grantId = ''
    await withTenant(stepped, async (ctx) => {
      const actor = await loadActor(ctx)
      const rows = await grantPermission(ctx, actor, {
        userId: org.memberId,
        permission: 'document:update:org',
        reason: 'Covering the Felixstowe desk while Omar is on leave.',
      })
      grantId = rows.find((row) => row.live)!.id
    })

    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      // Taking one back does not ask for a password: it is the narrowing direction.
      await revokePermissionGrant(ctx, actor, { grantId, reason: 'Omar is back.' })
    })

    const after = await withTenant(memberSession, async (ctx) => {
      const actor = await loadActor(ctx)
      expect(actor.extraPermissions).not.toContain('document:update:org')
      return can(actor, 'document:update', {
        type: 'document',
        organizationId: ctx.organizationId,
        createdBy: org.ownerId,
      })
    })
    expect(after.allow).toBe(false)
    await clearGrants()
  })

  it('stops on its own when it expires, without waiting for a sweep', async () => {
    await withTenant(stepped, async (ctx) => {
      const actor = await loadActor(ctx)
      await grantPermission(ctx, actor, {
        userId: org.memberId,
        permission: 'document:update:org',
        reason: 'Two weeks of cover for the customs desk.',
        expiresAt: new Date(Date.now() + 14 * 86_400_000),
      })
    })
    // Move its end date into the past — the same row, no sweep, no other write.
    await adminSql()`
      UPDATE permission_grants SET expires_at = now() - interval '1 minute'
      WHERE organization_id = ${org.organizationId}`

    const after = await withTenant(memberSession, async (ctx) => {
      const actor = await loadActor(ctx)
      expect(actor.extraPermissions).toEqual([])
      return can(actor, 'document:update', {
        type: 'document',
        organizationId: ctx.organizationId,
        createdBy: org.ownerId,
      })
    })
    expect(after.allow).toBe(false)

    // It is still on the record, marked as no longer in force.
    const rows = await withTenant(session, async (ctx) => listPermissionGrants(ctx, await loadActor(ctx)))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.live).toBe(false)
    await clearGrants()
  })
})

describe('what an exception may not be', () => {
  it('is not a wildcard, which would be making somebody an administrator', async () => {
    await withTenant(stepped, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        grantPermission(ctx, actor, {
          userId: org.memberId,
          permission: '*:*:org',
          reason: 'They need to get on with things quickly.',
        }),
      ).rejects.toThrow(/administrator without saying so/i)
      await expect(
        grantPermission(ctx, actor, {
          userId: org.memberId,
          permission: 'document:*:org',
          reason: 'They need to get on with things quickly.',
        }),
      ).rejects.toThrow(ValidationError)
    })
  })

  it('is not something the granter does not have themselves', async () => {
    // An admin may read billing and not change it. They administer members, so they reach this
    // door — and cannot hand out through it a capability they have not got. Without this rule,
    // the ability to open the door would be a way to mint capability out of nothing.
    await adminSql()`
      UPDATE memberships SET role = 'admin'
      WHERE organization_id = ${org.organizationId} AND user_id = ${org.viewerId}`
    await withTenant(
      { organizationId: org.organizationId, userId: org.viewerId, timezone: TZ, steppedUpAt: new Date() },
      async (ctx) => {
        const actor = await loadActor(ctx)
        expect(can(actor, 'billing:update', { type: 'billing', organizationId: ctx.organizationId }).allow).toBe(false)
        await expect(
          grantPermission(ctx, actor, {
            userId: org.memberId,
            permission: 'billing:update:org',
            reason: 'They want to change what the company is charged.',
          }),
        ).rejects.toThrow(/do not have it yourself/i)

        // The owner, who does hold it, can.
        await expect(
          grantPermission(ctx, actor, {
            userId: org.memberId,
            permission: 'document:update:org',
            reason: 'Covering the Felixstowe desk while Omar is on leave.',
          }),
        ).resolves.toBeDefined()
      },
    )
    await clearGrants()
    await adminSql()`
      UPDATE memberships SET role = 'viewer'
      WHERE organization_id = ${org.organizationId} AND user_id = ${org.viewerId}`
  })

  it('is not something the role already carries', async () => {
    await withTenant(stepped, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        grantPermission(ctx, actor, {
          userId: org.memberId,
          permission: 'task:read:org',
          reason: 'So that they can see the work queue properly.',
        }),
      ).rejects.toThrow(/already has task:read:org from their member role/i)
    })
  })

  it('is not a string the engine would silently ignore', async () => {
    await withTenant(stepped, async (ctx) => {
      const actor = await loadActor(ctx)
      // The engine's own loop does `catch { continue }`, so a malformed grant would sit on the
      // screen doing nothing at all. It is refused here with a sentence instead.
      await expect(
        grantPermission(ctx, actor, {
          userId: org.memberId,
          permission: 'document:update',
          reason: 'They need to fix the handover notes.',
        }),
      ).rejects.toThrow(/a thing, a verb, and how far it reaches/i)
      await expect(
        grantPermission(ctx, actor, {
          userId: org.memberId,
          permission: 'document:update:everything',
          reason: 'They need to fix the handover notes.',
        }),
      ).rejects.toThrow(ValidationError)
    })
    // And the database refuses it too, so no other writer can put one there.
    await expect(
      adminSql()`
        INSERT INTO permission_grants (organization_id, user_id, permission, granted_by, reason)
        VALUES (${org.organizationId}, ${org.memberId}, 'document:update:*', ${org.ownerId},
                'A wildcard scope by another door.')`,
    ).rejects.toThrow(/permission_grants_shape/)
  })

  it('is not permanent by accident, and not longer than a year', async () => {
    await withTenant(stepped, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        grantPermission(ctx, actor, {
          userId: org.memberId,
          permission: 'document:update:org',
          reason: 'Covering the desk for the next few years.',
          expiresAt: new Date(Date.now() + (MAX_GRANT_DAYS + 30) * 86_400_000),
        }),
      ).rejects.toThrow(/at most 365 days/i)
      await expect(
        grantPermission(ctx, actor, {
          userId: org.memberId,
          permission: 'document:update:org',
          reason: 'Covering the desk, retrospectively.',
          expiresAt: new Date(Date.now() - 86_400_000),
        }),
      ).rejects.toThrow(/already ended/i)
    })
  })

  it('is not something anybody can hand out, and is not silent', async () => {
    await withTenant(memberSession, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        grantPermission(ctx, actor, {
          userId: org.viewerId,
          permission: 'document:update:org',
          reason: 'They asked me nicely for it this morning.',
        }),
      ).rejects.toThrow(PermissionError)
    })
  })

  it('asks for a fresh proof of identity, and taking one back does not', async () => {
    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        grantPermission(ctx, actor, {
          userId: org.memberId,
          permission: 'document:update:org',
          reason: 'Covering the Felixstowe desk while Omar is on leave.',
        }),
      ).rejects.toThrow(StepUpRequiredError)
    })
  })

  it('needs a reason somebody could act on in six months', async () => {
    await withTenant(stepped, async (ctx) => {
      const actor = await loadActor(ctx)
      await expect(
        grantPermission(ctx, actor, {
          userId: org.memberId,
          permission: 'document:update:org',
          reason: 'needed',
        }),
      ).rejects.toThrow(/role change nobody wrote down/i)
    })
  })

  it('is refused twice over rather than duplicated', async () => {
    await withTenant(stepped, async (ctx) => {
      const actor = await loadActor(ctx)
      await grantPermission(ctx, actor, {
        userId: org.memberId,
        permission: 'document:update:org',
        reason: 'Covering the Felixstowe desk while Omar is on leave.',
      })
      await expect(
        grantPermission(ctx, actor, {
          userId: org.memberId,
          permission: 'document:update:org',
          reason: 'Covering the Felixstowe desk a second time.',
        }),
      ).rejects.toThrow(/already has that exception/i)
    })
    // The database holds the same rule for anybody writing another way.
    await expect(
      adminSql()`
        INSERT INTO permission_grants (organization_id, user_id, permission, granted_by, reason)
        VALUES (${org.organizationId}, ${org.memberId}, 'document:update:org', ${org.ownerId},
                'A duplicate by another door.')`,
    ).rejects.toThrow(/permission_grants_one_live/)
    await clearGrants()
  })
})

describe('the person it is about hears about it', () => {
  it('is told when one is granted, and when it is taken back', async () => {
    let grantId = ''
    await withTenant(stepped, async (ctx) => {
      const actor = await loadActor(ctx)
      const rows = await grantPermission(ctx, actor, {
        userId: org.memberId,
        permission: 'document:update:org',
        reason: 'Covering the Felixstowe desk while Omar is on leave.',
      })
      grantId = rows.find((row) => row.live)!.id
    })

    // §29.3: nothing about a person reaches anybody before it reaches them. A `disclosure` is
    // the one kind of notification that cannot be turned down (ADR 0047).
    const [told] = await adminSql()<{ type: string; title: string }[]>`
      SELECT type, title FROM notifications
      WHERE organization_id = ${org.organizationId} AND user_id = ${org.memberId}
      ORDER BY created_at DESC LIMIT 1`
    expect(told!.type).toBe('disclosure')
    expect(told!.title).toContain('document:update:org')

    await withTenant(session, async (ctx) => {
      const actor = await loadActor(ctx)
      await revokePermissionGrant(ctx, actor, { grantId, reason: 'Omar is back.' })
    })
    const [toldAgain] = await adminSql()<{ title: string }[]>`
      SELECT title FROM notifications
      WHERE organization_id = ${org.organizationId} AND user_id = ${org.memberId}
      ORDER BY created_at DESC LIMIT 1`
    expect(toldAgain!.title).toContain('was taken off your account')
    await clearGrants()
  })

  it('is another tenant’s 404, never their 403', async () => {
    const other = await createTenant('permission-grants-other')
    try {
      const [theirs] = await adminSql()<{ id: string }[]>`
        INSERT INTO permission_grants (organization_id, user_id, permission, granted_by, reason)
        VALUES (${other.organizationId}, ${other.memberId}, 'document:update:org', ${other.ownerId},
                'An exception in another organization.')
        RETURNING id`
      await withTenant(session, async (ctx) => {
        const actor = await loadActor(ctx)
        await expect(
          revokePermissionGrant(ctx, actor, { grantId: theirs!.id, reason: 'Not mine to take off.' }),
        ).rejects.toThrow(NotFoundError)
      })
      // And it governs nobody here.
      await withTenant(memberSession, async (ctx) => {
        const actor = await loadActor(ctx)
        expect(actor.extraPermissions).toEqual([])
      })
    } finally {
      await destroyTenant('permission-grants-other')
    }
  })
})
