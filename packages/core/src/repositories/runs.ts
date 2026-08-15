import type { RunStatus, StepStatus, TenantContext } from '@superwork/db'
import { NotFoundError } from '../errors.js'

/** Persistence for durable agent runs (§5.3). Read/write helpers only — no orchestration. */

export interface RunView {
  id: string
  status: RunStatus
  mode: string
  request: string
  summary: string | null
  plan: unknown
  report: unknown
  principalUserId: string
  principalName: string
  agentName: string | null
  failureClass: string | null
  failureDetail: string | null
  costCents: number
  tokensIn: number
  tokensOut: number
  stepsUsed: number
  toolCallsUsed: number
  containsUntrustedContent: boolean
  capabilityDowngraded: boolean
  injectionFlags: unknown[]
  aiMode: string
  traceId: string
  undoneAt: Date | null
  createdAt: Date
  finishedAt: Date | null
}

export interface StepView {
  id: string
  ordinal: number
  phase: string
  label: string
  status: StepStatus
  toolName: string | null
  riskTier: string | null
  subagent: string | null
  detail: Record<string, unknown>
  errorClass: string | null
  errorMessage: string | null
  durationMs: number | null
  startedAt: Date | null
}

const SELECT_RUN = (ctx: TenantContext) => ctx.sql`
  SELECT r.id, r.status, r.mode, r.request, r.summary, r.plan, r.report,
         r.principal_user_id AS "principalUserId", u.name AS "principalName",
         ag.name AS "agentName",
         r.failure_class AS "failureClass", r.failure_detail AS "failureDetail",
         r.cost_cents::float8 AS "costCents", r.tokens_in AS "tokensIn", r.tokens_out AS "tokensOut",
         r.steps_used AS "stepsUsed", r.tool_calls_used AS "toolCallsUsed",
         r.contains_untrusted_content AS "containsUntrustedContent",
         r.capability_downgraded AS "capabilityDowngraded",
         r.injection_flags AS "injectionFlags", r.ai_mode AS "aiMode", r.trace_id AS "traceId",
         r.undone_at AS "undoneAt", r.created_at AS "createdAt", r.finished_at AS "finishedAt"
  FROM agent_runs r
  JOIN users u ON u.id = r.principal_user_id
  LEFT JOIN agents ag ON ag.id = r.agent_id`

export async function getRun(ctx: TenantContext, id: string): Promise<RunView> {
  const [row] = await ctx.sql<RunView[]>`
    ${SELECT_RUN(ctx)} WHERE r.organization_id = ${ctx.organizationId} AND r.id = ${id} AND r.deleted_at IS NULL`
  if (!row) throw new NotFoundError()
  return row
}

export async function listRuns(
  ctx: TenantContext,
  filter: { principalUserId?: string; limit?: number } = {},
): Promise<RunView[]> {
  const sql = ctx.sql
  return sql<RunView[]>`
    ${SELECT_RUN(ctx)}
    WHERE r.organization_id = ${ctx.organizationId} AND r.deleted_at IS NULL
      ${filter.principalUserId ? sql`AND r.principal_user_id = ${filter.principalUserId}` : sql``}
    ORDER BY r.created_at DESC
    LIMIT ${Math.min(filter.limit ?? 25, 100)}`
}

export async function listSteps(ctx: TenantContext, runId: string): Promise<StepView[]> {
  return ctx.sql<StepView[]>`
    SELECT id, ordinal, phase, label, status, tool_name AS "toolName", risk_tier AS "riskTier",
           subagent, detail, error_class AS "errorClass", error_message AS "errorMessage",
           duration_ms AS "durationMs", started_at AS "startedAt"
    FROM agent_steps
    WHERE organization_id = ${ctx.organizationId} AND run_id = ${runId}
    ORDER BY ordinal`
}

export interface CitationView {
  id: string
  claim: string
  sourceType: string
  sourceId: string | null
  documentId: string | null
  documentTitle: string | null
  anchor: string | null
  snippet: string | null
  ordinal: number
}

export async function listCitations(ctx: TenantContext, runId: string): Promise<CitationView[]> {
  return ctx.sql<CitationView[]>`
    SELECT c.id, c.claim, c.source_type AS "sourceType", c.source_id AS "sourceId",
           c.document_id AS "documentId", d.title AS "documentTitle", c.anchor, c.snippet, c.ordinal
    FROM citations c
    LEFT JOIN documents d ON d.id = c.document_id
    WHERE c.organization_id = ${ctx.organizationId} AND c.run_id = ${runId}
    ORDER BY c.ordinal`
}

export interface UndoOperationView {
  id: string
  ordinal: number
  forwardTool: string
  inverseTool: string
  inverseInput: Record<string, unknown>
  entityType: string
  entityId: string | null
  description: string
  undoneAt: Date | null
  undoError: string | null
  expiresAt: Date | null
}

export async function listUndoOperations(ctx: TenantContext, runId: string): Promise<UndoOperationView[]> {
  return ctx.sql<UndoOperationView[]>`
    SELECT id, ordinal, forward_tool AS "forwardTool", inverse_tool AS "inverseTool",
           inverse_input AS "inverseInput", entity_type AS "entityType", entity_id AS "entityId",
           description, undone_at AS "undoneAt", undo_error AS "undoError", expires_at AS "expiresAt"
    FROM undo_operations
    WHERE organization_id = ${ctx.organizationId} AND run_id = ${runId}
    ORDER BY ordinal`
}

export async function listToolCalls(
  ctx: TenantContext,
  runId: string,
): Promise<
  {
    id: string
    toolName: string
    riskTier: string
    input: Record<string, unknown>
    output: unknown
    ok: boolean | null
    errorCode: string | null
    durationMs: number | null
  }[]
> {
  return ctx.sql`
    SELECT id, tool_name AS "toolName", risk_tier AS "riskTier", input, output, ok,
           error_code AS "errorCode", duration_ms AS "durationMs"
    FROM tool_calls
    WHERE organization_id = ${ctx.organizationId} AND run_id = ${runId}
    ORDER BY created_at`
}

export interface RunMessageView {
  id: string
  role: string
  content: string
  taskClass: string | null
  model: string | null
  tokensIn: number
  tokensOut: number
  costCents: number
  latencyMs: number | null
  simulated: boolean
  createdAt: Date
}

/**
 * What the model was asked to do at each step, what it said, and what that cost (ADR 0040).
 *
 * `agent_messages` was written by nothing until now, so a run could say it cost four cents
 * and not which step, which model, or how long any of it took. The run's own totals are the
 * sum of these rows — kept by a trigger rather than by whichever caller remembered — so the
 * figure at the top of the page and the rows underneath it cannot disagree.
 *
 * Gated by the run, like its steps, citations and tool calls: reading a run is what entitles
 * somebody to what the run did.
 */
export async function listRunMessages(ctx: TenantContext, runId: string): Promise<RunMessageView[]> {
  return ctx.sql<RunMessageView[]>`
    SELECT id, role, content, task_class AS "taskClass", model,
           tokens_in AS "tokensIn", tokens_out AS "tokensOut",
           cost_cents::float8 AS "costCents", latency_ms AS "latencyMs", simulated,
           created_at AS "createdAt"
    FROM agent_messages
    WHERE organization_id = ${ctx.organizationId} AND run_id = ${runId} AND deleted_at IS NULL
    ORDER BY created_at`
}
