import { adminSql, closePools, withTenant } from '@superwork/db'
import { claimBatch, deliverDueNudges, markDispatched, markFailed, writeActivity } from '@superwork/core'
import { evict, generateDueBriefings, generateDueDigests, runWatchers } from '@superwork/agent'
import { emailProvider } from '@superwork/integrations'

/**
 * The background worker.
 *
 * Two jobs, both of which the spec insists must be observable rather than silent:
 *   • dispatch the transactional outbox, honouring the email recall window (§2.4, §5.7)
 *   • run the read-only watchers that produce insights (§9.1)
 *
 * Failures back off exponentially and land in a dead-letter state after six attempts;
 * nothing is retried forever and nothing fails quietly.
 */

const POLL_MS = Number(process.env['WORKER_POLL_MS'] ?? 5000)
const WATCHER_MS = Number(process.env['WORKER_WATCHER_MS'] ?? 15 * 60_000)
const BRIEFING_MS = Number(process.env['WORKER_BRIEFING_MS'] ?? 30 * 60_000)
const DIGEST_MS = Number(process.env['WORKER_DIGEST_MS'] ?? 60 * 60_000)
const NUDGE_MS = Number(process.env['WORKER_NUDGE_MS'] ?? 5 * 60_000)

let stopping = false
process.on('SIGINT', () => { stopping = true })
process.on('SIGTERM', () => { stopping = true })

async function activeOrganizations(): Promise<{ id: string; ownerId: string; timezone: string }[]> {
  return adminSql()<{ id: string; ownerId: string; timezone: string }[]>`
    SELECT o.id, o.timezone,
           (SELECT m.user_id FROM memberships m
             WHERE m.organization_id = o.id AND m.role = 'owner' AND m.deleted_at IS NULL
             ORDER BY m.created_at LIMIT 1) AS "ownerId"
    FROM organizations o
    WHERE o.deleted_at IS NULL`
}

async function dispatchOutbox(org: { id: string; ownerId: string; timezone: string }): Promise<number> {
  return withTenant({ organizationId: org.id, userId: org.ownerId, timezone: org.timezone }, async (ctx) => {
    const batch = await claimBatch(ctx, 25)
    let dispatched = 0

    for (const message of batch) {
      try {
        if (message.topic === 'email.send') {
          await dispatchEmail(ctx, message.payload as { sendId: string; draftId: string })
        }
        await markDispatched(ctx, message.id)
        dispatched += 1
      } catch (error) {
        await markFailed(ctx, message.id, error instanceof Error ? error.message : String(error), message.attempts)
      }
    }
    return dispatched
  })
}

async function dispatchEmail(
  ctx: Parameters<typeof writeActivity>[0],
  payload: { sendId: string; draftId: string },
): Promise<void> {
  const [send] = await ctx.sql<
    { id: string; send_after: Date; recalled_at: Date | null; sent_at: Date | null; idempotency_key: string }[]
  >`
    SELECT id, send_after, recalled_at, sent_at, idempotency_key FROM email_sends
    WHERE organization_id = ${ctx.organizationId} AND id = ${payload.sendId}`
  if (!send) return

  // The recall window: a user who changes their mind inside it wins.
  if (send.recalled_at) return
  if (send.sent_at) return
  if (send.send_after.getTime() > Date.now()) {
    throw new Error('Still inside the recall window; will retry after it closes.')
  }

  const [draft] = await ctx.sql<{ subject: string; body_text: string; to_addresses: string[] }[]>`
    SELECT subject, body_text, to_addresses FROM email_drafts
    WHERE organization_id = ${ctx.organizationId} AND id = ${payload.draftId}`
  if (!draft) throw new Error('The draft no longer exists.')

  const receipt = await emailProvider().send({
    to: draft.to_addresses,
    subject: draft.subject,
    body: draft.body_text,
    idempotencyKey: send.idempotency_key,
  })

  await ctx.sql`
    UPDATE email_sends SET sent_at = ${receipt.sentAt}, provider_message_id = ${receipt.providerMessageId}
    WHERE organization_id = ${ctx.organizationId} AND id = ${send.id}`

  await writeActivity(ctx, {
    actorType: 'system',
    actorLabel: 'Superwork',
    verb: 'sent',
    entityType: 'email_draft',
    entityId: payload.draftId,
    entityLabel: draft.subject,
    summary: `Sent "${draft.subject}" to ${draft.to_addresses.join(', ')} after the recall window closed.`,
  })
}

async function main(): Promise<void> {
  console.log(`Superwork worker started · outbox every ${POLL_MS}ms · watchers every ${WATCHER_MS}ms`)
  let lastWatcherRun = 0
  let lastBriefingRun = 0
  let lastDigestRun = 0
  let lastNudgeRun = 0

  while (!stopping) {
    const organizations = await activeOrganizations()

    for (const org of organizations) {
      if (!org.ownerId) continue
      try {
        const dispatched = await dispatchOutbox(org)
        if (dispatched > 0) console.log(`[outbox] ${org.id}: dispatched ${dispatched}`)
      } catch (error) {
        console.error(`[outbox] ${org.id} failed:`, error instanceof Error ? error.message : error)
      }
    }

    if (Date.now() - lastWatcherRun > WATCHER_MS) {
      lastWatcherRun = Date.now()
      for (const org of organizations) {
        if (!org.ownerId) continue
        try {
          const result = await runWatchers({ organizationId: org.id, userId: org.ownerId, timezone: org.timezone })
          if (result.created || result.suppressed) {
            console.log(
              `[watchers] ${org.id}: ${result.created} new, ${result.deduped} deduped, ${result.suppressed} held back by the daily cap`,
            )
          }
        } catch (error) {
          console.error(`[watchers] ${org.id} failed:`, error instanceof Error ? error.message : error)
        }
      }
    }

    // Briefings are generated per person at their own local hour, and the sweep is
    // spread across the day rather than fired at one instant (§26.5).
    if (Date.now() - lastBriefingRun > BRIEFING_MS) {
      lastBriefingRun = Date.now()
      for (const org of organizations) {
        if (!org.ownerId) continue
        try {
          const result = await generateDueBriefings({
            organizationId: org.id,
            userId: org.ownerId,
            timezone: org.timezone,
          })
          if (result.generated > 0) console.log(`[briefings] ${org.id}: generated ${result.generated}`)
        } catch (error) {
          console.error(`[briefings] ${org.id} failed:`, error instanceof Error ? error.message : error)
        }
      }
    }

    // The nudge ladder: what is due, inside each person's shared daily budget (§29.2).
    if (Date.now() - lastNudgeRun > NUDGE_MS) {
      lastNudgeRun = Date.now()
      for (const org of organizations) {
        if (!org.ownerId) continue
        try {
          const outcome = await withTenant(
            { organizationId: org.id, userId: org.ownerId, timezone: org.timezone },
            (ctx) => deliverDueNudges(ctx),
          )
          if (outcome.delivered || outcome.heldByBudget || outcome.cancelled) {
            console.log(
              `[nudges] ${org.id}: ${outcome.delivered} delivered, ${outcome.heldByBudget} held by the daily budget, ` +
                `${outcome.cancelled} cancelled because the work was already done`,
            )
          }
        } catch (error) {
          console.error(`[nudges] ${org.id} failed:`, error instanceof Error ? error.message : error)
        }
      }
    }

    // Weekly digests: every agent owes its owner an account of what it did (§27.6).
    if (Date.now() - lastDigestRun > DIGEST_MS) {
      lastDigestRun = Date.now()
      try {
        const written = await generateDueDigests()
        if (written > 0) console.log(`[digests] wrote ${written}`)
      } catch (error) {
        console.error('[digests] failed:', error instanceof Error ? error.message : error)
      }
    }

    // Free the in-memory event buffers of runs nobody is watching.
    for (const runId of finishedRunIds) evict(runId)
    finishedRunIds.clear()

    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }

  console.log('Worker stopping.')
  await closePools()
}

const finishedRunIds = new Set<string>()

await main()
