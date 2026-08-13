import type { StepStatus, TenantContext } from '@superwork/db'
import type { GateOutcome, Plan, RunReport } from './types.js'

/** Durable-run persistence helpers. Every phase writes before it proceeds (§5.3). */

export async function insertRun(
  ctx: TenantContext,
  input: {
    principalUserId: string
    agentId: string | null
    mode: string
    request: string
    uiContext: Record<string, unknown>
    trigger: string
    budget: Record<string, number>
    aiMode: string
    isDemo: boolean
  },
): Promise<string> {
  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO agent_runs (
      organization_id, agent_id, principal_user_id, mode, status, trigger, request,
      ui_context, timezone, budget, ai_mode, trace_id, is_demo, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.agentId}, ${input.principalUserId}, ${input.mode}, 'queued',
      ${input.trigger}, ${input.request}, ${ctx.sql.json(input.uiContext)}, ${ctx.timezone},
      ${ctx.sql.json(input.budget)}, ${input.aiMode}, ${ctx.traceId}, ${input.isDemo}, ${ctx.userId}
    ) RETURNING id`
  return row!.id
}

export async function setRunStatus(
  ctx: TenantContext,
  runId: string,
  status: string,
  extra: { failureClass?: string; failureDetail?: string; summary?: string } = {},
): Promise<void> {
  await ctx.sql`
    UPDATE agent_runs SET
      status = ${status}::sw_run_status,
      failure_class = ${extra.failureClass ?? null},
      failure_detail = ${extra.failureDetail ?? null},
      summary = coalesce(${extra.summary ?? null}, summary),
      started_at = coalesce(started_at, CASE WHEN ${status} IN ('planning','running') THEN now() END),
      finished_at = CASE WHEN ${status} IN ('succeeded','failed','cancelled','aborted_by_admin','budget_exceeded','undone')
                         THEN now() ELSE finished_at END
    WHERE organization_id = ${ctx.organizationId} AND id = ${runId}`
}

export async function savePlan(ctx: TenantContext, runId: string, plan: Plan, gate: GateOutcome): Promise<void> {
  await ctx.sql`
    UPDATE agent_runs SET plan = ${ctx.sql.json({ plan, gate: stripPreviewFunctions(gate) })}
    WHERE organization_id = ${ctx.organizationId} AND id = ${runId}`
}

export async function saveReport(ctx: TenantContext, runId: string, report: RunReport): Promise<void> {
  await ctx.sql`
    UPDATE agent_runs SET report = ${ctx.sql.json(report)}, summary = ${report.narrative}
    WHERE organization_id = ${ctx.organizationId} AND id = ${runId}`
}

export async function markUntrusted(
  ctx: TenantContext,
  runId: string,
  flags: { sourceId: string; label: string; patterns: string[] }[],
  downgraded: boolean,
): Promise<void> {
  await ctx.sql`
    UPDATE agent_runs SET
      contains_untrusted_content = true,
      capability_downgraded = ${downgraded},
      injection_flags = ${ctx.sql.json(flags)}
    WHERE organization_id = ${ctx.organizationId} AND id = ${runId}`
}

export interface StepRecord {
  ordinal: number
  phase: string
  label: string
  status: StepStatus
  toolName?: string | null
  riskTier?: string | null
  subagent?: string | null
  detail?: Record<string, unknown>
  errorClass?: string | null
  errorMessage?: string | null
  durationMs?: number | null
}

export async function recordStep(ctx: TenantContext, runId: string, step: StepRecord): Promise<string> {
  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO agent_steps (
      organization_id, run_id, ordinal, phase, label, status, tool_name, risk_tier, subagent,
      detail, error_class, error_message, duration_ms, started_at, finished_at, created_by
    ) VALUES (
      ${ctx.organizationId}, ${runId}, ${step.ordinal}, ${step.phase}, ${step.label},
      ${step.status}, ${step.toolName ?? null}, ${step.riskTier ?? null}::sw_risk_tier,
      ${step.subagent ?? null}, ${ctx.sql.json(step.detail ?? {})}, ${step.errorClass ?? null},
      ${step.errorMessage ?? null}, ${step.durationMs ?? null}, now(),
      ${step.status === 'running' || step.status === 'queued' ? null : new Date()}, ${ctx.userId}
    )
    ON CONFLICT (run_id, ordinal) DO UPDATE SET
      status = EXCLUDED.status, detail = EXCLUDED.detail, error_class = EXCLUDED.error_class,
      error_message = EXCLUDED.error_message, duration_ms = EXCLUDED.duration_ms,
      finished_at = EXCLUDED.finished_at
    RETURNING id`
  await ctx.sql`
    UPDATE agent_runs SET steps_used = greatest(steps_used, ${step.ordinal + 1})
    WHERE organization_id = ${ctx.organizationId} AND id = ${runId}`
  return row!.id
}

export async function recordToolCall(
  ctx: TenantContext,
  runId: string,
  input: {
    stepId: string | null
    toolName: string
    riskTier: string
    input: Record<string, unknown>
    output: unknown
    ok: boolean
    errorCode?: string | null
    errorMessage?: string | null
    idempotencyKey: string
    argsHash: string
    durationMs: number
  },
): Promise<string> {
  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO tool_calls (
      organization_id, run_id, step_id, tool_name, risk_tier, input, output, ok,
      error_code, error_message, idempotency_key, args_hash, duration_ms, created_by
    ) VALUES (
      ${ctx.organizationId}, ${runId}, ${input.stepId}, ${input.toolName}, ${input.riskTier}::sw_risk_tier,
      ${ctx.sql.json(input.input)}, ${ctx.sql.json(input.output ?? null)}, ${input.ok},
      ${input.errorCode ?? null}, ${input.errorMessage ?? null}, ${input.idempotencyKey},
      ${input.argsHash}, ${input.durationMs}, ${ctx.userId}
    )
    ON CONFLICT (organization_id, idempotency_key) DO UPDATE SET updated_at = now()
    RETURNING id`
  await ctx.sql`
    UPDATE agent_runs SET tool_calls_used = tool_calls_used + 1
    WHERE organization_id = ${ctx.organizationId} AND id = ${runId}`
  return row!.id
}

/** A completed side effect is never re-executed on resume — the key makes it safe. */
export async function findCompletedCall(
  ctx: TenantContext,
  idempotencyKey: string,
): Promise<{ output: unknown; ok: boolean } | null> {
  const [row] = await ctx.sql<{ output: unknown; ok: boolean }[]>`
    SELECT output, ok FROM tool_calls
    WHERE organization_id = ${ctx.organizationId} AND idempotency_key = ${idempotencyKey}`
  return row ?? null
}

export async function recordUndo(
  ctx: TenantContext,
  runId: string,
  input: {
    ordinal: number
    toolCallId: string
    forwardTool: string
    inverseTool: string
    inverseInput: Record<string, unknown>
    entityType: string
    entityId: string | null
    description: string
  },
): Promise<void> {
  await ctx.sql`
    INSERT INTO undo_operations (
      organization_id, run_id, tool_call_id, ordinal, forward_tool, inverse_tool, inverse_input,
      entity_type, entity_id, description, expires_at, created_by
    ) VALUES (
      ${ctx.organizationId}, ${runId}, ${input.toolCallId}, ${input.ordinal}, ${input.forwardTool},
      ${input.inverseTool}, ${ctx.sql.json(input.inverseInput)}, ${input.entityType}, ${input.entityId},
      ${input.description}, now() + interval '30 days', ${ctx.userId}
    )`
}

export async function addUsage(
  ctx: TenantContext,
  runId: string,
  usage: { tokensIn: number; tokensOut: number; costCents: number },
): Promise<void> {
  await ctx.sql`
    UPDATE agent_runs SET
      tokens_in = tokens_in + ${usage.tokensIn},
      tokens_out = tokens_out + ${usage.tokensOut},
      cost_cents = cost_cents + ${usage.costCents}
    WHERE organization_id = ${ctx.organizationId} AND id = ${runId}`
}

function stripPreviewFunctions(gate: GateOutcome): unknown {
  return {
    ...gate,
    steps: gate.steps.map((s) => ({ ...s })),
  }
}
