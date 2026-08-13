/**
 * Plan limits (§19). These defaults seed the `plan_limits` table; the database is the
 * source of truth at runtime so limits can be changed without a deploy.
 */

export type PlanTier = 'free' | 'team' | 'business' | 'enterprise'

export interface PlanLimits {
  tier: PlanTier
  seats: number | null
  agentRunsPerMonth: number | null
  aiSpendCapCents: number | null
  perUserDailySpendCapCents: number | null
  documentsIndexed: number | null
  storageGb: number | null
  workflowRunsPerMonth: number | null
  autopilotAllowed: boolean
}

export const DEFAULT_PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free: {
    tier: 'free',
    seats: 3,
    agentRunsPerMonth: 100,
    aiSpendCapCents: 500,
    perUserDailySpendCapCents: 100,
    documentsIndexed: 100,
    storageGb: 1,
    workflowRunsPerMonth: 50,
    autopilotAllowed: false,
  },
  team: {
    tier: 'team',
    seats: 25,
    agentRunsPerMonth: 5_000,
    aiSpendCapCents: 20_000,
    perUserDailySpendCapCents: 1_000,
    documentsIndexed: 10_000,
    storageGb: 100,
    workflowRunsPerMonth: 5_000,
    autopilotAllowed: false,
  },
  business: {
    tier: 'business',
    seats: 250,
    agentRunsPerMonth: 100_000,
    aiSpendCapCents: 250_000,
    perUserDailySpendCapCents: 5_000,
    documentsIndexed: 250_000,
    storageGb: 2_000,
    workflowRunsPerMonth: 100_000,
    autopilotAllowed: true,
  },
  enterprise: {
    tier: 'enterprise',
    seats: null,
    agentRunsPerMonth: null,
    aiSpendCapCents: null,
    perUserDailySpendCapCents: 20_000,
    documentsIndexed: null,
    storageGb: null,
    workflowRunsPerMonth: null,
    autopilotAllowed: true,
  },
}

/** Default per-run agent budget (§5.5). Organizations may tighten but not exceed plan caps. */
export interface RunBudget {
  maxSteps: number
  maxToolCalls: number
  maxTokensIn: number
  maxTokensOut: number
  maxWallClockMs: number
  maxCostCents: number
  maxParallelism: number
}

export const DEFAULT_RUN_BUDGET: RunBudget = {
  maxSteps: 24,
  maxToolCalls: 40,
  maxTokensIn: 200_000,
  maxTokensOut: 16_000,
  maxWallClockMs: 120_000,
  maxCostCents: 50,
  maxParallelism: 4,
}
