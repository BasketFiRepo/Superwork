import { NextResponse } from 'next/server'
import { withTenant, type TenantContext } from '@superwork/db'
import {
  checkRateLimit,
  loadActor,
  recordApiRequest,
  resolveApiKey,
  type Actor,
  type ApiScope,
  type ResolvedKey,
} from '@superwork/auth'

/**
 * The public API boundary (§22.2).
 *
 * Every request is authenticated to a key, the key acts as a person, the scope is checked
 * before the handler runs, the rate limit is counted in the database, and the call is
 * logged whether it succeeded or not. A handler never sees an unauthenticated request.
 */

export interface ApiRequestContext {
  ctx: TenantContext
  actor: Actor
  key: ResolvedKey
}

type Handler = (context: ApiRequestContext) => Promise<unknown>

export async function withApiKey(
  request: Request,
  scope: ApiScope,
  handler: Handler,
): Promise<NextResponse> {
  const started = Date.now()
  const path = new URL(request.url).pathname
  const key = await resolveApiKey(request.headers.get('authorization'))

  if (!key) {
    return json(
      { error: 'unauthorized', message: 'Present a valid API key as `Authorization: Bearer sw_…`.' },
      401,
    )
  }

  const session = { organizationId: key.organizationId, userId: key.principalUserId, timezone: 'UTC' }

  if (!key.scopes.includes(scope)) {
    await withTenant(session, (ctx) =>
      recordApiRequest(ctx, {
        keyId: key.keyId,
        method: request.method,
        path,
        status: 403,
        durationMs: Date.now() - started,
        scopeUsed: scope,
        errorCode: 'missing_scope',
      }),
    )
    return json(
      {
        error: 'forbidden',
        message: `This key does not hold the "${scope}" scope. Its scopes are: ${key.scopes.join(', ') || 'none'}.`,
      },
      403,
    )
  }

  try {
    return await withTenant(session, async (ctx) => {
      const limit = await checkRateLimit(ctx, key)
      if (!limit.allow) {
        await recordApiRequest(ctx, {
          keyId: key.keyId,
          method: request.method,
          path,
          status: 429,
          durationMs: Date.now() - started,
          scopeUsed: scope,
          errorCode: 'rate_limited',
        })
        return json(
          {
            error: 'rate_limited',
            message: `${limit.used} requests in the last minute against a limit of ${limit.limit}.`,
          },
          429,
          { 'retry-after': String(limit.retryAfterSeconds) },
        )
      }

      const actor = await loadActor(ctx, key.principalUserId)
      const payload = await handler({ ctx, actor, key })
      await recordApiRequest(ctx, {
        keyId: key.keyId,
        method: request.method,
        path,
        status: 200,
        durationMs: Date.now() - started,
        scopeUsed: scope,
      })
      return json(payload, 200)
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Something went wrong.'
    await withTenant(session, (ctx) =>
      recordApiRequest(ctx, {
        keyId: key.keyId,
        method: request.method,
        path,
        status: 400,
        durationMs: Date.now() - started,
        scopeUsed: scope,
        errorCode: 'handler_error',
      }),
    ).catch(() => {})
    return json({ error: 'bad_request', message }, 400)
  }
}

function json(payload: unknown, status: number, headers: Record<string, string> = {}): NextResponse {
  return NextResponse.json(payload, { status, headers })
}
