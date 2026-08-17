import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * Time-based one-time passwords (RFC 6238), §4.1.
 *
 * `users.mfa_enabled` has existed since migration 0001 and nothing has ever written to it or
 * read it: there was no second factor anywhere in the product, and step-up re-asked for the
 * same password the session was opened with — so a stolen session plus a known password
 * reached every irreversible action.
 *
 * TOTP rather than WebAuthn, for the same reason every other external dependency has a working
 * mock: the whole product runs with no credentials and no network. A TOTP secret is verified
 * offline against a standard every authenticator app already implements, which is a real second
 * factor rather than a placeholder for one. WebAuthn belongs behind an `IdentityProvider` when
 * one exists; it needs an origin-bound browser ceremony that cannot be honestly simulated.
 *
 * Everything here is pure. The lockout, the replay window and the enrolment rules live with
 * the rows they protect; this file does arithmetic.
 */

/** RFC 6238 defaults, and what every authenticator app assumes. */
export const TOTP_PERIOD_SECONDS = 30
export const TOTP_DIGITS = 6

/**
 * How far either side of now a code is accepted.
 *
 * One step — thirty seconds — covers a phone whose clock has drifted and a person who typed
 * the last two digits as the code rolled over. Wider would multiply the guessing surface by
 * the width; narrower would reject codes that are, to the person holding the phone, correct.
 */
export const TOTP_WINDOW_STEPS = 1

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(bytes: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

/** Tolerant of spacing and case, because people retype these from a screen. */
export function base32Decode(input: string): Buffer | null {
  const cleaned = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase()
  if (cleaned.length === 0) return null
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of cleaned) {
    const index = BASE32.indexOf(char)
    if (index === -1) return null
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** 160 bits, which is the SHA-1 block size RFC 4226 recommends for the shared secret. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

/** The time step a given instant falls in. This is what replay protection counts. */
export function totpCounter(now: Date = new Date()): number {
  return Math.floor(now.getTime() / 1000 / TOTP_PERIOD_SECONDS)
}

/** One code for one step. HMAC-SHA1 with dynamic truncation, exactly as RFC 4226 specifies. */
export function totpCode(secret: string, counter: number): string | null {
  const key = base32Decode(secret)
  if (!key) return null

  const message = Buffer.alloc(8)
  // The counter is 64-bit and JavaScript integers are 53, which is fine until the year
  // 285,000-something; written as two 32-bit halves rather than assuming it fits.
  message.writeUInt32BE(Math.floor(counter / 2 ** 32), 0)
  message.writeUInt32BE(counter % 2 ** 32, 4)

  const digest = createHmac('sha1', key).update(message).digest()
  const offset = digest[digest.length - 1]! & 0x0f
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

export interface TotpVerification {
  ok: boolean
  /** The step the code belonged to, for the caller to store against replay. */
  counter: number | null
}

/**
 * Checks a code against the window, refusing anything at or before `afterCounter`.
 *
 * The replay guard is the caller's to persist and this function's to enforce: a code is valid
 * for thirty seconds, which is thirty seconds in which a shoulder-surfer or a proxy can use it
 * again. Storing the step it belonged to and refusing to go backwards makes each code
 * single-use without needing a cache.
 */
export function verifyTotp(
  secret: string,
  code: string,
  options: { now?: Date; afterCounter?: number | null; window?: number } = {},
): TotpVerification {
  const cleaned = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(cleaned)) return { ok: false, counter: null }

  const centre = totpCounter(options.now ?? new Date())
  const window = options.window ?? TOTP_WINDOW_STEPS
  const floor = options.afterCounter ?? null

  for (let offset = -window; offset <= window; offset++) {
    const counter = centre + offset
    if (floor !== null && counter <= floor) continue
    const expected = totpCode(secret, counter)
    if (!expected) return { ok: false, counter: null }
    // Constant-time, so a wrong code cannot be narrowed down by how long it took to reject.
    const a = Buffer.from(expected)
    const b = Buffer.from(cleaned)
    if (a.length === b.length && timingSafeEqual(a, b)) return { ok: true, counter }
  }
  return { ok: false, counter: null }
}

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * Built here rather than rendered as a QR image: a QR code is a picture of this string, and
 * generating one needs either a dependency or a canvas. The string is shown for copying, which
 * every app accepts, and the label says so.
 */
export function otpauthUri(secret: string, input: { issuer: string; account: string }): string {
  const label = encodeURIComponent(`${input.issuer}:${input.account}`)
  const params = new URLSearchParams({
    secret,
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  })
  return `otpauth://totp/${label}?${params.toString()}`
}

/** Recovery codes: shown once, stored as hashes, removed as they are used. */
export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () =>
    randomBytes(5)
      .toString('hex')
      .toUpperCase()
      .replace(/(.{5})(.{5})/, '$1-$2'),
  )
}

export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[\s-]/g, '').toUpperCase()
}
