import { withTenant } from '@superwork/db'
import { loadActor } from '@superwork/auth'
import {
  getAgent,
  getSimulation,
  personaSnapshot,
  saveSimulation,
  type PersonaDraft,
  type SimulationProposal,
  type SimulationView,
} from '@superwork/core'
import { getTool } from '@superwork/tools'
import { startRun, type RunSession } from './runtime.js'
import { bufferedEvents, isFinished } from './bus.js'
import type { GateOutcome, Plan, RunPersona } from './types.js'

/**
 * Simulating an agent before it is published (§27.3, §24 Phase 3 acceptance).
 *
 * The run is the real one: the same grounding, the same planner, the same gate, under the
 * *proposed* persona rather than the published one. Only the last phase differs — nothing
 * executes, nothing is queued for approval, and the result is stored as a review artifact.
 *
 * What "against last week's data" honestly means is stated on the screen: the triggers
 * this agent would have had in the window are replayed against the data as it stands now.
 * Superwork does not keep a time machine of every row, and pretending otherwise would put
 * a number in front of a reviewer that nothing could reproduce.
 */

export interface SimulateInput {
  agentId: string
  /** Defaults to the agent's current configuration. */
  proposed?: PersonaDraft
  windowDays?: number
  /** Hard ceiling on how many occasions are replayed, so a simulation cannot run away. */
  maxOccasions?: number
}

export async function simulateAgent(session: RunSession, input: SimulateInput): Promise<SimulationView> {
  const { agent, snapshot } = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const found = await getAgent(ctx, actor, input.agentId)
    return { agent: found, snapshot: input.proposed ?? personaSnapshot(found) }
  })

  const windowDays = Math.min(Math.max(input.windowDays ?? 7, 1), 30)
  const windowTo = new Date()
  const windowFrom = new Date(windowTo.getTime() - windowDays * 86_400_000)

  const persona: RunPersona = {
    agentId: agent.agentId,
    key: agent.key,
    name: snapshot.name,
    purpose: snapshot.purpose,
    mode: snapshot.mode,
    status: 'active',
    toolGrants: snapshot.toolGrants,
    maxSensitivity: snapshot.maxSensitivity,
    autopilotDailyActionCap: snapshot.autopilotDailyActionCap,
    autopilotWeeklyCostCapCents: snapshot.autopilotWeeklyCostCapCents,
  }

  const occasions = occasionsFor(snapshot, windowFrom, windowTo, input.maxOccasions ?? 3)
  const proposals: SimulationProposal[] = []
  let costCents = 0

  for (const occasion of occasions) {
    const { runId } = await startRun(session, {
      request: occasion.request,
      mode: snapshot.mode,
      trigger: 'schedule',
      agentKey: agent.key,
      persona,
      planOnly: true,
      uiContext: { route: `/settings/agents/${agent.agentId}`, simulation: true, occasion: occasion.label },
    })

    const outcome = await waitForPlan(runId)
    if (!outcome) {
      proposals.push({
        occasion: occasion.label,
        request: occasion.request,
        summary: 'The run did not produce a plan in time. Nothing was executed.',
        steps: [],
        requiresApproval: false,
        estimatedCostCents: 0,
      })
      continue
    }

    const { plan, gate } = outcome
    costCents += gate.estimatedCostCents ?? 0
    proposals.push({
      occasion: occasion.label,
      request: occasion.request,
      summary: plan.summary,
      steps: gate.steps.map((step) => ({
        tool: step.tool,
        riskTier: step.riskTier,
        intent: step.intent,
        allowed: step.allowed,
        reason: step.reason,
        preview: step.preview.map(
          (line) =>
            `${line.operation}: ${line.entityLabel}` +
            (line.changes.length ? ` — ${line.changes.map((c) => `${c.field} → ${c.to ?? 'none'}`).join(', ')}` : ''),
        ),
      })),
      requiresApproval: gate.requiresApproval,
      estimatedCostCents: gate.estimatedCostCents ?? 0,
    })
  }

  const totals = summarise(proposals)
  const findings = review(snapshot, proposals, totals)

  const view = await withTenant(session, async (ctx) => {
    const actor = await loadActor(ctx)
    const id = await saveSimulation(ctx, {
      agentId: agent.agentId,
      snapshot,
      windowFrom,
      windowTo,
      proposals,
      totals,
      findings,
      costCents,
    })
    return getSimulation(ctx, actor, id)
  })

  return view
}

interface Occasion {
  label: string
  request: string
}

/**
 * When this agent would have woken up. A scheduled agent gets one occasion per scheduled
 * day in the window; an unscheduled one gets a single occasion, because inventing traffic
 * it never had would make the simulation look busier than the agent.
 */
function occasionsFor(snapshot: PersonaDraft, from: Date, to: Date, max: number): Occasion[] {
  const request = snapshot.purpose.trim()
  if (!snapshot.scheduleCron) {
    return [{ label: 'On demand', request }]
  }

  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000))
  const count = Math.min(days, max)
  const occasions: Occasion[] = []
  for (let index = 0; index < count; index += 1) {
    const at = new Date(to.getTime() - index * 86_400_000)
    occasions.push({
      label: at.toISOString().slice(0, 10),
      request,
    })
  }
  return occasions
}

async function waitForPlan(runId: string, timeoutMs = 45_000): Promise<{ plan: Plan; gate: GateOutcome } | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const events = bufferedEvents(runId)
    const ready = events.find((e): e is Extract<typeof e, { type: 'plan.ready' }> => e.type === 'plan.ready')
    if (ready) return { plan: ready.plan, gate: ready.gate }
    if (isFinished(runId)) return null
    await new Promise((resolve) => setTimeout(resolve, 120))
  }
  return null
}

function summarise(proposals: SimulationProposal[]): SimulationView['totals'] {
  const byTool: Record<string, number> = {}
  let stepsProposed = 0
  let stepsBlocked = 0
  let wouldRequireApproval = 0
  let wouldRunUnattended = 0

  for (const proposal of proposals) {
    for (const step of proposal.steps) {
      stepsProposed += 1
      byTool[step.tool] = (byTool[step.tool] ?? 0) + 1
      if (!step.allowed) {
        stepsBlocked += 1
        continue
      }
      if (step.riskTier === 'read') continue
      if (proposal.requiresApproval) wouldRequireApproval += 1
      else wouldRunUnattended += 1
    }
  }

  return {
    occasions: proposals.length,
    stepsProposed,
    stepsBlocked,
    wouldRequireApproval,
    wouldRunUnattended,
    byTool,
  }
}

/**
 * The part a reviewer actually reads. Each finding is something a person would otherwise
 * have to notice by comparing a config screen with a list of proposals.
 */
function review(
  snapshot: PersonaDraft,
  proposals: SimulationProposal[],
  totals: SimulationView['totals'],
): { severity: 'low' | 'medium' | 'high'; message: string }[] {
  const findings: { severity: 'low' | 'medium' | 'high'; message: string }[] = []

  const blocked = proposals.flatMap((p) => p.steps.filter((s) => !s.allowed))
  if (blocked.length > 0) {
    const tools = [...new Set(blocked.map((s) => s.tool))]
    // Say *why* they were refused. "The mode is too narrow" and "the grant is missing"
    // lead to opposite decisions, and a reviewer should not have to guess which it is.
    const byMode = blocked.filter((step) => /mode, which can/i.test(step.reason)).length
    const cause =
      byMode === blocked.length
        ? `Its mode ceiling (${snapshot.mode}) is what stops them, not its grants — in ${snapshot.mode} mode it proposes and a person applies the result.`
        : byMode > 0
          ? `${byMode} were stopped by the ${snapshot.mode} mode ceiling and the rest by missing grants.`
          : 'The grants do not cover what it planned to do.'
    findings.push({
      severity: 'medium',
      message: `${blocked.length} proposed ${blocked.length === 1 ? 'step was' : 'steps were'} refused by the gate (${tools.join(', ')}). ${cause}`,
    })
  }

  const grantedButUnused = snapshot.toolGrants.filter(
    (grant) => grant !== '*' && !Object.keys(totals.byTool).some((tool) => tool.startsWith(grant.replace(/@v\d+$/, ''))),
  )
  if (grantedButUnused.length > 0) {
    findings.push({
      severity: 'low',
      message: `Granted but never used in this window: ${grantedButUnused.join(', ')}. An unused grant is reach nobody is watching.`,
    })
  }

  const writeTools = Object.keys(totals.byTool).filter((tool) => {
    const resolved = getTool(tool) ?? getTool(`${tool}@v1`)
    return resolved ? resolved.riskTier !== 'read' : false
  })
  if (snapshot.mode === 'autopilot' && writeTools.length > 0) {
    findings.push({
      severity: 'high',
      message:
        `On autopilot this would change things without anyone reading the plan first (${writeTools.join(', ')}). ` +
        `The daily cap of ${snapshot.autopilotDailyActionCap} actions is the only thing standing between a bad plan and a bad day.`,
    })
  }

  const perOccasion = totals.occasions > 0 ? totals.wouldRunUnattended / totals.occasions : 0
  if (perOccasion > snapshot.autopilotDailyActionCap) {
    findings.push({
      severity: 'high',
      message:
        `It proposed ${perOccasion.toFixed(1)} unattended actions per occasion against a cap of ` +
        `${snapshot.autopilotDailyActionCap} per day. The cap would stop it part-way through its own plan.`,
    })
  }

  if (totals.stepsProposed === 0) {
    findings.push({
      severity: 'low',
      message: 'It proposed nothing in this window. That may be correct, or the purpose may not describe a job it can do.',
    })
  }

  return findings
}
