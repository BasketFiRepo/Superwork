import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools, withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  claimSendForDispatch,
  listOutgoing,
  markSendFailed,
  NotFoundError,
  PermissionError,
  recallSend,
  ValidationError,
} from '@superwork/core'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * Stopping a send before it goes (ADR 0054).
 *
 * `send_email` returns `recallWindowSeconds` in its own output schema, dates the row a minute
 * ahead, and the worker reads `recalled_at` before handing anything to the provider — the comment
 * there has always said "a user who changes their mind inside it wins". Nothing ever wrote
 * `recalled_at`. The window was a delay with no button behind it.
 *
 * The interesting tests are the race ones. A recall arriving between the worker's read and its
 * call to the provider would have marked a message recalled that the recipient already had, so
 * dispatch claims the row and the two cannot both win.
 */

const TZ = 'Europe/London'
let org: TenantFixture
let session: { organizationId: string; userId: string; timezone: string }
let memberSession: { organizationId: string; userId: string; timezone: string }

beforeAll(async () => {
  org = await createTenant('undo-send')
  session = { organizationId: org.organizationId, userId: org.ownerId, timezone: TZ }
  memberSession = { organizationId: org.organizationId, userId: org.memberId, timezone: TZ }
})

afterAll(async () => {
  await destroyTenant('undo-send')
  await closePools()
})

/** An approved draft and a send waiting out its window, as `send_email` would leave them. */
async function outgoing(options: { by?: string; secondsAhead?: number } = {}): Promise<{
  sendId: string
  draftId: string
}> {
  const by = options.by ?? org.ownerId
  const [draft] = await adminSql()<{ id: string }[]>`
    INSERT INTO email_drafts (
      organization_id, to_addresses, subject, body_text, status, is_demo, created_by
    ) VALUES (
      ${org.organizationId}, ARRAY['ops@customer.example'], 'Reefer 4471 handover',
      'The trailer is pre-cooled and ready.', 'approved', true, ${by}
    ) RETURNING id`
  const [send] = await adminSql()<{ id: string }[]>`
    INSERT INTO email_sends (
      organization_id, draft_id, provider, send_after, idempotency_key, is_demo, created_by
    ) VALUES (
      ${org.organizationId}, ${draft!.id}, 'mock',
      now() + make_interval(secs => ${options.secondsAhead ?? 60}),
      ${`test-${draft!.id}`}, true, ${by}
    ) RETURNING id`
  await adminSql()`
    UPDATE email_drafts SET status = 'sent' WHERE organization_id = ${org.organizationId} AND id = ${draft!.id}`
  return { sendId: send!.id, draftId: draft!.id }
}

describe('what is on its way out is visible, with the time left on it', () => {
  it('lists it with a countdown, who sent it, and whose it is', async () => {
    const { sendId } = await outgoing()
    const rows = await withTenant(session, async (ctx) => listOutgoing(ctx, await loadActor(ctx)))
    const row = rows.find((entry) => entry.id === sendId)!
    expect(row.subject).toBe('Reefer 4471 handover')
    expect(row.toAddresses).toEqual(['ops@customer.example'])
    expect(row.secondsLeft).toBeGreaterThan(50)
    expect(row.secondsLeft).toBeLessThanOrEqual(60)
    expect(row.dispatching).toBe(false)
    expect(row.mine).toBe(true)
  })

  it('drops off the list once it has gone, been stopped, or given up', async () => {
    const sent = await outgoing()
    await adminSql()`
      UPDATE email_sends SET sent_at = now() WHERE organization_id = ${org.organizationId} AND id = ${sent.sendId}`
    const failed = await outgoing()
    await withTenant(session, (ctx) => markSendFailed(ctx, failed.sendId, 'The provider refused it.', { terminal: true }))

    const rows = await withTenant(session, async (ctx) => listOutgoing(ctx, await loadActor(ctx)))
    expect(rows.map((row) => row.id)).not.toContain(sent.sendId)
    expect(rows.map((row) => row.id)).not.toContain(failed.sendId)
  })
})

describe('a person can stop their own send without a permission to send', () => {
  it('lets the member who is sending it call it back', async () => {
    // A member has `email:draft:own` and no send permission at all. Requiring one to *stop* a
    // send would mean watching your own mistake leave.
    const { sendId, draftId } = await outgoing({ by: org.memberId })
    const rows = await withTenant(memberSession, async (ctx) =>
      recallSend(ctx, await loadActor(ctx), { sendId, reason: 'The figure in it is wrong.' }),
    )
    expect(rows.map((row) => row.id)).not.toContain(sendId)

    const [row] = await adminSql()<
      { recalledAt: Date | null; recalledBy: string | null; recallReason: string | null }[]
    >`
      SELECT recalled_at AS "recalledAt", recalled_by AS "recalledBy", recall_reason AS "recallReason"
      FROM email_sends WHERE organization_id = ${org.organizationId} AND id = ${sendId}`
    expect(row!.recalledAt).not.toBeNull()
    expect(row!.recalledBy).toBe(org.memberId)
    expect(row!.recallReason).toContain('figure')

    // And the draft is a draft again: sending it needs approving again, because what was
    // approved is the thing they no longer want sent.
    const [draft] = await adminSql()<{ status: string }[]>`
      SELECT status FROM email_drafts WHERE organization_id = ${org.organizationId} AND id = ${draftId}`
    expect(draft!.status).toBe('draft')
  })

  it('refuses somebody else’s send when they could not have sent it', async () => {
    const { sendId } = await outgoing({ by: org.ownerId })
    await withTenant({ ...memberSession, userId: org.viewerId }, async (ctx) => {
      // The refusal names what would work — "you need Manager access to send this email" — which
      // is the shape every refusal in this product takes. The claim here is the class.
      await expect(
        recallSend(ctx, await loadActor(ctx), { sendId, reason: 'Not mine to stop.' }),
      ).rejects.toThrow(PermissionError)
    })
  })

  it('needs a reason, and says so', async () => {
    const { sendId } = await outgoing()
    await withTenant(session, async (ctx) => {
      await expect(recallSend(ctx, await loadActor(ctx), { sendId, reason: 'x' })).rejects.toThrow(
        ValidationError,
      )
    })
  })

  it('is another tenant’s 404, never their 403', async () => {
    const other = await createTenant('undo-send-other')
    try {
      const [theirs] = await adminSql()<{ id: string }[]>`
        INSERT INTO email_sends (organization_id, provider, send_after, idempotency_key, created_by)
        VALUES (${other.organizationId}, 'mock', now() + interval '60 seconds', 'theirs-1', ${other.ownerId})
        RETURNING id`
      await withTenant(session, async (ctx) => {
        await expect(
          recallSend(ctx, await loadActor(ctx), { sendId: theirs!.id, reason: 'Not mine.' }),
        ).rejects.toThrow(NotFoundError)
      })
    } finally {
      await destroyTenant('undo-send-other')
    }
  })
})

describe('the person and the dispatcher cannot both win', () => {
  it('refuses the recall once dispatch has claimed the row', async () => {
    // Due now, so the dispatcher may take it.
    const { sendId } = await outgoing({ secondsAhead: 0 })
    const claimed = await withTenant(session, (ctx) => claimSendForDispatch(ctx, sendId))
    expect(claimed).not.toBeNull()

    await withTenant(session, async (ctx) => {
      await expect(
        recallSend(ctx, await loadActor(ctx), { sendId, reason: 'Changed my mind.' }),
      ).rejects.toThrow(/already going out|too late/i)
    })

    const [row] = await adminSql()<{ recalledAt: Date | null }[]>`
      SELECT recalled_at AS "recalledAt" FROM email_sends
      WHERE organization_id = ${org.organizationId} AND id = ${sendId}`
    expect(row!.recalledAt).toBeNull()
  })

  it('refuses the claim once the person has stopped it', async () => {
    const { sendId } = await outgoing({ secondsAhead: 0 })
    await withTenant(session, async (ctx) =>
      recallSend(ctx, await loadActor(ctx), { sendId, reason: 'Stopped in time.' }),
    )
    const claimed = await withTenant(session, (ctx) => claimSendForDispatch(ctx, sendId))
    expect(claimed).toBeNull()
  })

  it('will not claim one that is not due yet, however often it is asked', async () => {
    const { sendId } = await outgoing({ secondsAhead: 60 })
    expect(await withTenant(session, (ctx) => claimSendForDispatch(ctx, sendId))).toBeNull()
    expect(await withTenant(session, (ctx) => claimSendForDispatch(ctx, sendId))).toBeNull()
  })

  it('will not claim one twice, so two workers cannot both send it', async () => {
    const { sendId } = await outgoing({ secondsAhead: 0 })
    expect(await withTenant(session, (ctx) => claimSendForDispatch(ctx, sendId))).not.toBeNull()
    expect(await withTenant(session, (ctx) => claimSendForDispatch(ctx, sendId))).toBeNull()
  })

  it('refuses to stop one that has already gone, and says the honest next step', async () => {
    const { sendId } = await outgoing({ secondsAhead: 0 })
    await adminSql()`
      UPDATE email_sends SET dispatch_started_at = now(), sent_at = now()
      WHERE organization_id = ${org.organizationId} AND id = ${sendId}`
    await withTenant(session, async (ctx) => {
      await expect(
        recallSend(ctx, await loadActor(ctx), { sendId, reason: 'Too late, but trying.' }),
      ).rejects.toThrow(/write to them again/i)
    })
  })
})

describe('the database refuses the contradiction, whoever writes it', () => {
  it('will not store a send that is both recalled and sent', async () => {
    const { sendId } = await outgoing()
    await adminSql()`
      UPDATE email_sends SET recalled_at = now(), recalled_by = ${org.ownerId}, recall_reason = 'stopped'
      WHERE organization_id = ${org.organizationId} AND id = ${sendId}`
    await expect(
      adminSql()`
        UPDATE email_sends SET sent_at = now()
        WHERE organization_id = ${org.organizationId} AND id = ${sendId}`,
    ).rejects.toThrow(/email_sends_not_both_recalled_and_sent/)
  })

  it('will not store a recall that names nobody', async () => {
    const { sendId } = await outgoing()
    await expect(
      adminSql()`
        UPDATE email_sends SET recalled_at = now()
        WHERE organization_id = ${org.organizationId} AND id = ${sendId}`,
    ).rejects.toThrow(/email_sends_recall_attributed/)
  })

  it('will not store a failure with no reason, or a reason with no failure', async () => {
    const { sendId } = await outgoing()
    await expect(
      adminSql()`
        UPDATE email_sends SET failed_at = now()
        WHERE organization_id = ${org.organizationId} AND id = ${sendId}`,
    ).rejects.toThrow(/email_sends_failure_says_why/)
    await expect(
      adminSql()`
        UPDATE email_sends SET error = 'something'
        WHERE organization_id = ${org.organizationId} AND id = ${sendId}`,
    ).rejects.toThrow(/email_sends_failure_says_why/)
  })
})

describe('a send that gave up says so on its own row', () => {
  it('records the reason when it is terminal, and releases the claim when it is not', async () => {
    const { sendId } = await outgoing({ secondsAhead: 0 })
    await withTenant(session, (ctx) => claimSendForDispatch(ctx, sendId))

    // Not terminal: the claim goes back so the next attempt can take it.
    await withTenant(session, (ctx) =>
      markSendFailed(ctx, sendId, 'The provider timed out.', { terminal: false }),
    )
    let [row] = await adminSql()<{ failedAt: Date | null; error: string | null; claim: Date | null }[]>`
      SELECT failed_at AS "failedAt", error, dispatch_started_at AS claim FROM email_sends
      WHERE organization_id = ${org.organizationId} AND id = ${sendId}`
    expect(row!.failedAt).toBeNull()
    expect(row!.claim).toBeNull()

    await withTenant(session, (ctx) =>
      markSendFailed(ctx, sendId, 'The provider refused it six times.', { terminal: true }),
    )
    ;[row] = await adminSql()<{ failedAt: Date | null; error: string | null; claim: Date | null }[]>`
      SELECT failed_at AS "failedAt", error, dispatch_started_at AS claim FROM email_sends
      WHERE organization_id = ${org.organizationId} AND id = ${sendId}`
    expect(row!.failedAt).not.toBeNull()
    expect(row!.error).toContain('six times')
  })
})
