/**
 * Provider interfaces (§13.1).
 *
 * Interfaces are capability-shaped, not vendor-shaped. The application programs against
 * these; a missing integration degrades a feature, it never breaks the app.
 */

export type RuntimeMode = 'mock' | 'sandbox' | 'live'

export interface ProviderHealth {
  ok: boolean
  lastSuccessfulSyncAt: Date | null
  errorRate: number
  tokenExpiresAt: Date | null
  message: string
}

export interface Provider {
  readonly name: string
  readonly mode: RuntimeMode
  /** What this provider can actually do — features check this, never the vendor name. */
  readonly capabilities: Record<string, boolean>
  healthCheck(): Promise<ProviderHealth>
}

// ---------------------------------------------------------------------------

export interface OutboundEmail {
  to: string[]
  cc?: string[]
  subject: string
  body: string
  /** Threading: replying keeps the conversation intact on the provider side. */
  inReplyToExternalId?: string | null
  /** Idempotency: the same key must never produce two sends. */
  idempotencyKey: string
}

export interface SendReceipt {
  providerMessageId: string
  sentAt: Date
  /** Set when the provider accepted the message but has not dispatched it yet. */
  queued: boolean
}

export interface EmailProvider extends Provider {
  send(email: OutboundEmail): Promise<SendReceipt>
  /** Recall inside the send-delay window (§5.7). Returns false once dispatched. */
  recall(providerMessageId: string): Promise<boolean>
  sync(cursor: string | null): Promise<{ messages: InboundMessage[]; cursor: string | null }>
}

export interface InboundMessage {
  externalId: string
  threadExternalId: string
  from: { name: string | null; address: string }
  to: string[]
  subject: string
  body: string
  sentAt: Date
}

// ---------------------------------------------------------------------------

export interface CalendarProvider extends Provider {
  availability(userIds: string[], from: Date, to: Date): Promise<{ userId: string; busy: { from: Date; to: Date }[] }[]>
  createEvent(input: {
    title: string
    from: Date
    to: Date
    attendees: string[]
    description?: string
    idempotencyKey: string
  }): Promise<{ externalId: string }>
}

export interface StorageProvider extends Provider {
  put(key: string, body: Buffer, contentType: string): Promise<{ key: string; bytes: number }>
  get(key: string): Promise<Buffer>
  remove(key: string): Promise<void>
}

/*
 * `signedUrl(key, expiresInSeconds)` was declared here and is gone (ADR 0085).
 *
 * A signed URL grants access to whoever holds it. That is a capability this product's permission
 * model deliberately does not have: a link that works on possession can be forwarded, logged by a
 * proxy, or sit in a browser history after the person's clearance changed. Files are streamed
 * through a route that asks `can()` on every request instead, which is the same question the
 * document itself is behind.
 *
 * It was never implemented, so nothing is lost by saying so. A real provider that needs to offload
 * bytes can add it back — behind a permission check, with an expiry measured in seconds.
 */

export interface ChatProvider extends Provider {
  /** Identity mapping is resolved by SSO subject or verified email, never display name. */
  resolveUser(email: string): Promise<{ chatUserId: string } | null>
  postDirectMessage(chatUserId: string, text: string, actions?: { id: string; label: string }[]): Promise<{ ts: string }>
  postToChannel(channelId: string, text: string): Promise<{ ts: string }>
}

// ---------------------------------------------------------------------------

/** Injectable behaviours so §5.6 failure handling is tested honestly, not assumed. */
export interface MockBehaviour {
  latencyMs?: number
  failureRate?: number
  rateLimited?: boolean
  tokenExpired?: boolean
}

// ---------------------------------------------------------------------------
// Phase 3 capabilities (§13.1, §22)
// ---------------------------------------------------------------------------

export interface FinanceInvoice {
  externalId: string
  reference: string
  /** The counterparty as the finance system knows it — matched to a company by domain. */
  accountName: string
  amountCents: number
  currency: string
  issuedAt: Date
  dueAt: Date
  paidAt: Date | null
  status: 'draft' | 'open' | 'paid' | 'overdue' | 'disputed'
}

export interface FinanceProvider extends Provider {
  /** Read-only in v1: Superwork never writes to the ledger of record. */
  invoices(input: { accountName?: string; since?: Date; limit?: number }): Promise<FinanceInvoice[]>
  balance(accountName: string): Promise<{ outstandingCents: number; overdueCents: number; currency: string }>
}

export interface CrmAccount {
  externalId: string
  name: string
  domains: string[]
  owner: string | null
  stage: string | null
  updatedAt: Date
}

export interface CrmProvider extends Provider {
  accounts(cursor: string | null): Promise<{ accounts: CrmAccount[]; cursor: string | null }>
  /** What a sync *would* change, so an admin approves an import rather than discovering it. */
  previewImport(accounts: CrmAccount[]): Promise<{ create: string[]; update: string[]; conflict: string[] }>
}

export interface DirectoryUser {
  externalId: string
  email: string
  displayName: string
  department: string | null
  active: boolean
}

export interface IdentityProvider extends Provider {
  /** SCIM-shaped: the directory is the source of truth, Superwork mirrors it. */
  users(cursor: string | null): Promise<{ users: DirectoryUser[]; cursor: string | null }>
  /** Verifies an assertion without trusting anything the browser supplied. */
  verifyAssertion(assertion: string): Promise<{ email: string; externalId: string } | null>
}

// ---------------------------------------------------------------------------
// What the company pays for (§19, ADR 0086)
// ---------------------------------------------------------------------------

/**
 * The billing system, which is not this one.
 *
 * Superwork holds no card and takes no payment. What it holds is the *consequence* of a payment —
 * a tier, a seat count, a period and a status — and those had no writer at all, so an organization
 * was on whatever plan the seed said for ever.
 *
 * Three questions, and they are exactly the three a billing system owns and this product cannot
 * answer on its own: what would this cost, did it go through, and did the period renew. Everything
 * around them — who may ask, the seat arithmetic, what stops working, the audit record — is
 * Superwork's and is real whichever implementation answers.
 *
 * `BILLING_MODE` has been in the environment schema since Phase 0 and was read by nothing. It
 * chooses between these implementations now.
 */
export interface PlanQuote {
  tier: string
  seats: number
  /** What the period would cost, in the organization's own currency. */
  amountCents: number
  currency: string
  /** How long the period the quote buys is, so the renewal date is the provider's and not ours. */
  periodDays: number
  /** One line a person can read, shown beside the figure rather than instead of it. */
  description: string
}

export interface PlanCommitted {
  /** What the billing system called this. Recorded, shown, and never parsed. */
  reference: string
  periodStart: Date
  periodEnd: Date
  /** `trialing` is a provider's answer, not a state Superwork puts an organization into. */
  status: 'active' | 'trialing'
}

export interface PlanRenewal {
  paid: boolean
  reference: string | null
  periodStart: Date
  periodEnd: Date
  /** Present only when `paid` is false, and shown to the organization as-is. */
  declineReason?: string
}

export interface BillingProvider extends Provider {
  quote(input: { tier: string; seats: number; currency: string }): Promise<PlanQuote>
  /**
   * Takes the money, or says it could not. `idempotencyKey` is the same promise it is on an
   * email: the same key must never be charged twice.
   */
  commit(input: {
    tier: string
    seats: number
    currency: string
    idempotencyKey: string
  }): Promise<PlanCommitted>
  /** Asked once a period has ended, per subscription. Never asked for a plan that costs nothing. */
  renew(input: {
    tier: string
    seats: number
    currency: string
    reference: string | null
    idempotencyKey: string
  }): Promise<PlanRenewal>
}
