import type { TenantContext } from '@superwork/db'
import { asJson } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import type { CompiledWorkflow, DetectedRisk, WorkflowGraph } from '@superwork/ai'
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { writeActivity, writeAudit } from '../audit.js'
import { describeCron } from '../cron.js'
import { startOfDay } from '../time.js'
import { assertSteppedUp } from '../step-up.js'
import { setScheduleEnabled, upsertSchedule, type CatchUpPolicy, type ScheduleView } from './schedules.js'

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
  /** Who chose the two throttles, when and why. Null on a workflow still on the defaults. */
  limitsSetByName: string | null
  limitsSetAt: Date | null
  limitsReason: string | null
  createdAt: Date
  /** Null when the workflow only runs when somebody runs it. */
  scheduleCron: string | null
  scheduleTimezone: string | null
  scheduleEnabled: boolean | null
  scheduleCatchUp: string | null
  nextRunAt: Date | null
  lastRunAt: Date | null
  skippedTotal: number | null
  lastSkippedReason: string | null
}

const SELECT_WORKFLOW = (ctx: TenantContext) => ctx.sql`
  SELECT w.id, w.name, w.description, w.owner_user_id AS "ownerUserId", u.name AS "ownerName",
         w.status, w.current_version_id AS "currentVersionId", v.ordinal AS "currentVersionOrdinal",
         v.graph, coalesce(v.readback, '') AS readback, coalesce(v.detected_risks, '[]'::jsonb) AS risks,
         w.simulated_ok AS "simulatedOk", w.last_simulation_id AS "lastSimulationId",
         w.max_concurrent_runs AS "maxConcurrentRuns", w.daily_action_cap AS "dailyActionCap",
         (SELECT name FROM users WHERE id = w.limits_set_by) AS "limitsSetByName",
         w.limits_set_at AS "limitsSetAt", w.limits_reason AS "limitsReason",
         w.created_at AS "createdAt",
         s.cron AS "scheduleCron", s.timezone AS "scheduleTimezone", s.enabled AS "scheduleEnabled",
         s.catch_up_policy AS "scheduleCatchUp",
         s.next_run_at AS "nextRunAt", s.last_run_at AS "lastRunAt",
         s.skipped_total AS "skippedTotal", s.last_skipped_reason AS "lastSkippedReason"
  FROM workflows w
  LEFT JOIN users u ON u.id = w.owner_user_id
  LEFT JOIN workflow_versions v ON v.id = w.current_version_id
  LEFT JOIN schedules s ON s.organization_id = w.organization_id AND s.kind = 'workflow'
                       AND s.target_id = w.id AND s.deleted_at IS NULL`

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
  // Editing returns a workflow to draft, so it comes off the clock with it. An edited
  // automation that kept firing on its old schedule would be firing a version nobody
  // dry-ran.
  await setScheduleEnabled(ctx, 'workflow', workflowId, false)

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

  // Activation is what puts a workflow on the clock. A schedule created any earlier would
  // mean a draft that fires, which is not a draft.
  const trigger = workflow.graph?.trigger
  let schedule: ScheduleView | null = null
  if (trigger?.kind === 'schedule') {
    schedule = await upsertSchedule(ctx, {
      kind: 'workflow',
      targetId: input.workflowId,
      cron: trigger.spec,
      timezone: ctx.timezone,
    })
  }

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
    summary:
      `Activated version ${workflow.currentVersionOrdinal}. ${workflow.readback}` +
      (schedule
        ? ` It runs ${describeCron(schedule.cron, schedule.timezone)}, starting ${schedule.nextRunAt?.toISOString() ?? 'shortly'}.`
        : ' It runs when somebody runs it.'),
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
  // Pausing a workflow that is not on the clock is what people expect "pause" to mean.
  await setScheduleEnabled(ctx, 'workflow', input.workflowId, false)
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

/** The two limits a workflow runs under, and the bounds a person may choose between. */
export const WORKFLOW_LIMITS = {
  maxConcurrentRuns: { min: 1, max: 50 },
  dailyActionCap: { min: 1, max: 10_000 },
} as const

export interface Capacity {
  allow: boolean
  reason: string
  /** How many actions this workflow may still take today. */
  remaining: number
  /** Runs that have not finished — usually ones waiting for somebody to approve them. */
  unfinished: number
  /** Tool calls it has actually made today, in the organization's timezone. */
  usedToday: number
}

/**
 * What this workflow may do right now, counted from what it has actually done (§27.6).
 *
 * Two limits, both columns a person set (ADR 0046). A workflow whose last batch is still
 * waiting for approval does not queue a second one — that is how somebody arrives on Monday
 * to two hundred approvals. And the day's action cap is counted from the tool calls that
 * really happened, not from a counter that resets when a process restarts.
 *
 * This lives in the repository rather than in the executor because the screen that offers to
 * change the numbers has to show what they are doing right now, and two places counting
 * "what has it done today" would eventually disagree about the only thing that matters.
 */
export async function checkCapacity(ctx: TenantContext, workflow: WorkflowView): Promise<Capacity> {
  const [busy] = await ctx.sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM workflow_runs
    WHERE organization_id = ${ctx.organizationId} AND workflow_id = ${workflow.id}
      AND deleted_at IS NULL AND simulated = false
      AND status IN ('queued', 'running', 'awaiting_approval')`
  const unfinished = busy?.count ?? 0

  const [today] = await ctx.sql<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM tool_calls tc
    JOIN agent_runs r ON r.id = tc.run_id
    WHERE tc.organization_id = ${ctx.organizationId} AND tc.ok = true
      AND r.trigger = 'workflow'
      AND r.ui_context->>'workflowId' = ${workflow.id}
      AND tc.created_at >= ${startOfDay(new Date(), ctx.timezone)}`
  const usedToday = today?.count ?? 0
  const remaining = Math.max(0, workflow.dailyActionCap - usedToday)

  if (unfinished >= workflow.maxConcurrentRuns) {
    return {
      allow: false,
      remaining: 0,
      unfinished,
      usedToday,
      reason:
        `Skipped: ${unfinished} earlier ${unfinished === 1 ? 'run is' : 'runs are'} still unfinished — most likely ` +
        'waiting for somebody to approve them. It will run again once they are decided.',
    }
  }
  if (remaining <= 0) {
    return {
      allow: false,
      remaining: 0,
      unfinished,
      usedToday,
      reason:
        `Skipped: it has already done ${usedToday} things today and its cap is ${workflow.dailyActionCap}. ` +
        'Raise the cap if that is too low — it is a number somebody set, not a failure.',
    }
  }
  return { allow: true, reason: '', remaining, unfinished, usedToday }
}

/**
 * Sets the two throttles (§10.2, ADR 0046).
 *
 * Raising either one widens what runs unattended — more work queued at once, or more actions
 * in a day — so it asks for a fresh proof of identity. Lowering never does: a control that
 * asks for a password to make something safer teaches people to click through the prompt.
 *
 * The bounds are checked here with the numbers in the message, and again by a CHECK
 * constraint, because "no limit" must stay unexpressible whatever writes the row.
 */
export async function setWorkflowLimits(
  ctx: TenantContext,
  actor: Actor,
  input: { workflowId: string; maxConcurrentRuns: number; dailyActionCap: number; reason: string },
): Promise<WorkflowView> {
  guard(ctx, actor, 'workflow:update')
  const before = await getWorkflow(ctx, actor, input.workflowId)

  const reason = input.reason.trim()
  if (reason.length < 4) {
    throw new ValidationError('Say why. A throttle nobody explained is one nobody can review.')
  }

  for (const [field, value, label] of [
    ['maxConcurrentRuns', input.maxConcurrentRuns, 'runs at once'],
    ['dailyActionCap', input.dailyActionCap, 'actions a day'],
  ] as const) {
    const bound = WORKFLOW_LIMITS[field]
    if (!Number.isInteger(value) || value < bound.min || value > bound.max) {
      throw new ValidationError(
        `${label} has to be a whole number between ${bound.min} and ${bound.max}. ` +
          'There is no "unlimited" — an automation that acts without a person watching has a ceiling by design.',
      )
    }
  }

  if (
    input.maxConcurrentRuns > before.maxConcurrentRuns ||
    input.dailyActionCap > before.dailyActionCap
  ) {
    assertSteppedUp(actor, 'workflow.throttle')
  }

  await ctx.sql`
    UPDATE workflows
    SET max_concurrent_runs = ${input.maxConcurrentRuns}, daily_action_cap = ${input.dailyActionCap},
        limits_set_by = ${actor.userId}, limits_set_at = now(), limits_reason = ${reason}
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.workflowId}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'workflow.limits_set',
    entityType: 'workflow',
    entityId: input.workflowId,
    before: { maxConcurrentRuns: before.maxConcurrentRuns, dailyActionCap: before.dailyActionCap },
    after: {
      maxConcurrentRuns: input.maxConcurrentRuns,
      dailyActionCap: input.dailyActionCap,
      reason,
      wasDefault: before.limitsSetByName === null,
    },
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'throttled',
    entityType: 'workflow',
    entityId: input.workflowId,
    entityLabel: before.name,
    summary:
      `“${before.name}” may run ${input.maxConcurrentRuns} at a time and do ${input.dailyActionCap} ` +
      `things a day, set by ${actor.displayName}. ${reason}`,
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
    /** What the step did. Present for every step. */
    detail: string | null
    output: Record<string, unknown> | null
    wouldHave: Record<string, unknown> | null
    /** Why it failed, written only on a failure and never null when it did (ADR 0053). */
    error: string | null
    /** How long this step took, so a slow run can say which step was slow. */
    durationMs: number | null
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
             output, would_have AS "wouldHave", error, duration_ms AS "durationMs"
      FROM workflow_step_runs
      WHERE organization_id = ${ctx.organizationId} AND workflow_run_id = ${run.id} AND deleted_at IS NULL
      ORDER BY ordinal`
    out.push({ ...run, steps })
  }
  return out
}

/**
 * Changes when an active workflow runs (§10.2).
 *
 * Only an active workflow has a clock, so this is the one place a person can re-time
 * something that is already running without going back through the dry run — the *when*
 * changed, not the *what*. Changing what it does is `saveCompiled`, and that returns it to
 * draft and takes it off the clock.
 */
export async function setWorkflowSchedule(
  ctx: TenantContext,
  actor: Actor,
  input: { workflowId: string; cron: string; timezone?: string; catchUpPolicy?: CatchUpPolicy; enabled?: boolean },
): Promise<ScheduleView | null> {
  guard(ctx, actor, 'workflow:activate')
  const workflow = await getWorkflow(ctx, actor, input.workflowId)
  if (workflow.status !== 'active') {
    throw new ValidationError(
      'Only an active workflow has a clock. Dry-run this version and activate it, then choose when it runs.',
    )
  }

  const schedule = await upsertSchedule(ctx, {
    kind: 'workflow',
    targetId: input.workflowId,
    cron: input.cron,
    timezone: input.timezone ?? workflow.scheduleTimezone ?? ctx.timezone,
    ...(input.catchUpPolicy ? { catchUpPolicy: input.catchUpPolicy } : {}),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
  })

  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'rescheduled',
    entityType: 'workflow',
    entityId: input.workflowId,
    entityLabel: workflow.name,
    summary: schedule
      ? `${workflow.name} now runs ${describeCron(schedule.cron, schedule.timezone)}.`
      : `${workflow.name} has no next firing for that schedule.`,
  })
  return schedule
}
