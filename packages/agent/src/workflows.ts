import { randomUUID } from 'node:crypto'
import { asJson, withTenant, type TenantContext } from '@superwork/db'
import { env } from '@superwork/config'
import { asAgent, can, loadActor, type Actor } from '@superwork/auth'
import {
  assertEditsAreOffered,
  checkCapacity,
  claimDueSchedules,
  createApproval,
  occurrencesBetween,
  getApproval,
  getWorkflow,
  notify,
  recordSimulation,
  runAggregate,
  startOfDay,
  SuperworkError,
  writeAudit,
  type AggregateQuery,
  type PreviewLine,
  type SimulationSummary,
  type WorkflowView,
} from '@superwork/core'
import type { WorkflowGraph, WorkflowNode } from '@superwork/ai'
import { checkRateLimit, getTool, hashArgs, redactInput, type ToolContext } from '@superwork/tools'
import { insertRun, recordToolCall, recordUndo, setRunStatus } from './persistence.js'
import type { RunSession } from './runtime.js'

/**
 * The workflow executor (§10.2, §10.3.5).
 *
 * A workflow is a deterministic DAG, so there is no planner here — but there is no second
 * execution path either. Every effect goes through the same tool registry, the same policy
 * engine, the same approval repository, the same audit trail and the same undo ledger as
 * an agent run, and hangs off an `agent_runs` row so "undo this" means the same thing
 * whichever produced it.
 *
 * A simulated run reads exactly what a live one would and then stops before every effect,
 * recording what it *would have* done on the step row. That is the run that opens the
 * activation gate, and it is the only kind of run a draft workflow can have.
 */

/**
 * The plan a workflow run is working from.
 *
 * It is not invented for the record: it is the compiled graph of the version being run, the
 * readback a person approved when they activated it, and the version's ordinal — so the
 * question "what was this going to do, and who agreed to it" is answerable from the run
 * alone. There is no gate outcome beside it, because a workflow is gated per stopping step
 * as it walks rather than once up front; the approval nodes are in the steps below.
 */
function planFromGraph(workflow: WorkflowView, graph: WorkflowGraph): Record<string, unknown> {
  return {
    plan: {
      intent: workflow.name,
      summary: workflow.readback,
      answerOnly: false,
      steps: graph.nodes
        .filter((node) => node.type === 'action' || node.type === 'notify' || node.type === 'approval')
        .map((node) => ({
          id: node.id,
          tool: node.ref ?? node.type,
          args: node.args ?? {},
          intent: node.label,
        })),
      needsAttention: [],
    },
    source: {
      workflowId: workflow.id,
      versionId: workflow.currentVersionId,
      versionOrdinal: workflow.currentVersionOrdinal,
      trigger: graph.trigger,
    },
  }
}

export interface WorkflowStepOutcome {
  nodeId: string
  nodeType: string
  label: string
  status: 'succeeded' | 'failed' | 'skipped' | 'awaiting_approval'
  /** What the step did. Written for every step. */
  detail: string
  /** Why it failed. Present only on a failure (ADR 0053). */
  error?: string
}

export interface WorkflowRunOutcome {
  runId: string
  workflowId: string
  agentRunId: string | null
  status: 'succeeded' | 'awaiting_approval' | 'failed' | 'skipped'
  simulated: boolean
  /** How many times the trigger fired in the window (simulations) or 1 (live). */
  occurrences: number
  windowFrom: Date
  windowTo: Date
  /** Per firing, against the data as it stands now. */
  wouldHave: { label: string; count: number }[]
  matched: number
  steps: WorkflowStepOutcome[]
  approvalId: string | null
  note: string
  error: string | null
  /**
   * Which kind of failure it was, taken from the error rather than guessed (§5.6, ADR 0053).
   * Null while the run has not failed.
   */
  failureClass: string | null
}

/** Nothing fans out further than this in one run, however many rows the query returned. */
const MAX_ITEMS_PER_RUN = 50

export async function simulateWorkflow(
  session: RunSession,
  input: { workflowId: string; windowDays?: number },
): Promise<WorkflowRunOutcome> {
  return execute(session, { ...input, simulated: true, trigger: 'simulation' })
}

/**
 * What caused a run that something other than a person started (ADR 0090).
 *
 * `depth` is the length of the causal chain behind it, not a retry count: a workflow whose action
 * raises an event that triggers a workflow is one link, and a product where a task creates a task
 * has exactly that shape available to it.
 */
export interface Cause {
  eventId: string
  idempotencyKey: string
  payload: Record<string, unknown>
  depth: number
  isReplay?: boolean
}

export async function runWorkflow(
  session: RunSession,
  input: { workflowId: string; trigger?: string; cause?: Cause },
): Promise<WorkflowRunOutcome> {
  return execute(session, { ...input, simulated: false })
}

async function execute(
  session: RunSession,
  input: {
    workflowId: string
    simulated: boolean
    windowDays?: number
    trigger?: string
    cause?: Cause
  },
): Promise<WorkflowRunOutcome> {
  const traceId = randomUUID()
  const windowDays = input.windowDays ?? 30
  const windowTo = new Date()
  const windowFrom = new Date(windowTo.getTime() - windowDays * 86_400_000)

  const prepared = await withTenant({ ...session, traceId }, async (ctx) => {
    const actor = await loadActor(ctx)
    const workflow = await getWorkflow(ctx, actor, input.workflowId)
    const permission = can(actor, input.simulated ? 'workflow:simulate' : 'workflow:activate', {
      type: 'workflow',
      id: workflow.id,
      organizationId: ctx.organizationId,
      riskTier: 'high',
    })
    if (!permission.allow) throw new Error(permission.reason)
    if (!workflow.graph || !workflow.currentVersionId) {
      throw new Error('This workflow has no compiled version to run.')
    }
    if (!input.simulated && workflow.status !== 'active') {
      throw new Error('Only an active workflow runs for real. Dry-run it and activate it first.')
    }

    // Unattended work is bounded by numbers a person set, checked against what actually
    // happened rather than against a counter in memory (§27.6).
    const capacity = input.simulated ? { allow: true, reason: '', remaining: MAX_ITEMS_PER_RUN } : await checkCapacity(ctx, workflow)
    const runId = await openRun(ctx, workflow, input.simulated, input.trigger ?? 'manual', input.cause)
    if (!capacity.allow) {
      await ctx.sql`
        UPDATE workflow_runs SET status = 'cancelled', finished_at = now(), error = ${capacity.reason}
        WHERE organization_id = ${ctx.organizationId} AND id = ${runId}`
      return { workflow, runId, agentRunId: null, actor, capacity }
    }
    const agentRunId = input.simulated
      ? null
      : await insertRun(ctx, {
          principalUserId: workflow.ownerUserId ?? actor.userId,
          agentId: null,
          mode: 'execute',
          request: `Workflow: ${workflow.name}`,
          uiContext: { workflowId: workflow.id, workflowRunId: runId },
          trigger: 'workflow',
          budget: { maxSteps: 200, maxToolCalls: MAX_ITEMS_PER_RUN * 4, maxCostCents: 200, maxWallClockMs: 600_000 },
          aiMode: env().AI_MODE,
          isDemo: false,
        })
    if (agentRunId) {
      await ctx.sql`
        UPDATE workflow_runs SET agent_run_ids = array_append(agent_run_ids, ${agentRunId}::uuid)
        WHERE organization_id = ${ctx.organizationId} AND id = ${runId}`
      // What this run intends to do, before it does any of it. An agent run stores the plan
      // its planner produced; a workflow run had one all along — the compiled graph a person
      // read back and activated — and was storing nothing, so the compliance review's
      // question "for any action, can you show what was proposed beforehand?" answered *no*
      // for every action a workflow ever took.
      await ctx.sql`
        UPDATE agent_runs SET plan = ${ctx.sql.json(asJson(planFromGraph(workflow, workflow.graph!)))}
        WHERE organization_id = ${ctx.organizationId} AND id = ${agentRunId}`
      await setRunStatus(ctx, agentRunId, 'running')
    }
    return { workflow, runId, agentRunId, actor, capacity }
  })

  const outcome: WorkflowRunOutcome = {
    runId: prepared.runId,
    workflowId: prepared.workflow.id,
    agentRunId: prepared.agentRunId,
    status: 'succeeded',
    simulated: input.simulated,
    occurrences: 1,
    windowFrom,
    windowTo,
    wouldHave: [],
    matched: 0,
    steps: [],
    approvalId: null,
    note: '',
    error: null,
    failureClass: null,
  }

  if (!prepared.capacity.allow) {
    outcome.status = 'skipped'
    outcome.note = prepared.capacity.reason
    return outcome
  }

  try {
    await walk(
      session,
      traceId,
      prepared.workflow,
      prepared.workflow.graph!,
      outcome,
      windowFrom,
      windowTo,
      prepared.capacity.remaining,
    )
  } catch (error) {
    outcome.status = 'failed'
    outcome.error = error instanceof Error ? error.message : String(error)
    // The class travels with the error (§5.6) and this used to throw it away, stamping every
    // workflow failure as 'tool' — a value that is not even in the taxonomy. A refusal, a
    // missing row and a budget are three different things to the person reading the run.
    outcome.failureClass = error instanceof SuperworkError ? error.failureClass : 'internal'
  }
  // Described here rather than inside the walk: a graph that stops at an approval returns
  // early, and a run with no sentence to show for it is a run nobody can read.
  outcome.note = describe(outcome)

  await withTenant({ ...session, traceId }, async (ctx) => {
    await closeRun(ctx, outcome)
    if (input.simulated) {
      const actor = await loadActor(ctx)
      await recordSimulation(ctx, actor, {
        workflowId: prepared.workflow.id,
        summary: summarize(outcome),
      })
    }
    if (prepared.agentRunId) {
      await setRunStatus(
        ctx,
        prepared.agentRunId,
        outcome.status === 'awaiting_approval' ? 'awaiting_approval' : outcome.status,
        {
          summary: outcome.note,
          ...(outcome.error
            ? { failureClass: outcome.failureClass ?? 'internal', failureDetail: outcome.error }
            : {}),
        },
      )
    }
  })

  return outcome
}

function summarize(outcome: WorkflowRunOutcome): SimulationSummary {
  return {
    runId: outcome.runId,
    occurrences: outcome.occurrences,
    wouldHave: outcome.wouldHave,
    windowFrom: outcome.windowFrom,
    windowTo: outcome.windowTo,
    passed: outcome.status !== 'failed',
    note: outcome.note,
  }
}

/**
 * Walks the graph from its trigger. Nodes are visited once, in dependency order; a node
 * whose predecessor produced nothing is recorded as skipped rather than silently dropped,
 * because "it did nothing" and "it never ran" are different answers.
 */
async function walk(
  session: RunSession,
  traceId: string,
  workflow: WorkflowView,
  graph: WorkflowGraph,
  outcome: WorkflowRunOutcome,
  windowFrom: Date,
  windowTo: Date,
  /** What is left of the workflow's daily action cap, or the per-run ceiling for a dry run. */
  remaining = MAX_ITEMS_PER_RUN,
): Promise<void> {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const order = topological(graph)
  let items: Record<string, unknown>[] = []
  let ordinal = 0
  const pending: PlannedAction[] = []
  const previews: PreviewLine[] = []

  for (const nodeId of order) {
    const node = byId.get(nodeId)
    if (!node) continue

    // Per node, not per walk (ADR 0053). The `try` used to sit around the whole walk, so a
    // node that threw left no row: the step list on the screen ended at the last thing that
    // worked, the run said it failed, and nothing said which step was the one. The reason is
    // written where a reader is already looking, and then re-thrown so the run still fails.
    const startedAt = Date.now()
    try {
    switch (node.type) {
      case 'trigger': {
        outcome.occurrences =
          graph.trigger.kind === 'schedule'
            ? countFirings(graph.trigger.spec, windowFrom, windowTo, session.timezone)
            : 1
        await step(session, traceId, outcome, ordinal++, node, 'succeeded', {
          durationMs: Date.now() - startedAt,
          detail:
            graph.trigger.kind === 'schedule'
              ? `${graph.trigger.description} — ${outcome.occurrences} firings in the last ${days(windowFrom, windowTo)} days`
              : 'Started by hand',
          wouldHave: outcome.simulated ? { firings: outcome.occurrences } : null,
        })
        break
      }

      case 'query': {
        const result = await withTenant({ ...session, traceId }, async (ctx) => {
          const actor = await loadActor(ctx)
          return runAggregate(ctx, actor, node.ref as AggregateQuery, (node.args ?? {}) as never)
        })
        const ceiling = Math.min(MAX_ITEMS_PER_RUN, Math.max(remaining, 0))
        items = result.rows.slice(0, ceiling)
        outcome.matched = result.rows.length
        await step(session, traceId, outcome, ordinal++, node, 'succeeded', {
          durationMs: Date.now() - startedAt,
          detail: `${result.rows.length} matched. ${result.basis}`,
          output: { total: result.total, basis: result.basis, matched: result.rows.length },
        })
        break
      }

      case 'for_each': {
        await step(session, traceId, outcome, ordinal++, node, items.length ? 'succeeded' : 'skipped', {
          durationMs: Date.now() - startedAt,
          detail: items.length
            ? `${items.length} to work through${outcome.matched > items.length ? ` — of ${outcome.matched}; the rest are over what this run may do and will be picked up next time` : ''}`
            : 'Nothing matched, so nothing was worked through.',
        })
        break
      }

      case 'action': {
        if (items.length === 0) {
          await step(session, traceId, outcome, ordinal++, node, 'skipped', {
            detail: 'Nothing to act on.',
            durationMs: Date.now() - startedAt,
          })
          break
        }
        const planned = items.map((item, index) => plan(node, item, index, workflow))
        const preview = await previewAll(session, traceId, outcome, planned)
        previews.push(...preview)
        pending.push(...planned)
        outcome.wouldHave.push({ label: node.label, count: planned.length })
        await step(session, traceId, outcome, ordinal++, node, 'succeeded', {
          durationMs: Date.now() - startedAt,
          detail: outcome.simulated
            ? `Would have run ${planned.length} × ${node.ref}`
            : `${planned.length} prepared for ${node.ref}`,
          wouldHave: outcome.simulated ? { tool: node.ref, count: planned.length, preview } : null,
        })
        break
      }

      case 'approval': {
        if (outcome.simulated || pending.length === 0) {
          await step(session, traceId, outcome, ordinal++, node, outcome.simulated ? 'succeeded' : 'skipped', {
            durationMs: Date.now() - startedAt,
            detail: outcome.simulated
              ? `Would have held ${pending.length} ${pending.length === 1 ? 'change' : 'changes'} for a person to approve.`
              : 'Nothing to approve.',
            wouldHave: outcome.simulated ? { held: pending.length } : null,
          })
          break
        }
        outcome.approvalId = await raiseApproval(session, traceId, workflow, outcome, previews)
        outcome.status = 'awaiting_approval'
        await step(session, traceId, outcome, ordinal++, node, 'awaiting_approval', {
          durationMs: Date.now() - startedAt,
          detail: `Waiting for a person to approve ${pending.length} ${pending.length === 1 ? 'change' : 'changes'}.`,
          output: { approvalId: outcome.approvalId, pending: pending.map(serialize) },
        })
        return
      }

      case 'notify': {
        if (outcome.simulated) {
          await step(session, traceId, outcome, ordinal++, node, 'succeeded', {
            durationMs: Date.now() - startedAt,
            detail: `Would have told ${items.length} ${items.length === 1 ? 'owner' : 'owners'} what happened.`,
            wouldHave: { notified: items.length },
          })
          break
        }
        const sent = await notifyOwners(session, traceId, workflow, items)
        await step(session, traceId, outcome, ordinal++, node, 'succeeded', {
          detail: `Told ${sent} ${sent === 1 ? 'person' : 'people'} what happened.`,
          durationMs: Date.now() - startedAt,
        })
        break
      }
    }
    } catch (error) {
      await step(session, traceId, outcome, ordinal++, node, 'failed', {
        detail: 'It stopped here.',
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      })
      throw error
    }
  }

  // No approval node and work to do: this graph acts on its own, which the compiler only
  // permits for reversible internal changes.
  if (!outcome.simulated && pending.length > 0 && outcome.status === 'succeeded') {
    await applyActions(session, traceId, outcome, pending)
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

interface PlannedAction {
  /** Stable within a run: what an approver's edit is addressed to. */
  key: string
  nodeId: string
  tool: string
  args: Record<string, unknown>
  label: string
}

function serialize(action: PlannedAction): Record<string, unknown> {
  return { key: action.key, nodeId: action.nodeId, tool: action.tool, args: action.args, label: action.label }
}

/**
 * Turns one matched row into one tool call. The mapping is explicit per tool: a workflow
 * never passes a row through to a tool wholesale, because a column that arrives from a
 * query is not an argument a person approved.
 */
function plan(node: WorkflowNode, item: Record<string, unknown>, index: number, workflow: WorkflowView): PlannedAction {
  const key = `${node.id}#${index}`
  const subject = String(item['subject'] ?? item['title'] ?? 'this')
  const company = item['company_name'] ? String(item['company_name']) : null

  if (node.ref === 'create_task@v1') {
    return {
      key,
      nodeId: node.id,
      tool: 'create_task@v1',
      args: {
        title: `Follow up: ${subject}`.slice(0, 300),
        assigneeId: item['owner_id'] ?? item['assignee_id'] ?? workflow.ownerUserId ?? null,
        priority: 'medium',
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
        ...(item['conversation_id'] ? { derivedFrom: { type: 'conversation', id: item['conversation_id'] } } : {}),
      },
      label: `Follow up: ${subject}`,
    }
  }
  if (node.ref === 'draft_email@v1') {
    return {
      key,
      nodeId: node.id,
      tool: 'draft_email@v1',
      args: {
        conversationId: item['conversation_id'] ?? null,
        companyId: item['company_id'] ?? null,
        subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
        referenceLastExchange: true,
      },
      label: company ? `Reply to ${company}` : `Reply about ${subject}`,
    }
  }
  return { key, nodeId: node.id, tool: node.ref ?? 'unknown', args: {}, label: node.label }
}

async function previewAll(
  session: RunSession,
  traceId: string,
  outcome: WorkflowRunOutcome,
  planned: PlannedAction[],
): Promise<PreviewLine[]> {
  return withTenant({ ...session, traceId }, async (ctx) => {
    const actor = await agentFor(ctx, outcome)
    const lines: PreviewLine[] = []
    for (const action of planned) {
      const tool = getTool(action.tool)
      if (!tool?.preview) continue
      const parsed = tool.inputSchema.safeParse(action.args)
      if (!parsed.success) continue
      try {
        const preview = await tool.preview(parsed.data, context(ctx, actor, outcome, action))
        lines.push(...preview.map((line) => ({ ...line, stepId: action.key })))
      } catch {
        // A preview that cannot be rendered is reported as such rather than hidden — an
        // approval card with a missing line is how people approve what they did not see.
        lines.push({
          operation: action.tool.replace(/@v\d+$/, '').replace(/_/g, ' '),
          entityType: 'workflow',
          entityLabel: action.label,
          changes: [{ field: 'Preview unavailable', to: 'this one will be shown at execution time' }],
          riskTier: tool.riskTier,
          reversible: tool.reversible,
        })
      }
    }
    return lines
  })
}

/** Executes the prepared calls. Same registry, same idempotency, same undo ledger. */
async function applyActions(
  session: RunSession,
  traceId: string,
  outcome: WorkflowRunOutcome,
  planned: PlannedAction[],
): Promise<void> {
  let undoOrdinal = 0
  let done = 0
  const failures: string[] = []

  for (const action of planned) {
    const applied = await withTenant({ ...session, traceId }, async (ctx) => {
      const tool = getTool(action.tool)
      if (!tool) return { ok: false, message: `No tool named "${action.tool}".` }
      const actor = await agentFor(ctx, outcome)
      const decision = can(
        actor,
        `${tool.requiredPermissions[0]?.split(':')[0] ?? 'task'}:${tool.requiredPermissions[0]?.split(':')[1] ?? 'read'}`,
        { type: 'workflow', organizationId: ctx.organizationId, riskTier: tool.riskTier },
      )
      // The permission check happens here as well as at the API — a workflow is not a way
      // around the policy engine, it is another caller of it.
      if (!decision.allow) return { ok: false, message: decision.reason }

      const parsed = tool.inputSchema.safeParse(action.args)
      if (!parsed.success) return { ok: false, message: parsed.error.issues.map((i) => i.message).join('; ') }

      // The same budget the agent runtime measures against, from the same counter: a workflow
      // is another caller of the tool registry, not a way around it (ADR 0050). Its own daily
      // action cap is about this automation; this one is about the system on the other end.
      const budget = await checkRateLimit(ctx, tool, outcome.agentRunId ?? null)
      if (!budget.allow) return { ok: false, message: budget.reason }

      const argsHash = hashArgs(tool.name, action.args)
      const idempotencyKey = `${outcome.runId}:${action.nodeId}:${argsHash}`
      const started = Date.now()
      const result = await tool.execute(parsed.data, context(ctx, actor, outcome, action, idempotencyKey))
      const toolCallId = await recordToolCall(ctx, outcome.agentRunId!, {
        stepId: null,
        toolName: tool.name,
        riskTier: tool.riskTier,
        input: redactInput(tool, parsed.data as Record<string, unknown>),
        output: result.ok ? result.value : { code: result.code, message: result.message },
        ok: result.ok,
        errorCode: result.ok ? null : result.code,
        errorMessage: result.ok ? null : result.message,
        idempotencyKey,
        argsHash,
        durationMs: Date.now() - started,
      })
      if (result.ok && tool.buildUndo) {
        const undo = tool.buildUndo(parsed.data, result.value)
        if (undo) {
          await recordUndo(ctx, outcome.agentRunId!, {
            ordinal: undoOrdinal++,
            toolCallId,
            forwardTool: tool.name,
            inverseTool: undo.tool,
            inverseInput: undo.input,
            entityType: undo.entityType,
            entityId: undo.entityId,
            description: undo.description,
          })
        }
      }
      return result.ok ? { ok: true, message: 'ok' } : { ok: false, message: result.message }
    })

    if (applied.ok) done += 1
    else failures.push(`${action.label} — ${applied.message}`)
  }

  outcome.wouldHave = [{ label: 'applied', count: done }]
  if (failures.length) {
    outcome.status = done > 0 ? 'succeeded' : 'failed'
    outcome.error = failures.join('; ')
  }
}

export interface SweepOutcome {
  claimed: number
  ran: number
  skipped: number
  awaitingApproval: number
  failed: number
  notes: string[]
}

/**
 * The scheduled sweep (§10.2). Called by the worker.
 *
 * Claiming and rescheduling happen in one transaction, so two workers divide the due
 * schedules between them rather than both firing the same one. Everything a firing did not
 * do — because it was late, because the last batch is still waiting for a person, because
 * the day's cap is spent — is counted and reported rather than dropped, because a workflow
 * that has quietly stopped working is worse than one that visibly stopped.
 */
export async function runDueWorkflows(session: RunSession, now = new Date()): Promise<SweepOutcome> {
  const traceId = randomUUID()
  const claimed = await withTenant({ ...session, traceId }, (ctx) => claimDueSchedules(ctx, 'workflow', 20, now))

  const outcome: SweepOutcome = { claimed: claimed.length, ran: 0, skipped: 0, awaitingApproval: 0, failed: 0, notes: [] }

  for (const schedule of claimed) {
    // A workflow schedule always addresses a row; the constraint guarantees it.
    if (!schedule.targetId) continue
    if (schedule.skipped > 0 && schedule.skippedReason) {
      outcome.skipped += schedule.skipped
      outcome.notes.push(`${schedule.targetId}: ${schedule.skippedReason}`)
    }
    for (let index = 0; index < schedule.runs; index += 1) {
      try {
        const run = await runWorkflow(session, { workflowId: schedule.targetId, trigger: 'schedule' })
        if (run.status === 'skipped') {
          outcome.skipped += 1
          outcome.notes.push(`${schedule.targetId}: ${run.note}`)
        } else if (run.status === 'awaiting_approval') {
          outcome.awaitingApproval += 1
          outcome.ran += 1
        } else if (run.status === 'failed') {
          outcome.failed += 1
          outcome.notes.push(`${schedule.targetId}: ${run.error ?? 'failed'}`)
        } else {
          outcome.ran += 1
        }
      } catch (error) {
        // A workflow that has been paused or deleted since the sweep began is not an
        // error worth retrying; it is reported once and the schedule stays advanced.
        outcome.failed += 1
        outcome.notes.push(`${schedule.targetId}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return outcome
}

/** Resumes a workflow run whose approval was decided. */
export async function continueWorkflowAfterApproval(
  session: RunSession,
  workflowRunId: string,
): Promise<WorkflowRunOutcome> {
  const traceId = randomUUID()
  const state = await withTenant({ ...session, traceId }, async (ctx) => {
    const [run] = await ctx.sql<
      { workflow_id: string; agent_run_ids: string[]; status: string; simulated: boolean }[]
    >`
      SELECT workflow_id, agent_run_ids, status::text AS status, simulated FROM workflow_runs
      WHERE organization_id = ${ctx.organizationId} AND id = ${workflowRunId}`
    if (!run) throw new Error('That workflow run does not exist.')
    const [step] = await ctx.sql<{ output: { pending?: Record<string, unknown>[]; approvalId?: string } }[]>`
      SELECT output FROM workflow_step_runs
      WHERE organization_id = ${ctx.organizationId} AND workflow_run_id = ${workflowRunId}
        AND node_type = 'approval'
      ORDER BY ordinal DESC LIMIT 1`
    const pending = (step?.output?.pending ?? []) as unknown as PlannedAction[]
    // What the approver actually approved is what runs. An edit made on the card is
    // applied here, to the argument it was addressed to, and to nothing else (§11.2).
    const approvalId = step?.output?.approvalId
    if (approvalId) {
      const actor = await loadActor(ctx)
      const approval = await getApproval(ctx, actor, approvalId)
      if (approval.status === 'approved_with_edits') {
        assertEditsAreOffered(approval.preview, approval.edits ?? undefined)
        const edits = (approval.edits?.['steps'] ?? {}) as Record<string, Record<string, unknown>>
        for (const action of pending) {
          const patch = edits[action.key]
          if (patch) action.args = { ...action.args, ...patch }
        }
      }
    }
    return { run, pending }
  })

  if (state.run.status !== 'awaiting_approval') {
    throw new Error(`That workflow run is ${state.run.status.replace(/_/g, ' ')}, not waiting for approval.`)
  }

  const outcome: WorkflowRunOutcome = {
    runId: workflowRunId,
    workflowId: state.run.workflow_id,
    agentRunId: state.run.agent_run_ids[0] ?? null,
    status: 'succeeded',
    simulated: false,
    occurrences: 1,
    windowFrom: new Date(),
    windowTo: new Date(),
    wouldHave: [],
    matched: state.pending.length,
    steps: [],
    approvalId: null,
    note: '',
    error: null,
    failureClass: null,
  }

  await applyActions(session, traceId, outcome, state.pending)
  outcome.note = describe(outcome)

  await withTenant({ ...session, traceId }, async (ctx) => {
    await closeRun(ctx, outcome)
    if (outcome.agentRunId) {
      await setRunStatus(ctx, outcome.agentRunId, outcome.status, { summary: outcome.note })
    }
  })
  return outcome
}

// ---------------------------------------------------------------------------
// Approvals and notifications
// ---------------------------------------------------------------------------

async function raiseApproval(
  session: RunSession,
  traceId: string,
  workflow: WorkflowView,
  outcome: WorkflowRunOutcome,
  preview: PreviewLine[],
): Promise<string> {
  return withTenant({ ...session, traceId }, async (ctx) => {
    const actor = await agentFor(ctx, outcome)
    return createApproval(ctx, actor, {
      title: `${workflow.name} — ${preview.length} ${preview.length === 1 ? 'change' : 'changes'}`,
      kind: 'workflow_run',
      riskTier: preview.some((line) => line.riskTier === 'high') ? 'high' : 'low',
      agentRunId: outcome.agentRunId,
      approverUserId: workflow.ownerUserId,
      preview,
      evidence: [
        {
          claim: workflow.readback || `Prepared by the workflow "${workflow.name}".`,
          sourceType: 'workflow',
          sourceId: workflow.id,
        },
        {
          claim: `${outcome.matched} ${outcome.matched === 1 ? 'item' : 'items'} matched the workflow's query.`,
          sourceType: 'aggregate',
        },
      ],
      requestedByLabel: workflow.name,
      policyReason:
        'A workflow prepared these. Nothing leaves the organization, and nothing irreversible happens, ' +
        'until a person decides here.',
    })
  })
}

async function notifyOwners(
  session: RunSession,
  traceId: string,
  workflow: WorkflowView,
  items: Record<string, unknown>[],
): Promise<number> {
  return withTenant({ ...session, traceId }, async (ctx) => {
    const owners = new Set(
      items.map((item) => item['owner_id'] ?? item['assignee_id']).filter((id): id is string => typeof id === 'string'),
    )
    for (const ownerId of owners) {
      await notify(ctx, {
        userId: ownerId,
        type: 'workflow',
        title: workflow.name,
        body: `${workflow.name} ran and prepared work on your accounts. Nothing was sent.`,
        entityType: 'workflow',
        entityId: workflow.id,
      })
    }
    return owners.size
  })
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

async function openRun(
  ctx: TenantContext,
  workflow: WorkflowView,
  simulated: boolean,
  trigger: string,
  cause?: Cause,
): Promise<string> {
  // The idempotency key is the dispatch record (ADR 0090). An event-triggered run keys itself by
  // the event, so the unique index — not a cursor, not a lease — is what stops the same event
  // running the same workflow twice. Everything else keys itself uniquely, as before.
  const key = cause?.idempotencyKey ?? `${workflow.currentVersionId}:${trigger}:${randomUUID()}`
  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO workflow_runs (
      organization_id, workflow_id, workflow_version_id, status, trigger, simulated,
      trigger_payload, run_depth, is_replay, idempotency_key, started_at, created_by
    ) VALUES (
      ${ctx.organizationId}, ${workflow.id}, ${workflow.currentVersionId}, 'running', ${trigger},
      ${simulated}, ${ctx.sql.json(asJson(cause?.payload ?? {}))}, ${cause?.depth ?? 0},
      ${cause?.isReplay ?? false}, ${key}, now(), ${ctx.userId}
    ) RETURNING id`
  await writeAudit(ctx, {
    actorType: 'user',
    actorId: ctx.userId,
    action: simulated ? 'workflow.simulated' : 'workflow.run',
    entityType: 'workflow',
    entityId: workflow.id,
    after: { runId: row!.id, trigger, eventId: cause?.eventId ?? null, depth: cause?.depth ?? 0 },
  })
  return row!.id
}

/**
 * One row per step, written once, in the state it ended in.
 *
 * `error` and `duration_ms` were declared on this table and written by nothing (ADR 0053).
 * `detail` says what the step *did* and is written for every step; `error` says why it failed
 * and exists only on a failure — the database holds both halves of that as a constraint, so
 * "it failed and we do not know what happened" cannot be stored by anybody.
 */
async function step(
  session: RunSession,
  traceId: string,
  outcome: WorkflowRunOutcome,
  ordinal: number,
  node: WorkflowNode,
  status: WorkflowStepOutcome['status'],
  extra: {
    detail: string
    output?: Record<string, unknown>
    wouldHave?: Record<string, unknown> | null
    /** Required when `status` is 'failed', and refused otherwise. */
    error?: string
    /** How long this node took. Null only where a step is recorded outside the walk. */
    durationMs?: number
  },
): Promise<void> {
  const error = status === 'failed' ? (extra.error?.trim() || 'It stopped here, and did not say why.') : null
  outcome.steps.push({
    nodeId: node.id,
    nodeType: node.type,
    label: node.label,
    status,
    detail: extra.detail,
    ...(error ? { error } : {}),
  })
  await withTenant({ ...session, traceId }, async (ctx) => {
    await ctx.sql`
      INSERT INTO workflow_step_runs (
        organization_id, workflow_run_id, node_id, node_type, ordinal, status, input, output,
        would_have, error, duration_ms, created_by
      ) VALUES (
        ${ctx.organizationId}, ${outcome.runId}, ${node.id}, ${node.type}, ${ordinal}, ${status},
        ${ctx.sql.json(asJson({ label: node.label, ref: node.ref ?? null, detail: extra.detail }))},
        ${extra.output ? ctx.sql.json(asJson(extra.output)) : null},
        ${extra.wouldHave ? ctx.sql.json(asJson(extra.wouldHave)) : null},
        ${error}, ${extra.durationMs ?? null}, ${ctx.userId}
      )`
  })
}

async function closeRun(ctx: TenantContext, outcome: WorkflowRunOutcome): Promise<void> {
  await ctx.sql`
    UPDATE workflow_runs
    SET status = ${outcome.simulated && outcome.status === 'succeeded' ? 'simulated' : outcome.status}::sw_workflow_run_status,
        finished_at = ${outcome.status === 'awaiting_approval' ? null : new Date()},
        error = ${outcome.error}
    WHERE organization_id = ${ctx.organizationId} AND id = ${outcome.runId}`
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function agentFor(ctx: TenantContext, outcome: WorkflowRunOutcome): Promise<Actor> {
  const actor = await loadActor(ctx)
  return asAgent(ctx, actor, {
    agentId: outcome.agentRunId ?? outcome.runId,
    agentName: 'Workflow',
    // A workflow never exceeds what its owner could do by hand, and never sends.
    mode: outcome.simulated ? 'ask' : 'execute',
    toolGrants: ['create_task@v1', 'draft_email@v1', 'update_task@v1', 'create_follow_up@v1'],
    maxSensitivity: 'confidential',
  })
}

function context(
  ctx: TenantContext,
  actor: Actor,
  outcome: WorkflowRunOutcome,
  action: PlannedAction,
  idempotencyKey?: string,
): ToolContext {
  return {
    organizationId: ctx.organizationId,
    principalUserId: actor.userId,
    agentRunId: outcome.agentRunId ?? outcome.runId,
    stepId: action.nodeId,
    idempotencyKey: idempotencyKey ?? `${outcome.runId}:${action.nodeId}:preview`,
    traceId: ctx.traceId,
    tenantDb: ctx,
    policy: actor,
    dryRun: outcome.simulated,
  }
}

function topological(graph: WorkflowGraph): string[] {
  const indegree = new Map<string, number>()
  for (const node of graph.nodes) indegree.set(node.id, indegree.get(node.id) ?? 0)
  for (const node of graph.nodes) {
    for (const next of node.next) indegree.set(next, (indegree.get(next) ?? 0) + 1)
  }
  const queue = graph.nodes.filter((node) => (indegree.get(node.id) ?? 0) === 0).map((node) => node.id)
  const byId = new Map(graph.nodes.map((node) => [node.id, node]))
  const order: string[] = []
  const seen = new Set<string>()
  while (queue.length) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    order.push(id)
    for (const next of byId.get(id)?.next ?? []) {
      const remaining = (indegree.get(next) ?? 1) - 1
      indegree.set(next, remaining)
      if (remaining <= 0) queue.push(next)
    }
  }
  // A cycle would leave nodes unvisited. They are appended rather than dropped, so a bad
  // graph shows up as a run that did something odd instead of a run that quietly did less.
  for (const node of graph.nodes) if (!seen.has(node.id)) order.push(node.id)
  return order
}

/**
 * How many times a schedule fired between two instants, in the timezone it is scheduled in.
 *
 * The same function the scheduler uses to find the next firing, so the number a dry run
 * reports is the number the worker will actually produce — a prediction computed a
 * different way from the thing it predicts is not a prediction.
 */
export function countFirings(spec: string, from: Date, to: Date, timeZone = 'UTC'): number {
  return occurrencesBetween(spec, timeZone, from, to).length
}

function days(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000)
}

/**
 * The sentence a person reads (§10.3.5). It separates what is counted from what is
 * projected: the firings are history, the effects are what one firing would do against
 * the data as it stands now. Multiplying the two would be a made-up number.
 */
function describe(outcome: WorkflowRunOutcome): string {
  if (outcome.status === 'failed') return `The run failed: ${outcome.error ?? 'unknown reason'}.`
  if (!outcome.simulated) {
    const applied = outcome.wouldHave.find((entry) => entry.label === 'applied')?.count ?? 0
    if (outcome.status === 'awaiting_approval') {
      return `Prepared ${outcome.matched} ${outcome.matched === 1 ? 'change' : 'changes'} and stopped for approval.`
    }
    return `Applied ${applied} ${applied === 1 ? 'change' : 'changes'}.`
  }

  const firings = `This would have fired ${outcome.occurrences} ${outcome.occurrences === 1 ? 'time' : 'times'} in the last ${days(outcome.windowFrom, outcome.windowTo)} days.`
  if (outcome.matched === 0) {
    return `${firings} Run against today's data it matches nothing, so it would have done nothing. That is a real result, not a failure — activate it if you expect that to change.`
  }
  const effects = outcome.wouldHave
    .filter((entry) => entry.count > 0)
    .map((entry) => `${entry.count} × ${entry.label.toLowerCase()}`)
    .join(', ')
  return `${firings} Run against today's data it matches ${outcome.matched} ${outcome.matched === 1 ? 'item' : 'items'} and would have done: ${effects}. Nothing was created, drafted or sent.`
}
