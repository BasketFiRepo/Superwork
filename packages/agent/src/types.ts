import { z } from 'zod'
import type { RiskTier } from '@superwork/db'
import type { PreviewLine } from '@superwork/core'

/**
 * The Plan is the unit of approval, the unit of audit and the unit of replay (§5.2).
 * The model commits to the *shape* of the work before any of it happens.
 */

export const PlanStepSchema = z.object({
  id: z.string(),
  tool: z.string(),
  args: z.record(z.unknown()),
  intent: z.string(),
})

export const PlanSchema = z.object({
  intent: z.string(),
  summary: z.string(),
  answerOnly: z.boolean(),
  steps: z.array(PlanStepSchema),
  needsAttention: z
    .array(z.object({ label: z.string(), reason: z.string(), entityType: z.string(), entityId: z.string() }))
    .default([]),
  clarification: z
    .object({ question: z.string(), options: z.array(z.object({ id: z.string(), label: z.string() })) })
    .optional(),
})

export type PlanStep = z.infer<typeof PlanStepSchema>
export type Plan = z.infer<typeof PlanSchema>

/** A plan step after the Gate has evaluated it. */
export interface GatedStep extends PlanStep {
  riskTier: RiskTier
  reversible: boolean
  inverse: string | null
  allowed: boolean
  reason: string
  requiresApproval: boolean
  preview: PreviewLine[]
}

export interface GateOutcome {
  steps: GatedStep[]
  requiresApproval: boolean
  blocked: GatedStep[]
  estimatedCostCents: number
  approvalTitle: string
  riskTier: RiskTier
}

export interface Citation {
  claim: string
  sourceType: string
  sourceId?: string | null
  documentId?: string | null
  documentTitle?: string | null
  anchor?: string | null
  snippet?: string | null
}

export interface RunReport {
  narrative: string
  outcome: { created: number; updated: number; drafted: number; sent: number; skipped: string[]; failed: string[] }
  citations: Citation[]
  needsAttention: Plan['needsAttention']
  undoable: boolean
  degraded: string | null
  simulated: boolean
  injectionWarnings: { sourceId: string; label: string; patterns: string[] }[]
}

/** Structured step events streamed to the trace rail (§5.8). */
export type RunEvent =
  | { type: 'run.started'; runId: string; traceId: string }
  | { type: 'step.started'; ordinal: number; phase: string; label: string }
  | { type: 'step.finished'; ordinal: number; status: string; durationMs: number; detail?: Record<string, unknown> }
  | { type: 'plan.ready'; plan: Plan; gate: GateOutcome }
  | { type: 'tool.called'; tool: string; riskTier: RiskTier; args: Record<string, unknown> }
  | { type: 'tool.result'; tool: string; ok: boolean; summary: string }
  | { type: 'approval.required'; approvalId: string; title: string }
  | { type: 'text'; delta: string }
  | { type: 'run.completed'; status: string; report: RunReport; costCents: number }
  | { type: 'run.failed'; failureClass: string; message: string }

export interface StartRunInput {
  request: string
  mode: 'ask' | 'assist' | 'execute' | 'autopilot'
  uiContext?: Record<string, unknown>
  trigger?: 'user' | 'schedule' | 'event' | 'workflow' | 'watcher'
  agentKey?: string
  dryRun?: boolean
}
