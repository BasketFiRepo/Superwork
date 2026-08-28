import type { RuntimeMode } from './env.js'

/**
 * Which capability each mode variable governs, and which of them can actually be anything
 * other than `mock` (§2.3, §13.1 — ADR 0088).
 *
 * Six mode variables have existed since Phase 0 and **four of them switched nothing.**
 * `emailProvider()`, `storageProvider()` and — added a day ago, by the same hand writing this —
 * `billingProvider()` returned the mock unconditionally, while `emailMode()` and `billingMode()`
 * read the variable *only to print it on the integrations screen*. So a deployment could set
 * `EMAIL_MODE=live`, read "live" back off its own screen, and be running on a provider that files
 * every message into memory and sends nothing.
 *
 * That is the failure this codebase keeps finding, one layer further out than usual: not a column
 * nothing writes, but a **setting nothing reads** — and worse than the flag version (ADR 0022),
 * because the flag screen said "declared but inert" and this one said "live".
 *
 * `CALENDAR_MODE` is the sharpest of the four: there is no calendar resolver, no calendar mock and
 * no consumer anywhere. The variable governs a capability that does not exist in code at all.
 *
 * So the fact lives here, once, and two things read it: the environment refuses to start when a
 * mode asks for an implementation that is not there, and the integrations screen reports what was
 * *resolved* rather than what was asked for. A test asserts this list against the resolvers
 * themselves, because a hand-kept list is the second place a fact lives and the two drift.
 */
export type Capability = 'ai' | 'email' | 'calendar' | 'storage' | 'chat' | 'finance' | 'crm' | 'identity' | 'http' | 'billing'

/** The variable that governs each capability. A capability absent here has no switch at all. */
export const CAPABILITY_MODE_VARS = {
  ai: 'AI_MODE',
  email: 'EMAIL_MODE',
  calendar: 'CALENDAR_MODE',
  storage: 'STORAGE_MODE',
  billing: 'BILLING_MODE',
  http: 'HTTP_TOOLS_MODE',
} as const satisfies Partial<Record<Capability, string>>

/**
 * The capabilities something other than a mock can be resolved for. Two, today.
 *
 * `chat`, `finance`, `crm` and `identity` are deliberately not here *and* have no variable: a
 * capability with no switch cannot lie about which implementation is in force, which is why those
 * four were never part of this bug.
 */
export const LIVE_IMPLEMENTED: readonly Capability[] = ['ai', 'http']

/** Whether a mode can be honoured, or is a promise the process cannot keep. */
export function canResolve(capability: Capability, mode: RuntimeMode): boolean {
  return mode === 'mock' || LIVE_IMPLEMENTED.includes(capability)
}

/**
 * Said in the words of somebody who has just been refused a boot. It names the capability, the
 * variable, and the only two things that fix it — because "unsupported mode" sends people to the
 * source to work out which half is missing.
 */
export function unresolvableModeMessage(capability: Capability, variable: string, mode: RuntimeMode): string {
  return (
    `${variable}=${mode} asks for a ${mode} ${capability} implementation and there is none to resolve to. ` +
    `Superwork would have run on the simulated one and reported itself connected, which is worse than ` +
    `not starting. Run with ${variable}=mock, or build the ${capability} provider first.`
  )
}
