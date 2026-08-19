import type { TenantContext } from '@superwork/db'
import type { Tool } from './registry.js'

/**
 * The budget a tool call is measured against (§5.6, ADR 0050).
 *
 * Every tool in the registry has declared `rateLimit: { perRun, perOrgPerHour }` since Phase 1
 * and **nothing read it**. The numbers were on twenty tools and in two columns of
 * `custom_tools`, and no code path consulted any of them — a limit the type system enforced
 * the shape of and the product enforced nothing about.
 *
 * Two budgets, because they stop two different failures:
 *
 *   **Per run** stops one plan from doing the same thing over and over — the loop that drafts
 *   forty emails because a step kept coming back unsatisfied. It is the budget a person feels
 *   as "it did the same thing forty times".
 *
 *   **Per organization per hour** stops many runs from adding up to the same thing. It is the
 *   budget somebody *else's* system feels, which is why it belongs to the organization rather
 *   than to the run that happened to be last.
 *
 * Both are counted from `tool_calls` — the calls that really happened — rather than from a
 * counter held in a process that restarts, which is the same reasoning the workflow throttle
 * uses (ADR 0046).
 */

export interface RateLimitVerdict {
  allow: boolean
  /** Empty when allowed. Says which budget stopped it, and what happens next. */
  reason: string
  usedThisRun: number
  usedThisHour: number
  perRun: number
  perHour: number
}

export async function checkRateLimit(
  ctx: TenantContext,
  tool: Pick<Tool, 'name' | 'rateLimit'>,
  runId: string | null,
): Promise<RateLimitVerdict> {
  const [row] = await ctx.sql<{ thisRun: number; thisHour: number }[]>`
    SELECT
      count(*) FILTER (WHERE ${runId}::uuid IS NOT NULL AND run_id = ${runId}::uuid)::int AS "thisRun",
      count(*) FILTER (WHERE created_at >= now() - interval '1 hour')::int AS "thisHour"
    FROM tool_calls
    WHERE organization_id = ${ctx.organizationId} AND tool_name = ${tool.name}
      AND deleted_at IS NULL
      AND (created_at >= now() - interval '1 hour' OR run_id = ${runId}::uuid)`

  const usedThisRun = row?.thisRun ?? 0
  const usedThisHour = row?.thisHour ?? 0
  const { perRun, perOrgPerHour } = tool.rateLimit

  if (usedThisRun >= perRun) {
    return {
      allow: false,
      usedThisRun,
      usedThisHour,
      perRun,
      perHour: perOrgPerHour,
      reason:
        `Stopped: this run has already called ${tool.name} ${usedThisRun} times and its budget is ` +
        `${perRun}. That is the limit somebody set on how often one plan may do the same thing — ` +
        'raise it if it is too low, or look at why the step keeps repeating.',
    }
  }

  if (usedThisHour >= perOrgPerHour) {
    return {
      allow: false,
      usedThisRun,
      usedThisHour,
      perRun,
      perHour: perOrgPerHour,
      reason:
        `Stopped: this organization has called ${tool.name} ${usedThisHour} times in the last hour ` +
        `and its budget is ${perOrgPerHour}. The hour is a rolling one, so the oldest call falls ` +
        'out of it as time passes and this will run again by itself.',
    }
  }

  return { allow: true, reason: '', usedThisRun, usedThisHour, perRun, perHour: perOrgPerHour }
}
