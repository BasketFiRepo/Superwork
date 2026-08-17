import { createHash, timingSafeEqual } from 'node:crypto'
import { authSql } from '@superwork/db'
import {
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  otpauthUri,
  totpCounter,
  verifyTotp,
} from './totp.js'
import { verifyPassword } from './session.js'

/**
 * Enrolling, proving and removing a second factor (§4.1).
 *
 * The rules that matter are here rather than in the pure arithmetic next door:
 *
 *   **Enrolment is two steps.** Generating a secret does not turn anything on. It is turned on
 *   by proving a code from it, which is the only evidence that the person can actually read the
 *   thing they will be asked for from now on. A one-step enrolment is a lockout waiting for the
 *   first typo.
 *
 *   **Turning it off asks for the factor.** Otherwise a stolen session removes the protection
 *   and then does whatever it liked — the factor would guard everything except its own removal.
 *
 *   **Recovery codes are shown once and stored as hashes**, removed as they are used. Single use
 *   is the storage rather than a flag somebody has to remember to clear.
 */

/** Recovery codes are high-entropy and single-use, so a fast hash is the right one. */
function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex')
}

export interface MfaStatus {
  enabled: boolean
  /** A secret exists and has not been proved yet: an enrolment somebody started. */
  pending: boolean
  confirmedAt: Date | null
  recoveryCodesLeft: number
}

export async function mfaStatus(userId: string): Promise<MfaStatus> {
  const [row] = await authSql()<
    { enabled: boolean; hasSecret: boolean; confirmedAt: Date | null; left: number }[]
  >`
    SELECT mfa_enabled AS enabled, mfa_secret IS NOT NULL AS "hasSecret",
           mfa_confirmed_at AS "confirmedAt", cardinality(mfa_recovery_hashes) AS left
    FROM users WHERE id = ${userId} AND deleted_at IS NULL`
  return {
    enabled: row?.enabled ?? false,
    pending: (row?.hasSecret ?? false) && !(row?.enabled ?? false),
    confirmedAt: row?.confirmedAt ?? null,
    recoveryCodesLeft: Number(row?.left ?? 0),
  }
}

export interface Enrolment {
  secret: string
  /** For an authenticator app. Shown for copying; a QR code is a picture of this string. */
  uri: string
}

/**
 * Starts an enrolment, replacing any unproved one.
 *
 * Deliberately refuses when a factor is already on: changing the secret out from under a
 * working factor is how somebody ends up holding a phone that no longer opens their account.
 * Turn it off first, which asks for the factor.
 */
export async function beginMfaEnrolment(
  userId: string,
  input: { issuer: string; account: string },
): Promise<Enrolment | { error: string }> {
  const status = await mfaStatus(userId)
  if (status.enabled) {
    return { error: 'Two-factor sign-in is already on. Turn it off first if you are moving to a new phone.' }
  }
  const secret = generateTotpSecret()
  await authSql()`
    UPDATE users SET mfa_secret = ${secret}, mfa_confirmed_at = NULL, mfa_last_counter = NULL,
                     updated_at = now()
    WHERE id = ${userId} AND deleted_at IS NULL`
  return { secret, uri: otpauthUri(secret, input) }
}

export interface ConfirmResult {
  ok: boolean
  reason?: string
  /** Shown once, at enrolment. Superwork cannot show them again. */
  recoveryCodes?: string[]
}

/** Turns it on, and only a proved code does that. */
export async function confirmMfaEnrolment(
  userId: string,
  code: string,
  options: { now?: Date } = {},
): Promise<ConfirmResult> {
  const sql = authSql()
  const [row] = await sql<{ secret: string | null; enabled: boolean }[]>`
    SELECT mfa_secret AS secret, mfa_enabled AS enabled FROM users
    WHERE id = ${userId} AND deleted_at IS NULL`
  if (!row?.secret) return { ok: false, reason: 'Start again — there is no enrolment in progress.' }
  if (row.enabled) return { ok: false, reason: 'Two-factor sign-in is already on.' }

  const check = verifyTotp(row.secret, code, options.now ? { now: options.now } : {})
  if (!check.ok) {
    return { ok: false, reason: 'That code is not right. Check the clock on your phone and try the next one.' }
  }

  const codes = generateRecoveryCodes()
  await sql`
    UPDATE users
    SET mfa_enabled = true, mfa_confirmed_at = now(), mfa_last_counter = ${check.counter},
        mfa_recovery_hashes = ${codes.map(hashRecoveryCode)}, updated_at = now()
    WHERE id = ${userId} AND deleted_at IS NULL`
  return { ok: true, recoveryCodes: codes }
}

/** Abandons an enrolment nobody proved. Never touches a factor that is on. */
export async function cancelMfaEnrolment(userId: string): Promise<void> {
  await authSql()`
    UPDATE users SET mfa_secret = NULL, mfa_confirmed_at = NULL, mfa_last_counter = NULL, updated_at = now()
    WHERE id = ${userId} AND deleted_at IS NULL AND mfa_enabled = false`
}

export interface FactorCheck {
  ok: boolean
  /** True when a recovery code was spent rather than a generated one. */
  usedRecoveryCode?: boolean
  reason?: string
}

/**
 * Checks a code — from the app or from the recovery list — and burns it.
 *
 * `now` is a seam, the same one the nudge ladder takes: a used code cannot be reused inside its
 * own thirty-second window, which is correct and makes consecutive codes impossible to exercise
 * in less than thirty seconds of real time. A test that names the moment it means is testing the
 * real replay guard rather than waiting for a clock (ADR 0039 made the same point about
 * reminders).
 *
 * The replay guard and the single-use list are both advanced here, in one place, because every
 * caller that accepts a factor has to do both and one that forgot would be the hole.
 */
export async function verifyFactor(
  userId: string,
  code: string,
  options: { now?: Date } = {},
): Promise<FactorCheck> {
  const sql = authSql()
  const [row] = await sql<
    { secret: string | null; enabled: boolean; last: string | null; hashes: string[] }[]
  >`
    SELECT mfa_secret AS secret, mfa_enabled AS enabled, mfa_last_counter::text AS last,
           mfa_recovery_hashes AS hashes
    FROM users WHERE id = ${userId} AND deleted_at IS NULL`
  if (!row?.enabled || !row.secret) return { ok: false, reason: 'Two-factor sign-in is not on for this account.' }

  const check = verifyTotp(row.secret, code, {
    ...(options.now ? { now: options.now } : {}),
    afterCounter: row.last === null ? null : Number(row.last),
  })
  if (check.ok) {
    await sql`
      UPDATE users SET mfa_last_counter = ${check.counter}, updated_at = now() WHERE id = ${userId}`
    return { ok: true }
  }

  // A recovery code, compared in constant time against each remaining hash and then removed.
  const candidate = hashRecoveryCode(code)
  const candidateBuffer = Buffer.from(candidate)
  const match = row.hashes.find((stored) => {
    const storedBuffer = Buffer.from(stored)
    return storedBuffer.length === candidateBuffer.length && timingSafeEqual(storedBuffer, candidateBuffer)
  })
  if (match) {
    await sql`
      UPDATE users SET mfa_recovery_hashes = array_remove(mfa_recovery_hashes, ${match}), updated_at = now()
      WHERE id = ${userId}`
    return { ok: true, usedRecoveryCode: true }
  }

  return { ok: false, reason: 'That code is not right. A recovery code works too, and each one works once.' }
}

/**
 * Turns it off, which requires the factor — or the password when the phone is gone and a
 * recovery code has been spent to prove it.
 *
 * A session alone is not enough. The whole point of the factor is that a session might not be
 * the person, and removal is the one action that would make every other action free.
 */
export async function disableMfa(
  userId: string,
  proof: { code?: string; password?: string; now?: Date },
): Promise<{ ok: boolean; reason?: string }> {
  const sql = authSql()
  const status = await mfaStatus(userId)
  if (!status.enabled) return { ok: true }

  if (proof.code) {
    const check = await verifyFactor(userId, proof.code, proof.now ? { now: proof.now } : {})
    if (!check.ok) return { ok: false, reason: check.reason ?? 'That code is not right.' }
  } else if (proof.password) {
    const [row] = await sql<{ hash: string | null }[]>`
      SELECT password_hash AS hash FROM users WHERE id = ${userId} AND deleted_at IS NULL`
    if (!row?.hash || !(await verifyPassword(proof.password, row.hash))) {
      return { ok: false, reason: 'That password is not right.' }
    }
  } else {
    return { ok: false, reason: 'Turning off two-factor sign-in needs a code from your app, or your password.' }
  }

  await sql`
    UPDATE users
    SET mfa_enabled = false, mfa_secret = NULL, mfa_confirmed_at = NULL, mfa_last_counter = NULL,
        mfa_recovery_hashes = '{}', updated_at = now()
    WHERE id = ${userId} AND deleted_at IS NULL`
  return { ok: true }
}

/** Fresh codes, replacing whatever is left. Needs the factor, like every other change to it. */
export async function regenerateRecoveryCodes(
  userId: string,
  code: string,
  options: { now?: Date } = {},
): Promise<{ ok: boolean; reason?: string; recoveryCodes?: string[] }> {
  const check = await verifyFactor(userId, code, options)
  if (!check.ok) return { ok: false, reason: check.reason ?? 'That code is not right.' }
  const codes = generateRecoveryCodes()
  await authSql()`
    UPDATE users SET mfa_recovery_hashes = ${codes.map(hashRecoveryCode)}, updated_at = now()
    WHERE id = ${userId} AND deleted_at IS NULL`
  return { ok: true, recoveryCodes: codes }
}

/** The step a code would belong to right now — used by tests and the acceptance loops. */
export { totpCounter }
