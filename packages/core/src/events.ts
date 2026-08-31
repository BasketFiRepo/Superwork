import { asJson, type TenantContext } from '@superwork/db'
import {
  EVENT_DEFINITIONS,
  EVENT_NAMES,
  eventDefinition,
  unknownEventMessage,
  type EventDefinition,
} from '@superwork/config'

/**
 * The internal event log (ADR 0090).
 *
 * `events` was created in migration 0005 with the comment *"Internal event bus log. Workflow
 * triggers and watchers read from here"* — and then nothing wrote to it and nothing read from it,
 * for the same reason `messages.sanitized_at` had no writer: the table said what it was for
 * clearly enough that every review saw a design rather than an absence.
 *
 * ### Why a fourth log
 *
 * Three others already exist and none of them is this one:
 *
 *   **`audit_logs`** is who did what, kept because somebody may have to answer for it. It is
 *   written for the record, not to be acted on, and nothing may consume it — a log that changes
 *   behaviour is a log somebody has a reason to shape.
 *
 *   **`activity`** is the human-readable feed. It exists to be *read by a person*, in sentences,
 *   and its rows are phrased rather than structured.
 *
 *   **`outbox`** is the closest, and the difference is the one that matters: a row there is one
 *   intended delivery, and it carries `status`, `attempts` and `next_attempt_at` because
 *   *exactly one* thing must happen to it. An event has no such state, because it does not know
 *   who cares. Nought, one or five workflows may be subscribed, and per-subscriber progress
 *   cannot live on a row shared between them.
 *
 * So: the outbox is intent to deliver, this is a record that something happened. Fanning out from
 * the outbox would mean giving one row several independent fates.
 *
 * ### Where the dispatch record lives instead
 *
 * Nowhere on the event — on the run. `workflow_runs` has a unique index on
 * `(organization_id, idempotency_key)`, and an event-triggered run keys itself
 * `version:event:<event id>`. A workflow that has already run for an event therefore *cannot* run
 * for it again: the second insert is a unique violation, not a decision. That means no cursor
 * table to fall behind, no lease to expire, and two workers racing on the same event settle it in
 * the index rather than in a lock.
 */

/**
 * The names this product raises live in `@superwork/config` — the workflow compiler needs them
 * and cannot import this package. Re-exported here so a caller emitting one does not have to know
 * that, and so the list has exactly one definition (ADR 0090).
 */
export { EVENT_DEFINITIONS, EVENT_NAMES, eventDefinition, unknownEventMessage, type EventDefinition }

export type EventActorType = 'user' | 'agent' | 'system' | 'integration'

export interface EmitEventInput {
  name: string
  entityType: string
  entityId: string
  /** Enough for a reader to know what happened without loading the row it points at. */
  payload?: Record<string, unknown>
  actorType?: EventActorType
  actorId?: string | null
  isDemo?: boolean
}

export interface EventRow {
  id: string
  name: string
  entityType: string | null
  entityId: string | null
  payload: Record<string, unknown>
  actorType: EventActorType
  actorId: string | null
  traceId: string | null
  occurredAt: Date
}

/**
 * Records that something happened.
 *
 * `trace_id` is taken from the context rather than passed, and it is the load-bearing part. A
 * workflow run opens its own trace and carries it into everything the run does, so an event
 * raised *by* a run is already marked with which run raised it — which is how the dispatcher
 * computes `run_depth` without anything having to thread a counter through the tool layer. The
 * correlation the rest of the system uses for debugging turns out to be exactly the correlation a
 * cycle detector needs.
 *
 * Emitting never throws into its caller's work. A task is created, or it is not; whether the
 * event log heard about it is not a reason to fail the create. The row is the one thing here that
 * can be lost, and the sweep that reads it is bounded by time rather than by a cursor, so a lost
 * row costs one dispatch rather than stalling every later one.
 */
export async function emitEvent(ctx: TenantContext, input: EmitEventInput): Promise<string | null> {
  try {
    const [row] = await ctx.sql<{ id: string }[]>`
      INSERT INTO events (
        organization_id, name, entity_type, entity_id, payload, actor_type, actor_id,
        trace_id, is_demo, created_by
      ) VALUES (
        ${ctx.organizationId}, ${input.name}, ${input.entityType}, ${input.entityId},
        ${ctx.sql.json(asJson(input.payload ?? {}))}, ${input.actorType ?? 'system'},
        ${input.actorId ?? null}, ${ctx.traceId}, ${input.isDemo ?? false}, ${ctx.userId}
      ) RETURNING id`
    return row!.id
  } catch (error) {
    // An unknown name is a programming error and worth seeing; it is still not worth failing
    // somebody's task creation over.
    console.error(`[events] could not record ${input.name}: ${error instanceof Error ? error.message : error}`)
    return null
  }
}

/**
 * Events of one name inside a window, oldest first.
 *
 * Bounded by time rather than by a cursor on purpose. A cursor is a second piece of state that can
 * be wrong in a way nothing notices — ahead of the events it claims to have dispatched — and the
 * cost of not having one is only that the sweep re-examines events it has already handled, which
 * the run's idempotency key settles for free.
 */
export async function eventsSince(
  ctx: TenantContext,
  name: string,
  since: Date,
  limit = 200,
): Promise<EventRow[]> {
  const rows = await ctx.sql<
    {
      id: string
      name: string
      entity_type: string | null
      entity_id: string | null
      payload: Record<string, unknown>
      actor_type: EventActorType
      actor_id: string | null
      trace_id: string | null
      occurred_at: Date
    }[]
  >`
    SELECT id, name, entity_type, entity_id, payload, actor_type, actor_id, trace_id, occurred_at
    FROM events
    WHERE organization_id = ${ctx.organizationId} AND name = ${name}
      AND occurred_at >= ${since} AND deleted_at IS NULL
    ORDER BY occurred_at ASC
    LIMIT ${limit}`
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    entityType: row.entity_type,
    entityId: row.entity_id,
    payload: row.payload,
    actorType: row.actor_type,
    actorId: row.actor_id,
    traceId: row.trace_id,
    occurredAt: row.occurred_at,
  }))
}

/** One event by id, for a replay. */
export async function getEvent(ctx: TenantContext, id: string): Promise<EventRow | null> {
  const [row] = await eventsById(ctx, [id])
  return row ?? null
}

async function eventsById(ctx: TenantContext, ids: string[]): Promise<EventRow[]> {
  const rows = await ctx.sql<
    {
      id: string
      name: string
      entity_type: string | null
      entity_id: string | null
      payload: Record<string, unknown>
      actor_type: EventActorType
      actor_id: string | null
      trace_id: string | null
      occurred_at: Date
    }[]
  >`
    SELECT id, name, entity_type, entity_id, payload, actor_type, actor_id, trace_id, occurred_at
    FROM events
    WHERE organization_id = ${ctx.organizationId} AND id = ANY(${ids}::uuid[]) AND deleted_at IS NULL`
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    entityType: row.entity_type,
    entityId: row.entity_id,
    payload: row.payload,
    actorType: row.actor_type,
    actorId: row.actor_id,
    traceId: row.trace_id,
    occurredAt: row.occurred_at,
  }))
}
