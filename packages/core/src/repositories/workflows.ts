import type { TenantContext } from '@superwork/db'
import { asJson } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import type { CompiledWorkflow, DetectedRisk, WorkflowGraph } from '@superwork/ai'
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeActivity, writeAudit } from '../audit.js'

/**
 * Workflows (§10).
 *
 * The rule that matters is §10.2's: nothing can be activated until a dry run against real
 * data has passed. It is enforced here rather than in the UI — `activate` refuses a
 * workflow whose latest simulation is missing, stale, or belongs to a different version.
 *
 * A workflow also has an accountable owner, for the same reason an agent does.
 */

export type WorkflowStatus = 'draft' | 'active' | 'paused' | 'archived'

export interface WorkflowView {
  id: string
  name: string
  description: string | null
  ownerUserId: string | null
  ownerName: string | null
  status: WorkflowStatus
  currentVersionId: string | null
  currentVersionOrdinal: number | null
  graph: WorkflowGraph | null
  readback: string
  risks: DetectedRisk[]
  simulatedOk: boolean
  lastSimulationId: string | null
  maxConcurrentRuns: number
  dailyActionCap: number
  createdAt: Date
}

const SELECT_WORKFLOW = (ctx: TenantContext) => ctx.sql`
  SELECT w.id, w.name, w.description, w.owner_user_id AS "ownerUserId", u.name AS "ownerName",
         w.status, w.current_version_id AS "currentVersionId", v.ordinal AS "currentVersionOrdinal",
         v.graph, coalesce(v.readback, '') AS readback, coalesce(v.detected_risks, '[]'::jsonb) AS risks,
         w.simulated_ok AS "simulatedOk", w.last_simulation_id AS "lastSimulationId",
         w.max_concurrent_runs AS "maxConcurrentRuns", w.daily_action_cap AS "dailyActionCap",
         w.created_at AS "createdAt"
  FROM workflows w
  LEFT JOIN users u ON u.id = w.owner_user_id
  LEFT JOIN workflow_versions v ON v.id = w.current_version_id`

function guard(ctx: TenantContext, actor: Actor, action: string): void {
  const decision = can(actor, action, {
    type: 'workflow',
    organizationId: ctx.organizationId,
    riskTier: 'high',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
}

export async function listWorkflows(ctx: TenantContext, actor: Actor): Promise<WorkflowView[]> {
  guard(ctx, actor, 'workflow:read')
  return ctx.sql<WorkflowView[]>`
    ${SELECT_WORKFLOW(ctx)}
    WHERE w.organization_id = ${ctx.organizationId} AND w.deleted_at IS NULL
    ORDER BY w.status, w.name`
}

export async function getWorkflow(ctx: TenantContext, actor: Actor, id: string): Promise<WorkflowView> {
  guard(ctx, actor, 'workflow:read')
  const [row] = await ctx.sql<WorkflowView[]>`
    ${SELECT_WORKFLOW(ctx)}
    WHERE w.organization_id = ${ctx.organizationId} AND w.id = ${id} AND w.deleted_at IS NULL`
  if (!row) throw new NotFoundError()
  return row
}

/**
 * Saves a compiled description as a draft version. Compiling is not creating: an
 * automation that could not be compiled is never stored as one.
 */
export async function saveCompiled(
  ctx: TenantContext,
  actor: Actor,
  input: { workflowId?: string; description: string; compiled: CompiledWorkflow; ownerUserId?: string },
): Promise<WorkflowView> {
  guard(ctx, actor, 'workflow:create')
  if (input.compiled.unsupported) {
    throw new ValidationError(input.compiled.unsupported)
  }

  let workflowId = input.workflowId
  if (!workflowId) {
    const [row] = await ctx.sql<{ id: string }[]>`
      INSERT INTO workflows (
        organization_id, name, description, owner_user_id, status, created_by
      ) VALUES (
        ${ctx.organizationId}, ${input.compiled.name}, ${input.description},
        ${input.ownerUserId ?? actor.userId}, 'draft', ${ctx.userId}
      ) RETURNING id`
    workflowId = row!.id
  }

  const [version] = await ctx.sql<{ id: string; ordinal: number }[]>`
    INSERT INTO workflow_versions (
      organization_id, workflow_id, ordinal, graph, readback, detected_risks, created_by
    )
    SELECT ${ctx.organizationId}, ${workflowId}, coalesce(max(ordinal), 0) + 1,
           ${ctx.sql.json(asJson(input.compiled.graph))}, ${input.compiled.readback},
           ${ctx.sql.json(asJson(input.compiled.risks))}, ${ctx.userId}
    FROM workflow_versions
    WHERE organization_id = ${ctx.organizationId} AND workflow_id = ${workflowId}
    RETURNING id, ordinal`

  // A new version invalidates the previous dry run — the gate is per version, not per
  // workflow, or editing an automation would quietly bypass it (§10.2).
  await ctx.sql`
    UPDATE workflows
    SET current_version_id = ${version!.id}, description = ${input.description},
        simulated_ok = false, last_simulation_id = NULL, status = 'draft'
    WHERE organization_id = ${ctx.organizationId} AND id = ${workflowId}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'workflow.version_saved',
    entityType: 'workflow',
    entityId: workflowId,
    after: { ordinal: version!.ordinal, risks: input.compiled.risks.length },
  })

  return getWorkflow(ctx, actor, workflowId)
}

export interface SimulationSummary {
  runId: string
  occurrences: number
  wouldHave: { label: string; count: number }[]
  windowFrom: Date
  windowTo: Date
  passed: boolean
  note: string
}

/** Records a completed dry run and opens the activation gate if it passed. */
export async function recordSimulation(
  ctx: TenantContext,
  actor: Actor,
  input: { workflowId: string; summary: SimulationSummary },
): Promise<void> {
  guard(ctx, actor, 'workflow:simulate')
  await ctx.sql`
    UPDATE workflows
    SET simulated_ok = ${input.summary.passed}, last_simulation_id = ${input.summary.runId}
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.workflowId}`

  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'dry-ran',
    entityType: 'workflow',
    entityId: input.workflowId,
    entityLabel: 'workflow',
    summary:
      `Would have fired ${input.summary.occurrences} times in the last ` +
      `${Math.round((input.summary.windowTo.getTime() - input.summary.windowFrom.getTime()) / 86_400_000)} days. ` +
      input.summary.wouldHave.map((entry) => `${entry.count} × ${entry.label}`).join(', '),
  })
}

/**
 * Activation. Refuses without a passing dry run of *this* version, and without an owner —
 * the two rules that prevent most automation disasters (§10.2).
 */
export async function activateWorkflow(
  ctx: TenantContext,
  actor: Actor,
  input: { workflowId: string; ownerUserId?: string },
): Promise<WorkflowView> {
  guard(ctx, actor, 'workflow:activate')
  const workflow = await getWorkflow(ctx, actor, input.workflowId)

  const owner = input.ownerUserId ?? workflow.ownerUserId
  if (!owner) {
    throw new ValidationError('An automation needs an accountable owner before it can run. Name one.')
  }
  if (!workflow.simulatedOk || !workflow.lastSimulationId) {
    throw new ValidationError(
      'Dry-run this version first. Nothing is activated until a run against real data has shown what it would do — ' +
        'that single rule prevents most automation disasters.',
    )
  }

  const [simulation] = await ctx.sql<{ workflow_version_id: string }[]>`
    SELECT workflow_version_id FROM workflow_runs
    WHERE organization_id = ${ctx.organizationId} AND id = ${workflow.lastSimulationId}`
  if (!simulation || simulation.workflow_version_id !== workflow.currentVersionId) {
    throw new ValidationError('That dry run was of a different version. Run it again against this one.')
  }

  await ctx.sql`
    UPDATE workflows SET status = 'active', owner_user_id = ${owner}
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.workflowId}`
  await ctx.sql`
    UPDATE workflow_versions SET published_at = now(), published_by = ${actor.userId}
    WHERE organization_id = ${ctx.organizationId} AND id = ${workflow.currentVersionId}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'workflow.activated',
    entityType: 'workflow',
    entityId: input.workflowId,
    after: { version: workflow.currentVersionOrdinal, owner },
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'activated',
    entityType: 'workflow',
    entityId: input.workflowId,
    entityLabel: workflow.name,
    summary: `Activated version ${workflow.currentVersionOrdinal}. ${workflow.readback}`,
  })

  return getWorkflow(ctx, actor, input.workflowId)
}

export async function setWorkflowStatus(
  ctx: TenantContext,
  actor: Actor,
  input: { workflowId: string; status: 'paused' | 'archived' | 'active'; reason?: string },
): Promise<WorkflowView> {
  guard(ctx, actor, 'workflow:activate')
  if (input.status === 'active') return activateWorkflow(ctx, actor, { workflowId: input.workflowId })

  await ctx.sql`
    UPDATE workflows SET status = ${input.status}
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.workflowId}`
  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: `workflow.${input.status}`,
    entityType: 'workflow',
    entityId: input.workflowId,
    after: { reason: input.reason ?? null },
  })
  return getWorkflow(ctx, actor, input.workflowId)
}

/**
 * The workflow run an agent run belongs to, if any. An approval carries the agent run;
 * this is how the approvals API knows to resume a workflow rather than a planned agent run.
 */
export async function workflowRunForAgentRun(ctx: TenantContext, agentRunId: string): Promise<string | null> {
  const [row] = await ctx.sql<{ id: string }[]>`
    SELECT id FROM workflow_runs
    WHERE organization_id = ${ctx.organizationId} AND ${agentRunId}::uuid = ANY(agent_run_ids)
      AND deleted_at IS NULL
    ORDER BY created_at DESC LIMIT 1`
  return row?.id ?? null
}

export interface WorkflowRunView {
  id: string
  workflowId: string
  workflowName: string
  versionOrdinal: number
  status: string
  trigger: string
  simulated: boolean
  costCents: number
  startedAt: Date | null
  finishedAt: Date | null
  error: string | null
  steps: {
    nodeId: string
    nodeType: string
    status: string
    label: string
    detail: string | null
    output: Record<string, unknown> | null
    wouldHave: Record<string, unknown> | null
    error: string | null
  }[]
}

export async function listWorkflowRuns(
  ctx: TenantContext,
  actor: Actor,
  filter: { workflowId?: string; limit?: number } = {},
): Promise<WorkflowRunView[]> {
  guard(ctx, actor, 'workflow:read')
  const sql = ctx.sql
  const runs = await sql<
    {
      id: string
      workflowId: string
      workflowName: string
      versionOrdinal: number
      status: string
      trigger: string
      simulated: boolean
      costCents: number
      startedAt: Date | null
      finishedAt: Date | null
      error: string | null
    }[]
  >`
    SELECT r.id, r.workflow_id AS "workflowId", w.name AS "workflowName", v.ordinal AS "versionOrdinal",
           r.status::text AS status, r.trigger, r.simulated, r.cost_cents::float8 AS "costCents",
           r.started_at AS "startedAt", r.finished_at AS "finishedAt", r.error
    FROM workflow_runs r
    JOIN workflows w ON w.id = r.workflow_id
    JOIN workflow_versions v ON v.id = r.workflow_version_id
    WHERE r.organization_id = ${ctx.organizationId} AND r.deleted_at IS NULL
      ${filter.workflowId ? sql`AND r.workflow_id = ${filter.workflowId}` : sql``}
    ORDER BY r.created_at DESC
    LIMIT ${Math.min(filter.limit ?? 20, 100)}`

  const out: WorkflowRunView[] = []
  for (const run of runs) {
    const steps = await sql<WorkflowRunView['steps']>`
      SELECT node_id AS "nodeId", node_type AS "nodeType", status,
             coalesce(input->>'label', node_id) AS label, input->>'detail' AS detail,
             output, would_have AS "wouldHave", error
      FROM workflow_step_runs
      WHERE organization_id = ${ctx.organizationId} AND workflow_run_id = ${run.id} AND deleted_at IS NULL
      ORDER BY ordinal`
    out.push({ ...run, steps })
  }
  return out
}
