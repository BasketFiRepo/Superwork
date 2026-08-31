import { withTenant, type TenantContext } from '@superwork/db'
import { EVENT_NAMES, eventDefinition } from '@superwork/config'
import { eventsSince, getEvent, NotFoundError, ValidationError, type EventRow } from '@superwork/core'
import { runWorkflow, type Cause } from './workflows.js'
import type { RunSession } from './runtime.js'

/**
 * The event dispatcher (ADR 0090).
 *
 * Until this existed, a workflow could run on a clock or when somebody pressed a button.
 * `activateWorkflow` scheduled a workflow whose trigger was a schedule and had no `else`, so a
 * workflow triggered by an event was marked active, published, audited as activated and shown on
 * the screen as running — and nothing would ever fire it. That branch is now refused at
 * activation; this is the machinery that makes refusing it unnecessary.
 *
 * ### It decides when, not what
 *
 * An event-triggered run executes the same compiled graph a scheduled one would: it runs the
 * version's query and acts on what comes back. The event decides *that* it runs, and is recorded
 * in `trigger_payload` so "why did this run happen" is answerable from the run — it does not
 * narrow the query. Making the event scope the work needs the query layer to take an entity, and
 * that is a bigger change than this one; it is named in the ADR rather than half-done here.
 *
 * ### Nothing is claimed
 *
 * There is no cursor and no lease. The sweep reads a window of recent events and tries each one
 * against each subscribed workflow; the run's idempotency key — `version:event:<id>` against a
 * unique index — is what makes the second attempt impossible. Two workers racing the same event
 * settle it in the index. A worker that dies mid-sweep loses nothing, because it had claimed
 * nothing. The cost is that a sweep re-examines events it has already dispatched, which is one
 * indexed lookup each.
 */

/** How far back a sweep looks. Longer than the sweep interval, so a missed tick catches up. */
export const EVENT_WINDOW_MS = 15 * 60_000

/**
 * How long a chain of workflows causing workflows may get.
 *
 * The hazard is not hypothetical: `create_task@v1` is one of the two actions the compiler can
 * emit, and `task.created` is one of the three events it can subscribe to, so the compiler can
 * build a workflow that triggers itself out of one sentence. Three links is enough for a fan-out
 * somebody designed and far short of a loop nobody meant.
 */
export const MAX_EVENT_DEPTH = 3

export interface DispatchOutcome {
  events: number
  matched: number
  ran: number
  alreadyRun: number
  skipped: number
  refusedTooDeep: number
  failed: number
  notes: string[]
}

interface Subscription {
  workflowId: string
  workflowName: string
  versionId: string
  eventName: string
}

/** Active workflows whose published version says it runs on an event. */
export async function subscriptions(ctx: TenantContext, eventName: string): Promise<Subscription[]> {
  const rows = await ctx.sql<
    { workflow_id: string; workflow_name: string; version_id: string }[]
  >`
    SELECT w.id AS workflow_id, w.name AS workflow_name, v.id AS version_id
    FROM workflows w
    JOIN workflow_versions v ON v.id = w.current_version_id AND v.deleted_at IS NULL
    WHERE w.organization_id = ${ctx.organizationId}
      AND w.status = 'active' AND w.deleted_at IS NULL
      AND v.graph -> 'trigger' ->> 'kind' = 'event'
      AND v.graph -> 'trigger' ->> 'spec' = ${eventName}`
  return rows.map((row) => ({
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    versionId: row.version_id,
    eventName,
  }))
}

/**
 * How deep the causal chain behind an event is.
 *
 * Derived rather than carried. A workflow run opens a trace and `withTenant` carries it into
 * everything the run does, so an event raised *by* a run already says which run raised it — the
 * same correlation the rest of the system uses to reconstruct what happened. Nothing had to
 * thread a counter through the tool layer for this to work, which is why it will keep working for
 * effects nobody has written yet.
 *
 * An event with no run behind it — a person filing a task, a mailbox syncing — is depth zero.
 */
export async function causeDepth(ctx: TenantContext, traceId: string | null): Promise<number> {
  if (!traceId) return 0
  const [row] = await ctx.sql<{ depth: number | null }[]>`
    SELECT max(wr.run_depth) AS depth
    FROM workflow_runs wr
    JOIN agent_runs ar ON ar.id = ANY(wr.agent_run_ids)
    WHERE wr.organization_id = ${ctx.organizationId} AND ar.trace_id = ${traceId}`
  return (row?.depth ?? -1) + 1
}

/** Whether this workflow has already run for this event. */
async function alreadyRan(ctx: TenantContext, key: string): Promise<boolean> {
  const [row] = await ctx.sql<{ id: string }[]>`
    SELECT id FROM workflow_runs
    WHERE organization_id = ${ctx.organizationId} AND idempotency_key = ${key} LIMIT 1`
  return row !== undefined
}

const keyFor = (versionId: string, eventId: string): string => `${versionId}:event:${eventId}`

/**
 * One sweep: every subscribed workflow against every recent event it subscribes to.
 *
 * Called by the worker beside the schedule sweep, because the two answer the same question a
 * minute apart — is there anything to run — and differ only in what they ask it of.
 */
export async function dispatchEvents(session: RunSession, now = new Date()): Promise<DispatchOutcome> {
  const outcome: DispatchOutcome = {
    events: 0,
    matched: 0,
    ran: 0,
    alreadyRun: 0,
    skipped: 0,
    refusedTooDeep: 0,
    failed: 0,
    notes: [],
  }
  const since = new Date(now.getTime() - EVENT_WINDOW_MS)

  for (const eventName of EVENT_NAMES) {
    const work = await withTenant(session, async (ctx) => {
      const subscribed = await subscriptions(ctx, eventName)
      if (subscribed.length === 0) return []
      const events = await eventsSince(ctx, eventName, since)
      outcome.events += events.length

      const pending: { subscription: Subscription; event: EventRow; depth: number }[] = []
      for (const event of events) {
        for (const subscription of subscribed) {
          if (await alreadyRan(ctx, keyFor(subscription.versionId, event.id))) {
            outcome.alreadyRun += 1
            continue
          }
          outcome.matched += 1
          pending.push({ subscription, event, depth: await causeDepth(ctx, event.traceId) })
        }
      }
      return pending
    })

    for (const { subscription, event, depth } of work) {
      if (depth > MAX_EVENT_DEPTH) {
        outcome.refusedTooDeep += 1
        outcome.notes.push(
          `${subscription.workflowName}: not run for ${event.name} — ${depth} automations deep, ` +
            `which is past the ${MAX_EVENT_DEPTH} this allows. Something is triggering itself.`,
        )
        continue
      }
      const cause: Cause = {
        eventId: event.id,
        idempotencyKey: keyFor(subscription.versionId, event.id),
        payload: {
          event: event.name,
          eventId: event.id,
          entityType: event.entityType,
          entityId: event.entityId,
          occurredAt: event.occurredAt.toISOString(),
          ...event.payload,
        },
        depth,
      }
      await runOne(session, subscription, cause, outcome, event.name)
    }
  }
  return outcome
}

async function runOne(
  session: RunSession,
  subscription: Subscription,
  cause: Cause,
  outcome: DispatchOutcome,
  eventName: string,
): Promise<void> {
  try {
    const run = await runWorkflow(session, { workflowId: subscription.workflowId, trigger: 'event', cause })
    if (run.status === 'skipped') {
      outcome.skipped += 1
      outcome.notes.push(`${subscription.workflowName}: ${run.note}`)
    } else if (run.status === 'failed') {
      outcome.failed += 1
      outcome.notes.push(`${subscription.workflowName}: ${run.error ?? 'failed'}`)
    } else {
      outcome.ran += 1
    }
  } catch (error) {
    // The race this leaves open on purpose: two workers both read the event as undispatched and
    // both try. The unique index settles it, and the loser is not a failure — it is the design
    // working, which is why it is counted where it is rather than reported.
    if (isDuplicate(error)) {
      outcome.alreadyRun += 1
      return
    }
    outcome.failed += 1
    outcome.notes.push(
      `${subscription.workflowName}: ${eventName} — ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

function isDuplicate(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505'
}

/**
 * Runs a workflow against an event it has already been offered, or was never offered.
 *
 * `workflow_runs.is_replay` has existed since migration 0007 with nothing to set it. This is what
 * it is for: the dispatcher was down, or the workflow was activated after the thing happened, and
 * somebody wants the run that should have occurred. It is deliberately a person's decision and
 * not a recovery the sweep performs on its own — a dispatcher that reached back on its own after
 * an outage would be a product that suddenly acts on a day of history nobody re-read.
 *
 * The replay keys itself apart from the original so the idempotency index does not refuse it, and
 * says on the row that it was one, because a second run for one event is otherwise indistinguishable
 * from the bug this whole mechanism exists to prevent.
 */
export async function replayEvent(
  session: RunSession,
  input: { workflowId: string; eventId: string },
): Promise<{ runId: string; status: string }> {
  const prepared = await withTenant(session, async (ctx) => {
    const event = await getEvent(ctx, input.eventId)
    if (!event) throw new NotFoundError('That event is not in the log.')
    if (!eventDefinition(event.name)) {
      throw new ValidationError(`"${event.name}" is not an event this product raises.`)
    }
    const [version] = await ctx.sql<{ id: string; kind: string | null; spec: string | null }[]>`
      SELECT v.id, v.graph -> 'trigger' ->> 'kind' AS kind, v.graph -> 'trigger' ->> 'spec' AS spec
      FROM workflows w
      JOIN workflow_versions v ON v.id = w.current_version_id AND v.deleted_at IS NULL
      WHERE w.organization_id = ${ctx.organizationId} AND w.id = ${input.workflowId}
        AND w.status = 'active' AND w.deleted_at IS NULL`
    if (!version) {
      throw new ValidationError('Only an active workflow can be replayed against an event.')
    }
    if (version.kind !== 'event' || version.spec !== event.name) {
      // Replaying an event at a workflow that does not subscribe to it would run something
      // against an input it was never designed for, by hand, with no record of the mismatch.
      throw new ValidationError(
        `This workflow does not run on ${event.name}, so there is nothing here to replay.`,
      )
    }
    return { event, versionId: version.id, depth: await causeDepth(ctx, event.traceId) }
  })

  const run = await runWorkflow(session, {
    workflowId: input.workflowId,
    trigger: 'event',
    cause: {
      eventId: prepared.event.id,
      idempotencyKey: `${prepared.versionId}:event:${prepared.event.id}:replay:${Date.now()}`,
      payload: {
        event: prepared.event.name,
        eventId: prepared.event.id,
        entityType: prepared.event.entityType,
        entityId: prepared.event.entityId,
        occurredAt: prepared.event.occurredAt.toISOString(),
        ...prepared.event.payload,
      },
      depth: prepared.depth,
      isReplay: true,
    },
  })
  return { runId: run.runId, status: run.status }
}
