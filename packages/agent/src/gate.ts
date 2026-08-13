import type { RiskTier, TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import type { PreviewLine } from '@superwork/core'
import { getTool, type ToolContext } from '@superwork/tools'
import type { GateOutcome, GatedStep, Plan } from './types.js'

/**
 * The Gate (§5.1).
 *
 * Permissions, risk policy and approval requirements are evaluated against the *whole
 * plan before any execution*. That ordering is what makes the plan the unit of approval
 * and lets an approver see the complete blast radius rather than one call at a time.
 */

export async function gatePlan(
  ctx: TenantContext,
  actor: Actor,
  plan: Plan,
  toolCtxFor: (step: { id: string; tool: string }) => ToolContext,
  killSwitch: boolean,
): Promise<GateOutcome> {
  const steps: GatedStep[] = []
  let highestRisk: RiskTier = 'read'

  for (const step of plan.steps) {
    const tool = getTool(step.tool) ?? getTool(`${step.tool}@v1`)
    if (!tool) {
      steps.push({
        ...step,
        riskTier: 'read',
        reversible: false,
        inverse: null,
        allowed: false,
        reason: `No tool named "${step.tool}" exists. The plan step was dropped rather than guessed at.`,
        requiresApproval: false,
        preview: [],
      })
      continue
    }

    const parsed = tool.inputSchema.safeParse(step.args)
    if (!parsed.success) {
      steps.push({
        ...step,
        riskTier: tool.riskTier,
        reversible: tool.reversible,
        inverse: tool.inverse ?? null,
        allowed: false,
        reason: `Arguments did not match the ${tool.name} contract: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`,
        requiresApproval: false,
        preview: [],
      })
      continue
    }

    const resource = tool.requiredPermissions[0]?.split(':') ?? ['task', 'read']
    const decision = can(
      actor,
      `${resource[0]}:${resource[1]}`,
      { type: resource[0]!, organizationId: ctx.organizationId, riskTier: tool.riskTier },
      { killSwitch },
    )

    let preview: PreviewLine[] = []
    if (decision.allow && tool.preview) {
      try {
        preview = await tool.preview(parsed.data, toolCtxFor(step))
      } catch (error) {
        preview = [
          {
            operation: tool.name,
            entityType: resource[0]!,
            entityLabel: step.intent,
            changes: [{ field: 'Preview unavailable', to: error instanceof Error ? error.message : 'unknown' }],
            riskTier: tool.riskTier,
            reversible: tool.reversible,
          },
        ]
      }
    }

    if (rank(tool.riskTier) > rank(highestRisk)) highestRisk = tool.riskTier

    steps.push({
      ...step,
      riskTier: tool.riskTier,
      reversible: tool.reversible,
      inverse: tool.inverse ?? null,
      allowed: decision.allow,
      reason: decision.reason,
      requiresApproval: decision.requiresApproval ?? false,
      preview,
    })
  }

  const writes = steps.filter((s) => s.allowed && s.riskTier !== 'read')
  // Bulk changes get an approval even when each individual write is low-risk (§11.1).
  const bulkThreshold = writes.length > 20
  const requiresApproval = steps.some((s) => s.allowed && s.requiresApproval) || bulkThreshold || writes.length > 0

  return {
    steps,
    requiresApproval: requiresApproval && writes.length > 0,
    blocked: steps.filter((s) => !s.allowed),
    estimatedCostCents: Math.max(1, Math.round(steps.length * 0.4)),
    approvalTitle: summarizePlan(plan, steps),
    riskTier: highestRisk,
  }
}

function rank(tier: RiskTier): number {
  return tier === 'high' ? 2 : tier === 'low' ? 1 : 0
}

function summarizePlan(plan: Plan, steps: GatedStep[]): string {
  const byTool = new Map<string, number>()
  for (const step of steps.filter((s) => s.allowed && s.riskTier !== 'read')) {
    const label = step.tool.replace(/@v\d+$/, '').replace(/_/g, ' ')
    byTool.set(label, (byTool.get(label) ?? 0) + 1)
  }
  const parts = [...byTool.entries()].map(([label, count]) => `${count} × ${label}`)
  return parts.length ? parts.join(', ') : plan.summary.slice(0, 120)
}
