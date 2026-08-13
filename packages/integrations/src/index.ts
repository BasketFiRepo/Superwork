import { env } from '@superwork/config'
import type { EmailProvider } from './contracts.js'
import { MockEmailProvider } from './mock/email.js'

export * from './contracts.js'
export { MockEmailProvider } from './mock/email.js'

let emailOverride: EmailProvider | null = null

/**
 * Provider resolution (§2.3). Every capability has a runtime mode, and the resolved mode
 * is surfaced in the UI wherever it affects what the user should believe.
 */
export function emailProvider(): EmailProvider {
  if (emailOverride) return emailOverride
  // Live implementations register here; until then a missing integration degrades the
  // feature to "drafted, not sent" rather than breaking the product.
  return new MockEmailProvider()
}

export function setEmailProvider(provider: EmailProvider | null): void {
  emailOverride = provider
}

export function emailMode(): 'mock' | 'sandbox' | 'live' {
  return env().EMAIL_MODE
}
