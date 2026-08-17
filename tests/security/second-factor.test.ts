import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { adminSql, closePools } from '@superwork/db'
import {
  base32Encode,
  beginMfaEnrolment,
  completeMfaLogin,
  confirmMfaEnrolment,
  disableMfa,
  hashPassword,
  login,
  mfaStatus,
  regenerateRecoveryCodes,
  resolvePendingSession,
  resolveSession,
  STEP_UP_MAX_FAILURES,
  stepUp,
  totpCode,
  totpCounter,
  verifyFactor,
  verifyTotp,
} from '@superwork/auth'
import { createTenant, destroyTenant, type TenantFixture } from '../helpers/fixtures.js'

/**
 * The second factor (ADR 0043).
 *
 * `users.mfa_enabled` has existed since migration 0001 and nothing has ever written to it or
 * read it. There was no second factor anywhere, and step-up — the gate in front of every
 * irreversible action — re-asked for the same password the session was opened with. So a stolen
 * session plus a known password reached everything.
 *
 * The arithmetic is checked against the RFC 6238 vectors first: a TOTP implementation that is
 * subtly wrong is a lockout for everybody who enrols.
 */

const EMAIL = 'factor.subject@fixture.example'
const PASSWORD = 'a-long-enough-password'
let org: TenantFixture
let userId: string

/**
 * A code, and the instant it belongs to.
 *
 * A used code cannot be reused inside its own thirty-second window — which is the replay guard
 * working — so consecutive codes cannot be exercised in less than thirty seconds of real time.
 * The test names the moment it means instead of waiting for a clock, exactly as the reminder
 * tests do (ADR 0039).
 */
const PERIOD_MS = 30_000
function at(step: number): Date {
  return new Date((totpCounter() + step) * PERIOD_MS)
}
function code(secret: string, step = 0): string {
  return totpCode(secret, totpCounter() + step)!
}

beforeAll(async () => {
  org = await createTenant('second-factor')
  await adminSql()`DELETE FROM users WHERE lower(email) = ${EMAIL}`
  const [user] = await adminSql()<{ id: string }[]>`
    INSERT INTO users (email, name, password_hash, timezone, is_demo)
    VALUES (${EMAIL}, 'Factor Subject', ${await hashPassword(PASSWORD)}, 'Europe/London', true)
    RETURNING id`
  userId = user!.id
  await adminSql()`
    INSERT INTO memberships (organization_id, user_id, role, is_demo)
    VALUES (${org.organizationId}, ${userId}, 'admin', true)`
})

afterAll(async () => {
  await destroyTenant('second-factor')
  await adminSql()`DELETE FROM users WHERE id = ${userId}`
  await closePools()
})

describe('the arithmetic', () => {
  it('matches the RFC 6238 SHA-1 vectors', () => {
    // The published secret is the ASCII string "12345678901234567890".
    const secret = base32Encode(Buffer.from('12345678901234567890'))
    const vectors: [number, string][] = [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
      [20000000000, '353130'],
    ]
    for (const [seconds, expected] of vectors) {
      expect(totpCode(secret, Math.floor(seconds / 30))).toBe(expected)
    }
  })

  it('accepts one step either side and nothing further', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'))
    const now = new Date()
    const counter = totpCounter(now)
    expect(verifyTotp(secret, totpCode(secret, counter - 1)!, { now }).ok).toBe(true)
    expect(verifyTotp(secret, totpCode(secret, counter + 1)!, { now }).ok).toBe(true)
    expect(verifyTotp(secret, totpCode(secret, counter - 2)!, { now }).ok).toBe(false)
    expect(verifyTotp(secret, totpCode(secret, counter + 2)!, { now }).ok).toBe(false)
  })

  it('refuses anything that is not six digits, without hitting the maths', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'))
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56 78']) {
      expect(verifyTotp(secret, bad).ok).toBe(false)
    }
  })
})

describe('enrolling', () => {
  let secret = ''

  it('does not turn anything on until a code proves the secret can be read', async () => {
    const started = await beginMfaEnrolment(userId, { issuer: 'Superwork', account: EMAIL })
    expect('secret' in started).toBe(true)
    secret = (started as { secret: string }).secret
    expect((started as { uri: string }).uri).toContain('otpauth://totp/')

    const half = await mfaStatus(userId)
    // A secret exists and the factor is off: an enrolment nobody has proved.
    expect(half.enabled).toBe(false)
    expect(half.pending).toBe(true)

    const wrong = await confirmMfaEnrolment(userId, '000000')
    expect(wrong.ok).toBe(false)
    expect((await mfaStatus(userId)).enabled).toBe(false)
  })

  it('turns it on for a good code, and hands over recovery codes once', async () => {
    const result = await confirmMfaEnrolment(userId, code(secret))
    expect(result.ok).toBe(true)
    expect(result.recoveryCodes?.length).toBeGreaterThan(0)

    const status = await mfaStatus(userId)
    expect(status.enabled).toBe(true)
    expect(status.recoveryCodesLeft).toBe(result.recoveryCodes!.length)

    // Hashes, not codes. A support engineer reading the row learns nothing usable.
    const [row] = await adminSql()<{ hashes: string[] }[]>`
      SELECT mfa_recovery_hashes AS hashes FROM users WHERE id = ${userId}`
    for (const stored of row!.hashes) {
      expect(result.recoveryCodes).not.toContain(stored)
      expect(stored).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('refuses to re-enrol over a working factor', async () => {
    const again = await beginMfaEnrolment(userId, { issuer: 'Superwork', account: EMAIL })
    expect('error' in again).toBe(true)
    expect((await mfaStatus(userId)).enabled).toBe(true)
  })

  it('will not accept the same code twice, inside its own window', async () => {
    const once = code(secret, 10)
    expect((await verifyFactor(userId, once, { now: at(10) })).ok).toBe(true)
    // Thirty seconds is thirty seconds in which a shoulder-surfer can reuse it.
    expect((await verifyFactor(userId, once, { now: at(10) })).ok).toBe(false)
  })

  it('cannot be enabled without a confirmed secret, whatever writes the row', async () => {
    await expect(
      adminSql()`UPDATE users SET mfa_enabled = true, mfa_secret = NULL WHERE id = ${userId}`,
    ).rejects.toThrow(/users_mfa_needs_confirmed_secret/)
  })
})

describe('signing in', () => {
  let secret = ''

  beforeAll(async () => {
    const [row] = await adminSql()<{ secret: string }[]>`
      SELECT mfa_secret AS secret FROM users WHERE id = ${userId}`
    secret = row!.secret
  })

  it('issues a session that resolves to nothing until the code is given', async () => {
    const result = await login(EMAIL, PASSWORD)
    expect(result?.mfaRequired).toBe(true)

    // The token is real and revocable, and reaches no screen, no API and no actor.
    expect(await resolveSession(result!.token)).toBeNull()
    // The one read that can see it can see only whose code to ask for.
    const pending = await resolvePendingSession(result!.token)
    expect(pending?.userId).toBe(userId)
    expect(pending?.email).toBe(EMAIL)

    const completed = await completeMfaLogin(result!.token, code(secret, 20), { now: at(20) })
    expect(completed.ok).toBe(true)

    const identity = await resolveSession(result!.token)
    expect(identity?.userId).toBe(userId)
    // A sign-in is still not a step-up. Different proofs about different moments.
    expect(identity?.steppedUpAt).toBeNull()
  })

  it('locks the browser out after five wrong codes, not the account', async () => {
    const attacker = await login(EMAIL, PASSWORD)
    for (let attempt = 1; attempt <= STEP_UP_MAX_FAILURES; attempt++) {
      const outcome = await completeMfaLogin(attacker!.token, '000000')
      expect(outcome.ok).toBe(false)
    }
    const locked = await completeMfaLogin(attacker!.token, '000000')
    expect(locked.ok).toBe(false)
    expect('lockedUntil' in locked && locked.lockedUntil).toBeTruthy()

    // The real person opens a new window and is unaffected: the counter is the session's.
    const theirs = await login(EMAIL, PASSWORD)
    expect((await completeMfaLogin(theirs!.token, code(secret, 30), { now: at(30) })).ok).toBe(true)
  })

  it('accepts a recovery code, once', async () => {
    const fresh = await regenerateRecoveryCodes(userId, code(secret, 40), { now: at(40) })
    expect(fresh.ok).toBe(true)
    const [recovery] = fresh.recoveryCodes!

    const session = await login(EMAIL, PASSWORD)
    const used = await completeMfaLogin(session!.token, recovery!)
    expect(used.ok).toBe(true)
    expect('usedRecoveryCode' in used && used.usedRecoveryCode).toBe(true)

    const second = await login(EMAIL, PASSWORD)
    expect((await completeMfaLogin(second!.token, recovery!)).ok).toBe(false)
    expect((await mfaStatus(userId)).recoveryCodesLeft).toBe(fresh.recoveryCodes!.length - 1)
  })
})

describe('step-up asks for the stronger proof', () => {
  it('refuses the password once a factor exists, and accepts a code', async () => {
    const [row] = await adminSql()<{ secret: string }[]>`
      SELECT mfa_secret AS secret FROM users WHERE id = ${userId}`
    const session = await login(EMAIL, PASSWORD)
    await completeMfaLogin(session!.token, code(row!.secret, 50), { now: at(50) })

    // The password would otherwise mean the factor guarded signing in and not the irreversible
    // actions, which is the wrong way round.
    const withPassword = await stepUp(session!.token, PASSWORD)
    expect(withPassword.ok).toBe(false)

    const withCode = await stepUp(session!.token, code(row!.secret, 60), { now: at(60) })
    expect(withCode.ok).toBe(true)
  })
})

describe('turning it off', () => {
  it('needs the factor, not just a session', async () => {
    const refused = await disableMfa(userId, {})
    expect(refused.ok).toBe(false)
    expect((await mfaStatus(userId)).enabled).toBe(true)

    const wrong = await disableMfa(userId, { code: '000000' })
    expect(wrong.ok).toBe(false)
    expect((await mfaStatus(userId)).enabled).toBe(true)
  })

  it('takes the secret and the recovery codes with it', async () => {
    const [row] = await adminSql()<{ secret: string }[]>`
      SELECT mfa_secret AS secret FROM users WHERE id = ${userId}`
    const off = await disableMfa(userId, { code: code(row!.secret, 70), now: at(70) })
    expect(off.ok).toBe(true)

    const status = await mfaStatus(userId)
    expect(status.enabled).toBe(false)
    expect(status.pending).toBe(false)
    expect(status.recoveryCodesLeft).toBe(0)

    const [after] = await adminSql()<{ secret: string | null; confirmed: Date | null }[]>`
      SELECT mfa_secret AS secret, mfa_confirmed_at AS confirmed FROM users WHERE id = ${userId}`
    expect(after!.secret).toBeNull()
    expect(after!.confirmed).toBeNull()

    // And signing in stops asking.
    const plain = await login(EMAIL, PASSWORD)
    expect(plain?.mfaRequired).toBe(false)
    expect((await resolveSession(plain!.token))?.userId).toBe(userId)
  })
})
