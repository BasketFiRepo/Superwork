import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { authSql, type TenantContext } from '@superwork/db'
import { can, type Actor } from './policy.js'

/**
 * API keys for the public API and the MCP server (§22).
 *
 * Three rules make this safe rather than convenient:
 *   • a key always acts *as a person*, so nothing the API does escapes the permission
 *     model or the audit trail;
 *   • the secret is stored as a hash and shown once, like any credential;
 *   • the key is resolved before a tenant is known, so the lookup runs on the pre-tenant
 *     role — the same boundary sign-in uses.
 */

export const API_SCOPES = [
  'tasks:read',
  'tasks:write',
  'knowledge:read',
  'runs:read',
  'runs:write',
  'mcp:read',
] as const

export type ApiScope = (typeof API_SCOPES)[number]

export interface IssuedKey {
  id: string
  name: string
  prefix: string
  /** Returned exactly once, at creation. Nothing stores it. */
  secret: string
  scopes: ApiScope[]
}

export interface ResolvedKey {
  keyId: string
  organizationId: string
  principalUserId: string
  scopes: ApiScope[]
  rateLimitPerMinute: number
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

export async function issueApiKey(
  ctx: TenantContext,
  actor: Actor,
  input: {
    name: string
    scopes: ApiScope[]
    principalUserId?: string
    rateLimitPerMinute?: number
    expiresAt?: Date | null
  },
): Promise<IssuedKey> {
  const decision = can(actor, 'settings:update', {
    type: 'settings',
    organizationId: ctx.organizationId,
    riskTier: 'high',
  })
  if (!decision.allow) throw new Error(decision.reason)

  const unknown = input.scopes.filter((scope) => !API_SCOPES.includes(scope))
  if (unknown.length > 0) throw new Error(`Unknown scope: ${unknown.join(', ')}`)
  if (input.scopes.length === 0) throw new Error('A key with no scopes can do nothing. Choose what it may read or write.')

  const prefix = `sw_${randomBytes(4).toString('hex')}`
  const secret = `${prefix}_${randomBytes(24).toString('base64url')}`

  // The key acts as a person, and that person's permissions bound it. Defaulting to the
  // creator means an API key can never quietly outrank whoever made it.
  const principalUserId = input.principalUserId ?? actor.userId

  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO api_keys (
      organization_id, name, prefix, secret_hash, scopes, principal_user_id,
      rate_limit_per_minute, expires_at, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.name}, ${prefix}, ${hashSecret(secret)}, ${input.scopes},
      ${principalUserId}, ${input.rateLimitPerMinute ?? 60}, ${input.expiresAt ?? null}, ${ctx.userId}
    ) RETURNING id`

  return { id: row!.id, name: input.name, prefix, secret, scopes: input.scopes }
}

/**
 * Resolves a presented secret. Runs on the pre-tenant role because the organization is
 * not known until the key is found — exactly like signing in (§3.3).
 */
export async function resolveApiKey(presented: string | null | undefined): Promise<ResolvedKey | null> {
  if (!presented) return null
  const value = presented.replace(/^Bearer\s+/i, '').trim()
  const prefix = value.split('_').slice(0, 2).join('_')
  if (!prefix.startsWith('sw_')) return null

  const rows = await authSql()<
    {
      id: string
      organization_id: string
      principal_user_id: string
      secret_hash: string
      scopes: string[]
      rate_limit_per_minute: number
      expires_at: Date | null
      revoked_at: Date | null
    }[]
  >`
    SELECT id, organization_id, principal_user_id, secret_hash, scopes,
           rate_limit_per_minute, expires_at, revoked_at
    FROM api_keys WHERE prefix = ${prefix} AND deleted_at IS NULL`

  const row = rows[0]
  if (!row) return null
  if (row.revoked_at) return null
  if (row.expires_at && row.expires_at.getTime() < Date.now()) return null

  const expected = Buffer.from(row.secret_hash, 'hex')
  const actual = Buffer.from(hashSecret(value), 'hex')
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null

  return {
    keyId: row.id,
    organizationId: row.organization_id,
    principalUserId: row.principal_user_id,
    scopes: row.scopes as ApiScope[],
    rateLimitPerMinute: row.rate_limit_per_minute,
  }
}

export interface ApiKeyView {
  id: string
  name: string
  prefix: string
  scopes: string[]
  principalName: string | null
  rateLimitPerMinute: number
  lastUsedAt: Date | null
  expiresAt: Date | null
  revokedAt: Date | null
  createdAt: Date
  requestsLastDay: number
}

export async function listApiKeys(ctx: TenantContext, actor: Actor): Promise<ApiKeyView[]> {
  const decision = can(actor, 'settings:read', { type: 'settings', organizationId: ctx.organizationId })
  if (!decision.allow) throw new Error(decision.reason)

  return ctx.sql<ApiKeyView[]>`
    SELECT k.id, k.name, k.prefix, k.scopes, u.name AS "principalName",
           k.rate_limit_per_minute AS "rateLimitPerMinute", k.last_used_at AS "lastUsedAt",
           k.expires_at AS "expiresAt", k.revoked_at AS "revokedAt", k.created_at AS "createdAt",
           (SELECT count(*)::int FROM api_requests r
             WHERE r.organization_id = k.organization_id AND r.api_key_id = k.id
               AND r.occurred_at > now() - interval '1 day') AS "requestsLastDay"
    FROM api_keys k
    LEFT JOIN users u ON u.id = k.principal_user_id
    WHERE k.organization_id = ${ctx.organizationId} AND k.deleted_at IS NULL
    ORDER BY k.created_at DESC`
}

export async function revokeApiKey(ctx: TenantContext, actor: Actor, keyId: string): Promise<void> {
  const decision = can(actor, 'settings:update', {
    type: 'settings',
    organizationId: ctx.organizationId,
    riskTier: 'high',
  })
  if (!decision.allow) throw new Error(decision.reason)

  await ctx.sql`
    UPDATE api_keys SET revoked_at = now(), revoked_by = ${actor.userId}
    WHERE organization_id = ${ctx.organizationId} AND id = ${keyId} AND deleted_at IS NULL`
}

/**
 * Fixed-window rate limiting, counted from the request log rather than from memory, so
 * every process agrees and a restart does not reset somebody's budget.
 */
export async function checkRateLimit(
  ctx: TenantContext,
  key: ResolvedKey,
): Promise<{ allow: boolean; used: number; limit: number; retryAfterSeconds: number }> {
  const [row] = await ctx.sql<{ used: string }[]>`
    SELECT count(*)::text AS used FROM api_requests
    WHERE organization_id = ${ctx.organizationId} AND api_key_id = ${key.keyId}
      AND occurred_at > now() - interval '1 minute'`
  const used = Number(row?.used ?? 0)
  return {
    allow: used < key.rateLimitPerMinute,
    used,
    limit: key.rateLimitPerMinute,
    retryAfterSeconds: 60,
  }
}

export async function recordApiRequest(
  ctx: TenantContext,
  input: {
    keyId: string | null
    method: string
    path: string
    status: number
    durationMs: number
    scopeUsed?: string | null
    errorCode?: string | null
  },
): Promise<void> {
  await ctx.sql`
    INSERT INTO api_requests (
      organization_id, api_key_id, method, path, status, duration_ms, scope_used, error_code, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.keyId}, ${input.method}, ${input.path}, ${input.status},
      ${input.durationMs}, ${input.scopeUsed ?? null}, ${input.errorCode ?? null}, ${ctx.userId}
    )`
  if (input.keyId) {
    await ctx.sql`
      UPDATE api_keys SET last_used_at = now()
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.keyId}`
  }
}
