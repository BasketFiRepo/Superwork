import { describe, expect, it } from 'vitest'
import {
  CAPABILITY_MODE_VARS,
  LIVE_IMPLEMENTED,
  canResolve,
  envIssues,
  type Capability,
} from '@superwork/config'
import {
  billingProvider,
  capabilityCatalogue,
  capabilityMode,
  chatProvider,
  crmProvider,
  emailProvider,
  financeProvider,
  httpTransport,
  identityProvider,
  setProvider,
  storageProvider,
} from '@superwork/integrations'

/**
 * A mode that decides which provider (ADR 0088).
 *
 * Six mode variables, four of which switched nothing: `emailProvider()`, `storageProvider()` and
 * `billingProvider()` returned the mock whatever the environment said, and `emailMode()` and
 * `billingMode()` read the variable only to print it. A deployment could set `EMAIL_MODE=live`,
 * read "live" back off its own integrations screen, and send nothing.
 *
 * What this pack holds: a mode nothing can honour stops the process, the resolver obeys the mode
 * it can honour, and the screen reports what is in force rather than what was asked for.
 */

const BASE = {
  DATABASE_URL: 'postgres://superwork_app:x@127.0.0.1:5432/superwork',
  SESSION_SECRET: 'a-secret-long-enough-to-pass',
}

describe('a mode the process cannot honour', () => {
  it('stops it starting, naming the capability and the way out', () => {
    const issue = envIssues({ ...BASE, EMAIL_MODE: 'live' }).find((entry) => entry.variable === 'EMAIL_MODE')
    expect(issue?.message).toMatch(/there is none to resolve to/)
    // The two things that fix it, rather than a bare "unsupported".
    expect(issue?.message).toMatch(/EMAIL_MODE=mock/)
    expect(issue?.message).toMatch(/build the email provider/)
  })

  it('says the same of a capability that has a variable and no code at all', () => {
    // `calendar` is the sharpest of the four: a contract, no resolver, no mock, no caller.
    const issues = envIssues({ ...BASE, CALENDAR_MODE: 'sandbox' })
    expect(issues.some((entry) => entry.variable === 'CALENDAR_MODE')).toBe(true)
  })

  it('says nothing about an environment that is entirely simulated', () => {
    expect(envIssues({ ...BASE })).toEqual([])
  })

  it('is not confused by sandbox, which is no more implemented than live', () => {
    expect(canResolve('storage', 'sandbox')).toBe(false)
    expect(canResolve('billing', 'live')).toBe(false)
  })

  it('lets through the two that can be honoured, and mock everywhere', () => {
    expect(canResolve('http', 'live')).toBe(true)
    expect(canResolve('ai', 'live')).toBe(true)
    for (const capability of Object.keys(CAPABILITY_MODE_VARS) as Capability[]) {
      expect(canResolve(capability, 'mock'), `${capability} must run simulated`).toBe(true)
    }
  })

  it('still asks AI_MODE=live for a key, which is a different refusal', () => {
    // `ai` *can* be live, so it is not refused for having nowhere to go — it is refused for
    // arriving without the credential. Two different sentences, on purpose.
    const issues = envIssues({ ...BASE, AI_MODE: 'live' })
    expect(issues.find((entry) => entry.variable === 'ANTHROPIC_API_KEY')?.message).toMatch(
      /requires ANTHROPIC_API_KEY/,
    )
    expect(issues.some((entry) => entry.variable === 'AI_MODE')).toBe(false)
  })
})

describe('the list of what can be live', () => {
  /**
   * The property that stops this becoming a second place a fact lives. `LIVE_IMPLEMENTED` is
   * hand-kept in config; the resolvers are the truth. Adding a live provider without listing it
   * leaves a mode nobody can select; listing one without building it lets a deployment start on a
   * promise the process cannot keep — which is the bug this whole increment is about.
   */
  it('agrees with what the resolvers can actually produce', () => {
    // `http` is the only capability in this package with a live implementation, and `ai` — which
    // lives in @superwork/ai — is the other. Anything else claiming to be live is drift.
    expect([...LIVE_IMPLEMENTED].sort()).toEqual(['ai', 'http'])
  })

  it('gives every capability with a switch a mode, and every one without it mock', () => {
    expect(capabilityMode('email')).toBe('mock')
    // No variable governs chat, so it cannot be asked for something it has not got.
    expect(capabilityMode('chat')).toBe('mock')
  })
})

describe('what the screen reports', () => {
  it('is the provider in force, not the variable', () => {
    const rows = capabilityCatalogue()
    expect(rows.every((row) => row.mode === 'mock')).toBe(true)

    // An injected implementation reports itself — which is what makes this "in force" rather than
    // "configured", and is how a sandbox or a test shows up honestly on the screen.
    setProvider('email', { ...emailProvider(), mode: 'live' as const })
    expect(capabilityCatalogue().find((row) => row.capability === 'email')?.mode).toBe('live')
    setProvider('email', null)
    expect(capabilityCatalogue().find((row) => row.capability === 'email')?.mode).toBe('mock')
  })

  it('covers every capability the product resolves', () => {
    const rows = capabilityCatalogue().map((row) => row.capability)
    for (const capability of ['email', 'calendar', 'storage', 'chat', 'finance', 'crm', 'identity', 'billing']) {
      expect(rows, `${capability} is missing from the integrations screen`).toContain(capability)
    }
  })
})

describe('the resolvers themselves', () => {
  it('hand back a simulated implementation under the default environment', () => {
    for (const provider of [
      emailProvider(),
      storageProvider(),
      chatProvider(),
      financeProvider(),
      crmProvider(),
      identityProvider(),
      billingProvider(),
      httpTransport(),
    ]) {
      expect(provider.mode, `${provider.name} should be simulated`).toBe('mock')
    }
  })

  it('let an override win over the mode, because that is how a test substitutes one', () => {
    setProvider('billing', { ...billingProvider(), mode: 'sandbox' as const })
    expect(billingProvider().mode).toBe('sandbox')
    setProvider('billing', null)
    expect(billingProvider().mode).toBe('mock')
  })
})
