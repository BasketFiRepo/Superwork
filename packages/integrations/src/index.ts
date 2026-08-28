import { env, CAPABILITY_MODE_VARS, LIVE_IMPLEMENTED, type Capability as ConfiguredCapability } from '@superwork/config'
import type {
  BillingProvider,
  ChatProvider,
  CrmProvider,
  EmailProvider,
  FinanceProvider,
  IdentityProvider,
  RuntimeMode,
  StorageProvider,
} from './contracts.js'
import { MockBillingProvider } from './mock/billing.js'
import { MockEmailProvider } from './mock/email.js'
import { MockStorageProvider } from './mock/storage.js'
import { FetchHttpTransport, MockHttpTransport, type HttpTransport } from './http.js'
import {
  MockChatProvider,
  MockCrmProvider,
  MockFinanceProvider,
  MockIdentityProvider,
} from './mock/workplace.js'

export * from './contracts.js'
export * from './http.js'
export { MockBillingProvider } from './mock/billing.js'
export { MockEmailProvider } from './mock/email.js'
export { MockStorageProvider, storageKeyFor } from './mock/storage.js'
export {
  MockChatProvider,
  MockCrmProvider,
  MockFinanceProvider,
  MockIdentityProvider,
} from './mock/workplace.js'

/**
 * Provider resolution (§2.3, §13.1). Every capability has a runtime mode, and the resolved
 * mode is surfaced in the UI wherever it affects what the user should believe.
 *
 * Capabilities are addressed by what they do — `chat`, `finance` — never by vendor. A
 * feature asks for the capability and degrades when it is absent; it never asks whether
 * Slack is connected.
 */

export type Capability =
  | 'email' | 'calendar' | 'storage' | 'chat' | 'finance' | 'crm' | 'identity' | 'http' | 'billing'

const overrides: Partial<Record<Capability, unknown>> = {}

/**
 * What a capability is set to, or `mock` where it has no switch at all (ADR 0088).
 *
 * A capability with no variable cannot be asked for something it has not got, which is why
 * `chat`, `finance`, `crm` and `identity` were never part of the bug this function exists to end.
 */
export function capabilityMode(capability: Capability): RuntimeMode {
  const variable = (CAPABILITY_MODE_VARS as Partial<Record<Capability, string>>)[capability]
  if (!variable) return 'mock'
  return env()[variable as 'EMAIL_MODE']
}

/**
 * The provider in force.
 *
 * This used to be `overrides[capability] ?? mock()`, with the mode read nowhere — so four
 * settings switched nothing and the screen reported them anyway. The mode chooses now, and a
 * capability whose mode cannot be honoured never reaches here: the environment refuses to start.
 * That refusal is what lets this fall back to the mock without lying — by the time anything is
 * resolved, `mock` is the only thing the mode can say.
 *
 * The override still wins over both. It is how tests and the sandbox substitute an
 * implementation, and it is deliberately not reachable from configuration.
 */
function resolve<T>(capability: Capability, mock: () => T, live?: () => T): T {
  const injected = overrides[capability] as T | undefined
  if (injected) return injected
  return live && capabilityMode(capability) !== 'mock' ? live() : mock()
}

export function emailProvider(): EmailProvider {
  return resolve('email', () => new MockEmailProvider())
}

export function storageProvider(): StorageProvider {
  return resolve('storage', () => new MockStorageProvider())
}

/**
 * The billing system, which is not this one (ADR 0086). `BILLING_MODE` has been in the
 * environment schema since Phase 0 and was read by nothing; it chooses here. Anything but `mock`
 * needs an implementation a deployment supplies, so the default resolves to the simulated one and
 * every figure it returns is badged as such.
 */
export function billingProvider(): BillingProvider {
  return resolve('billing', () => new MockBillingProvider())
}

export function billingMode(): RuntimeMode {
  return billingProvider().mode
}

export function chatProvider(): ChatProvider {
  return resolve('chat', () => new MockChatProvider())
}

export function financeProvider(): FinanceProvider {
  return resolve('finance', () => new MockFinanceProvider())
}

export function crmProvider(): CrmProvider {
  return resolve('crm', () => new MockCrmProvider())
}

export function identityProvider(): IdentityProvider {
  return resolve('identity', () => new MockIdentityProvider())
}

/**
 * The transport admin-authored tools call through (§22). Mock unless a deployment has
 * deliberately turned outbound HTTP on, so the product runs credential-free by default.
 */
export function httpTransport(): HttpTransport {
  return resolve<HttpTransport>('http', () => new MockHttpTransport(), () => new FetchHttpTransport())
}

/** Tests and the sandbox swap implementations; nothing else does. */
export function setProvider(capability: Capability, provider: unknown | null): void {
  if (provider === null) delete overrides[capability]
  else overrides[capability] = provider
}

export function setEmailProvider(provider: EmailProvider | null): void {
  setProvider('email', provider)
}

/**
 * What the email capability actually resolved to — not what was asked for. The screen that badges
 * a mailbox "simulated" reads this, and it used to read the variable instead (ADR 0088).
 */
export function emailMode(): RuntimeMode {
  return emailProvider().mode
}

export interface CapabilityDescriptor {
  capability: Capability
  label: string
  /** What stops working without it — stated as degradation, never as a broken app. */
  degradesTo: string
  mode: RuntimeMode
  vendorHint: string
}

/**
 * What the organization could connect, and what it loses by not connecting it. This backs
 * the integrations screen, so there is no button for a capability the product does not
 * actually use.
 *
 * **`mode` is what resolved, never what was asked for** (ADR 0088). It used to be read straight
 * off the environment for email, calendar and storage, while the resolvers returned the mock
 * whatever the variable said — so this screen was the place a deployment went to be told it had a
 * live mailbox it did not have. It is read from the provider in force now, which also means an
 * implementation injected by a test or the sandbox reports itself honestly here.
 *
 * `calendar` has no resolver at all — no mock, no consumer, only a contract — so it reports the
 * one thing that is true of it and says so in the open.
 */
export function capabilityCatalogue(): CapabilityDescriptor[] {
  return [
    {
      capability: 'email',
      label: 'Email',
      degradesTo: 'Replies are drafted and saved to Approvals instead of being sent.',
      mode: emailProvider().mode,
      vendorHint: 'Microsoft 365 · Google Workspace',
    },
    {
      capability: 'calendar',
      label: 'Calendar',
      // The one capability with a contract and nothing behind it: no resolver, no mock, no
      // caller. `CALENDAR_MODE` exists and can only ever be `mock`, which the environment now
      // refuses to let a deployment believe otherwise about.
      degradesTo:
        'Meetings are recorded from transcripts; availability is not read. Nothing implements this ' +
        'capability yet, so there is nothing to connect.',
      mode: 'mock',
      vendorHint: 'Microsoft 365 · Google Calendar',
    },
    {
      capability: 'storage',
      label: 'Document storage',
      degradesTo: 'Documents are stored in Superwork rather than mirrored to your drive.',
      mode: storageProvider().mode,
      vendorHint: 'SharePoint · Google Drive · S3',
    },
    {
      capability: 'chat',
      label: 'Chat',
      degradesTo: 'Notifications stay in Superwork and email. Nothing is posted to a workspace.',
      mode: chatProvider().mode,
      vendorHint: 'Slack · Microsoft Teams',
    },
    {
      capability: 'finance',
      label: 'Finance',
      degradesTo: 'Invoice and balance context is missing from account summaries.',
      mode: financeProvider().mode,
      vendorHint: 'Xero · QuickBooks · NetSuite',
    },
    {
      capability: 'crm',
      label: 'External CRM',
      degradesTo: 'Accounts are maintained in Superwork rather than mirrored from a CRM.',
      mode: crmProvider().mode,
      vendorHint: 'Salesforce · HubSpot · Pipedrive',
    },
    {
      capability: 'identity',
      label: 'Identity — SSO and SCIM',
      degradesTo: 'People sign in with a password and are invited by hand.',
      mode: identityProvider().mode,
      vendorHint: 'Okta · Entra ID · Google Workspace',
    },
    {
      capability: 'billing',
      label: 'Billing',
      degradesTo: 'Plan changes are recorded and enforced here; no card is held and nothing is charged.',
      mode: billingProvider().mode,
      vendorHint: 'Stripe · Chargebee · an internal finance system',
    },
  ]
}
