import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  createApproval,
  decideApproval,
  delegateApproval,
  handOverCandidates,
  getApproval,
  reclaimApproval,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * An approval somebody handed on (ADR 0082).
 *
 * `approvals.delegated_to` has existed since migration 0005 with no writer and no reader, and
 * `ApprovalStatus` carried `'delegated'` — a state the type system offered and no code path could
 * produce. Meanwhile `ApprovalView` computes `hoursWaiting`, so the product knew a card was
 * ageing on somebody who was away and had nothing to offer but waiting longer.
 *
 * The rule this file exists to hold: **delegation names who should decide, never who may.** A
 * hand-off that granted authority would be a permission transfer with a friendly button on it.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let owner: { organizationId: string; userId: string; timezone: string }
let member: { organizationId: string; userId: string; timezone: string }
let viewer: { organizationId: string; userId: string; timezone: string }
/** A second admin, so there is somebody a card can legitimately be handed to. */
let secondAdmin: { organizationId: string; userId: string; timezone: string }
let secondAdminId: string

const EMAIL = 'second-admin.approval-delegation@fixture.example'

async function pendingApproval(requestedBy?: string): Promise<string> {
  return withTenant(owner, async (ctx) => {
    const actor = await loadActor(ctx)
    // A preview is not optional — §25.14, enforced by `createApproval` itself. An approval with
    // no rendered diff is a card asking somebody to agree to something they cannot see.
    const id = await createApproval(ctx, actor, {
      title: 'Send the Halden rate card',
      riskTier: 'low',
      preview: [
        {
          operation: 'draft_email@v1',
          entityType: 'email',
          entityLabel: 'Halden Foods — rate card',
          changes: [{ field: 'body', to: 'The rates for the Glasgow lane are attached.' }],
          riskTier: 'low',
          reversible: true,
        },
      ],
      evidence: [],
      requestedByLabel: 'The agent',
    })
    if (requestedBy) {
      await ctx.sql`
        UPDATE approvals SET requested_by_actor_type = 'user', requested_by_user_id = ${requestedBy}
        WHERE id = ${id}`
    }
    return id
  })
}

beforeAll(async () => {
  org = await createTenant('approval-delegation')
  owner = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  member = { organizationId: org.organizationId, userId: org.memberId, timezone: TZ }
  viewer = { organizationId: org.organizationId, userId: org.viewerId, timezone: TZ }

  const sql = adminSql()
  await sql`DELETE FROM users WHERE email = ${EMAIL}`
  const [user] = await sql<{ id: string }[]>`
    INSERT INTO users (email, name, password_hash, timezone, is_demo)
    VALUES (${EMAIL}, 'The other admin', 'x', ${TZ}, true) RETURNING id`
  secondAdminId = user!.id
  await sql`
    INSERT INTO memberships (organization_id, user_id, role, is_demo)
    VALUES (${org.organizationId}, ${secondAdminId}, 'admin', true)`
  secondAdmin = { organizationId: org.organizationId, userId: secondAdminId, timezone: TZ }
})

afterAll(async () => {
  await destroyTenant('approval-delegation')
  await adminSql()`DELETE FROM users WHERE email = ${EMAIL}`
  await closePools()
})

describe('handing one on', () => {
  it('somebody who could have decided it may, and the card says who has it and why', async () => {
    const id = await pendingApproval()
    const handed = await withTenant(owner, async (ctx) =>
      delegateApproval(ctx, await loadActor(ctx), {
        approvalId: id,
        toUserId: secondAdminId,
        reason: 'On leave until Tuesday.',
      }),
    )
    expect(handed.delegatedToId).toBe(secondAdminId)
    expect(handed.delegatedToName).toBe('The other admin')
    expect(handed.delegatedByName).toBeTruthy()
    expect(handed.delegationReason).toBe('On leave until Tuesday.')
  })

  it('and it is still pending, because nothing has been decided', async () => {
    /**
     * The reason `'delegated'` was never a status. It sat among the states in which nothing more
     * is waiting, and anything reading `status = 'pending'` to mean "still open" would have
     * dropped every handed-on card out of the queue.
     */
    const id = await pendingApproval()
    const handed = await withTenant(owner, async (ctx) =>
      delegateApproval(ctx, await loadActor(ctx), {
        approvalId: id,
        toUserId: secondAdminId,
        reason: 'On leave until Tuesday.',
      }),
    )
    expect(handed.status).toBe('pending')
  })

  it('and the person it went to can decide it', async () => {
    const id = await pendingApproval()
    await withTenant(owner, async (ctx) =>
      delegateApproval(ctx, await loadActor(ctx), {
        approvalId: id,
        toUserId: secondAdminId,
        reason: 'On leave until Tuesday.',
      }),
    )
    const decided = await withTenant(secondAdmin, async (ctx) =>
      decideApproval(ctx, await loadActor(ctx), { approvalId: id, decision: 'approve' }),
    )
    expect(decided.status).toBe('approved')
  })

  it('and it can be taken back, which clears who was holding it', async () => {
    const id = await pendingApproval()
    await withTenant(owner, async (ctx) =>
      delegateApproval(ctx, await loadActor(ctx), {
        approvalId: id,
        toUserId: secondAdminId,
        reason: 'On leave until Tuesday.',
      }),
    )
    const back = await withTenant(owner, async (ctx) => reclaimApproval(ctx, await loadActor(ctx), id))
    expect(back.delegatedToId).toBeNull()
    expect(back.delegatedByName).toBeNull()
    expect(back.delegationReason).toBeNull()
  })
})

describe('what it must never do', () => {
  it('never widen who may decide — the delegate has to be able to already', async () => {
    const id = await pendingApproval()
    await expect(
      withTenant(owner, async (ctx) =>
        delegateApproval(ctx, await loadActor(ctx), {
          approvalId: id,
          toUserId: org.memberId,
          reason: 'Passing this down the ladder.',
        }),
      ),
    ).rejects.toThrow(/cannot decide approvals/i)
  })

  it('never to the person who asked, because that is self-approval by another route', async () => {
    const id = await pendingApproval(secondAdminId)
    await expect(
      withTenant(owner, async (ctx) =>
        delegateApproval(ctx, await loadActor(ctx), {
          approvalId: id,
          toUserId: secondAdminId,
          reason: 'They can just do it themselves.',
        }),
      ),
    ).rejects.toThrow(/self-approval by another route/i)
  })

  it('and the database refuses that too, whatever asks it', async () => {
    const id = await pendingApproval(secondAdminId)
    await expect(
      adminSql()`
        UPDATE approvals
           SET delegated_to = ${secondAdminId}, delegated_by = ${org.ownerId},
               delegated_at = now(), delegation_reason = 'By another door.'
         WHERE id = ${id}`,
    ).rejects.toThrow(/delegation_not_to_the_requester/i)
  })

  it('never by somebody who could not have decided it', async () => {
    /**
     * The refusal a member gets is *absence*, not denial — `getApproval` reports Not found for a
     * card they were never entitled to see (§3.2), and that happens before the delegation rules
     * are reached. Asserted as the message rather than the class so this notices if the boundary
     * ever softens into a 403 that confirms the approval exists.
     */
    const id = await pendingApproval()
    await expect(
      withTenant(member, async (ctx) =>
        delegateApproval(ctx, await loadActor(ctx), {
          approvalId: id,
          toUserId: secondAdminId,
          reason: 'Not mine to move, but here goes.',
        }),
      ),
    ).rejects.toThrow(/not found/i)
  })

  it('and the refusal reaches somebody who can see it but must not move it', async () => {
    // A viewer who *is* the requester can see their own card and still cannot hand it on, which
    // is the path that reaches the delegation rules rather than the visibility ones.
    const id = await pendingApproval(org.viewerId)
    await expect(
      withTenant(viewer, async (ctx) =>
        delegateApproval(ctx, await loadActor(ctx), {
          approvalId: id,
          toUserId: secondAdminId,
          reason: 'It is my request, so surely I may move it.',
        }),
      ),
    ).rejects.toThrow(/could have decided yourself/i)
  })

  it('and a viewer cannot so much as see one that is not theirs', async () => {
    const id = await pendingApproval()
    await expect(
      withTenant(viewer, async (ctx) =>
        delegateApproval(ctx, await loadActor(ctx), {
          approvalId: id,
          toUserId: secondAdminId,
          reason: 'Trying it on from the bottom rung.',
        }),
      ),
    ).rejects.toThrow(/not found/i)
  })

  it('never to yourself, which changes nothing', async () => {
    const id = await pendingApproval()
    await expect(
      withTenant(owner, async (ctx) =>
        delegateApproval(ctx, await loadActor(ctx), {
          approvalId: id,
          toUserId: org.ownerId,
          reason: 'Keeping it exactly where it is.',
        }),
      ),
    ).rejects.toThrow(/already yours/i)
  })

  it('and never across a tenant boundary', async () => {
    const id = await pendingApproval()
    const other = await createTenant('approval-delegation-b')
    try {
      await expect(
        withTenant(
          { organizationId: other.organizationId, userId: other.ownerId, timezone: TZ },
          async (ctx) =>
            delegateApproval(ctx, await loadActor(ctx), {
              approvalId: id,
              toUserId: other.ownerId,
              reason: 'From another organization entirely.',
            }),
        ),
      ).rejects.toThrow()
    } finally {
      await destroyTenant('approval-delegation-b')
    }
  })

  it('and not without saying why', async () => {
    const id = await pendingApproval()
    await expect(
      withTenant(owner, async (ctx) =>
        delegateApproval(ctx, await loadActor(ctx), {
          approvalId: id,
          toUserId: secondAdminId,
          reason: 'busy',
        }),
      ),
    ).rejects.toThrow(/Say why/i)
  })

  it('and a row that moved with no reason cannot be written at all', async () => {
    const id = await pendingApproval()
    await expect(
      adminSql()`
        UPDATE approvals SET delegated_to = ${secondAdminId}, delegated_by = ${org.ownerId},
                             delegated_at = now()
         WHERE id = ${id}`,
    ).rejects.toThrow(/delegation_attributed/i)
  })

  it('and not to somebody outside this organization', async () => {
    const id = await pendingApproval()
    const other = await createTenant('approval-delegation-c')
    try {
      await expect(
        adminSql()`
          UPDATE approvals SET delegated_to = ${other.ownerId}, delegated_by = ${org.ownerId},
                               delegated_at = now(), delegation_reason = 'From somewhere else.'
           WHERE id = ${id}`,
      ).rejects.toThrow(/active member of this organization/i)
    } finally {
      await destroyTenant('approval-delegation-c')
    }
  })

  it('and one already decided has nothing left to hand on', async () => {
    const id = await pendingApproval()
    await withTenant(owner, async (ctx) =>
      decideApproval(ctx, await loadActor(ctx), { approvalId: id, decision: 'approve' }),
    )
    await expect(
      withTenant(owner, async (ctx) =>
        delegateApproval(ctx, await loadActor(ctx), {
          approvalId: id,
          toUserId: secondAdminId,
          reason: 'Long after the fact.',
        }),
      ),
    ).rejects.toThrow(/nothing left to hand on/i)
  })
})

describe('what the picker offers', () => {
  it('only people the repository would accept', async () => {
    const id = await pendingApproval()
    const [approval, candidates] = await withTenant(owner, async (ctx) => {
      const actor = await loadActor(ctx)
      const view = await getApproval(ctx, actor, id)
      return [view, await handOverCandidates(ctx, actor, view)] as const
    })
    expect(approval.status).toBe('pending')
    expect(candidates.some((c) => c.id === secondAdminId)).toBe(true)
    // The member cannot decide approvals, so offering them would be a control that lies.
    expect(candidates.some((c) => c.id === org.memberId)).toBe(false)
    expect(candidates.some((c) => c.id === org.viewerId)).toBe(false)
    expect(candidates.some((c) => c.id === org.ownerId)).toBe(false)
  })

  it('and every name it offers is one the repository really takes', async () => {
    /**
     * The pairing that makes the two agree rather than merely look alike: every candidate is
     * actually handed the card, and none of them is refused.
     */
    const id = await pendingApproval()
    const candidates = await withTenant(owner, async (ctx) => {
      const actor = await loadActor(ctx)
      return handOverCandidates(ctx, actor, await getApproval(ctx, actor, id))
    })
    expect(candidates.length).toBeGreaterThan(0)
    for (const candidate of candidates) {
      const handed = await withTenant(owner, async (ctx) =>
        delegateApproval(ctx, await loadActor(ctx), {
          approvalId: id,
          toUserId: candidate.id,
          reason: 'Checking the picker tells the truth.',
        }),
      )
      expect(handed.delegatedToId).toBe(candidate.id)
    }
  })

  it('and offers nobody to somebody who could not hand it on', async () => {
    // The viewer's own request: visible to them, and still not theirs to move — so the picker
    // has to come back empty rather than the button simply not being drawn.
    const id = await pendingApproval(org.viewerId)
    const candidates = await withTenant(viewer, async (ctx) => {
      const actor = await loadActor(ctx)
      return handOverCandidates(ctx, actor, await getApproval(ctx, actor, id))
    })
    expect(candidates).toHaveLength(0)
  })
})

describe('the status that went', () => {
  it('the database no longer offers one that would make pending unreliable', async () => {
    const values = await adminSql()<{ enumlabel: string }[]>`
      SELECT e.enumlabel FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'sw_approval_status'`
    const labels = values.map((row) => row.enumlabel)
    expect(labels).toContain('pending')
    expect(labels).not.toContain('delegated')
  })

  it('and neither does the type the product is compiled against', async () => {
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../packages/db/src/types.ts', import.meta.url), 'utf8'),
    )
    const union = /export type ApprovalStatus =[^\n]*\n[^\n]*/.exec(source)?.[0] ?? ''
    expect(union).toMatch(/'pending'/)
    expect(union).not.toMatch(/'delegated'/)
  })
})
