import { DEFAULT_RUN_BUDGET, type RunBudget } from '@superwork/config'
import { BudgetError } from '@superwork/core'

/**
 * Run budgets and loop protection (§5.5). On breach the run halts, reports honestly
 * what it accomplished, and offers to continue with a larger budget — it never quietly
 * degrades or keeps spending.
 */

export interface BudgetState extends RunBudget {
  steps: number
  toolCalls: number
  tokensIn: number
  tokensOut: number
  costCents: number
  startedAt: number
  /** hash(tool, normalized args) → count. Three identical calls abort the branch. */
  callHashes: Map<string, number>
  noProgressSteps: number
}

export function newBudget(overrides: Partial<RunBudget> = {}): BudgetState {
  return {
    ...DEFAULT_RUN_BUDGET,
    ...overrides,
    steps: 0,
    toolCalls: 0,
    tokensIn: 0,
    tokensOut: 0,
    costCents: 0,
    startedAt: Date.now(),
    callHashes: new Map(),
    noProgressSteps: 0,
  }
}

export interface BudgetBreach {
  limit: keyof RunBudget
  message: string
}

export function checkBudget(state: BudgetState): BudgetBreach | null {
  if (state.steps >= state.maxSteps) {
    return { limit: 'maxSteps', message: `Reached the ${state.maxSteps}-step limit for a single run.` }
  }
  if (state.toolCalls >= state.maxToolCalls) {
    return { limit: 'maxToolCalls', message: `Reached the ${state.maxToolCalls}-tool-call limit for a single run.` }
  }
  if (state.costCents >= state.maxCostCents) {
    return { limit: 'maxCostCents', message: `Reached the ${(state.maxCostCents / 100).toFixed(2)} spend limit for a single run.` }
  }
  if (Date.now() - state.startedAt >= state.maxWallClockMs) {
    return { limit: 'maxWallClockMs', message: `Reached the ${Math.round(state.maxWallClockMs / 1000)}s time limit for a single run.` }
  }
  if (state.tokensIn >= state.maxTokensIn || state.tokensOut >= state.maxTokensOut) {
    return { limit: 'maxTokensIn', message: 'Reached the token limit for a single run.' }
  }
  return null
}

export function assertBudget(state: BudgetState): void {
  const breach = checkBudget(state)
  if (breach) throw new BudgetError(breach.message, { limit: breach.limit })
}

export function recordUsage(state: BudgetState, usage: { tokensIn: number; tokensOut: number; costCents: number }): void {
  state.tokensIn += usage.tokensIn
  state.tokensOut += usage.tokensOut
  state.costCents += usage.costCents
}

/** Loop protection: three identical calls in one run abort that branch and re-plan. */
export function registerCall(state: BudgetState, hash: string): { looping: boolean; count: number } {
  const count = (state.callHashes.get(hash) ?? 0) + 1
  state.callHashes.set(hash, count)
  state.toolCalls += 1
  return { looping: count >= 3, count }
}

/** A tool that succeeded but changed nothing. Capped at two per run. */
export function registerNoProgress(state: BudgetState): boolean {
  state.noProgressSteps += 1
  return state.noProgressSteps > 2
}
