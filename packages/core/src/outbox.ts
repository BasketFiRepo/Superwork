import { asJson, type TenantContext } from '@superwork/db'

/**
 * Transactional outbox (§2.4). Intent is written in the same transaction as the state
 * change; dispatch happens asynchronously. Nothing in this codebase performs an
 * external side effect inline in a request.
 */

export interface OutboxMessage {
  topic: string
  payload: Record<string, unknown>
  idempotencyKey: string
  notBefore?: Date
}

export async function enqueue(ctx: TenantContext, message: OutboxMessage): Promise<void> {
  await ctx.sql`
    INSERT INTO outbox (organization_id, topic, payload, idempotency_key, next_attempt_at, trace_id, created_by)
    VALUES (${ctx.organizationId}, ${message.topic}, ${ctx.sql.json(asJson(message.payload))},
            ${message.idempotencyKey}, ${message.notBefore ?? new Date()}, ${ctx.traceId}, ${ctx.userId})
    ON CONFLICT (organization_id, topic, idempotency_key) DO NOTHING`
}

export interface OutboxRow {
  id: string
  organization_id: string
  topic: string
  payload: Record<string, unknown>
  idempotency_key: string
  attempts: number
}

/** Claims a batch for dispatch. Uses SKIP LOCKED so multiple workers never collide. */
export async function claimBatch(ctx: TenantContext, limit = 20): Promise<OutboxRow[]> {
  return ctx.sql<OutboxRow[]>`
    UPDATE outbox SET status = 'dispatching', attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM outbox
      WHERE organization_id = ${ctx.organizationId}
        AND status IN ('pending', 'failed')
        AND next_attempt_at <= now()
      ORDER BY next_attempt_at
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id, organization_id, topic, payload, idempotency_key, attempts`
}

export async function markDispatched(ctx: TenantContext, id: string): Promise<void> {
  await ctx.sql`UPDATE outbox SET status = 'dispatched', dispatched_at = now() WHERE id = ${id}`
}

export async function markFailed(ctx: TenantContext, id: string, error: string, attempts: number): Promise<void> {
  // Exponential backoff with a dead-letter terminus after 6 attempts.
  const delaySeconds = Math.min(2 ** attempts, 3600)
  const status = attempts >= 6 ? 'dead' : 'failed'
  await ctx.sql`
    UPDATE outbox
    SET status = ${status}, last_error = ${error},
        next_attempt_at = now() + make_interval(secs => ${delaySeconds})
    WHERE id = ${id}`
}
