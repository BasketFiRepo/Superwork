import type { TenantContext } from '@superwork/db'
import { DEFAULT_PLAN_LIMITS, type PlanTier } from '@superwork/config'

/**
 * Metering (§19). Usage is recorded in the same transaction as the action wherever
 * possible, so a cost dashboard can never disagree with what actually happened.
 */

export type UsageUnit =
  | 'agent_run' | 'tool_call' | 'tokens_in' | 'tokens_out'
  | 'document_indexed' | 'workflow_run' | 'integration_sync'

export interface UsageInput {
  unit: UsageUnit
  quantity: number
  costCents?: number
  model?: string
  taskClass?: string
  agentRunId?: string
  departmentId?: string | null
  userId?: string
}

export async function record(ctx: TenantContext, input: UsageInput): Promise<void> {
  await ctx.sql`
    INSERT INTO usage_records (
      organization_id, department_id, user_id, agent_run_id, unit, quantity, cost_cents,
      model, task_class, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.departmentId ?? null}, ${input.userId ?? ctx.userId},
      ${input.agentRunId ?? null}, ${input.unit}, ${input.quantity}, ${input.costCents ?? 0},
      ${input.model ?? null}, ${input.taskClass ?? null}, ${ctx.userId}
    )`
}

export interface SpendSnapshot {
  monthToDateCents: number
  capCents: number | null
  /** 0–1. Soft warning at 0.8, hard stop only on a hard limit (§19.2). */
  utilization: number
  userTodayCents: number
  userDailyCapCents: number | null
}

export async function spendSnapshot(ctx: TenantContext, tier: PlanTier): Promise<SpendSnapshot> {
  const limits = DEFAULT_PLAN_LIMITS[tier]
  const [org] = await ctx.sql<{ total: string }[]>`
    SELECT coalesce(sum(cost_cents), 0)::text AS total
    FROM usage_records
    WHERE organization_id = ${ctx.organizationId}
      AND occurred_at >= date_trunc('month', now())`
  const [mine] = await ctx.sql<{ total: string }[]>`
    SELECT coalesce(sum(cost_cents), 0)::text AS total
    FROM usage_records
    WHERE organization_id = ${ctx.organizationId}
      AND user_id = ${ctx.userId}
      AND occurred_at >= (now() AT TIME ZONE ${ctx.timezone})::date`

  const monthToDateCents = Number(org?.total ?? 0)
  const capCents = limits.aiSpendCapCents
  return {
    monthToDateCents,
    capCents,
    utilization: capCents ? monthToDateCents / capCents : 0,
    userTodayCents: Number(mine?.total ?? 0),
    userDailyCapCents: limits.perUserDailySpendCapCents,
  }
}

export interface LimitDecision {
  allow: boolean
  reason: string
  warning?: string
}

export async function checkSpendLimits(ctx: TenantContext, tier: PlanTier): Promise<LimitDecision> {
  const snap = await spendSnapshot(ctx, tier)

  if (snap.userDailyCapCents !== null && snap.userTodayCents >= snap.userDailyCapCents) {
    return {
      allow: false,
      reason: `You have reached your daily AI budget of ${formatCents(snap.userDailyCapCents)}. It resets at midnight in your timezone, or an admin can raise it in Settings → Billing.`,
    }
  }
  if (snap.capCents !== null && snap.monthToDateCents >= snap.capCents) {
    return {
      allow: false,
      reason: `This organization has reached its monthly AI spend cap of ${formatCents(snap.capCents)}. An admin can raise the cap in Settings → Billing. Nothing has been silently degraded — the agent is stopped.`,
    }
  }
  if (snap.utilization >= 0.8) {
    return {
      allow: true,
      reason: 'Within budget.',
      warning: `${Math.round(snap.utilization * 100)}% of this month's AI budget is used.`,
    }
  }
  return { allow: true, reason: 'Within budget.' }
}

export function formatCents(cents: number, currency = 'GBP'): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(cents / 100)
}
