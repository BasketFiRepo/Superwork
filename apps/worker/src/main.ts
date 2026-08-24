import { adminSql, closePools, withTenant } from '@superwork/db'
import {
  applyRetention,
  claimBatch,
  claimSendForDispatch,
  deferMessage,
  deliverDueNudges,
  markDispatched,
  markFailed,
  markSendFailed,
  openLaddersForDueWork,
  runIngestionJobs,
  advanceMailboxCursor,
  fileInbound,
  mailboxesDueSync,
  markMailboxTrouble,
  sweepFollowUps,
  sweepSnoozedInsights,
  writeActivity,
} from '@superwork/core'
import { evict, generateDueBriefings, generateDueDigests, runDueWatchers, runDueWorkflows } from '@superwork/agent'
import { emailProvider } from '@superwork/integrations'

/**
 * Collecting what the connected mailboxes have (ADR 0084).
 *
 * `EmailProvider.sync()` has been on the contract since Phase 2 and nothing called it, which is
 * why nine columns on `email_accounts` stayed empty. This is the consumer.
 *
 * The failure half is the point. §5.6 divides provider failures into kinds, and the difference
 * matters here: a token that expired needs the person to reconnect and the mailbox must say so;
 * a rate limit is this minute's problem and the next pass will be fine. Treating them alike
 * either nags somebody about a hiccup or leaves a dead connection showing a stale inbox — the
 * classic integration lie the `email_accounts.status` column has been sitting there to prevent.
 *
 * The cursor advances only after what the provider handed over is filed. A cursor moved first
 * and a crash second is mail nobody will be offered again.
 */
async function syncMailboxes(
  ctx: Parameters<typeof mailboxesDueSync>[0],
  orgId: string,
): Promise<{ collected: number; deduped: number; stopped: number }> {
  const provider = emailProvider()
  let collected = 0
  let deduped = 0
  let stopped = 0

  for (const mailbox of await mailboxesDueSync(ctx)) {
    try {
      const batch = await provider.sync(mailbox.cursor)
      const filed = await fileInbound(ctx, mailbox.userId, batch.messages)
      await advanceMailboxCursor(ctx, mailbox.id, batch.cursor, new Date())
      collected += filed.collected
      deduped += filed.deduped
    } catch (error) {
      const name = error instanceof Error ? error.name : ''
      const said = error instanceof Error ? error.message : 'The provider failed in a way this does not recognise.'
      if (name === 'TransientError') {
        // This minute's problem. The next pass tries again, and the mailbox stays connected
        // rather than telling somebody to reconnect a mailbox that is fine.
        console.warn(`[mailboxes] ${orgId}: ${mailbox.address} rate limited, retrying next pass`)
        continue
      }
      await markMailboxTrouble(ctx, mailbox.id, name === 'AuthError' ? 'expired' : 'error', said)
      stopped += 1
    }
  }

  return { collected, deduped, stopped }
}

/**
 * The background worker.
 *
 * Every job here must be observable rather than silent:
 *   • dispatch the transactional outbox, honouring the email recall window (§2.4, §5.7)
 *   • index what is queued, retrying with backoff and giving up out loud (§7.1)
 *   • run each read-only watcher on the cadence it declares (§9.1)
 *   • fire the workflow schedules that are due (§10.2)
 *   • generate briefings, deliver the nudge ladder, write agent digests
 *   • purge what is past its retention window (§21)
 *
 * Failures back off exponentially and land in a dead-letter state after six attempts;
 * nothing is retried forever and nothing fails quietly.
 */

const POLL_MS = Number(process.env['WORKER_POLL_MS'] ?? 5000)
const BRIEFING_MS = Number(process.env['WORKER_BRIEFING_MS'] ?? 30 * 60_000)
const DIGEST_MS = Number(process.env['WORKER_DIGEST_MS'] ?? 60 * 60_000)
const NUDGE_MS = Number(process.env['WORKER_NUDGE_MS'] ?? 5 * 60_000)
// Schedules are minute-granular, so the sweep has to be too. Claiming is cheap: one
// indexed query per organization that returns nothing almost every time. Workflows and
// watchers share the sweep because they share the mechanism.
const SCHEDULE_MS = Number(process.env['WORKER_SCHEDULE_MS'] ?? 60_000)
// Retention is a daily job. Sweeping more often would delete the same nothing repeatedly;
// less often lets data outlive its window by up to that interval, which is a promise broken
// by a scheduling choice.
const RETENTION_MS = Number(process.env['WORKER_RETENTION_MS'] ?? 24 * 60 * 60_000)
/**
 * How long this process should live, for hosts that give it a slice rather than a machine.
 *
 * Zero — the default, and what a resident deployment wants — means until it is signalled.
 * A positive value makes the worker finish the pass it is on and stop, which is what a
 * scheduled invocation needs: the loop below already does one of every job on its first
 * pass, because each interval is measured from zero. Every job is therefore reached whether
 * this runs for a minute every five or forever, and the only thing that changes is how long
 * queued work waits.
 */
const MAX_RUNTIME_MS = Number(process.env['WORKER_MAX_RUNTIME_MS'] ?? 0)

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
          const outcome = await dispatchEmail(ctx, message.payload as { sendId: string; draftId: string })
          if (outcome.deferUntil) {
            // Waiting is not failing (ADR 0054). The attempt `claimBatch` counted is given back,
            // so a recall window cannot eat the retry budget of the send it is protecting.
            await deferMessage(ctx, message.id, outcome.deferUntil)
            continue
          }
        }
        await markDispatched(ctx, message.id)
        dispatched += 1
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        // The row says it gave up, not only the outbox message. `failed_at` and `error` have
        // been on `email_sends` since migration 0003 and nothing wrote either, so a send that
        // had exhausted its retries looked exactly like one still waiting (ADR 0054).
        if (message.topic === 'email.send') {
          const { sendId } = message.payload as { sendId: string }
          await markSendFailed(ctx, sendId, reason, { terminal: message.attempts >= 6 })
        }
        await markFailed(ctx, message.id, reason, message.attempts)
      }
    }
    return dispatched
  })
}

/**
 * Hands one message to the provider, or explains why it did not.
 *
 * The row is *claimed* before the provider is called (ADR 0054). Reading `recalled_at` and then
 * sending leaves a gap: a recall arriving inside it would mark a message recalled that the
 * recipient already had. `claimSendForDispatch` checks everything in the update, so a recall and
 * a dispatch cannot both succeed — one of the two finds no row.
 */
async function dispatchEmail(
  ctx: Parameters<typeof writeActivity>[0],
  payload: { sendId: string; draftId: string },
): Promise<{ deferUntil: Date | null }> {
  const [send] = await ctx.sql<
    { id: string; send_after: Date; recalled_at: Date | null; sent_at: Date | null }[]
  >`
    SELECT id, send_after, recalled_at, sent_at FROM email_sends
    WHERE organization_id = ${ctx.organizationId} AND id = ${payload.sendId}`
  if (!send) return { deferUntil: null }

  // A person who changed their mind inside the window wins, and the message is finished with.
  if (send.recalled_at || send.sent_at) return { deferUntil: null }
  if (send.send_after.getTime() > Date.now()) return { deferUntil: send.send_after }

  const claimed = await claimSendForDispatch(ctx, payload.sendId)
  // Somebody stopped it, or another worker has it. Either way this message is done.
  if (!claimed) return { deferUntil: null }

  const [draft] = await ctx.sql<
    {
      subject: string
      body_text: string
      to_addresses: string[]
      conversation_id: string | null
      sender_address: string | null
      sender_name: string | null
    }[]
  >`
    SELECT d.subject, d.body_text, d.to_addresses, d.conversation_id,
           u.email AS sender_address, u.name AS sender_name
    FROM email_drafts d
    LEFT JOIN users u ON u.id = d.created_by
    WHERE d.organization_id = ${ctx.organizationId} AND d.id = ${payload.draftId}`
  if (!draft) throw new Error('The draft no longer exists.')

  const receipt = await emailProvider().send({
    to: draft.to_addresses,
    subject: draft.subject,
    body: draft.body_text,
    idempotencyKey: claimed.idempotencyKey,
  })

  await ctx.sql`
    UPDATE email_sends SET sent_at = ${receipt.sentAt}, provider_message_id = ${receipt.providerMessageId}
    WHERE organization_id = ${ctx.organizationId} AND id = ${send.id}`

  // The reply goes into the thread it answers (ADR 0076).
  //
  // Until now a send set `sent_at`, wrote an activity, and left the thread showing the
  // customer's message as the last one — so `last_direction` stayed `inbound`, and the queue's
  // SLA test went on counting a reply we had already sent as one we owed. The inbox chased
  // threads it had itself answered.
  //
  // Written here rather than where the send is queued, because this is the moment it actually
  // left: a recalled message never reaches this line, and never appears in the record as
  // correspondence that happened.
  if (draft.conversation_id) {
    await ctx.sql`
      INSERT INTO messages (organization_id, conversation_id, direction, from_address, from_name,
                            to_addresses, sent_at, body_text, trust_level, created_by)
      VALUES (${ctx.organizationId}, ${draft.conversation_id}, 'outbound'::sw_message_direction,
              ${draft.sender_address ?? 'superwork@localhost'}, ${draft.sender_name},
              ${draft.to_addresses}, ${receipt.sentAt},
              ${draft.body_text}, 'org_data', ${ctx.userId})`
  }

  await writeActivity(ctx, {
    actorType: 'system',
    actorLabel: 'Superwork',
    verb: 'sent',
    entityType: 'email_draft',
    entityId: payload.draftId,
    entityLabel: draft.subject,
    summary: `Sent "${draft.subject}" to ${draft.to_addresses.join(', ')} after the recall window closed.`,
  })
  return { deferUntil: null }
}

async function main(): Promise<void> {
  const startedAt = Date.now()
  console.log(
    `Superwork worker started · outbox every ${POLL_MS}ms · schedules every ${SCHEDULE_MS}ms · ` +
      `retention every ${Math.round(RETENTION_MS / 3_600_000)}h · ` +
      (MAX_RUNTIME_MS > 0 ? `stopping after ${Math.round(MAX_RUNTIME_MS / 1000)}s` : 'until signalled'),
  )
  let lastBriefingRun = 0
  let lastDigestRun = 0
  let lastNudgeRun = 0
  let lastScheduleSweep = 0
  let lastRetentionSweep = 0

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

      // Indexing (§7.1). Rides the outbox's cadence because it is the same kind of work:
      // something a person asked for that must survive the request they asked it in.
      try {
        const indexed = await runIngestionJobs({
          organizationId: org.id,
          userId: org.ownerId,
          timezone: org.timezone,
        })
        if (indexed.claimed > 0) {
          console.log(
            `[indexing] ${org.id}: ${indexed.claimed} claimed · ${indexed.indexed} indexed · ` +
              `${indexed.failed} failed · ${indexed.skipped} skipped` +
              (indexed.gaveUp > 0 ? ` · ${indexed.gaveUp} gave up and now need a person` : ''),
          )
        }
      } catch (error) {
        console.error(`[indexing] ${org.id} failed:`, error instanceof Error ? error.message : error)
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
            // Open the ladder for anything near its date first. Nothing in the product
            // ever called `scheduleLadder`, so this pass has always delivered from an
            // empty queue — the whole ladder was reachable only from the acceptance loops.
            async (ctx) => {
              const laid = await openLaddersForDueWork(ctx)
              if (laid.opened > 0) console.log(`[nudges] ${org.id}: opened ${laid.opened} ladder(s)`)
              // Follow-ups ride the same pass: one that the customer has already answered
              // closes itself, and one that is due tells its owner, once. Nothing here
              // sends anything outward (§25.7).
              const followUps = await sweepFollowUps(ctx)
              if (followUps.surfaced > 0 || followUps.closedByReply > 0) {
                console.log(
                  `[follow-ups] ${org.id}: ${followUps.surfaced} surfaced, ` +
                    `${followUps.closedByReply} closed because they replied`,
                )
              }
              // Collect what the connected mailboxes have (ADR 0084). `EmailProvider.sync()`
              // has been on the contract since Phase 2 and this is the first thing to call it.
              const mail = await syncMailboxes(ctx, org.id)
              if (mail.collected > 0 || mail.stopped > 0) {
                console.log(
                  `[mailboxes] ${org.id}: ${mail.collected} collected, ${mail.deduped} already had, ` +
                    `${mail.stopped} stopped`,
                )
              }

              // And the insights somebody put off until now come back (ADR 0083). Same pass,
              // same reason: a snooze that never ends is a dismissal that lies about itself.
              const snoozes = await sweepSnoozedInsights(ctx)
              if (snoozes.returned > 0) {
                console.log(`[insights] ${org.id}: ${snoozes.returned} came back off snooze`)
              }
              return deliverDueNudges(ctx)
            },
          )
          if (outcome.delivered || outcome.heldByBudget || outcome.heldByCalendar || outcome.cancelled) {
            console.log(
              `[nudges] ${org.id}: ${outcome.delivered} delivered, ${outcome.heldByBudget} held by the daily budget, ` +
                `${outcome.heldByCalendar} held because it is not a working day for them, ` +
                `${outcome.cancelled} cancelled because the work was already done`,
            )
          }
        } catch (error) {
          console.error(`[nudges] ${org.id} failed:`, error instanceof Error ? error.message : error)
        }
      }
    }

    // Schedules (§9.1, §10.2). A firing that did not happen — late, muted, or held back
    // because the last batch is still waiting for a person — is logged with its reason; an
    // automation that has quietly stopped working is worse than one that visibly stopped.
    if (Date.now() - lastScheduleSweep > SCHEDULE_MS) {
      lastScheduleSweep = Date.now()
      for (const org of organizations) {
        if (!org.ownerId) continue
        const session = { organizationId: org.id, userId: org.ownerId, timezone: org.timezone }
        try {
          const watchers = await runDueWatchers(session)
          if (watchers.claimed > 0) {
            console.log(
              `[watchers] ${org.id}: ${watchers.claimed} due · ran ${watchers.ran.join(', ') || 'none'} · ` +
                `${watchers.created} new, ${watchers.deduped} already known, ${watchers.suppressed} held back by the daily cap`,
            )
            for (const note of watchers.skipped) console.log(`[watchers] ${org.id}: ${note}`)
          }
        } catch (error) {
          console.error(`[watchers] ${org.id} failed:`, error instanceof Error ? error.message : error)
        }

        try {
          const sweep = await runDueWorkflows(session)
          if (sweep.claimed > 0) {
            console.log(
              `[workflows] ${org.id}: ${sweep.claimed} due · ${sweep.ran} ran ` +
                `(${sweep.awaitingApproval} waiting for approval) · ${sweep.skipped} skipped · ${sweep.failed} failed`,
            )
            for (const note of sweep.notes) console.log(`[workflows] ${org.id}: ${note}`)
          }
        } catch (error) {
          console.error(`[workflows] ${org.id} failed:`, error instanceof Error ? error.message : error)
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

    // Retention (§21). What is past its window goes, in bounded batches, and what went is
    // logged — a purge nobody can see is indistinguishable from one that never ran.
    if (Date.now() - lastRetentionSweep > RETENTION_MS) {
      lastRetentionSweep = Date.now()
      for (const org of organizations) {
        if (!org.ownerId) continue
        try {
          const outcomes = await withTenant(
            { organizationId: org.id, userId: org.ownerId, timezone: org.timezone },
            (ctx) => applyRetention(ctx),
          )
          const purged = outcomes.filter((outcome) => outcome.purged > 0)
          if (purged.length > 0) {
            console.log(
              `[retention] ${org.id}: ` +
                purged.map((o) => `${o.purged} ${o.dataClass} past ${o.keepDays} days`).join(' · '),
            )
          }
          // Logged separately and always, even when nothing was purged. A sweep that
          // removed nothing because a hold covered everything is a materially different
          // event from a sweep that found nothing to remove.
          const held = outcomes.filter((outcome) => outcome.held > 0)
          if (held.length > 0) {
            console.log(
              `[retention] ${org.id}: kept by a legal hold — ` +
                held.map((o) => `${o.held} ${o.dataClass}`).join(' · '),
            )
          }
        } catch (error) {
          console.error(`[retention] ${org.id} failed:`, error instanceof Error ? error.message : error)
        }
      }
    }

    // Free the in-memory event buffers of runs nobody is watching.
    for (const runId of finishedRunIds) evict(runId)
    finishedRunIds.clear()

    // Checked after the pass, never before it, so the shortest possible lifetime is still
    // a whole pass rather than none.
    if (MAX_RUNTIME_MS > 0 && Date.now() - startedAt >= MAX_RUNTIME_MS) {
      console.log(`Reached WORKER_MAX_RUNTIME_MS (${MAX_RUNTIME_MS}ms); stopping after this pass.`)
      break
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }

  console.log('Worker stopping.')
  await closePools()
}

const finishedRunIds = new Set<string>()

await main()
