import { createHash } from 'node:crypto'
import type {
  BillingProvider,
  MockBehaviour,
  PlanCommitted,
  PlanQuote,
  PlanRenewal,
  ProviderHealth,
} from '../contracts.js'

/**
 * A billing system that charges nobody (§13.2, ADR 0086).
 *
 * The figures below are **not prices**. Nobody agreed them, no invoice will match them, and they
 * are here for one reason: a plan change that shows no number is a plan change nobody can review,
 * and a number the product invents quietly is worse than one it invents out loud. Every screen
 * that shows one badges it **Simulated**, the same way a mock tool call is badged.
 *
 * What is real is the arithmetic around it — per seat, per period, the same rate whichever screen
 * asks — because that is the part a real provider would replace without changing a caller.
 *
 * It always pays. A declined renewal is a state the product has to handle and cannot make itself
 * reach with a mock that never fails, so tests substitute a provider that declines rather than
 * this one growing a switch to fail on demand: a mock with a failure knob gets one more knob every
 * increment, and the knobs become the thing under test.
 */
const MONTHLY_RATE_CENTS: Record<string, number> = {
  free: 0,
  team: 1_200,
  business: 3_600,
  enterprise: 9_600,
}

const PERIOD_DAYS = 30

export class MockBillingProvider implements BillingProvider {
  readonly name = 'mock-billing'
  readonly mode = 'mock' as const
  readonly capabilities = { quote: true, commit: true, renew: true }

  constructor(private readonly behaviour: MockBehaviour = {}) {}

  async healthCheck(): Promise<ProviderHealth> {
    return {
      ok: true,
      lastSuccessfulSyncAt: new Date(),
      errorRate: this.behaviour.failureRate ?? 0,
      tokenExpiresAt: null,
      message: 'Simulated billing — nothing is charged and no card is held.',
    }
  }

  async quote(input: { tier: string; seats: number; currency: string }): Promise<PlanQuote> {
    await this.simulate()
    const rate = MONTHLY_RATE_CENTS[input.tier] ?? 0
    const amountCents = rate * input.seats
    return {
      tier: input.tier,
      seats: input.seats,
      amountCents,
      currency: input.currency,
      periodDays: PERIOD_DAYS,
      description:
        amountCents === 0
          ? 'The free plan costs nothing, so nothing would be charged.'
          : `${input.seats} × ${(rate / 100).toFixed(2)} per seat, per ${PERIOD_DAYS} days. Simulated: no payment is taken.`,
    }
  }

  async commit(input: {
    tier: string
    seats: number
    currency: string
    idempotencyKey: string
  }): Promise<PlanCommitted> {
    await this.simulate()
    const periodStart = new Date()
    return {
      reference: this.reference(input.idempotencyKey),
      periodStart,
      periodEnd: addDays(periodStart, PERIOD_DAYS),
      status: 'active',
    }
  }

  async renew(input: {
    tier: string
    seats: number
    currency: string
    reference: string | null
    idempotencyKey: string
  }): Promise<PlanRenewal> {
    await this.simulate()
    const periodStart = new Date()
    return {
      paid: true,
      reference: this.reference(input.idempotencyKey),
      periodStart,
      periodEnd: addDays(periodStart, PERIOD_DAYS),
    }
  }

  /**
   * Derived from the idempotency key, so asking twice with the same key produces the same
   * reference — which is the only part of a mock reference that carries any meaning.
   */
  private reference(idempotencyKey: string): string {
    return `sim_${createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 16)}`
  }

  private async simulate(): Promise<void> {
    if (this.behaviour.latencyMs) await new Promise((resolve) => setTimeout(resolve, this.behaviour.latencyMs))
  }
}

function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000)
}
