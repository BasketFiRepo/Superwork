import { createHash } from 'node:crypto'
import type {
  ChatProvider,
  CrmAccount,
  CrmProvider,
  DirectoryUser,
  FinanceInvoice,
  FinanceProvider,
  IdentityProvider,
  MockBehaviour,
  ProviderHealth,
} from '../contracts.js'

/**
 * Mock chat, finance, CRM and identity providers (§13.2).
 *
 * These exist so the Phase 3 surfaces are real without a credential: connecting, health,
 * sync previews and failure handling all work, and every screen that shows their output
 * says `Simulated`. They are deterministic — the same account name always produces the
 * same invoices — so a demo, a test and a screenshot agree with each other.
 *
 * None of them writes business records into the tenant. An import is previewed and
 * approved by a person; a mock provider silently filling the database with invented
 * invoices would be exactly the fake-integration anti-pattern (§25.11).
 */

function seedOf(value: string): number {
  return parseInt(createHash('sha256').update(value).digest('hex').slice(0, 8), 16)
}

function health(behaviour: MockBehaviour, message: string): ProviderHealth {
  return {
    ok: !behaviour.tokenExpired,
    lastSuccessfulSyncAt: behaviour.tokenExpired ? null : new Date(),
    errorRate: behaviour.failureRate ?? 0,
    tokenExpiresAt: behaviour.tokenExpired ? new Date(Date.now() - 1000) : null,
    message: behaviour.tokenExpired ? 'The connection expired. Reconnect to resume syncing.' : message,
  }
}

async function simulate(behaviour: MockBehaviour): Promise<void> {
  if (behaviour.latencyMs) await new Promise((resolve) => setTimeout(resolve, behaviour.latencyMs))
  if (behaviour.rateLimited) throw new Error('rate_limited: the provider asked us to slow down.')
  if (behaviour.failureRate && Math.random() < behaviour.failureRate) {
    throw new Error('provider_unavailable: simulated failure.')
  }
}

export class MockChatProvider implements ChatProvider {
  readonly name = 'mock-chat'
  readonly mode = 'mock' as const
  readonly capabilities = { directMessage: true, channels: true, actions: true, presence: false }

  private readonly posted: { to: string; text: string; at: Date }[] = []

  constructor(private readonly behaviour: MockBehaviour = {}) {}

  async healthCheck(): Promise<ProviderHealth> {
    return health(this.behaviour, 'Simulated workspace — messages are kept in memory and never delivered.')
  }

  /** Identity is resolved by verified email, never by display name (§13.4). */
  async resolveUser(email: string): Promise<{ chatUserId: string } | null> {
    await simulate(this.behaviour)
    if (!email.includes('@')) return null
    return { chatUserId: `U${seedOf(email).toString(36).toUpperCase().slice(0, 8)}` }
  }

  async postDirectMessage(chatUserId: string, text: string): Promise<{ ts: string }> {
    await simulate(this.behaviour)
    const at = new Date()
    this.posted.push({ to: chatUserId, text, at })
    return { ts: `${at.getTime() / 1000}` }
  }

  async postToChannel(channelId: string, text: string): Promise<{ ts: string }> {
    return this.postDirectMessage(channelId, text)
  }

  /** What a test message actually did, for the connection screen. */
  outbox(): { to: string; text: string; at: Date }[] {
    return [...this.posted]
  }
}

const INVOICE_STATUSES: FinanceInvoice['status'][] = ['paid', 'open', 'overdue', 'disputed']

export class MockFinanceProvider implements FinanceProvider {
  readonly name = 'mock-finance'
  readonly mode = 'mock' as const
  readonly capabilities = { invoices: true, balances: true, payments: false, writeback: false }

  constructor(private readonly behaviour: MockBehaviour = {}) {}

  async healthCheck(): Promise<ProviderHealth> {
    return health(this.behaviour, 'Simulated ledger — read-only, and derived from the account name.')
  }

  async invoices(input: { accountName?: string; since?: Date; limit?: number }): Promise<FinanceInvoice[]> {
    await simulate(this.behaviour)
    const account = input.accountName ?? 'Unnamed account'
    const seed = seedOf(account)
    const count = Math.min(input.limit ?? 4, 4)
    const invoices: FinanceInvoice[] = []

    for (let index = 0; index < count; index += 1) {
      const issuedAt = new Date(Date.now() - (index + 1) * 21 * 86_400_000)
      const dueAt = new Date(issuedAt.getTime() + 30 * 86_400_000)
      const status = INVOICE_STATUSES[(seed + index) % INVOICE_STATUSES.length]!
      invoices.push({
        externalId: `INV-${(seed % 90000) + 10000 + index}`,
        reference: `NW-${(seed % 90000) + 10000 + index}`,
        accountName: account,
        amountCents: 50_000 + ((seed + index * 7919) % 450_000),
        currency: 'GBP',
        issuedAt,
        dueAt,
        paidAt: status === 'paid' ? new Date(dueAt.getTime() - 3 * 86_400_000) : null,
        status,
      })
    }
    return invoices.filter((invoice) => !input.since || invoice.issuedAt >= input.since)
  }

  async balance(accountName: string): Promise<{ outstandingCents: number; overdueCents: number; currency: string }> {
    const invoices = await this.invoices({ accountName })
    const outstanding = invoices.filter((invoice) => invoice.status !== 'paid')
    return {
      outstandingCents: outstanding.reduce((sum, invoice) => sum + invoice.amountCents, 0),
      overdueCents: outstanding
        .filter((invoice) => invoice.status === 'overdue')
        .reduce((sum, invoice) => sum + invoice.amountCents, 0),
      currency: 'GBP',
    }
  }
}

export class MockCrmProvider implements CrmProvider {
  readonly name = 'mock-crm'
  readonly mode = 'mock' as const
  readonly capabilities = { accounts: true, contacts: false, opportunities: false, writeback: false }

  constructor(
    private readonly behaviour: MockBehaviour = {},
    private readonly fixtures: CrmAccount[] = DEFAULT_ACCOUNTS,
  ) {}

  async healthCheck(): Promise<ProviderHealth> {
    return health(this.behaviour, 'Simulated CRM — a small fixed account list, nothing is written back.')
  }

  async accounts(cursor: string | null): Promise<{ accounts: CrmAccount[]; cursor: string | null }> {
    await simulate(this.behaviour)
    const offset = cursor ? Number(cursor) : 0
    const page = this.fixtures.slice(offset, offset + 25)
    return { accounts: page, cursor: offset + page.length < this.fixtures.length ? String(offset + page.length) : null }
  }

  /**
   * A preview, not an import. The admin sees what would be created, updated and what
   * conflicts before anything touches their data.
   */
  async previewImport(accounts: CrmAccount[]): Promise<{ create: string[]; update: string[]; conflict: string[] }> {
    await simulate(this.behaviour)
    return {
      create: accounts.filter((account) => account.stage === 'prospect').map((account) => account.name),
      update: accounts.filter((account) => account.stage !== 'prospect' && account.owner !== null).map((a) => a.name),
      conflict: accounts.filter((account) => account.owner === null).map((account) => account.name),
    }
  }
}

const DEFAULT_ACCOUNTS: CrmAccount[] = [
  { externalId: 'CRM-1', name: 'Halden Foods', domains: ['haldenfoods.example'], owner: 'Sarah Lindqvist', stage: 'customer', updatedAt: new Date() },
  { externalId: 'CRM-2', name: 'Kestrel Pharma', domains: ['kestrelpharma.example'], owner: 'Sarah Lindqvist', stage: 'customer', updatedAt: new Date() },
  { externalId: 'CRM-3', name: 'Northbank Chilled', domains: ['northbank.example'], owner: null, stage: 'prospect', updatedAt: new Date() },
]

export class MockIdentityProvider implements IdentityProvider {
  readonly name = 'mock-identity'
  readonly mode = 'mock' as const
  readonly capabilities = { sso: true, scim: true, groups: false, justInTime: true }

  constructor(
    private readonly behaviour: MockBehaviour = {},
    private readonly directory: DirectoryUser[] = DEFAULT_DIRECTORY,
  ) {}

  async healthCheck(): Promise<ProviderHealth> {
    return health(this.behaviour, 'Simulated directory — assertions are accepted only for verified domains.')
  }

  async users(cursor: string | null): Promise<{ users: DirectoryUser[]; cursor: string | null }> {
    await simulate(this.behaviour)
    const offset = cursor ? Number(cursor) : 0
    const page = this.directory.slice(offset, offset + 50)
    return { users: page, cursor: offset + page.length < this.directory.length ? String(offset + page.length) : null }
  }

  async verifyAssertion(assertion: string): Promise<{ email: string; externalId: string } | null> {
    await simulate(this.behaviour)
    // The mock accepts `mock-sso:<email>` and nothing else. It is deliberately impossible
    // to "sign in as" somebody by editing a display name.
    const match = /^mock-sso:([^\s@]+@[^\s@]+)$/.exec(assertion.trim())
    if (!match) return null
    const email = match[1]!.toLowerCase()
    const known = this.directory.find((user) => user.email.toLowerCase() === email)
    return { email, externalId: known?.externalId ?? `EXT-${seedOf(email).toString(36).slice(0, 8)}` }
  }
}

const DEFAULT_DIRECTORY: DirectoryUser[] = [
  { externalId: 'EXT-1', email: 'maya@northwind.example', displayName: 'Maya Ellison', department: 'Executive', active: true },
  { externalId: 'EXT-2', email: 'david@northwind.example', displayName: 'David Okafor', department: 'Operations', active: true },
  { externalId: 'EXT-3', email: 'iris@northwind.example', displayName: 'Iris Bennett', department: 'Finance', active: true },
]
