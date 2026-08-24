import type { TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from './errors.js'
import { writeAudit } from './audit.js'
import { notify } from './notify.js'

/**
 * What people think of what the watchers found (§9.2).
 *
 * `insight_feedback` has been written since Phase 3 and read by nothing, under a comment on
 * the route that says *"Dismissal reasons tune future thresholds per organization and per
 * user"*. Nothing tuned. The card asks why an insight was dismissed and the answer went
 * nowhere — which is worse than not asking, because being asked implies it matters.
 *
 * **A watcher that is right and unwelcome is not the same as a watcher that is wrong.**
 * That is the whole decision here. The four reasons are four different sentences:
 *
 *   `wrong`            — false positive. Evidence against the watcher.
 *   `not_useful`       — correct, and not worth anybody's attention. Evidence against it.
 *   `already_handled`  — the watcher was **right**; somebody had dealt with it first. That
 *                        is not a fault, it is a *timing* problem, and the answer is to run
 *                        the watcher earlier rather than to switch it off.
 *   `not_my_job`       — right, and sent to the wrong person. A routing problem.
 *
 * What existed read none of this. `mutedWatchers` counted `insights.status = 'dismissed'`
 * and muted at 70%, so a watcher whose every insight was real and already handled was
 * switched off exactly as fast as one that was making things up.
 */

export type FeedbackReason = 'not_useful' | 'wrong' | 'already_handled' | 'not_my_job'

/** Which reasons are evidence that the watcher itself is bad. */
export const AGAINST_THE_WATCHER: FeedbackReason[] = ['wrong', 'not_useful']

/** How many ratings before an opinion is worth acting on. */
export const MIN_RATINGS_TO_JUDGE = 20
/** Above this share of `wrong` + `not_useful`, the watcher stops running. */
export const MUTE_THRESHOLD = 0.7
/** Above this share of `already_handled`, the watcher is right but late. */
export const LATE_THRESHOLD = 0.5
/** Above this share of `not_my_job`, it is reaching the wrong people. */
export const MISROUTED_THRESHOLD = 0.5

export interface WatcherQuality {
  watcher: string
  shown: number
  /** Dismissed with nothing said about why — the only signal when nobody rates. */
  dismissed: number
  rated: number
  helpful: number
  wrong: number
  notUseful: number
  alreadyHandled: number
  notMyJob: number
  /**
   * `muted` — switched off; `late` — right, but somebody got there first; `misrouted` —
   * right, and reaching the wrong people; `quiet` — too few ratings to judge; `good`.
   */
  verdict: 'good' | 'late' | 'misrouted' | 'muted' | 'quiet'
  /** Said in full, because a watcher being switched off needs to be explainable. */
  reason: string
}

/**
 * Every watcher's record, from the feedback people actually gave.
 *
 * Counts insights *shown* separately from insights *rated*: a watcher with two hundred
 * insights and three opinions has not been judged, and saying so is more useful than
 * computing a rate from three votes.
 */
export async function watcherQuality(ctx: TenantContext, actor?: Actor): Promise<WatcherQuality[]> {
  if (actor) {
    const decision = can(actor, 'insight:read', { type: 'insight', organizationId: ctx.organizationId })
    if (!decision.allow) throw new PermissionError(decision.reason)
  }

  const rows = await ctx.sql<
    {
      watcher: string
      shown: number
      dismissed: number
      rated: number
      helpful: number
      wrong: number
      notUseful: number
      alreadyHandled: number
      notMyJob: number
    }[]
  >`
    SELECT i.watcher,
           count(DISTINCT i.id)::int AS shown,
           count(DISTINCT i.id) FILTER (WHERE i.status = 'dismissed')::int AS dismissed,
           count(f.id)::int AS rated,
           count(f.id) FILTER (WHERE f.helpful)::int AS helpful,
           count(f.id) FILTER (WHERE f.reason = 'wrong')::int AS wrong,
           count(f.id) FILTER (WHERE f.reason = 'not_useful')::int AS "notUseful",
           count(f.id) FILTER (WHERE f.reason = 'already_handled')::int AS "alreadyHandled",
           count(f.id) FILTER (WHERE f.reason = 'not_my_job')::int AS "notMyJob"
    FROM insights i
    LEFT JOIN insight_feedback f
      ON f.insight_id = i.id AND f.organization_id = i.organization_id AND f.deleted_at IS NULL
    WHERE i.organization_id = ${ctx.organizationId} AND i.deleted_at IS NULL
    GROUP BY i.watcher
    ORDER BY i.watcher`

  return rows.map((row) => ({ ...row, ...judge(row) }))
}

function judge(row: {
  shown: number
  dismissed: number
  rated: number
  wrong: number
  notUseful: number
  alreadyHandled: number
  notMyJob: number
}): { verdict: WatcherQuality['verdict']; reason: string } {
  if (row.rated < MIN_RATINGS_TO_JUDGE) {
    // Nobody said why, but they kept throwing it away. The old rule read exactly this and
    // nothing else; it is kept as the fallback rather than dropped, because removing a
    // control while replacing it is how a refinement becomes a regression. Where people do
    // give reasons, the reasons win — they can tell "wrong" from "already handled".
    if (row.shown >= MIN_RATINGS_TO_JUDGE && row.dismissed / row.shown > MUTE_THRESHOLD) {
      return {
        verdict: 'muted',
        reason: `${row.dismissed} of ${row.shown} were dismissed with no reason given. Nobody said what was wrong with it, so it is switched off on the throwing-away alone — rate a few and it will be judged on what you say instead.`,
      }
    }
    return {
      verdict: 'quiet',
      reason: `${row.rated} of ${row.shown} rated. Below ${MIN_RATINGS_TO_JUDGE} nothing is decided from what people said — a rate computed from a handful of opinions is a guess with a percentage sign on it.`,
    }
  }

  const badShare = (row.wrong + row.notUseful) / row.rated
  if (badShare > MUTE_THRESHOLD) {
    return {
      verdict: 'muted',
      reason: `${Math.round(badShare * 100)}% of ${row.rated} ratings said it was wrong or not worth surfacing. It has stopped running.`,
    }
  }

  const lateShare = row.alreadyHandled / row.rated
  if (lateShare > LATE_THRESHOLD) {
    return {
      verdict: 'late',
      reason: `${Math.round(lateShare * 100)}% said it was already handled. It is finding real things after somebody else has — run it earlier rather than switching it off.`,
    }
  }

  const misroutedShare = row.notMyJob / row.rated
  if (misroutedShare > MISROUTED_THRESHOLD) {
    return {
      verdict: 'misrouted',
      reason: `${Math.round(misroutedShare * 100)}% said it was not their job. It is right, and reaching the wrong people.`,
    }
  }

  return {
    verdict: 'good',
    reason: `${Math.round((1 - badShare) * 100)}% of ${row.rated} ratings found it worth having.`,
  }
}

/**
 * The watchers that stop running, and why.
 *
 * Replaces a rule that counted `insights.status = 'dismissed'` at 70% over twenty insights.
 * Dismissal alone cannot tell "you were wrong" from "you were right and I had already dealt
 * with it", and muting on the second is how a working watcher gets switched off.
 */
export async function mutedWatcherReasons(ctx: TenantContext): Promise<Map<string, string>> {
  const quality = await watcherQuality(ctx)
  return new Map(quality.filter((row) => row.verdict === 'muted').map((row) => [row.watcher, row.reason]))
}

export interface FeedbackInput {
  insightId: string
  helpful: boolean
  reason?: FeedbackReason | null
  /**
   * `'snoozed'` is not here on purpose (ADR 0083). Putting one off needs a date, and a status
   * with no date is a snooze nothing will ever bring back — so it goes through `snoozeInsight`,
   * which is the only thing that can set both. The database refuses the pair coming apart.
   */
  status?: 'acknowledged' | 'in_progress' | 'resolved' | 'dismissed'
}

/**
 * Records what somebody thought, and optionally moves the insight.
 *
 * Two different permissions, deliberately. Rating needs only `insight:read` — you are
 * commenting on something you were shown. Changing the status needs `insight:update`,
 * because dismissing an insight takes it off everybody's screen, not just yours. Both are
 * checked before anything is written, so a refusal leaves nothing behind and can say so.
 *
 * Neither was checked at all: the route took an actor and never used it, so anybody signed
 * in — down to a `guest`, who holds no insight permission whatsoever — could rate any
 * insight and dismiss it for the whole organization.
 */
export async function recordInsightFeedback(
  ctx: TenantContext,
  actor: Actor,
  input: FeedbackInput,
): Promise<void> {
  const [insight] = await ctx.sql<{ id: string; assignedTo: string | null; watcher: string }[]>`
    SELECT id, assigned_to AS "assignedTo", watcher FROM insights
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.insightId} AND deleted_at IS NULL`
  if (!insight) throw new NotFoundError()

  const resource = {
    type: 'insight',
    id: insight.id,
    organizationId: ctx.organizationId,
    assigneeId: insight.assignedTo,
    ownerId: insight.assignedTo,
    riskTier: 'low' as const,
  }

  const readable = can(actor, 'insight:read', resource)
  if (!readable.allow) throw new PermissionError(readable.reason)

  // Both checks happen before anything is written. The refusal used to come after the
  // rating was inserted and say "your rating was recorded" — inside a transaction that
  // then rolled the rating back. A message that describes a write the database undid is
  // worse than a plain refusal.
  if (input.status) {
    const writable = can(actor, 'insight:update', resource)
    if (!writable.allow) {
      throw new PermissionError(
        `${writable.reason} Nothing was changed, including your rating — moving an insight is what needs the extra permission, because dismissing it takes it off everybody's screen. Rate it without moving it and the rating will land.`,
      )
    }
  }

  if (!input.helpful && !input.reason) {
    throw new ValidationError(
      'Say what was wrong with it. "Not helpful" on its own cannot tell a watcher that is mistaken from one that is merely early.',
    )
  }

  // One vote per person: a later opinion replaces an earlier one rather than stacking.
  await ctx.sql`
    INSERT INTO insight_feedback (organization_id, insight_id, user_id, helpful, reason, created_by)
    VALUES (${ctx.organizationId}, ${input.insightId}, ${actor.userId}, ${input.helpful},
            ${input.reason ?? null}, ${ctx.userId})
    ON CONFLICT (insight_id, user_id) WHERE deleted_at IS NULL
    DO UPDATE SET helpful = EXCLUDED.helpful, reason = EXCLUDED.reason, updated_at = now()`

  if (input.status) {
    await ctx.sql`
      UPDATE insights
      SET status = ${input.status}::sw_insight_status,
          resolved_at = CASE WHEN ${input.status} IN ('resolved', 'dismissed') THEN now() ELSE resolved_at END,
          updated_at = now()
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.insightId}`
  }

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'insight.rated',
    entityType: 'insight',
    entityId: input.insightId,
    after: {
      helpful: input.helpful,
      reason: input.reason ?? null,
      watcher: insight.watcher,
      ...(input.status ? { status: input.status } : {}),
    },
  })
}


// ---------------------------------------------------------------------------------------------
// Not now (ADR 0083)

/** How long a snooze may run. Beyond this it is a dismissal wearing a date. */
export const MAX_SNOOZE_DAYS = 30

export interface SnoozeInput {
  insightId: string
  until: Date
  reason?: string | null
}

/**
 * Putting an insight off until a date (ADR 0083).
 *
 * `insights.snoozed_until` has existed since migration 0006 and nothing has ever written it,
 * `'snoozed'` had no control, and nothing would have brought one back if it did. A snooze that
 * never ends is a dismissal that lies about itself — and it lies in the direction that matters,
 * because dismissal is the signal `watcherQuality` is built on.
 *
 * Needs `insight:update`, the same as dismissing: both take the card off everybody's screen.
 * No reason is required — dismissal demands one because it is a verdict on the watcher, and
 * making people write an essay to say "not this week" points them at the dismiss button instead.
 */
export async function snoozeInsight(ctx: TenantContext, actor: Actor, input: SnoozeInput): Promise<void> {
  const [insight] = await ctx.sql<{ id: string; assignedTo: string | null; status: string; title: string }[]>`
    SELECT id, assigned_to AS "assignedTo", status, title FROM insights
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.insightId} AND deleted_at IS NULL`
  if (!insight) throw new NotFoundError()

  const resource = {
    type: 'insight',
    id: insight.id,
    organizationId: ctx.organizationId,
    assigneeId: insight.assignedTo,
    ownerId: insight.assignedTo,
    riskTier: 'low' as const,
  }
  const decision = can(actor, 'insight:update', resource)
  if (!decision.allow) throw new PermissionError(decision.reason)

  // Work already under way is not something to defer — you either finish it or say it is not
  // happening. Offering snooze there would turn `in_progress` into a place things go to be
  // forgotten with a date attached.
  if (!['new', 'acknowledged'].includes(insight.status)) {
    throw new ValidationError(
      `This insight is ${insight.status.replace(/_/g, ' ')}. Only one nobody has started can be put off.`,
    )
  }

  const now = new Date()
  if (input.until <= now) {
    throw new ValidationError('Pick a date in the future — a snooze that has already ended is not one.')
  }
  const days = (input.until.getTime() - now.getTime()) / 86_400_000
  if (days > MAX_SNOOZE_DAYS) {
    throw new ValidationError(
      `${MAX_SNOOZE_DAYS} days is the longest an insight can be put off. Past that it is a dismissal, and dismissing it says something the watcher can learn from.`,
    )
  }

  await ctx.sql`
    UPDATE insights
       SET status = 'snoozed', snoozed_until = ${input.until}, snoozed_by = ${actor.userId},
           snooze_reason = ${input.reason?.trim() || null}, updated_at = now(), version = version + 1
     WHERE organization_id = ${ctx.organizationId} AND id = ${input.insightId}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'insight.snoozed',
    entityType: 'insight',
    entityId: insight.id,
    before: { status: insight.status },
    after: { status: 'snoozed', until: input.until.toISOString(), reason: input.reason?.trim() || null },
  })
}

/**
 * Bringing one back before its date (ADR 0083).
 *
 * The other half of being able to put something off, and it was missing from the first draft —
 * the browser check's second run is what found it, by snoozing the demo's only insight and then
 * having nothing to act on. Every other deferral in this product can be undone: a delegation can
 * be taken back, an attendance record can be unrecorded. A snooze you cannot cancel is a small
 * trap, and the sweep that would eventually release it is up to a month away.
 */
export async function unsnoozeInsight(ctx: TenantContext, actor: Actor, insightId: string): Promise<void> {
  const [insight] = await ctx.sql<{ id: string; assignedTo: string | null; status: string }[]>`
    SELECT id, assigned_to AS "assignedTo", status FROM insights
    WHERE organization_id = ${ctx.organizationId} AND id = ${insightId} AND deleted_at IS NULL`
  if (!insight) throw new NotFoundError()

  const decision = can(actor, 'insight:update', {
    type: 'insight',
    id: insight.id,
    organizationId: ctx.organizationId,
    assigneeId: insight.assignedTo,
    ownerId: insight.assignedTo,
    riskTier: 'low' as const,
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
  if (insight.status !== 'snoozed') throw new ValidationError('This insight has not been put off.')

  // The same state the sweep returns it to, for the same reason: somebody had seen it.
  await ctx.sql`
    UPDATE insights
       SET status = 'acknowledged', snoozed_until = NULL, snooze_reason = NULL,
           updated_at = now(), version = version + 1
     WHERE organization_id = ${ctx.organizationId} AND id = ${insightId}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'insight.returned_early',
    entityType: 'insight',
    entityId: insight.id,
    before: { status: 'snoozed' },
    after: { status: 'acknowledged' },
  })
}

export interface SnoozeSweep {
  returned: number
}

/**
 * Bringing back what was put off.
 *
 * Returns to `acknowledged` rather than `new`, and that is the honest state: somebody saw this
 * one and decided when to look again. Sending it back to `new` would say nobody had ever read
 * it, which is the sort of small lie a badge count is built on.
 *
 * No actor: this runs in the worker on every organization, the same shape as `sweepFollowUps`.
 */
export async function sweepSnoozedInsights(
  ctx: TenantContext,
  options: { now?: Date } = {},
): Promise<SnoozeSweep> {
  const now = options.now ?? new Date()

  const due = await ctx.sql<{ id: string; title: string; assignedTo: string | null; snoozedBy: string | null }[]>`
    UPDATE insights
       SET status = 'acknowledged', snoozed_until = NULL, snooze_reason = NULL,
           updated_at = now(), version = version + 1
     WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
       AND status = 'snoozed' AND snoozed_until <= ${now}
    RETURNING id, title, assigned_to AS "assignedTo", snoozed_by AS "snoozedBy"`

  for (const insight of due) {
    // Whoever put it off, or whoever it belongs to. Coming back silently would make a snooze
    // indistinguishable from a dismissal for anybody not watching the list.
    const tell = insight.snoozedBy ?? insight.assignedTo
    if (tell) {
      await notify(ctx, {
        userId: tell,
        type: 'insight_returned',
        title: 'An insight you put off is back',
        body: insight.title,
        entityType: 'insight',
        entityId: insight.id,
        url: '/insights',
        now,
      })
    }
    await writeAudit(ctx, {
      actorType: 'system',
      action: 'insight.returned',
      entityType: 'insight',
      entityId: insight.id,
      before: { status: 'snoozed' },
      after: { status: 'acknowledged' },
    })
  }

  // `snoozed_by` is deliberately left on the row. It is who last put it off, and clearing it
  // would lose the answer to "why did this disappear for a fortnight?" — the column the snooze
  // is over, `snoozed_until`, is the one that has to go.
  return { returned: due.length }
}
