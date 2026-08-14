import { randomUUID } from 'node:crypto'
import { appSql, type Sql } from './client.js'

/**
 * Isolation layer two (§3.2): a TenantContext is required to construct any repository.
 * There is no exported path to a tenant table that does not carry one, and the context
 * only ever hands out a `sql` handle bound to a transaction where `app.current_org`
 * has already been set.
 */
export interface TenantContext {
  readonly organizationId: string
  readonly userId: string
  /** IANA timezone of the *viewing user*. "Today" and "overdue" are computed with it (§2.4). */
  readonly timezone: string
  readonly requestId: string
  readonly traceId: string
  /**
   * When the request's session last re-proved its identity (§4.1), or null. Carried on the
   * context because it is a property of *this request*, not of the person: the same user in
   * another tab has not re-authenticated just because this one did.
   */
  readonly steppedUpAt: Date | null
  readonly sql: Sql
}

export interface TenantContextInput {
  organizationId: string
  userId: string
  timezone?: string
  requestId?: string
  traceId?: string
  steppedUpAt?: Date | null
}

/**
 * Opens a transaction, pins the tenant for its lifetime, and runs `fn`.
 * `set_config(..., true)` scopes the setting to the transaction, so a pooled
 * connection can never leak a tenant to the next checkout.
 */
export async function withTenant<T>(
  input: TenantContextInput,
  fn: (ctx: TenantContext) => Promise<T>,
): Promise<T> {
  if (!input.organizationId) throw new Error('withTenant requires an organizationId')
  if (!input.userId) throw new Error('withTenant requires a userId — every access has a principal')

  const traceId = input.traceId ?? randomUUID()
  const requestId = input.requestId ?? randomUUID()

  return appSql().begin(async (tx) => {
    await tx`SELECT set_config('app.current_org', ${input.organizationId}, true),
                    set_config('app.current_user_id', ${input.userId}, true)`
    const ctx: TenantContext = {
      organizationId: input.organizationId,
      userId: input.userId,
      timezone: input.timezone ?? 'UTC',
      requestId,
      traceId,
      steppedUpAt: input.steppedUpAt ?? null,
      sql: tx as unknown as Sql,
    }
    return fn(ctx)
  }) as Promise<T>
}

/** Derives a child context that reuses the same transaction (sub-agents, nested repositories). */
export function childContext(ctx: TenantContext, overrides: Partial<TenantContextInput>): TenantContext {
  return {
    ...ctx,
    ...(overrides.userId ? { userId: overrides.userId } : {}),
    ...(overrides.timezone ? { timezone: overrides.timezone } : {}),
  }
}

/**
 * postgres.js types `sql.json()` against its own recursive JSONValue. Domain objects are
 * structurally JSON but do not satisfy that type, so this is the single, explicit place
 * where that widening happens — rather than a cast scattered through every call site.
 */
type JsonParameter = Parameters<Sql['json']>[0]

export function asJson<T>(value: T): JsonParameter {
  return value as JsonParameter
}
