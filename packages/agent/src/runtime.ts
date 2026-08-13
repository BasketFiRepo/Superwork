import { randomUUID } from 'node:crypto'
import { withTenant, type TenantContext } from '@superwork/db'
import { env } from '@superwork/config'
import { asAgent, can, killSwitchEngaged, loadActor, type Actor } from '@superwork/auth'
import {
  BudgetError,
  checkSpendLimits,
  createApproval,
  record as recordUsageRecord,
  writeActivity,
  writeAudit,
  type EvidenceItem,
  type PreviewLine,
} from '@superwork/core'
import { completeWithFallback, loadPrompt, renderPrompt, assembleContext, type ContextBlock } from '@superwork/ai'
import { getTool, hashArgs, redactInput, visibleTools, type ToolContext } from '@superwork/tools'
import { PlanSchema, type GateOutcome, type GatedStep, type Plan, type RunEvent, type RunReport, type StartRunInput } from './types.js'
import { assertBudget, newBudget, recordUsage, registerCall, type BudgetState } from './budget.js'
import { ground } from './ground.js'
import { gatePlan } from './gate.js'
import { publish } from './bus.js'
import {
  addUsage,
  findCompletedCall,
  insertRun,
  markUntrusted,
  recordStep,
  recordToolCall,
  recordUndo,
  savePlan,
  saveReport,
  setRunStatus,
} from './persistence.js'

/**
 * The agent runtime (Part V).
 *
 *   Intake → Ground → Plan → Gate → Act → Observe → Reflect → Report → Persist
 *
 * Each phase opens its own short transaction, so a run that waits days for an approval
 * holds no connection, no lock and no worker slot.
 */

export interface RunSession {
  organizationId: string
  userId: string
  timezone: string
}

interface Phase {
  ordinal: number
}

export async function startRun(session: RunSession, input: StartRunInput): Promise<{ runId: string; traceId: string }> {
  const traceId = randomUUID()

  const runId = await withTenant({ ...session, traceId }, async (ctx) => {
    const actor = await loadActor(ctx)
    const decision = can(actor, 'agent_run:create', {
      type: 'agent_run',
      organizationId: ctx.organizationId,
      ownerId: actor.userId,
    })
    if (!decision.allow) throw new Error(decision.reason)

    const [org] = await ctx.sql<{ plan_tier: 'free' | 'team' | 'business' | 'enterprise'; is_demo: boolean }[]>`
      SELECT plan_tier, is_demo FROM organizations WHERE id = ${ctx.organizationId}`
    const spend = await checkSpendLimits(ctx, org?.plan_tier ?? 'free')
    if (!spend.allow) throw new BudgetError(spend.reason)

    const budget = newBudget()
    return insertRun(ctx, {
      principalUserId: actor.userId,
      agentId: await resolveAgentId(ctx, input.agentKey ?? 'orchestrator'),
      mode: input.mode,
      request: input.request,
      uiContext: input.uiContext ?? {},
      trigger: input.trigger ?? 'user',
      budget: {
        maxSteps: budget.maxSteps,
        maxToolCalls: budget.maxToolCalls,
        maxCostCents: budget.maxCostCents,
        maxWallClockMs: budget.maxWallClockMs,
      },
      aiMode: env().AI_MODE,
      isDemo: org?.is_demo ?? false,
    })
  })

  publish(runId, { type: 'run.started', runId, traceId })
  // Detached on purpose: the user may navigate away and the run continues (§5.8).
  void drive({ ...session, traceId }, runId, input).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error)
    publish(runId, { type: 'run.failed', failureClass: 'model', message })
    await withTenant({ ...session, traceId }, (ctx) =>
      setRunStatus(ctx, runId, 'failed', { failureClass: 'model', failureDetail: message }),
    ).catch(() => {})
  })

  return { runId, traceId }
}

async function drive(session: RunSession & { traceId: string }, runId: string, input: StartRunInput): Promise<void> {
  const phase: Phase = { ordinal: 0 }
  const budget = newBudget()

  // ---- Intake --------------------------------------------------------------
  const intake = await withTenant(session, async (ctx) => {
    await setRunStatus(ctx, runId, 'planning')
    await emitStep(ctx, runId, phase, {
      phase: 'intake',
      label: `Understanding the request`,
      status: 'succeeded',
      detail: { route: input.uiContext?.['route'] ?? null, mode: input.mode },
    })
    const actor = await loadActor(ctx)
    const killSwitch = await killSwitchEngaged(ctx)
    const [org] = await ctx.sql<{ name: string; industry: string | null }[]>`
      SELECT name, industry FROM organizations WHERE id = ${ctx.organizationId}`
    return { actor, killSwitch, orgName: org?.name ?? 'this organization', industry: org?.industry ?? 'operations' }
  })

  if (intake.killSwitch) {
    await withTenant(session, (ctx) =>
      setRunStatus(ctx, runId, 'aborted_by_admin', {
        failureClass: 'policy',
        failureDetail: 'Agent execution is halted organization-wide by the admin kill switch.',
      }),
    )
    publish(runId, {
      type: 'run.failed',
      failureClass: 'policy',
      message: 'Agent execution is halted organization-wide by the admin kill switch. An admin can re-enable it in Settings → AI Governance.',
    })
    return
  }

  const agentActor = await withTenant(session, (ctx) =>
    asAgent(ctx, intake.actor, {
      agentId: runId,
      agentName: 'Superwork',
      mode: input.mode,
      toolGrants: ['*'],
      maxSensitivity: 'confidential',
    }),
  )

  // ---- Ground --------------------------------------------------------------
  const grounded = await withTenant(session, async (ctx) => {
    const started = Date.now()
    const result = await ground(ctx, agentActor, input.request, {
      mode: input.mode,
      canDraft: input.mode === 'execute' || input.mode === 'assist',
      canExecuteLow: input.mode === 'execute' || input.mode === 'autopilot',
      canExecuteHigh: false,
    })
    await emitStep(ctx, runId, phase, {
      phase: 'ground',
      label: describeGrounding(result.grounding),
      status: 'succeeded',
      durationMs: Date.now() - started,
      detail: { aggregates: result.aggregatesRun, retrieval: result.retrievalNote },
    })
    if (result.containsUntrusted) {
      const downgraded = result.injectionFindings.length > 0
      await markUntrusted(ctx, runId, result.injectionFindings, downgraded)
      if (downgraded) {
        await emitStep(ctx, runId, phase, {
          phase: 'ground',
          label: `Suspicious content detected in ${result.injectionFindings.length} message(s) — capabilities downgraded`,
          status: 'succeeded',
          detail: { findings: result.injectionFindings },
        })
      }
    }
    return result
  })

  // A run that read untrusted content cannot take high-risk actions without a human (§5.9.3).
  const downgraded = grounded.injectionFindings.length > 0
  if (downgraded && agentActor.agent) agentActor.agent.capabilityDowngraded = true

  // ---- Plan ----------------------------------------------------------------
  const promptVars = {
    org: { name: intake.orgName, industry: intake.industry },
    user: {
      name: intake.actor.displayName,
      role: intake.actor.role,
      department: intake.actor.departmentIds[0] ?? 'the organization',
      timezone: session.timezone,
    },
    now: new Date().toISOString(),
    route_context: String(input.uiContext?.['route'] ?? 'unknown'),
    mode: input.mode,
    effective_capabilities: input.mode === 'ask' ? 'read only' : input.mode === 'assist' ? 'read and propose' : 'read, propose and reversible writes',
  }
  const system = renderPrompt(loadPrompt('system', 1), promptVars)
  const blocks = buildBlocks(grounded, agentActor, input)
  const assembly = assembleContext(blocks)

  const planStarted = Date.now()
  const planResponse = await completeWithFallback({
    taskClass: 'agent.plan',
    system,
    blocks: assembly.blocks,
    userMessage: input.request,
    grounding: grounded.grounding as unknown as Record<string, unknown>,
    outputSchema: planJsonSchema(),
  })

  if (planResponse.usage) {
    recordUsage(budget, planResponse.usage)
    await withTenant(session, async (ctx) => {
      await addUsage(ctx, runId, planResponse.usage!)
      await recordUsageRecord(ctx, {
        unit: 'tokens_in',
        quantity: planResponse.usage!.tokensIn,
        costCents: planResponse.usage!.costCents,
        model: planResponse.usage!.model,
        taskClass: 'agent.plan',
        agentRunId: runId,
      })
    })
  }

  const parsed = PlanSchema.safeParse(planResponse.json)
  if (!parsed.success) {
    await withTenant(session, (ctx) =>
      setRunStatus(ctx, runId, 'failed', {
        failureClass: 'model',
        failureDetail: `The planner returned output that did not match the plan contract: ${parsed.error.message}`,
      }),
    )
    publish(runId, {
      type: 'run.failed',
      failureClass: 'model',
      message: 'The planner returned malformed output. Nothing was changed.',
    })
    return
  }
  const plan: Plan = parsed.data

  // ---- Gate ----------------------------------------------------------------
  const gate = await withTenant(session, async (ctx) => {
    const outcome = await gatePlan(
      ctx,
      agentActor,
      plan,
      (step) => toolContext(ctx, agentActor, runId, step.id, step.tool, input.dryRun ?? false),
      intake.killSwitch,
    )
    await savePlan(ctx, runId, plan, outcome)
    await emitStep(ctx, runId, phase, {
      phase: 'plan',
      label: plan.steps.length ? `Planned ${plan.steps.length} steps` : 'Answering without changing anything',
      status: 'succeeded',
      durationMs: Date.now() - planStarted,
      detail: { intent: plan.intent, blocked: outcome.blocked.length },
    })
    await emitStep(ctx, runId, phase, {
      phase: 'gate',
      label: outcome.requiresApproval ? 'Checking permissions — approval required' : 'Checking permissions',
      status: 'succeeded',
      detail: {
        allowed: outcome.steps.filter((s) => s.allowed).length,
        blocked: outcome.blocked.map((s) => ({ tool: s.tool, reason: s.reason })),
      },
    })
    return outcome
  })

  publish(runId, { type: 'plan.ready', plan, gate })

  // ---- Answer-only path -----------------------------------------------------
  if (plan.answerOnly || gate.steps.filter((s) => s.allowed && s.riskTier !== 'read').length === 0) {
    await answerAndFinish(session, runId, phase, budget, system, assembly.blocks, input, grounded, plan, planResponse.degraded)
    return
  }

  // ---- Approval gate --------------------------------------------------------
  if (gate.requiresApproval) {
    const approvalId = await withTenant(session, async (ctx) => {
      const preview: PreviewLine[] = gate.steps.filter((s) => s.allowed).flatMap((s) => s.preview)
      const evidence = buildEvidence(grounded)
      const id = await createApproval(ctx, agentActor, {
        title: gate.approvalTitle,
        kind: 'agent_plan',
        riskTier: gate.riskTier,
        agentRunId: runId,
        preview,
        evidence,
        requestedByLabel: 'Superwork',
        policyReason: downgraded
          ? 'This run read untrusted external content, so every change is held for a person to approve.'
          : 'Changes proposed by an agent are held for approval before execution.',
      })
      await setRunStatus(ctx, runId, 'awaiting_approval')
      await emitStep(ctx, runId, phase, {
        phase: 'gate',
        label: 'Waiting for your approval',
        status: 'awaiting_approval',
        detail: { approvalId: id },
      })
      return id
    })
    publish(runId, { type: 'approval.required', approvalId, title: gate.approvalTitle })
    return
  }

  await executeApprovedPlan(session, runId, phase, budget, plan, gate, input, grounded, system, assembly.blocks, planResponse.degraded)
}

/** Resumes a run whose plan was approved. Called by the approvals API. */
export async function continueAfterApproval(
  session: RunSession & { traceId?: string },
  runId: string,
  edits?: Record<string, unknown>,
): Promise<void> {
  const traceId = session.traceId ?? randomUUID()
  const state = await withTenant({ ...session, traceId }, async (ctx) => {
    const [row] = await ctx.sql<{ plan: { plan: Plan; gate: GateOutcome }; request: string; mode: string; steps_used: number }[]>`
      SELECT plan, request, mode, steps_used FROM agent_runs
      WHERE organization_id = ${ctx.organizationId} AND id = ${runId}`
    return row ?? null
  })
  if (!state?.plan) throw new Error('This run has no stored plan to resume.')

  const phase: Phase = { ordinal: state.steps_used }
  const budget = newBudget()
  const plan = applyEdits(state.plan.plan, edits)

  void executeApprovedPlan(
    { ...session, traceId },
    runId,
    phase,
    budget,
    plan,
    state.plan.gate,
    { request: state.request, mode: state.mode as StartRunInput['mode'] },
    null,
    '',
    [],
    null,
  ).catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error)
    publish(runId, { type: 'run.failed', failureClass: 'transient', message })
    await withTenant({ ...session, traceId }, (ctx) =>
      setRunStatus(ctx, runId, 'failed', { failureClass: 'transient', failureDetail: message }),
    ).catch(() => {})
  })
}

async function executeApprovedPlan(
  session: RunSession & { traceId: string },
  runId: string,
  phase: Phase,
  budget: BudgetState,
  plan: Plan,
  gate: GateOutcome,
  input: Pick<StartRunInput, 'request' | 'mode' | 'dryRun'>,
  grounded: Awaited<ReturnType<typeof ground>> | null,
  system: string,
  blocks: ContextBlock[],
  degraded: string | null,
): Promise<void> {
  const outcome: RunReport['outcome'] = { created: 0, updated: 0, drafted: 0, sent: 0, skipped: [], failed: [] }
  let undoOrdinal = 0

  await withTenant(session, (ctx) => setRunStatus(ctx, runId, 'running'))

  for (const step of gate.steps) {
    if (!step.allowed) {
      outcome.skipped.push(`${step.tool.replace(/@v\d+$/, '')} — ${step.reason}`)
      await withTenant(session, (ctx) =>
        emitStep(ctx, runId, phase, {
          phase: 'act',
          label: `Skipped ${step.tool.replace(/@v\d+$/, '').replace(/_/g, ' ')}`,
          status: 'skipped',
          toolName: step.tool,
          errorClass: 'permission',
          errorMessage: step.reason,
        }),
      )
      continue
    }

    try {
      assertBudget(budget)
    } catch (error) {
      if (error instanceof BudgetError) {
        await finishBudgetExceeded(session, runId, phase, outcome, error.message)
        return
      }
      throw error
    }

    const executed = await runStep(session, runId, phase, budget, step, input.dryRun ?? false, undoOrdinal)
    if (executed.undoRecorded) undoOrdinal += 1

    if (executed.ok) {
      if (step.tool.startsWith('create_task')) outcome.created += 1
      else if (step.tool.startsWith('draft_email')) outcome.drafted += 1
      else if (step.tool.startsWith('send_email')) outcome.sent += 1
      else outcome.updated += 1
    } else if (executed.looping) {
      outcome.failed.push(`${step.tool} repeated identical calls and was stopped`)
    } else {
      outcome.failed.push(`${step.tool.replace(/@v\d+$/, '')} — ${executed.message}`)
    }
  }

  // ---- Report ---------------------------------------------------------------
  const report = await withTenant(session, async (ctx) => {
    const narrativeResponse = await completeWithFallback({
      taskClass: 'agent.report',
      system: system || 'Summarize what changed, plainly and honestly.',
      blocks,
      userMessage: input.request,
      grounding: {
        outcome,
        needsAttention: plan.needsAttention,
        injectionWarnings: grounded?.injectionFindings ?? [],
      },
    })
    if (narrativeResponse.usage) {
      recordUsage(budget, narrativeResponse.usage)
      await addUsage(ctx, runId, narrativeResponse.usage)
    }

    const citations = grounded ? await persistCitations(ctx, runId, grounded) : []
    const built: RunReport = {
      narrative: String((narrativeResponse.json as { text?: string })?.text ?? narrativeResponse.text),
      outcome,
      citations,
      needsAttention: plan.needsAttention,
      undoable: undoOrdinal > 0,
      degraded: degraded ?? narrativeResponse.degraded,
      simulated: narrativeResponse.simulated,
      injectionWarnings: grounded?.injectionFindings ?? [],
    }
    await saveReport(ctx, runId, built)
    await setRunStatus(ctx, runId, outcome.failed.length && !outcome.created && !outcome.updated ? 'failed' : 'succeeded')
    await emitStep(ctx, runId, phase, { phase: 'report', label: 'Reported what changed', status: 'succeeded' })
    await recordUsageRecord(ctx, { unit: 'agent_run', quantity: 1, costCents: budget.costCents, agentRunId: runId })
    await writeActivity(ctx, {
      actorType: 'agent',
      actorUserId: session.userId,
      actorLabel: 'Superwork',
      verb: 'completed a run',
      entityType: 'agent_run',
      entityId: runId,
      entityLabel: input.request.slice(0, 80),
      summary: built.narrative,
      agentRunId: runId,
    })
    return built
  })

  publish(runId, { type: 'run.completed', status: 'succeeded', report, costCents: budget.costCents })
}

async function runStep(
  session: RunSession & { traceId: string },
  runId: string,
  phase: Phase,
  budget: BudgetState,
  step: GatedStep,
  dryRun: boolean,
  undoOrdinal: number,
): Promise<{ ok: boolean; message: string; looping: boolean; undoRecorded: boolean }> {
  const tool = getTool(step.tool) ?? getTool(`${step.tool}@v1`)
  if (!tool) return { ok: false, message: 'tool not found', looping: false, undoRecorded: false }

  const argsHash = hashArgs(tool.name, step.args)
  const loop = registerCall(budget, argsHash)
  if (loop.looping) {
    return { ok: false, message: 'identical call repeated three times', looping: true, undoRecorded: false }
  }

  // Idempotency key derived from (run_id, step_id) — a resumed run never repeats an effect.
  const idempotencyKey = `${runId}:${step.id}:${argsHash}`

  return withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const agentActor = await asAgent(ctx, actor, {
      agentId: runId,
      agentName: 'Superwork',
      mode: 'execute',
      toolGrants: ['*'],
      maxSensitivity: 'confidential',
    })

    const stepId = await emitStep(ctx, runId, phase, {
      phase: 'act',
      label: describeStep(tool.name, step),
      status: 'running',
      toolName: tool.name,
      riskTier: tool.riskTier,
    })

    publish(runId, { type: 'tool.called', tool: tool.name, riskTier: tool.riskTier, args: redactInput(tool, step.args) })

    const existing = await findCompletedCall(ctx, idempotencyKey)
    if (existing?.ok) {
      await recordStep(ctx, runId, {
        ordinal: phase.ordinal - 1,
        phase: 'act',
        label: `${describeStep(tool.name, step)} (already done)`,
        status: 'succeeded',
        toolName: tool.name,
        riskTier: tool.riskTier,
      })
      return { ok: true, message: 'already applied', looping: false, undoRecorded: false }
    }

    const started = Date.now()
    const parsed = tool.inputSchema.safeParse(step.args)
    if (!parsed.success) {
      await recordStep(ctx, runId, {
        ordinal: phase.ordinal - 1,
        phase: 'act',
        label: describeStep(tool.name, step),
        status: 'failed',
        toolName: tool.name,
        riskTier: tool.riskTier,
        errorClass: 'validation',
        errorMessage: parsed.error.message,
      })
      return { ok: false, message: 'invalid arguments', looping: false, undoRecorded: false }
    }

    let result: Awaited<ReturnType<typeof tool.execute>>
    try {
      result = await withTimeout(
        tool.execute(parsed.data, toolContext(ctx, agentActor, runId, step.id, tool.name, dryRun, idempotencyKey)),
        tool.timeoutMs,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await recordStep(ctx, runId, {
        ordinal: phase.ordinal - 1,
        phase: 'act',
        label: describeStep(tool.name, step),
        status: 'failed',
        toolName: tool.name,
        riskTier: tool.riskTier,
        errorClass: classifyError(error),
        errorMessage: message,
        durationMs: Date.now() - started,
      })
      publish(runId, { type: 'tool.result', tool: tool.name, ok: false, summary: message })
      return { ok: false, message, looping: false, undoRecorded: false }
    }

    const durationMs = Date.now() - started
    const toolCallId = await recordToolCall(ctx, runId, {
      stepId,
      toolName: tool.name,
      riskTier: tool.riskTier,
      input: redactInput(tool, parsed.data as Record<string, unknown>),
      output: result.ok ? result.value : { code: result.code, message: result.message },
      ok: result.ok,
      errorCode: result.ok ? null : result.code,
      errorMessage: result.ok ? null : result.message,
      idempotencyKey,
      argsHash,
      durationMs,
    })

    await recordStep(ctx, runId, {
      ordinal: phase.ordinal - 1,
      phase: result.ok ? 'observe' : 'act',
      label: describeStep(tool.name, step),
      status: result.ok ? 'succeeded' : 'failed',
      toolName: tool.name,
      riskTier: tool.riskTier,
      durationMs,
      ...(result.ok ? {} : { errorClass: result.code, errorMessage: result.message }),
    })

    publish(runId, {
      type: 'tool.result',
      tool: tool.name,
      ok: result.ok,
      summary: result.ok ? summarizeOutput(result.value) : result.message,
    })

    let undoRecorded = false
    if (result.ok && tool.buildUndo) {
      const undo = tool.buildUndo(parsed.data, result.value)
      if (undo) {
        await recordUndo(ctx, runId, {
          ordinal: undoOrdinal,
          toolCallId,
          forwardTool: tool.name,
          inverseTool: undo.tool,
          inverseInput: undo.input,
          entityType: undo.entityType,
          entityId: undo.entityId,
          description: undo.description,
        })
        undoRecorded = true
      }
    }

    return {
      ok: result.ok,
      message: result.ok ? 'ok' : result.message,
      looping: false,
      undoRecorded,
    }
  })
}

async function answerAndFinish(
  session: RunSession & { traceId: string },
  runId: string,
  phase: Phase,
  budget: BudgetState,
  system: string,
  blocks: ContextBlock[],
  input: StartRunInput,
  grounded: Awaited<ReturnType<typeof ground>>,
  plan: Plan,
  degraded: string | null,
): Promise<void> {
  const response = await completeWithFallback({
    taskClass: 'agent.answer',
    system,
    blocks,
    userMessage: input.request,
    grounding: grounded.grounding as unknown as Record<string, unknown>,
  })

  const answer = (response.json ?? {}) as { text?: string; citations?: { claim: string; knowledgeIndex: number }[] }
  const text = answer.text ?? response.text

  for (const word of text.split(/(\s+)/)) publish(runId, { type: 'text', delta: word })

  const report = await withTenant(session, async (ctx) => {
    if (response.usage) {
      recordUsage(budget, response.usage)
      await addUsage(ctx, runId, response.usage)
      await recordUsageRecord(ctx, {
        unit: 'tokens_out',
        quantity: response.usage.tokensOut,
        costCents: response.usage.costCents,
        model: response.usage.model,
        taskClass: 'agent.answer',
        agentRunId: runId,
      })
    }
    const citations = await persistCitations(ctx, runId, grounded, answer.citations)
    const built: RunReport = {
      narrative: text,
      outcome: { created: 0, updated: 0, drafted: 0, sent: 0, skipped: [], failed: [] },
      citations,
      needsAttention: plan.needsAttention,
      undoable: false,
      degraded: degraded ?? response.degraded,
      simulated: response.simulated,
      injectionWarnings: grounded.injectionFindings,
    }
    await saveReport(ctx, runId, built)
    await setRunStatus(ctx, runId, 'succeeded')
    await emitStep(ctx, runId, phase, { phase: 'report', label: 'Answered with citations', status: 'succeeded' })
    await recordUsageRecord(ctx, { unit: 'agent_run', quantity: 1, costCents: budget.costCents, agentRunId: runId })
    return built
  })

  publish(runId, { type: 'run.completed', status: 'succeeded', report, costCents: budget.costCents })
}

async function finishBudgetExceeded(
  session: RunSession & { traceId: string },
  runId: string,
  phase: Phase,
  outcome: RunReport['outcome'],
  message: string,
): Promise<void> {
  const report: RunReport = {
    narrative: `${message} I stopped there rather than continuing. ${outcome.created} created, ${outcome.updated} updated, ${outcome.drafted} drafted, nothing sent.`,
    outcome,
    citations: [],
    needsAttention: [],
    undoable: outcome.created > 0 || outcome.updated > 0,
    degraded: null,
    simulated: false,
    injectionWarnings: [],
  }
  await withTenant(session, async (ctx) => {
    await saveReport(ctx, runId, report)
    await setRunStatus(ctx, runId, 'budget_exceeded', { failureClass: 'budget', failureDetail: message })
    await emitStep(ctx, runId, phase, { phase: 'reflect', label: 'Stopped — budget reached', status: 'failed', errorClass: 'budget', errorMessage: message })
  })
  publish(runId, { type: 'run.completed', status: 'budget_exceeded', report, costCents: 0 })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function emitStep(
  ctx: TenantContext,
  runId: string,
  phase: Phase,
  step: {
    phase: string
    label: string
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'awaiting_approval'
    toolName?: string
    riskTier?: string
    durationMs?: number
    detail?: Record<string, unknown>
    errorClass?: string
    errorMessage?: string
  },
): Promise<string> {
  const ordinal = phase.ordinal++
  const id = await recordStep(ctx, runId, { ordinal, ...step })
  publish(runId, { type: 'step.started', ordinal, phase: step.phase, label: step.label })
  publish(runId, {
    type: 'step.finished',
    ordinal,
    status: step.status,
    durationMs: step.durationMs ?? 0,
    ...(step.detail ? { detail: step.detail } : {}),
  })
  return id
}

function toolContext(
  ctx: TenantContext,
  actor: Actor,
  runId: string,
  stepId: string,
  toolName: string,
  dryRun: boolean,
  idempotencyKey?: string,
): ToolContext {
  return {
    organizationId: ctx.organizationId,
    principalUserId: actor.userId,
    agentRunId: runId,
    stepId,
    idempotencyKey: idempotencyKey ?? `${runId}:${stepId}:${toolName}`,
    traceId: ctx.traceId,
    tenantDb: ctx,
    policy: actor,
    dryRun,
  }
}

function buildBlocks(
  grounded: Awaited<ReturnType<typeof ground>>,
  actor: Actor,
  input: StartRunInput,
): ContextBlock[] {
  const blocks: ContextBlock[] = [
    {
      zone: 'actor',
      trust: 'trusted_system',
      label: 'Acting on behalf of',
      data: { name: actor.displayName, role: actor.role, mode: input.mode },
    },
    {
      zone: 'task_context',
      trust: 'trusted_system',
      label: 'Where the user is',
      data: input.uiContext ?? {},
    },
  ]

  for (const [name, agg] of Object.entries(grounded.grounding.aggregates)) {
    blocks.push({
      zone: 'task_context',
      trust: 'org_data',
      label: `Aggregate: ${name}`,
      data: { basis: agg.basis, rows: agg.rows },
      sourceId: name,
    })
  }

  for (const chunk of grounded.grounding.knowledge) {
    blocks.push({
      zone: 'knowledge',
      trust: 'org_data',
      label: `${chunk.documentTitle}${chunk.headingPath ? ` › ${chunk.headingPath}` : ''}`,
      text: chunk.content,
      sourceId: chunk.documentId,
    })
  }

  // Untrusted external content is fenced in its own zone and never enters the
  // instruction region (§5.9.2).
  for (const item of grounded.grounding.untrusted) {
    blocks.push({
      zone: 'external',
      trust: 'untrusted_external',
      label: item.label,
      data: { flagged: item.flagged, patterns: item.patterns },
      sourceId: item.sourceId,
    })
  }

  const visible = visibleTools(actor, 'orchestrator', actor.organizationId)
  blocks.push({
    zone: 'tools',
    trust: 'trusted_system',
    label: 'Tools available to you',
    data: visible.map((t) => ({ name: t.name, description: t.description, riskTier: t.riskTier })),
  })

  return blocks
}

function buildEvidence(grounded: Awaited<ReturnType<typeof ground>>): EvidenceItem[] {
  const evidence: EvidenceItem[] = []
  for (const [name, agg] of Object.entries(grounded.grounding.aggregates)) {
    if (agg.rows.length === 0) continue
    evidence.push({
      claim: `${agg.rows.length} rows from ${name.replace(/_/g, ' ')}. ${agg.basis}`,
      sourceType: 'query_aggregate',
      sourceId: name,
    })
  }
  for (const chunk of grounded.grounding.knowledge.slice(0, 3)) {
    evidence.push({
      claim: chunk.content.slice(0, 180),
      sourceType: 'document_chunk',
      documentId: chunk.documentId,
      anchor: chunk.anchor,
      snippet: chunk.content.slice(0, 400),
    })
  }
  return evidence
}

async function persistCitations(
  ctx: TenantContext,
  runId: string,
  grounded: Awaited<ReturnType<typeof ground>>,
  requested?: { claim: string; knowledgeIndex: number }[],
): Promise<RunReport['citations']> {
  const list = requested?.length
    ? requested
        .map((c) => ({ claim: c.claim, chunk: grounded.grounding.knowledge[c.knowledgeIndex] }))
        .filter((c) => c.chunk)
    : grounded.grounding.knowledge.slice(0, 4).map((chunk) => ({ claim: chunk.content.slice(0, 160), chunk }))

  const citations: RunReport['citations'] = []
  let ordinal = 0
  for (const item of list) {
    const chunk = item.chunk!
    await ctx.sql`
      INSERT INTO citations (organization_id, run_id, claim, source_type, source_id, document_id, anchor, snippet, ordinal, created_by)
      VALUES (${ctx.organizationId}, ${runId}, ${item.claim}, 'document_chunk', NULL, ${chunk.documentId},
              ${chunk.anchor}, ${chunk.content.slice(0, 400)}, ${ordinal}, ${ctx.userId})`
    citations.push({
      claim: item.claim,
      sourceType: 'document_chunk',
      documentId: chunk.documentId,
      documentTitle: chunk.documentTitle,
      anchor: chunk.anchor,
      snippet: chunk.content.slice(0, 400),
    })
    ordinal += 1
  }

  // Aggregate-derived figures are cited too — a number without a basis is a defect.
  for (const [name, agg] of Object.entries(grounded.grounding.aggregates)) {
    if (agg.rows.length === 0) continue
    await ctx.sql`
      INSERT INTO citations (organization_id, run_id, claim, source_type, source_id, anchor, snippet, ordinal, created_by)
      VALUES (${ctx.organizationId}, ${runId}, ${`${agg.rows.length} rows — ${agg.basis}`}, 'query_aggregate', NULL,
              ${name}, ${agg.basis}, ${ordinal}, ${ctx.userId})`
    citations.push({ claim: `${agg.rows.length} rows — ${agg.basis}`, sourceType: 'query_aggregate', anchor: name })
    ordinal += 1
  }

  return citations
}

async function resolveAgentId(ctx: TenantContext, key: string): Promise<string | null> {
  const [row] = await ctx.sql<{ id: string }[]>`
    SELECT id FROM agents WHERE organization_id = ${ctx.organizationId} AND key = ${key} AND deleted_at IS NULL`
  return row?.id ?? null
}

function describeGrounding(g: { aggregates: Record<string, { rows: unknown[] }>; knowledge: unknown[] }): string {
  const parts: string[] = []
  const stale = g.aggregates['stale_customer_threads']?.rows.length
  const overdue = g.aggregates['tasks_overdue']?.rows.length
  if (stale) parts.push(`${stale} customer threads`)
  if (overdue) parts.push(`${overdue} overdue tasks`)
  if (g.knowledge.length) parts.push(`${g.knowledge.length} document passages`)
  return parts.length ? `Read ${parts.join(', ')}` : 'Read company memory'
}

function describeStep(toolName: string, step: GatedStep): string {
  const verb = toolName.replace(/@v\d+$/, '').replace(/_/g, ' ')
  const title = step.args['title'] ?? step.args['subject']
  return typeof title === 'string' ? `${capitalize(verb)}: ${title}` : capitalize(verb)
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function summarizeOutput(value: unknown): string {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record['title'] === 'string') return String(record['title'])
    if (typeof record['subject'] === 'string') return String(record['subject'])
    if (Array.isArray(record['rows'])) return `${record['rows'].length} rows`
    if (Array.isArray(record['results'])) return `${record['results'].length} results`
  }
  return 'done'
}

function classifyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/timed out/i.test(message)) return 'transient'
  if (/permission|access/i.test(message)) return 'permission'
  if (/not found/i.test(message)) return 'not_found'
  return 'transient'
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Tool timed out after ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    clearTimeout(timer!)
  }
}

function applyEdits(plan: Plan, edits?: Record<string, unknown>): Plan {
  if (!edits) return plan
  const stepEdits = edits['steps'] as Record<string, Record<string, unknown>> | undefined
  if (!stepEdits) return plan
  return {
    ...plan,
    steps: plan.steps.map((step) => (stepEdits[step.id] ? { ...step, args: { ...step.args, ...stepEdits[step.id] } } : step)),
  }
}

function planJsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    required: ['intent', 'summary', 'answerOnly', 'steps'],
    properties: {
      intent: { type: 'string' },
      summary: { type: 'string' },
      answerOnly: { type: 'boolean' },
      steps: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'tool', 'args', 'intent'],
          properties: {
            id: { type: 'string' },
            tool: { type: 'string' },
            args: { type: 'object' },
            intent: { type: 'string' },
          },
        },
      },
      needsAttention: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            reason: { type: 'string' },
            entityType: { type: 'string' },
            entityId: { type: 'string' },
          },
        },
      },
    },
  }
}

export type { RunEvent }
