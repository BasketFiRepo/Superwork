import type { TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeActivity, writeAudit } from '../audit.js'

/**
 * Stopping a send that has not gone yet (§5.7, ADR 0054).
 *
 * `send_email` returns `recallWindowSeconds` in its own output schema, dates the row a minute
 * ahead, and enqueues the dispatch with `notBefore` on it. The worker reads `recalled_at` before
 * it hands anything to the provider and stops if it is set — the comment there has always said
 * "a user who changes their mind inside it wins".
 *
 * Nothing ever wrote `recalled_at`. The window was a delay with no button behind it, and the
 * tool had been telling every caller about a recall the product did not have.
 *
 * **The race is the design.** The worker used to read the row and then call the provider, so a
 * recall landing between those two would set `recalled_at` on a message that had already gone.
 * Dispatch now *claims* the row with a conditional update, and a recall is refused once the
 * claim is taken — so the two cannot both succeed, and neither side has to be trusted to check
 * in the right order.
 */

export interface OutgoingSendView {
  id: string
  draftId: string | null
  subject: string | null
  toAddresses: string[]
  /** When the dispatcher may pick it up. */
  sendAfter: Date
  /** Seconds left to change your mind, floored at zero. */
  secondsLeft: number
  /** True once the dispatcher has claimed it: too late, and the screen says so. */
  dispatching: boolean
  sentByName: string | null
  /** Whether this is the viewer's own outgoing message. */
  mine: boolean
}

export async function listOutgoing(
  ctx: TenantContext,
  actor: Actor,
  options: { now?: Date } = {},
): Promise<OutgoingSendView[]> {
  const decision = can(actor, 'conversation:read', {
    type: 'conversation',
    organizationId: ctx.organizationId,
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const now = options.now ?? new Date()
  const rows = await ctx.sql<OutgoingSendView[]>`
    SELECT s.id, s.draft_id AS "draftId", d.subject,
           coalesce(d.to_addresses, '{}') AS "toAddresses",
           s.send_after AS "sendAfter",
           greatest(0, ceil(extract(epoch FROM (s.send_after - ${now})))::int) AS "secondsLeft",
           (s.dispatch_started_at IS NOT NULL) AS dispatching,
           u.name AS "sentByName",
           (s.created_by = ${actor.userId}) AS mine
    FROM email_sends s
    LEFT JOIN email_drafts d ON d.id = s.draft_id
    LEFT JOIN users u ON u.id = s.created_by
    WHERE s.organization_id = ${ctx.organizationId}
      AND s.sent_at IS NULL AND s.recalled_at IS NULL AND s.failed_at IS NULL
      AND s.deleted_at IS NULL
    ORDER BY s.send_after`

  return rows
}

/**
 * Stops one before it goes.
 *
 * Not gated on `email:send` when it is the person's own outgoing message. A member can draft an
 * email and has no send permission at all, so requiring one to *stop* a send would mean watching
 * your own mistake leave while the one person who could call it back was in a meeting. Nothing
 * about this direction can hurt anybody: it is the narrowing one, and it does not need a
 * password either (ADRs 0044, 0046, 0050).
 *
 * The draft goes back to `draft`, not to `approved`. Somebody changed their mind about sending
 * this; sending it again should need the approval again, because the thing that was approved is
 * the thing they no longer want sent.
 */
export async function recallSend(
  ctx: TenantContext,
  actor: Actor,
  input: { sendId: string; reason: string },
): Promise<OutgoingSendView[]> {
  const reason = input.reason.trim()
  if (reason.length < 3) throw new ValidationError('Say why it is being stopped.')

  const [send] = await ctx.sql<
    {
      id: string
      draftId: string | null
      createdBy: string | null
      subject: string | null
      toAddresses: string[]
      sentAt: Date | null
      recalledAt: Date | null
      dispatchStartedAt: Date | null
    }[]
  >`
    SELECT s.id, s.draft_id AS "draftId", s.created_by AS "createdBy", d.subject,
           coalesce(d.to_addresses, '{}') AS "toAddresses",
           s.sent_at AS "sentAt", s.recalled_at AS "recalledAt",
           s.dispatch_started_at AS "dispatchStartedAt"
    FROM email_sends s
    LEFT JOIN email_drafts d ON d.id = s.draft_id
    WHERE s.organization_id = ${ctx.organizationId} AND s.id = ${input.sendId}
      AND s.deleted_at IS NULL`
  if (!send) throw new NotFoundError()

  if (send.createdBy !== actor.userId) {
    const decision = can(actor, 'email:send', {
      type: 'email_draft',
      id: send.draftId ?? undefined,
      organizationId: ctx.organizationId,
      createdBy: send.createdBy,
      riskTier: 'low',
    })
    if (!decision.allow) throw new PermissionError(decision.reason)
  }

  if (send.recalledAt) {
    throw new ValidationError('That one has already been stopped.')
  }
  if (send.sentAt) {
    throw new ValidationError(
      'That has already gone out. Nothing here can call back a message the recipient already ' +
        'has — the honest next step is to write to them again.',
    )
  }

  // The claim, not the clock, is what decides. Conditional so that a dispatcher which took the
  // row a millisecond ago wins and this returns nothing to update.
  const [stopped] = await ctx.sql<{ id: string }[]>`
    UPDATE email_sends
    SET recalled_at = now(), recalled_by = ${actor.userId}, recall_reason = ${reason},
        updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.sendId}
      AND sent_at IS NULL AND recalled_at IS NULL AND dispatch_started_at IS NULL
    RETURNING id`
  if (!stopped) {
    throw new ValidationError(
      'It is already going out — the send began a moment ago, so it is too late to stop it. ' +
        'Nothing was changed.',
    )
  }

  if (send.draftId) {
    await ctx.sql`
      UPDATE email_drafts SET status = 'draft', updated_at = now()
      WHERE organization_id = ${ctx.organizationId} AND id = ${send.draftId}`
  }

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'email.recalled',
    entityType: 'email_send',
    entityId: input.sendId,
    before: { subject: send.subject, to: send.toAddresses, sentAt: null },
    after: { reason, draftStatus: send.draftId ? 'draft' : null },
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'stopped',
    entityType: 'email_draft',
    entityId: send.draftId ?? input.sendId,
    entityLabel: send.subject ?? 'an email',
    summary:
      `“${send.subject ?? 'An email'}” was stopped before it went to ` +
      `${send.toAddresses.join(', ') || 'its recipients'}. ${reason} It is a draft again, so ` +
      'sending it needs approving again.',
  })

  return listOutgoing(ctx, actor)
}

/**
 * Claims a send for dispatch, or returns null because somebody got there first.
 *
 * Called by the worker immediately before it hands the message to the provider. Everything it
 * checks is checked *in the update*, so a recall arriving between a read and a send cannot slip
 * through: one of the two statements finds no row.
 */
export async function claimSendForDispatch(
  ctx: TenantContext,
  sendId: string,
  options: { now?: Date } = {},
): Promise<{ id: string; idempotencyKey: string; draftId: string | null } | null> {
  const now = options.now ?? new Date()
  const [claimed] = await ctx.sql<{ id: string; idempotencyKey: string; draftId: string | null }[]>`
    UPDATE email_sends
    SET dispatch_started_at = now(), updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${sendId}
      AND sent_at IS NULL AND recalled_at IS NULL AND failed_at IS NULL
      AND dispatch_started_at IS NULL
      AND send_after <= ${now}
      AND deleted_at IS NULL
    RETURNING id, idempotency_key AS "idempotencyKey", draft_id AS "draftId"`
  return claimed ?? null
}

/**
 * Records that a send gave up, on the row rather than only on the outbox message.
 *
 * `failed_at` and `error` have been on this table since migration 0003 and nothing wrote either,
 * so a send that had exhausted its retries looked exactly like one still waiting for its window
 * to close. The claim is released, because an attempt that failed is not an attempt that reached
 * anybody — and the outbox decides whether there will be another one.
 */
export async function markSendFailed(
  ctx: TenantContext,
  sendId: string,
  error: string,
  options: { terminal: boolean },
): Promise<void> {
  if (!options.terminal) {
    await ctx.sql`
      UPDATE email_sends SET dispatch_started_at = NULL, updated_at = now()
      WHERE organization_id = ${ctx.organizationId} AND id = ${sendId} AND sent_at IS NULL`
    return
  }
  await ctx.sql`
    UPDATE email_sends
    SET failed_at = now(), error = ${error.slice(0, 2000) || 'It failed, and the provider said nothing.'},
        dispatch_started_at = NULL, updated_at = now()
    WHERE organization_id = ${ctx.organizationId} AND id = ${sendId} AND sent_at IS NULL`
}
