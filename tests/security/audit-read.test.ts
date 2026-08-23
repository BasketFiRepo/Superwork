import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor, type Actor } from '@superwork/auth'
import { myAuditTrail, readAuditLog, writeAudit } from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * An audit log somebody can read (ADR 0079).
 *
 * `writeAudit` is called from all over this product and nothing ever read the table — the only
 * two queries against it in the whole repository were the retention sweep counting rows to
 * delete and the erasure preview counting rows about a person. Meanwhile `audit:read:org` had
 * been in the administrator's grant list since the ladder was built.
 *
 * A permission with no feature behind it is the same failure as a column with no writer, one
 * layer up.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let owner: { organizationId: string; userId: string; timezone: string }
let member: { organizationId: string; userId: string; timezone: string }
let ownerActor: Actor

beforeAll(async () => {
  org = await createTenant('audit-read')
  owner = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  member = { organizationId: org.organizationId, userId: org.memberId, timezone: TZ }
  ownerActor = await withTenant(owner, async (ctx) => loadActor(ctx))

  // One of each, so the reader is exercised on what the product actually writes.
  await withTenant(member, async (ctx) => {
    await writeAudit(ctx, {
      actorType: 'user',
      actorId: org.memberId,
      action: 'document.classified',
      entityType: 'document',
      entityId: org.documentId,
      before: { sensitivity: 'internal' },
      after: { sensitivity: 'restricted' },
    })
  })
  await withTenant(owner, async (ctx) => {
    await writeAudit(ctx, {
      actorType: 'user',
      actorId: org.ownerId,
      action: 'member.password_changed',
      entityType: 'user',
      entityId: org.ownerId,
      // `SENSITIVE_FIELDS` redacts at the logging layer, so the trail records that it changed
      // without ever having held it.
      before: { password_hash: 'before' },
      after: { password_hash: 'after' },
    })
  })
})

afterAll(async () => {
  await destroyTenant('audit-read')
  await closePools()
})

describe('who may read the trail', () => {
  it('an administrator, which is what the grant has always said', async () => {
    const entries = await withTenant(owner, async (ctx) => readAuditLog(ctx, ownerActor, {}))
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.some((e) => e.action === 'document.classified')).toBe(true)
  })

  it('and nobody else, however much of it is about them', async () => {
    await expect(
      withTenant(member, async (ctx) => readAuditLog(ctx, await loadActor(ctx), {})),
    ).rejects.toThrow()
  })

  it('and not a manager, whose read-everything wildcard does not reach it', async () => {
    /**
     * The one that was nearly shipped wrong. A manager carries `*:read:org`, which matched
     * `audit:read` because the resolver treated `*` as "any resource type" — so every manager
     * could read the whole organization's trail, and `audit:read:org` in the administrator's
     * list was decoration. The browser check caught it by asserting a refusal that did not come.
     */
    await withTenant(owner, async (ctx) => {
      await ctx.sql`UPDATE memberships SET role = 'manager' WHERE user_id = ${org.memberId}`
    })
    const asManager = { organizationId: org.organizationId, userId: org.memberId, timezone: TZ }
    await expect(
      withTenant(asManager, async (ctx) => readAuditLog(ctx, await loadActor(ctx), {})),
    ).rejects.toThrow()
    // And the refusal names a rung above the one they are on, never the one they hold (ADR 0059).
    const refusal = await withTenant(asManager, async (ctx) =>
      readAuditLog(ctx, await loadActor(ctx), {}).then(
        () => '',
        (error: Error) => error.message,
      ),
    )
    expect(refusal).toMatch(/Admin access/i)
    await withTenant(owner, async (ctx) => {
      await ctx.sql`UPDATE memberships SET role = 'member' WHERE user_id = ${org.memberId}`
    })
  })

  it('and never across a tenant boundary', async () => {
    const other = await createTenant('audit-read-b')
    try {
      const theirs = await withTenant(
        { organizationId: other.organizationId, userId: other.ownerId, timezone: TZ },
        async (ctx) => readAuditLog(ctx, await loadActor(ctx), {}),
      )
      expect(theirs.every((e) => e.action !== 'document.classified')).toBe(true)
    } finally {
      await destroyTenant('audit-read-b')
    }
  })
})

describe('what a line says', () => {
  it('who is answerable, what they did, and to what', async () => {
    const [entry] = await withTenant(owner, async (ctx) =>
      readAuditLog(ctx, ownerActor, { action: 'document.classified' }),
    )
    expect(entry!.actorName).toBeTruthy()
    expect(entry!.entityType).toBe('document')
    expect(entry!.diff.sensitivity).toEqual({ from: 'internal', to: 'restricted' })
  })

  it('and names a redacted field rather than dropping it', async () => {
    // "Three fields not recorded" is a fact an auditor needs; silence is not.
    const [entry] = await withTenant(owner, async (ctx) =>
      readAuditLog(ctx, ownerActor, { action: 'member.password_changed' }),
    )
    expect(entry!.redactedFields).toContain('password_hash')
    expect(entry!.diff.password_hash).toEqual({ from: '[redacted]', to: '[redacted]' })
  })

  it('and whether a password was re-entered before it', async () => {
    const entries = await withTenant(owner, async (ctx) => readAuditLog(ctx, ownerActor, {}))
    expect(entries.every((e) => typeof e.steppedUp === 'boolean')).toBe(true)
  })
})

describe('what it can be asked', () => {
  it('what happened to one record', async () => {
    const entries = await withTenant(owner, async (ctx) =>
      readAuditLog(ctx, ownerActor, { entityType: 'document', entityId: org.documentId }),
    )
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.every((e) => e.entityId === org.documentId)).toBe(true)
  })

  it('and what one account did, because a compromised one cannot be investigated otherwise', async () => {
    const entries = await withTenant(owner, async (ctx) =>
      readAuditLog(ctx, ownerActor, { principalUserId: org.memberId }),
    )
    expect(entries.length).toBeGreaterThan(0)
    expect(entries.some((e) => e.action === 'document.classified')).toBe(true)
  })
})

describe('what it deliberately cannot be asked', () => {
  /**
   * §29.5 forbids individual productivity scoring by construction rather than by policy.
   * "What did this account do" is a security question; "how much did this person do" is a
   * measure of them, and the difference is only that nobody wrote the second query.
   *
   * The same line ADR 0070 drew for digests, asserted the same way — because it is not a
   * difference a comment can hold.
   */
  it('how much anybody did — there is no aggregate keyed on the person', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../packages/core/src/audit.ts', import.meta.url), 'utf8'),
    )
    expect(/GROUP\s+BY\s+[a-z.]*principal_user_id/i.test(source)).toBe(false)
    expect(/count\s*\(/i.test(source)).toBe(false)
  })

  it('and the screen has no totals on it either', async () => {
    const page = await import('node:fs').then((fs) =>
      fs.readFileSync(
        new URL('../../apps/web/src/app/(app)/settings/audit/page.tsx', import.meta.url),
        'utf8',
      ),
    )
    // The one number on the page is how many rows are shown, which is not a measure of anybody.
    expect(/GROUP\s+BY/i.test(page)).toBe(false)
  })
})

describe('the person it is about', () => {
  /**
   * §29.3: nothing about a person reaches their manager that the person has not already seen.
   * An administrator can now read what a member did, so this is what makes that true.
   */
  it('can read their own trail without holding audit:read', async () => {
    const mine = await withTenant(member, async (ctx) => myAuditTrail(ctx, await loadActor(ctx)))
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.some((e) => e.action === 'document.classified')).toBe(true)
  })

  it('and sees only their own, never somebody else’s', async () => {
    const mine = await withTenant(member, async (ctx) => myAuditTrail(ctx, await loadActor(ctx)))
    expect(mine.some((e) => e.action === 'member.password_changed')).toBe(false)
  })

  it('which is the same row the administrator reads, from the same table', async () => {
    const mine = await withTenant(member, async (ctx) => myAuditTrail(ctx, await loadActor(ctx)))
    const theirs = await withTenant(owner, async (ctx) =>
      readAuditLog(ctx, ownerActor, { principalUserId: org.memberId }),
    )
    expect(mine.map((e) => e.id).sort()).toEqual(theirs.map((e) => e.id).sort())
  })
})

describe('what the trail holds to, whatever writes it', () => {
  /**
   * The asymmetry here is deliberate and worth stating, because the first version of this test
   * asserted something the design does not promise. Migration 0009 replaced 0005's blanket rule
   * with two:
   *
   *   * **Nobody may rewrite a line** — UPDATE is refused for every role, the owner connection
   *     included. A record somebody can tidy is not evidence.
   *   * **The application role may not delete one.** The owner connection may, and that is the
   *     single path history leaves by: retention sweeps and erasure both run through it. An
   *     audit trail that could never be trimmed would be a retention policy nobody could keep.
   */
  it('nobody can rewrite a line, including the owner connection', async () => {
    const [row] = await adminSql()<{ id: string }[]>`
      SELECT id FROM audit_logs WHERE organization_id = ${org.organizationId} LIMIT 1`
    await expect(
      adminSql()`UPDATE audit_logs SET action = 'tidied' WHERE id = ${row!.id}`,
    ).rejects.toThrow(/history cannot be rewritten/i)
  })

  it('and the product cannot delete one, whatever it is asked to do', async () => {
    const [row] = await adminSql()<{ id: string }[]>`
      SELECT id FROM audit_logs WHERE organization_id = ${org.organizationId} LIMIT 1`
    // Not the trigger. Migration 0008 revoked DELETE from `superwork_app` outright, so the
    // privilege system refuses before any row is examined — which is the stronger refusal of the
    // two, because it does not depend on a trigger still being attached.
    await expect(
      withTenant(owner, async (ctx) => ctx.sql`DELETE FROM audit_logs WHERE id = ${row!.id}`),
    ).rejects.toThrow(/permission denied for table audit_logs/i)
  })

  it('and would still refuse if somebody granted it the privilege back', async () => {
    /**
     * The trigger's `current_user = 'superwork_app'` branch is unreachable while the REVOKE
     * above stands, which means nothing in the suite proves it works — and an unexercised
     * guard is a guard nobody knows the state of. So this test creates the only situation in
     * which it matters: a future migration, or a DBA with good intentions, hands the runtime
     * role DELETE back. The trail must hold anyway.
     */
    const [row] = await adminSql()<{ id: string }[]>`
      SELECT id FROM audit_logs WHERE organization_id = ${org.organizationId} LIMIT 1`
    await adminSql()`GRANT DELETE ON audit_logs TO superwork_app`
    try {
      await expect(
        withTenant(owner, async (ctx) => ctx.sql`DELETE FROM audit_logs WHERE id = ${row!.id}`),
      ).rejects.toThrow(/append-only for the application role/i)
    } finally {
      await adminSql()`REVOKE DELETE ON audit_logs FROM superwork_app`
    }
  })

  it('while the connection retention runs on may, because that is how a policy is kept', async () => {
    const [row] = await adminSql()<{ id: string }[]>`
      INSERT INTO audit_logs (organization_id, actor_type, action, entity_type)
      VALUES (${org.organizationId}, 'system', 'test.expired', 'document') RETURNING id`
    await adminSql()`DELETE FROM audit_logs WHERE id = ${row!.id}`
    const remaining = await adminSql()<{ id: string }[]>`
      SELECT id FROM audit_logs WHERE id = ${row!.id}`
    expect(remaining).toHaveLength(0)
  })
})
