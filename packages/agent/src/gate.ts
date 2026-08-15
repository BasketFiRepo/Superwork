import type { RiskTier, TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { approvalPolicies, evaluateApprovalPolicies, type PreviewLine } from '@superwork/core'
import { resolveTool, type Tool, type ToolContext } from '@superwork/tools'
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
  /** This tenant's admin-authored tools, gated exactly like the built-ins (§22). */
  tenantTools?: Map<string, Tool<any, any>> | null,
): Promise<GateOutcome> {
  const steps: GatedStep[] = []
  let highestRisk: RiskTier = 'read'

  for (const step of plan.steps) {
    const tool = resolveTool(step.tool, tenantTools)
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

  // The rules used to live here as a constant — `writes.length > 20`, the same twenty the
  // seeded "Bulk changes require approval" policy states. The row and the constant agreed
  // and only the constant ran, so an admin could neither see nor change the rule that was
  // actually governing them (§11.1).
  //
  // The floor stays in code and is passed in: any write is held for a person. A policy may
  // raise the bar — a senior approver, a shorter deadline, an outright refusal — and there
  // is no configuration that lowers it.
  const policy = evaluateApprovalPolicies(
    await approvalPolicies(ctx),
    {
      tools: steps.filter((s) => s.allowed).map((s) => s.tool),
      writes: writes.length,
      riskTier: highestRisk,
      actorType: actor.agent ? 'agent' : 'user',
      mode: actor.agent?.mode ?? null,
      departmentId: actor.departmentIds[0] ?? null,
    },
    steps.some((s) => s.allowed && s.requiresApproval) || writes.length > 0,
  )

  // A denied plan is refused rather than held: a card somebody can approve is not a
  // prohibition. Every write is struck out with the policy's own name as the reason.
  const denied = policy.denied && writes.length > 0
  const finalSteps = denied
    ? steps.map((step) =>
        step.allowed && step.riskTier !== 'read'
          ? { ...step, allowed: false, reason: policy.reason, requiresApproval: false }
          : step,
      )
    : steps

  return {
    steps: finalSteps,
    requiresApproval: !denied && policy.requiresApproval && writes.length > 0,
    blocked: finalSteps.filter((s) => !s.allowed),
    estimatedCostCents: Math.max(1, Math.round(steps.length * 0.4)),
    approvalTitle: summarizePlan(plan, steps),
    riskTier: highestRisk,
    policy,
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
