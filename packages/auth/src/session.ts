import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'
import { authSql } from '@superwork/db'

const scrypt = promisify(scryptCb)

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14
export const SESSION_COOKIE = 'sw_session'

/**
 * Argon2id is the production choice (§4.1); scrypt is used here so the product runs
 * with zero native dependencies. Both are memory-hard and salted per user, and the
 * hash format carries its algorithm so a future migration can rehash on login.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = (await scrypt(password, salt, 64)) as Buffer
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, saltHex, hashHex] = stored.split('$')
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false
  const derived = (await scrypt(password, Buffer.from(saltHex, 'hex'), 64)) as Buffer
  const expected = Buffer.from(hashHex, 'hex')
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export interface SessionIdentity {
  userId: string
  organizationId: string | null
  email: string
  name: string
  timezone: string
  /** When this session last re-proved its identity, or null if it never has (§4.1). */
  steppedUpAt: Date | null
}

export interface LoginResult {
  token: string
  identity: SessionIdentity
  organizations: { id: string; name: string; slug: string; isDemo: boolean }[]
}

export async function login(email: string, password: string, meta: { userAgent?: string } = {}): Promise<LoginResult | null> {
  const sql = authSql()
  const users = await sql<{ id: string; email: string; name: string; timezone: string; password_hash: string | null }[]>`
    SELECT id, email, name, timezone, password_hash
    FROM users WHERE lower(email) = lower(${email}) AND deleted_at IS NULL`
  const user = users[0]
  if (!user?.password_hash) return null
  if (!(await verifyPassword(password, user.password_hash))) return null

  const orgs = await sql<{ id: string; name: string; slug: string; is_demo: boolean }[]>`
    SELECT o.id, o.name, o.slug, o.is_demo
    FROM memberships m JOIN organizations o ON o.id = m.organization_id
    WHERE m.user_id = ${user.id} AND m.deleted_at IS NULL AND m.status = 'active'
    ORDER BY o.name`

  const token = randomBytes(32).toString('hex')
  const organizationId = orgs[0]?.id ?? null
  await sql`
    INSERT INTO sessions (user_id, organization_id, token_hash, user_agent, expires_at)
    VALUES (${user.id}, ${organizationId}, ${hashToken(token)}, ${meta.userAgent ?? null},
            ${new Date(Date.now() + SESSION_TTL_MS)})`

  return {
    token,
    identity: {
      userId: user.id,
      organizationId,
      email: user.email,
      name: user.name,
      timezone: user.timezone,
      // A fresh sign-in is not a step-up. They are different proofs about different
      // moments, and treating one as the other would make the first action after login
      // free — which is exactly the unlocked-laptop case.
      steppedUpAt: null,
    },
    organizations: orgs.map((o) => ({ id: o.id, name: o.name, slug: o.slug, isDemo: o.is_demo })),
  }
}

export async function resolveSession(token: string | undefined): Promise<SessionIdentity | null> {
  if (!token) return null
  const sql = authSql()
  const rows = await sql<
    {
      user_id: string
      organization_id: string | null
      email: string
      name: string
      timezone: string
      stepped_up_at: Date | null
    }[]
  >`
    SELECT s.user_id, s.organization_id, u.email, u.name, u.timezone, s.stepped_up_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${hashToken(token)}
      AND s.revoked_at IS NULL
      AND s.expires_at > now()
      AND u.deleted_at IS NULL`
  const row = rows[0]
  if (!row) return null
  await sql`UPDATE sessions SET last_seen_at = now() WHERE token_hash = ${hashToken(token)}`
  return {
    userId: row.user_id,
    organizationId: row.organization_id,
    email: row.email,
    name: row.name,
    timezone: row.timezone,
    steppedUpAt: row.stepped_up_at,
  }
}

/**
 * Step-up authentication (§4.1).
 *
 * The person proves, again and just now, that they are the one at the keyboard. It defends
 * against a session rather than a password — a laptop left open, a cookie lifted from a
 * machine — so it is asked for immediately before something irreversible and it expires
 * quickly afterwards.
 *
 * A stolen session must not become a password oracle, so failures are counted on the
 * session and lock it out. The lock is deliberately narrow: the session keeps everything it
 * could already do, and loses only the actions that require fresh proof.
 */
export const STEP_UP_MAX_FAILURES = 5
export const STEP_UP_LOCK_MS = 15 * 60_000

export type StepUpResult =
  | { ok: true; steppedUpAt: Date }
  | { ok: false; reason: string; lockedUntil?: Date }

export async function stepUp(token: string | undefined, password: string): Promise<StepUpResult> {
  if (!token) return { ok: false, reason: 'Sign in again — this session could not be read.' }
  const sql = authSql()
  const rows = await sql<
    { id: string; user_id: string; password_hash: string | null; failures: number; locked_until: Date | null }[]
  >`
    SELECT s.id, s.user_id, u.password_hash, s.step_up_failures AS failures,
           s.step_up_locked_until AS locked_until
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${hashToken(token)} AND s.revoked_at IS NULL AND s.expires_at > now()
      AND u.deleted_at IS NULL`
  const row = rows[0]
  if (!row?.password_hash) return { ok: false, reason: 'Sign in again — this session could not be read.' }

  if (row.locked_until && row.locked_until.getTime() > Date.now()) {
    return {
      ok: false,
      reason:
        'Too many failed attempts on this session. Confirming irreversible actions is paused for a few minutes; ' +
        'everything else still works.',
      lockedUntil: row.locked_until,
    }
  }

  if (!(await verifyPassword(password, row.password_hash))) {
    const failures = (row.locked_until ? 0 : row.failures) + 1
    const lockedUntil = failures >= STEP_UP_MAX_FAILURES ? new Date(Date.now() + STEP_UP_LOCK_MS) : null
    await sql`
      UPDATE sessions SET step_up_failures = ${failures}, step_up_locked_until = ${lockedUntil}
      WHERE id = ${row.id}`
    return {
      ok: false,
      reason: 'That password is not right.',
      ...(lockedUntil ? { lockedUntil } : {}),
    }
  }

  const now = new Date()
  await sql`
    UPDATE sessions SET stepped_up_at = ${now}, step_up_failures = 0, step_up_locked_until = NULL
    WHERE id = ${row.id}`
  return { ok: true, steppedUpAt: now }
}

/** Switching organizations re-issues the access context (§3.1). */
export async function switchOrganization(token: string, organizationId: string): Promise<boolean> {
  const sql = authSql()
  const identity = await resolveSession(token)
  if (!identity) return false
  const allowed = await sql<{ id: string }[]>`
    SELECT id FROM memberships
    WHERE user_id = ${identity.userId} AND organization_id = ${organizationId}
      AND deleted_at IS NULL AND status = 'active'`
  if (allowed.length === 0) return false
  await sql`UPDATE sessions SET organization_id = ${organizationId} WHERE token_hash = ${hashToken(token)}`
  return true
}

export async function logout(token: string): Promise<void> {
  await authSql()`UPDATE sessions SET revoked_at = now() WHERE token_hash = ${hashToken(token)}`
}
