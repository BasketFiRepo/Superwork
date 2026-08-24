import { randomUUID } from 'node:crypto'
import type { EmailProvider, InboundMessage, MockBehaviour, OutboundEmail, ProviderHealth, SendReceipt } from '../contracts.js'

/**
 * Mock providers are first class (§13.2).
 *
 * This one is backed by seeded database data and supports injected latency, failures,
 * rate limiting and token expiry — which is how the failure taxonomy in §5.6 gets tested
 * honestly rather than assumed. CI runs the whole product against providers like this,
 * and demo mode uses them, so nothing here needs a credential.
 */
export class MockEmailProvider implements EmailProvider {
  readonly name = 'mock-email'
  readonly mode = 'mock' as const
  readonly capabilities = { send: true, recall: true, sync: true, threading: true, attachments: false }

  private readonly sent = new Map<string, { email: OutboundEmail; sentAt: Date; dispatched: boolean }>()
  private readonly byIdempotencyKey = new Map<string, string>()

  constructor(private readonly behaviour: MockBehaviour = {}) {}

  async healthCheck(): Promise<ProviderHealth> {
    return {
      ok: !this.behaviour.tokenExpired,
      lastSuccessfulSyncAt: new Date(),
      errorRate: this.behaviour.failureRate ?? 0,
      tokenExpiresAt: this.behaviour.tokenExpired ? new Date(Date.now() - 1000) : null,
      message: this.behaviour.tokenExpired
        ? 'The connection expired. Reconnect to resume syncing.'
        : 'Simulated provider — nothing leaves this machine.',
    }
  }

  async send(email: OutboundEmail): Promise<SendReceipt> {
    await this.simulate()

    // Effectively-once: the same idempotency key returns the original receipt.
    const existing = this.byIdempotencyKey.get(email.idempotencyKey)
    if (existing) {
      const record = this.sent.get(existing)!
      return { providerMessageId: existing, sentAt: record.sentAt, queued: !record.dispatched }
    }

    const providerMessageId = `mock-${randomUUID()}`
    this.sent.set(providerMessageId, { email, sentAt: new Date(), dispatched: false })
    this.byIdempotencyKey.set(email.idempotencyKey, providerMessageId)
    return { providerMessageId, sentAt: new Date(), queued: true }
  }

  async recall(providerMessageId: string): Promise<boolean> {
    const record = this.sent.get(providerMessageId)
    if (!record || record.dispatched) return false
    this.sent.delete(providerMessageId)
    return true
  }

  /**
   * Inbound mail waiting to be collected (ADR 0084).
   *
   * This used to return an empty list, with a comment explaining that the demo's inbound mail
   * was seeded straight into `messages` — which is exactly why nothing ever called `sync`. A
   * mock that cannot produce an inbound message makes its own consumer untestable, so the
   * consumer was never written and nine columns on `email_accounts` stayed empty for a year.
   *
   * A mock provider is first class (§13.2). This one holds a queue, hands it over once, and
   * advances the cursor — the same shape a real provider has, with nothing leaving the machine.
   */
  private readonly inbound: InboundMessage[] = []

  /** Test and demo hook: what the provider will hand over on the next sync. */
  deliver(...messages: InboundMessage[]): void {
    this.inbound.push(...messages)
  }

  async sync(cursor: string | null): Promise<{ messages: InboundMessage[]; cursor: string | null }> {
    await this.simulate()
    // Taken rather than copied: a message collected twice from the same provider would be the
    // provider's bug, and the consumer has its own dedupe for the case where it is not.
    const messages = this.inbound.splice(0, this.inbound.length)
    return {
      messages,
      // Monotonic, so a cursor that goes backwards is visibly the caller's doing.
      cursor: messages.length > 0 ? messages[messages.length - 1]!.externalId : (cursor ?? 'mock-cursor-0'),
    }
  }

  /** Test hook: what would have gone out. */
  outbox(): { providerMessageId: string; email: OutboundEmail }[] {
    return [...this.sent.entries()].map(([providerMessageId, record]) => ({ providerMessageId, email: record.email }))
  }

  private async simulate(): Promise<void> {
    if (this.behaviour.tokenExpired) {
      const error = new Error('The Gmail connection expired 2 days ago.')
      error.name = 'AuthError'
      throw error
    }
    if (this.behaviour.rateLimited) {
      const error = new Error('Rate limited by the provider. Retry after backoff.')
      error.name = 'TransientError'
      throw error
    }
    if (this.behaviour.latencyMs) await new Promise((r) => setTimeout(r, this.behaviour.latencyMs))
    if (this.behaviour.failureRate && Math.random() < this.behaviour.failureRate) {
      const error = new Error('The provider returned 503.')
      error.name = 'TransientError'
      throw error
    }
  }
}
