import { env } from '@superwork/config'
import type {
  ChatProvider,
  CrmProvider,
  EmailProvider,
  FinanceProvider,
  IdentityProvider,
  RuntimeMode,
} from './contracts.js'
import { MockEmailProvider } from './mock/email.js'
import { FetchHttpTransport, MockHttpTransport, type HttpTransport } from './http.js'
import {
  MockChatProvider,
  MockCrmProvider,
  MockFinanceProvider,
  MockIdentityProvider,
} from './mock/workplace.js'

export * from './contracts.js'
export * from './http.js'
export { MockEmailProvider } from './mock/email.js'
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

export type Capability = 'email' | 'calendar' | 'storage' | 'chat' | 'finance' | 'crm' | 'identity' | 'http'

const overrides: Partial<Record<Capability, unknown>> = {}

function resolve<T>(capability: Capability, fallback: () => T): T {
  return (overrides[capability] as T | undefined) ?? fallback()
}

export function emailProvider(): EmailProvider {
  return resolve('email', () => new MockEmailProvider())
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
  return resolve('http', () => (env().HTTP_TOOLS_MODE === 'live' ? new FetchHttpTransport() : new MockHttpTransport()))
}

/** Tests and the sandbox swap implementations; nothing else does. */
export function setProvider(capability: Capability, provider: unknown | null): void {
  if (provider === null) delete overrides[capability]
  else overrides[capability] = provider
}

export function setEmailProvider(provider: EmailProvider | null): void {
  setProvider('email', provider)
}

export function emailMode(): RuntimeMode {
  return env().EMAIL_MODE
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
 */
export function capabilityCatalogue(): CapabilityDescriptor[] {
  const config = env()
  return [
    {
      capability: 'email',
      label: 'Email',
      degradesTo: 'Replies are drafted and saved to Approvals instead of being sent.',
      mode: config.EMAIL_MODE,
      vendorHint: 'Microsoft 365 · Google Workspace',
    },
    {
      capability: 'calendar',
      label: 'Calendar',
      degradesTo: 'Meetings are recorded from transcripts; availability is not read.',
      mode: config.CALENDAR_MODE,
      vendorHint: 'Microsoft 365 · Google Calendar',
    },
    {
      capability: 'storage',
      label: 'Document storage',
      degradesTo: 'Documents are stored in Superwork rather than mirrored to your drive.',
      mode: config.STORAGE_MODE,
      vendorHint: 'SharePoint · Google Drive · S3',
    },
    {
      capability: 'chat',
      label: 'Chat',
      degradesTo: 'Notifications stay in Superwork and email. Nothing is posted to a workspace.',
      mode: 'mock',
      vendorHint: 'Slack · Microsoft Teams',
    },
    {
      capability: 'finance',
      label: 'Finance',
      degradesTo: 'Invoice and balance context is missing from account summaries.',
      mode: 'mock',
      vendorHint: 'Xero · QuickBooks · NetSuite',
    },
    {
      capability: 'crm',
      label: 'External CRM',
      degradesTo: 'Accounts are maintained in Superwork rather than mirrored from a CRM.',
      mode: 'mock',
      vendorHint: 'Salesforce · HubSpot · Pipedrive',
    },
    {
      capability: 'identity',
      label: 'Identity — SSO and SCIM',
      degradesTo: 'People sign in with a password and are invited by hand.',
      mode: 'mock',
      vendorHint: 'Okta · Entra ID · Google Workspace',
    },
  ]
}
