import { randomUUID } from 'node:crypto'
import { withTenant, type TenantContext } from '@superwork/db'
import { env } from '@superwork/config'
import { asAgent, can, killSwitchEngaged, loadActor, type Actor } from '@superwork/auth'
import {
  BudgetError,
  checkSpendLimits,
  claimNextRun,
  createApproval,
  enqueueRun,
  certificationState,
  personaForKey,
  proposeMemories,
  record as recordUsageRecord,
  writeActivity,
  writeAudit,
  type EvidenceItem,
  type MemoryCandidate,
  type PreviewLine,
} from '@superwork/core'
import { completeWithFallback, loadSystemPrompt, renderPrompt, assembleContext, type ContextBlock } from '@superwork/ai'
import {
  checkRateLimit,
  customToolsFor,
  hashArgs,
  redactInput,
  resolveTool,
  visibleTools,
  type Tool,
  type ToolContext,
} from '@superwork/tools'
import {
  PlanSchema,
  type GateOutcome,
  type GatedStep,
  type Plan,
  type RunEvent,
  type RunPersona,
  type RunReport,
  type StartRunInput,
} from './types.js'
import { assertBudget, newBudget, recordUsage, registerCall, type BudgetState } from './budget.js'
import { ground } from './ground.js'
import { gatePlan } from './gate.js'
import { checkAutopilotCaps, pauseForCap } from './autopilot.js'
import { publish } from './bus.js'
import {
  recordMessage,
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
    const id = await insertRun(ctx, {
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

    // The department is resolved once, here: a membership change later must not silently
    // re-class work that is already waiting.
    await enqueueRun(ctx, {
      runId: id,
      departmentId: actor.departmentIds[0] ?? null,
      queueClass: input.queueClass ?? 'interactive',
    })
    return id
  })

  publish(runId, { type: 'run.started', runId, traceId })
  // The run is queued, not started. The fair-share scheduler decides which department
  // goes next; when nothing else is waiting, that is this run, immediately (§26.6).
  pendingInputs.set(runId, input)
  void pump(session)

  return { runId, traceId }
}

/**
 * The drain loop (§26.6).
 *
 * Runs are claimed through the fair-share scheduler rather than started where they were
 * created, so a department that queues two hundred jobs at 09:00 cannot push everybody
 * else behind them. When nothing else is waiting the claim is immediate, so an
 * interactive run still starts in milliseconds.
 *
 * `pendingInputs` carries the parts of a request that are not columns — a proposed
 * persona, the plan-only flag — for runs enqueued by this process. A run claimed after a
 * restart is reconstructed from its row, which is why those two fields belong to
 * simulations only.
 */
const pendingInputs = new Map<string, StartRunInput>()
let inFlight = 0

export function inFlightRuns(): number {
  return inFlight
}

export async function pump(session: RunSession, worker = `web-${process.pid}`): Promise<number> {
  let started = 0
  const ceiling = env().AGENT_MAX_CONCURRENT

  while (inFlight < ceiling) {
    const claimed = await withTenant(session, (ctx) => claimNextRun(ctx, worker)).catch(() => null)
    if (!claimed) break

    const stored = pendingInputs.get(claimed.runId)
    pendingInputs.delete(claimed.runId)
    const input = stored ?? (await withTenant(session, (ctx) => inputFromRow(ctx, claimed.runId)))
    if (!input) continue

    const traceId = randomUUID()
    inFlight += 1
    started += 1
    // Detached on purpose: the user may navigate away and the run continues (§5.8).
    void drive({ ...session, traceId }, claimed.runId, input)
      .catch(async (error) => {
        const message = error instanceof Error ? error.message : String(error)
        publish(claimed.runId, { type: 'run.failed', failureClass: 'model', message })
        await withTenant({ ...session, traceId }, (ctx) =>
          setRunStatus(ctx, claimed.runId, 'failed', { failureClass: 'model', failureDetail: message }),
        ).catch(() => {})
      })
      .finally(() => {
        inFlight -= 1
        // A finished run frees a slot; the next department in line takes it.
        void pump(session, worker).catch(() => {})
      })
  }

  return started
}

/** Rebuilds a request from the row, for runs this process did not enqueue. */
async function inputFromRow(ctx: TenantContext, runId: string): Promise<StartRunInput | null> {
  const [row] = await ctx.sql<
    {
      request: string
      mode: StartRunInput['mode']
      trigger: StartRunInput['trigger']
      ui_context: Record<string, unknown>
      agent_key: string | null
    }[]
  >`
    SELECT r.request, r.mode, r.trigger, r.ui_context, a.key AS agent_key
    FROM agent_runs r
    LEFT JOIN agents a ON a.id = r.agent_id
    WHERE r.organization_id = ${ctx.organizationId} AND r.id = ${runId}`
  if (!row) return null
  return {
    request: row.request,
    mode: row.mode,
    trigger: row.trigger,
    uiContext: row.ui_context,
    ...(row.agent_key ? { agentKey: row.agent_key } : {}),
  }
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
    const [org] = await ctx.sql<{ name: string; industry: string | null; tone: string | null }[]>`
      SELECT name, industry, profile->>'tone' AS tone
      FROM organizations WHERE id = ${ctx.organizationId}`
    const persona = input.persona ?? (await resolvePersona(ctx, input.agentKey ?? 'orchestrator'))
    // This tenant's own tools, resolved once per run. They are ordinary tools from here on.
    const tenantTools = await customToolsFor(ctx)
    return {
      actor,
      killSwitch,
      persona,
      tenantTools,
      orgName: org?.name ?? 'this organization',
      industry: org?.industry ?? 'operations',
      // The organization's own note about tone, which nothing read before ADR 0052. Phrased
      // here rather than in the prompt file so that an organization which has not said
      // anything contributes nothing, instead of an empty instruction.
      tone: org?.tone ? `This organization asks to be written to like this: ${org.tone}` : '',
    }
  })

  if (intake.persona.status === 'paused' || intake.persona.status === 'retired') {
    await withTenant(session, (ctx) =>
      setRunStatus(ctx, runId, 'failed', {
        failureClass: 'policy',
        failureDetail: `${intake.persona.name} is ${intake.persona.status}.`,
      }),
    )
    publish(runId, {
      type: 'run.failed',
      failureClass: 'policy',
      message: `${intake.persona.name} is ${intake.persona.status} and will not run until somebody turns it back on.`,
    })
    return
  }

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

  // The persona is data: an agent's grants, clearance and mode ceiling are columns the
  // studio writes and the gate enforces, so "structurally incapable of writing" is a
  // property of the row rather than a sentence in a prompt (§27.2).
  const persona = intake.persona
  // Nobody has stood behind this configuration recently enough to let it act unattended, so
  // the ceiling drops one rung and the run says so rather than failing (ADR 0068). Everything
  // short of autopilot still works: the agent goes on proposing and doing reversible things,
  // and a person is back in the loop for the rest.
  const withheld = persona.autopilotWithheldReason ?? null
  const ceiling = withheld && persona.mode === 'autopilot' ? 'execute' : persona.mode
  const effectiveMode = narrowerMode(input.mode, ceiling)
  const agentActor = await withTenant(session, (ctx) =>
    asAgent(ctx, intake.actor, {
      agentId: runId,
      agentName: persona.name,
      mode: effectiveMode,
      toolGrants: persona.toolGrants,
      maxSensitivity: persona.maxSensitivity,
    }),
  )

  // A ceiling that drops silently is a ceiling nobody can appeal. This says which review is
  // outstanding, on the run's own timeline, where the person reading the result will see it.
  if (withheld && persona.mode === 'autopilot') {
    await withTenant(session, (ctx) =>
      emitStep(ctx, runId, phase, {
        phase: 'intake',
        label: `Not running unattended — ${withheld}`,
        status: 'succeeded',
        detail: { requested: input.mode, running_as: effectiveMode, reason: withheld },
      }),
    )
  }

  // ---- Ground --------------------------------------------------------------
  const grounded = await withTenant(session, async (ctx) => {
    const started = Date.now()
    const result = await ground(ctx, agentActor, input.request, {
      mode: effectiveMode,
      canDraft: effectiveMode === 'execute' || effectiveMode === 'assist',
      canExecuteLow: effectiveMode === 'execute' || effectiveMode === 'autopilot',
      canExecuteHigh: false,
      uiContext: input.uiContext ?? {},
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
    org: { name: intake.orgName, industry: intake.industry, tone: intake.tone },
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
  const system = renderPrompt(loadSystemPrompt(), promptVars)
  const blocks = buildBlocks(grounded, agentActor, input, intake.tenantTools)
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
      // One writer: the message row carries the cost, the metering row is written from the
      // same numbers, and the run's totals are recomputed from the messages by a trigger.
      await recordMessage(ctx, runId, {
        taskClass: 'agent.plan',
        content: JSON.stringify(planResponse.json ?? planResponse.text),
        simulated: planResponse.simulated,
        usage: planResponse.usage!,
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
      intake.tenantTools,
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

  // ---- Plan-only path -------------------------------------------------------
  // A simulation stops here. It has read the same data, produced the same plan and been
  // through the same gate; the only difference is that nothing happens next (§27.3).
  if (input.planOnly) {
    const simulatedReport: RunReport = {
      narrative:
        `Simulation only. ${plan.summary} ` +
        `${gate.steps.filter((s) => s.allowed).length} of ${plan.steps.length} steps passed the gate` +
        `${gate.requiresApproval ? ' and would have waited for approval' : ''}. Nothing was executed.`,
      outcome: { created: 0, updated: 0, drafted: 0, sent: 0, skipped: [], failed: [] },
      citations: [],
      needsAttention: plan.needsAttention ?? [],
      undoable: false,
      degraded: planResponse.degraded,
      simulated: true,
      injectionWarnings: grounded.injectionFindings,
    }
    await withTenant(session, async (ctx) => {
      await emitStep(ctx, runId, phase, {
        phase: 'report',
        label: `Simulated — ${gate.steps.filter((s) => s.allowed).length} steps would run, nothing was executed`,
        status: 'succeeded',
        detail: { simulated: true },
      })
      await saveReport(ctx, runId, simulatedReport)
      await setRunStatus(ctx, runId, 'succeeded')
    })
    publish(runId, { type: 'run.completed', status: 'succeeded', report: simulatedReport, costCents: 0 })
    return
  }

  // ---- Answer-only path -----------------------------------------------------
  if (plan.answerOnly || gate.steps.filter((s) => s.allowed && s.riskTier !== 'read').length === 0) {
    await answerAndFinish(session, runId, phase, budget, system, assembly.blocks, input, grounded, plan, planResponse.degraded)
    return
  }

  // ---- Autopilot caps -------------------------------------------------------
  // Unattended execution is bounded by numbers a person set, checked against what
  // actually happened rather than against a counter in memory (§27.6).
  let capReason: string | null = null
  if (effectiveMode === 'autopilot' && !gate.requiresApproval) {
    const plannedActions = gate.steps.filter((s) => s.allowed && s.riskTier !== 'read').length
    const verdict = await withTenant(session, async (ctx) => {
      const outcome = await checkAutopilotCaps(ctx, {
        agentId: persona.agentId,
        dailyCap: persona.autopilotDailyActionCap,
        weeklyCapCents: persona.autopilotWeeklyCostCapCents,
        plannedActions,
      })
      await emitStep(ctx, runId, phase, {
        phase: 'gate',
        label: outcome.allow ? `Within its caps — ${outcome.reason}` : `Cap reached — ${outcome.reason}`,
        status: 'succeeded',
        detail: { actionsToday: outcome.actionsToday, dailyCap: outcome.dailyCap },
      })
      if (!outcome.allow && persona.agentId) {
        await pauseForCap(ctx, {
          agentId: persona.agentId,
          agentName: persona.name,
          reason: outcome.reason,
          until: new Date(Date.now() + 86_400_000),
        })
      }
      return outcome
    })
    if (!verdict.allow) capReason = verdict.reason
  }

  // ---- Approval gate --------------------------------------------------------
  if (gate.requiresApproval || capReason) {
    const approvalId = await withTenant(session, async (ctx) => {
      // Every preview line carries the step it came from, so an approver's edit lands on a
      // known argument of a known step rather than on a free-text patch (§11.2).
      const preview: PreviewLine[] = gate.steps
        .filter((s) => s.allowed)
        .flatMap((s) => s.preview.map((line) => ({ ...line, stepId: s.id })))
      const evidence = buildEvidence(grounded)
      const id = await createApproval(ctx, agentActor, {
        title: gate.approvalTitle,
        kind: 'agent_plan',
        riskTier: gate.riskTier,
        agentRunId: runId,
        preview,
        evidence,
        requestedByLabel: 'Superwork',
        // What this tenant's own rules decided, so the card can say why it is being asked
        // and to whom it went (§11.1). A cap or a downgrade is the more specific reason
        // when one applies, and the policy still routes it.
        policyId: gate.policy.policyId,
        approverRole: gate.policy.approverRole,
        slaHours: gate.policy.slaHours,
        policyReason: capReason
          ? `${persona.name} reached a cap you set, so this is waiting for you instead of running unattended. ${capReason}`
          : downgraded
            ? 'This run read untrusted external content, so every change is held for a person to approve.'
            : gate.policy.reason,
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

  await executeApprovedPlan(
    session,
    runId,
    phase,
    budget,
    plan,
    gate,
    input,
    grounded,
    system,
    assembly.blocks,
    planResponse.degraded,
    intake.tenantTools,
  )
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
    return row ? { ...row, tenantTools: await customToolsFor(ctx) } : null
  })
  if (!state?.plan) throw new Error('This run has no stored plan to resume.')
  const tenantTools = state.tenantTools

  const phase: Phase = { ordinal: state.steps_used }
  const budget = newBudget()
  const plan = applyEdits(state.plan.plan, edits)

  // An edited plan is not the plan that was gated. Re-running the gate is what keeps
  // "approve with edits" from being a way to widen what was approved: the edited
  // arguments are re-validated, re-permissioned and re-previewed, and if the edit made
  // the plan riskier than the one on the card it goes back for a fresh approval (§11.2).
  let gate = state.plan.gate
  if (edits) {
    const regated = await withTenant({ ...session, traceId }, async (ctx) => {
      const actor = await loadActor(ctx)
      const agentActor = await asAgent(ctx, actor, {
        agentId: runId,
        agentName: 'Superwork',
        mode: 'execute',
        toolGrants: ['*'],
        maxSensitivity: 'confidential',
      })
      const outcome = await gatePlan(
        ctx,
        agentActor,
        plan,
        (step) => toolContext(ctx, agentActor, runId, step.id, step.tool, false),
        await killSwitchEngaged(ctx),
        tenantTools,
      )
      await savePlan(ctx, runId, plan, outcome)
      await emitStep(ctx, runId, phase, {
        phase: 'gate',
        label: 'Re-checked the edited plan',
        status: 'succeeded',
        detail: {
          allowed: outcome.steps.filter((s) => s.allowed).length,
          blocked: outcome.blocked.map((s) => ({ tool: s.tool, reason: s.reason })),
        },
      })
      return outcome
    })

    const before = riskRank(state.plan.gate.riskTier)
    if (riskRank(regated.riskTier) > before) {
      const message =
        'Those edits make this riskier than the plan that was approved, so it is going back for a fresh ' +
        'decision rather than running on the old one.'
      await withTenant({ ...session, traceId }, (ctx) =>
        setRunStatus(ctx, runId, 'awaiting_approval', { failureClass: 'policy', failureDetail: message }),
      )
      publish(runId, { type: 'run.failed', failureClass: 'policy', message })
      throw new Error(message)
    }
    gate = regated
  }

  // Marked running before the work is detached, so a caller that polls immediately after
  // approving sees the transition rather than the status it approved from.
  await withTenant({ ...session, traceId }, (ctx) => setRunStatus(ctx, runId, 'running'))

  void executeApprovedPlan(
    { ...session, traceId },
    runId,
    phase,
    budget,
    plan,
    gate,
    { request: state.request, mode: state.mode as StartRunInput['mode'] },
    null,
    '',
    [],
    null,
    tenantTools,
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
  tenantTools?: Map<string, Tool<any, any>> | null,
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

    const executed = await runStep(session, runId, phase, budget, step, input.dryRun ?? false, undoOrdinal, tenantTools)
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
      // This call reached the run's totals and never reached metering at all, so the
      // narrative's spend was invisible to the cap it counted against.
      await recordMessage(ctx, runId, {
        taskClass: 'agent.report',
        content: String((narrativeResponse.json as { text?: string })?.text ?? narrativeResponse.text),
        simulated: narrativeResponse.simulated,
        usage: narrativeResponse.usage,
      })
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
    // Counts the run. Its cost is already on the per-call rows above — carrying it here as
    // well is what doubled month-to-date spend and tripped the cap at half the real figure.
    await recordUsageRecord(ctx, { unit: 'agent_run', quantity: 1, costCents: 0, agentRunId: runId })
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
  tenantTools?: Map<string, Tool<any, any>> | null,
): Promise<{ ok: boolean; message: string; looping: boolean; undoRecorded: boolean }> {
  const tool = resolveTool(step.tool, tenantTools)
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

    // The budget every tool has declared since Phase 1 and nothing ever read (ADR 0050).
    // Checked before the arguments, because a call that is over budget should not reach the
    // outside system whether or not its arguments would have parsed.
    const budget = await checkRateLimit(ctx, tool, runId)
    if (!budget.allow) {
      await recordStep(ctx, runId, {
        ordinal: phase.ordinal - 1,
        phase: 'act',
        label: describeStep(tool.name, step),
        status: 'failed',
        toolName: tool.name,
        riskTier: tool.riskTier,
        errorClass: 'rate_limit',
        errorMessage: budget.reason,
      })
      publish(runId, { type: 'tool.result', tool: tool.name, ok: false, summary: budget.reason })
      return { ok: false, message: budget.reason, looping: false, undoRecorded: false }
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

  const answer = (response.json ?? {}) as {
    text?: string
    citations?: { claim: string; knowledgeIndex: number }[]
    memories?: MemoryCandidate[]
  }
  const text = answer.text ?? response.text

  for (const word of text.split(/(\s+)/)) publish(runId, { type: 'text', delta: word })

  const report = await withTenant(session, async (ctx) => {
    if (response.usage) {
      recordUsage(budget, response.usage)
      await recordMessage(ctx, runId, {
        taskClass: 'agent.answer',
        content: text,
        simulated: response.simulated,
        usage: response.usage,
      })
    }
    const citations = await persistCitations(ctx, runId, grounded, answer.citations)

    // Reflect (§9.3): what did this run learn that is worth keeping? Candidates only —
    // nothing here is recalled until a person agrees with it, and anything whose citation
    // does not resolve to a passage this run actually retrieved is refused outright.
    if ((answer.memories ?? []).length > 0) {
      const proposed = await proposeMemories(ctx, {
        runId,
        knowledge: grounded.grounding.knowledge,
        candidates: answer.memories ?? [],
      })
      if (proposed.stored > 0) {
        await emitStep(ctx, runId, phase, {
          phase: 'reflect',
          label: `Noticed ${proposed.stored} ${proposed.stored === 1 ? 'fact' : 'facts'} worth remembering`,
          status: 'succeeded',
        })
      }
    }

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
    // Counts the run. Its cost is already on the per-call rows above — carrying it here as
    // well is what doubled month-to-date spend and tripped the cap at half the real figure.
    await recordUsageRecord(ctx, { unit: 'agent_run', quantity: 1, costCents: 0, agentRunId: runId })
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
  tenantTools?: Map<string, Tool<any, any>> | null,
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

  // Agreed facts come before retrieved passages inside the knowledge zone: they are
  // shorter, a person has stood behind each one, and if the zone has to yield tokens it
  // should give up a passage before it gives up something the organization has settled.
  if ((grounded.grounding.memories ?? []).length > 0) {
    blocks.push({
      zone: 'knowledge',
      trust: 'org_data',
      label: 'What this organization has agreed is true',
      data: (grounded.grounding.memories ?? []).map((memory) => ({
        fact: `${memory.subject} ${memory.predicate} ${memory.object}`,
        about: memory.scopeLabel,
        agreedOn: memory.agreedOn.slice(0, 10),
        source: memory.documentTitle,
        // Said out loud rather than left for the reader to infer from a date.
        note: memory.stale ? 'This kind of figure moves and has not been checked recently.' : undefined,
      })),
    })
  }

  for (const chunk of grounded.grounding.knowledge) {
    blocks.push({
      zone: 'knowledge',
      trust: 'org_data',
      // The expiry goes in the label, which is product-authored, rather than into the text —
      // retrieved content is never edited on its way to the model. Down-ranking makes an
      // expired passage unlikely to arrive; saying so is what stops it being quoted as
      // current when it does (ADR 0042).
      label:
        `${chunk.documentTitle}${chunk.headingPath ? ` › ${chunk.headingPath}` : ''}` +
        (chunk.expiredOn ? ` (EXPIRED ${chunk.expiredOn} — not current; say so if you cite it)` : ''),
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

  const visible = visibleTools(actor, 'orchestrator', actor.organizationId, false, tenantTools)
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

const MODE_RANK: Record<StartRunInput['mode'], number> = { ask: 0, assist: 1, execute: 2, autopilot: 3 }

/** The narrower of what was asked for and what the persona is allowed to be. */
function narrowerMode(requested: StartRunInput['mode'], ceiling: StartRunInput['mode']): StartRunInput['mode'] {
  return MODE_RANK[requested] <= MODE_RANK[ceiling] ? requested : ceiling
}

async function resolvePersona(ctx: TenantContext, key: string): Promise<RunPersona> {
  const persona = await personaForKey(ctx, key)
  if (persona) {
    const certification = certificationState(
      {
        name: persona.name,
        publishedVersion: persona.publishedVersion,
        recertifiedAt: persona.recertifiedAt,
        recertifiedVersion: persona.recertifiedVersion,
        recertifiedByName: persona.recertifiedByName,
      },
      persona.recertificationDays,
    )
    // Two reports in a row that nobody opened. One missed week is a person on holiday; two is
    // an agent running unattended in both directions — nobody watching it, and nobody reading
    // what it did. One is forgiven on purpose (ADR 0070).
    const unread =
      persona.unreadDigests >= 2
        ? `${persona.name} has written ${persona.unreadDigests} reports its owner has not read.`
        : null
    return {
      agentId: persona.agentId,
      key: persona.key,
      name: persona.name,
      purpose: persona.purpose,
      mode: persona.mode,
      status: persona.status,
      toolGrants: persona.toolGrants,
      maxSensitivity: persona.maxSensitivity,
      autopilotDailyActionCap: persona.autopilotDailyActionCap,
      autopilotWeeklyCostCapCents: persona.autopilotWeeklyCostCapCents,
      autopilotWithheldReason: certification.stale ? certification.summary : unread,
    }
  }
  // No row: the ad-hoc assistant, which is what a person gets when they type into the
  // rail. It is bounded by the human it acts for, and by nothing else.
  return {
    agentId: null,
    key,
    name: 'Superwork',
    purpose: 'Answers questions and proposes plans for the person who asked.',
    mode: 'execute',
    status: 'active',
    toolGrants: ['*'],
    maxSensitivity: 'confidential',
    autopilotDailyActionCap: 10,
    autopilotWeeklyCostCapCents: 500,
  }
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

function riskRank(tier: 'read' | 'low' | 'high' | string): number {
  return tier === 'high' ? 2 : tier === 'low' ? 1 : 0
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
