import type { AgentMode, Sensitivity, TenantContext } from '@superwork/db'
import { asJson } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { NotFoundError, PermissionError, ValidationError } from '../errors.js'
import { assertSteppedUp } from '../step-up.js'
import { certificationState, DEFAULT_RECERTIFICATION_DAYS } from '../agent-recertification.js'
import { writeActivity, writeAudit } from '../audit.js'

/**
 * The agent studio (§27, §24 Phase 3 acceptance).
 *
 * "An agent can be created, permissioned, simulated against last week's data, and
 * published through change control without an engineer."
 *
 * A persona is data, not code: its tool grants, mode ceiling, clearance and caps are
 * columns the runtime reads and the gate enforces. Publishing one is a reviewed change —
 * a second person, a justification, a simulation, and a version row that can be rolled
 * back to.
 */

export interface AgentPersona {
  agentId: string
  key: string
  name: string
  purpose: string
  ownerUserId: string
  ownerName: string | null
  scopeDepartmentId: string | null
  scopeDepartmentName: string | null
  mode: AgentMode
  status: 'draft' | 'active' | 'paused' | 'retired'
  toolGrants: string[]
  dataScopes: string[]
  maxSensitivity: Sensitivity
  scheduleCron: string | null
  budget: Record<string, unknown>
  escalationUserId: string | null
  autopilotDailyActionCap: number
  autopilotWeeklyCostCapCents: number
  autopilotPausedUntil: Date | null
  digestDay: number
  publishedAt: Date | null
  publishedByName: string | null
  /** Who last read what this may do and said it was still right (ADR 0068). */
  recertifiedAt: Date | null
  recertifiedByName: string | null
  recertifiedVersion: number | null
  recertificationNote: string | null
  /** The ordinal of the published configuration, or 0 for one never through the flow. */
  publishedVersion: number
  pausedReason: string | null
  currentVersion: number
  isDemo: boolean
}

/** The fields a change request may alter. Anything not here is not configurable. */
export interface PersonaDraft {
  name: string
  purpose: string
  ownerUserId: string
  scopeDepartmentId: string | null
  mode: AgentMode
  toolGrants: string[]
  dataScopes: string[]
  maxSensitivity: Sensitivity
  scheduleCron: string | null
  escalationUserId: string | null
  autopilotDailyActionCap: number
  autopilotWeeklyCostCapCents: number
  digestDay: number
}

const SELECT_AGENT = (ctx: TenantContext) => ctx.sql`
  SELECT a.id AS "agentId", a.key, a.name, a.purpose, a.owner_user_id AS "ownerUserId",
         o.name AS "ownerName", a.scope_department_id AS "scopeDepartmentId",
         d.name AS "scopeDepartmentName", a.mode::text AS mode, a.status::text AS status,
         a.tool_grants AS "toolGrants", a.data_scopes AS "dataScopes",
         a.max_sensitivity::text AS "maxSensitivity", a.schedule_cron AS "scheduleCron",
         a.budget, a.escalation_user_id AS "escalationUserId",
         a.autopilot_daily_action_cap AS "autopilotDailyActionCap",
         a.autopilot_weekly_cost_cap_cents AS "autopilotWeeklyCostCapCents",
         a.autopilot_paused_until AS "autopilotPausedUntil", a.digest_day AS "digestDay",
         a.published_at AS "publishedAt", p.name AS "publishedByName",
         a.recertified_at AS "recertifiedAt", r.name AS "recertifiedByName",
         a.recertified_version AS "recertifiedVersion",
         a.recertification_note AS "recertificationNote",
         a.paused_reason AS "pausedReason",
         (SELECT coalesce(max(v.ordinal), 0) FROM agent_versions v
           WHERE v.organization_id = a.organization_id AND v.agent_id = a.id) AS "publishedVersion",
         a.version AS "currentVersion", a.is_demo AS "isDemo"
  FROM agents a
  LEFT JOIN users o ON o.id = a.owner_user_id
  LEFT JOIN users p ON p.id = a.published_by
  LEFT JOIN users r ON r.id = a.recertified_by
  LEFT JOIN departments d ON d.id = a.scope_department_id`

function guard(actor: Actor, ctx: TenantContext, action: string, departmentId: string | null = null): void {
  const decision = can(actor, action, {
    type: 'agent',
    organizationId: ctx.organizationId,
    departmentId,
    riskTier: 'high',
  })
  if (!decision.allow) throw new PermissionError(decision.reason)
}

export async function listAgents(ctx: TenantContext, actor: Actor): Promise<AgentPersona[]> {
  guard(actor, ctx, 'agent:read')
  return ctx.sql<AgentPersona[]>`
    ${SELECT_AGENT(ctx)}
    WHERE a.organization_id = ${ctx.organizationId} AND a.deleted_at IS NULL AND a.is_subagent = false
    ORDER BY a.status, a.name`
}

export async function getAgent(ctx: TenantContext, actor: Actor, agentId: string): Promise<AgentPersona> {
  guard(actor, ctx, 'agent:read')
  const [row] = await ctx.sql<AgentPersona[]>`
    ${SELECT_AGENT(ctx)}
    WHERE a.organization_id = ${ctx.organizationId} AND a.id = ${agentId} AND a.deleted_at IS NULL`
  if (!row) throw new NotFoundError()
  return row
}

export function personaSnapshot(agent: AgentPersona): PersonaDraft {
  return {
    name: agent.name,
    purpose: agent.purpose,
    ownerUserId: agent.ownerUserId,
    scopeDepartmentId: agent.scopeDepartmentId,
    mode: agent.mode,
    toolGrants: agent.toolGrants,
    dataScopes: agent.dataScopes,
    maxSensitivity: agent.maxSensitivity,
    scheduleCron: agent.scheduleCron,
    escalationUserId: agent.escalationUserId,
    autopilotDailyActionCap: agent.autopilotDailyActionCap,
    autopilotWeeklyCostCapCents: agent.autopilotWeeklyCostCapCents,
    digestDay: agent.digestDay,
  }
}

export interface FieldChange {
  field: keyof PersonaDraft
  from: unknown
  to: unknown
  /** True when the change gives the agent more reach than it had. */
  widens: boolean
}

const MODE_RANK: Record<AgentMode, number> = { ask: 0, assist: 1, execute: 2, autopilot: 3 }
const SENSITIVITY_RANK: Record<Sensitivity, number> = { public: 0, internal: 1, confidential: 2, restricted: 3 }

/**
 * What changes, and which way. A reviewer should never have to diff two JSON blobs to
 * find out whether they are about to widen an agent's reach.
 */
export function diffPersona(before: PersonaDraft, after: PersonaDraft): FieldChange[] {
  const changes: FieldChange[] = []
  const keys = Object.keys(after) as (keyof PersonaDraft)[]

  for (const key of keys) {
    const from = before[key]
    const to = after[key]
    if (JSON.stringify(from) === JSON.stringify(to)) continue

    let widens = false
    if (key === 'mode') widens = MODE_RANK[to as AgentMode] > MODE_RANK[from as AgentMode]
    else if (key === 'maxSensitivity') {
      widens = SENSITIVITY_RANK[to as Sensitivity] > SENSITIVITY_RANK[from as Sensitivity]
    } else if (key === 'toolGrants' || key === 'dataScopes') {
      const previous = new Set(from as string[])
      widens = (to as string[]).some((grant) => !previous.has(grant) || grant === '*')
    } else if (key === 'autopilotDailyActionCap' || key === 'autopilotWeeklyCostCapCents') {
      widens = Number(to) > Number(from)
    } else if (key === 'scopeDepartmentId') {
      widens = to === null && from !== null
    }
    changes.push({ field: key, from, to, widens })
  }
  return changes
}

export async function createAgentDraft(
  ctx: TenantContext,
  actor: Actor,
  input: { key: string; name: string; purpose: string; ownerUserId?: string; scopeDepartmentId?: string | null },
): Promise<AgentPersona> {
  guard(actor, ctx, 'agent:create')
  if (!/^[a-z][a-z0-9_]{2,40}$/.test(input.key)) {
    throw new ValidationError('An agent key is lower-case letters, digits and underscores — it appears in the audit trail.')
  }
  if (!input.purpose.trim()) {
    throw new ValidationError('An agent needs a purpose. "What is this for?" is the first question every reviewer asks.')
  }

  const [clash] = await ctx.sql<{ id: string }[]>`
    SELECT id FROM agents
    WHERE organization_id = ${ctx.organizationId} AND key = ${input.key} AND deleted_at IS NULL`
  if (clash) throw new ValidationError(`An agent with the key "${input.key}" already exists.`)

  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO agents (
      organization_id, key, name, purpose, owner_user_id, scope_department_id,
      mode, status, tool_grants, max_sensitivity, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.key}, ${input.name}, ${input.purpose.trim()},
      ${input.ownerUserId ?? actor.userId}, ${input.scopeDepartmentId ?? null},
      -- A new agent starts where it can do the least damage.
      'ask'::sw_agent_mode, 'draft'::sw_agent_status, ${[]}, 'internal'::sw_sensitivity, ${ctx.userId}
    ) RETURNING id`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'agent.create_draft',
    entityType: 'agent',
    entityId: row!.id,
    after: { key: input.key, name: input.name, mode: 'ask', status: 'draft' },
  })

  return getAgent(ctx, actor, row!.id)
}

// ---------------------------------------------------------------------------
// Change control
// ---------------------------------------------------------------------------

export interface ChangeRequestView {
  id: string
  agentId: string
  agentName: string
  agentKey: string
  baseVersion: number
  proposed: PersonaDraft
  diff: FieldChange[]
  justification: string
  status: 'draft' | 'awaiting_approval' | 'approved' | 'rejected' | 'published' | 'rolled_back'
  simulationId: string | null
  requestedBy: string
  requestedByName: string | null
  decidedBy: string | null
  decidedByName: string | null
  decidedAt: Date | null
  decisionNote: string | null
  createdAt: Date
}

const SELECT_CHANGE = (ctx: TenantContext) => ctx.sql`
  SELECT c.id, c.agent_id AS "agentId", a.name AS "agentName", a.key AS "agentKey",
         c.base_version AS "baseVersion", c.proposed, c.diff, c.justification,
         c.status::text AS status, c.simulation_id AS "simulationId",
         c.requested_by AS "requestedBy", r.name AS "requestedByName",
         c.decided_by AS "decidedBy", d.name AS "decidedByName", c.decided_at AS "decidedAt",
         c.decision_note AS "decisionNote", c.created_at AS "createdAt"
  FROM agent_change_requests c
  JOIN agents a ON a.id = c.agent_id
  LEFT JOIN users r ON r.id = c.requested_by
  LEFT JOIN users d ON d.id = c.decided_by`

export async function requestChange(
  ctx: TenantContext,
  actor: Actor,
  input: { agentId: string; proposed: PersonaDraft; justification: string; simulationId?: string | null },
): Promise<ChangeRequestView> {
  const agent = await getAgent(ctx, actor, input.agentId)
  guard(actor, ctx, 'agent:update', agent.scopeDepartmentId)

  if (!input.justification.trim()) {
    throw new ValidationError('A change to an agent needs a reason. It is the first thing the approver reads.')
  }
  const diff = diffPersona(personaSnapshot(agent), input.proposed)
  if (diff.length === 0) throw new ValidationError('Nothing changed, so there is nothing to review.')

  if (input.proposed.toolGrants.includes('*') && input.proposed.mode !== 'ask') {
    throw new ValidationError(
      'An agent that can act may not hold every tool. Grant the tools it needs by name — that list is what a reviewer approves.',
    )
  }

  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO agent_change_requests (
      organization_id, agent_id, base_version, proposed, diff, justification,
      status, simulation_id, requested_by, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.agentId}, ${agent.currentVersion},
      ${ctx.sql.json(asJson(input.proposed))}, ${ctx.sql.json(asJson(diff))},
      ${input.justification.trim()}, 'awaiting_approval'::sw_change_status,
      ${input.simulationId ?? null}, ${actor.userId}, ${ctx.userId}
    ) RETURNING id`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'agent.change_requested',
    entityType: 'agent',
    entityId: input.agentId,
    after: { fields: diff.map((c) => c.field).join(', '), widens: diff.some((c) => c.widens) },
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'proposed a change to',
    entityType: 'agent',
    entityId: input.agentId,
    entityLabel: agent.name,
    summary:
      `Proposed ${diff.length} ${diff.length === 1 ? 'change' : 'changes'} to "${agent.name}"` +
      `${diff.some((c) => c.widens) ? ', widening what it may do' : ''}. Waiting for a second approver.`,
  })

  return getChangeRequest(ctx, actor, row!.id)
}

export async function getChangeRequest(ctx: TenantContext, actor: Actor, id: string): Promise<ChangeRequestView> {
  guard(actor, ctx, 'agent:read')
  const [row] = await ctx.sql<ChangeRequestView[]>`
    ${SELECT_CHANGE(ctx)}
    WHERE c.organization_id = ${ctx.organizationId} AND c.id = ${id} AND c.deleted_at IS NULL`
  if (!row) throw new NotFoundError()
  return row
}

export async function listChangeRequests(
  ctx: TenantContext,
  actor: Actor,
  filter: { agentId?: string; open?: boolean; limit?: number } = {},
): Promise<ChangeRequestView[]> {
  guard(actor, ctx, 'agent:read')
  const sql = ctx.sql
  return sql<ChangeRequestView[]>`
    ${SELECT_CHANGE(ctx)}
    WHERE c.organization_id = ${ctx.organizationId} AND c.deleted_at IS NULL
      ${filter.agentId ? sql`AND c.agent_id = ${filter.agentId}` : sql``}
      ${filter.open ? sql`AND c.status = 'awaiting_approval'` : sql``}
    ORDER BY c.created_at DESC
    LIMIT ${Math.min(filter.limit ?? 50, 200)}`
}

/**
 * Approving publishes. The approver may never be the requester — an agent's reach is
 * exactly the thing nobody should be able to widen alone (§27.4).
 */
export async function decideChange(
  ctx: TenantContext,
  actor: Actor,
  input: { changeRequestId: string; decision: 'approve' | 'reject'; note?: string },
): Promise<ChangeRequestView> {
  const request = await getChangeRequest(ctx, actor, input.changeRequestId)
  const agent = await getAgent(ctx, actor, request.agentId)
  guard(actor, ctx, 'agent:update', agent.scopeDepartmentId)

  if (request.status !== 'awaiting_approval') {
    throw new ValidationError(`This request is already ${request.status.replace(/_/g, ' ')}.`)
  }
  if (request.requestedBy === actor.userId) {
    throw new PermissionError(
      'Somebody else has to approve this. The person proposing a change to an agent cannot also be the one who signs it off.',
    )
  }
  // Rejecting needs no fresh proof — it changes nothing. Approving publishes a new
  // version and widens what an agent may do, and that is what step-up is for (§4.1).
  if (input.decision === 'approve') assertSteppedUp(actor, 'agent.publish')
  if (input.decision === 'approve' && agent.currentVersion !== request.baseVersion) {
    throw new ValidationError(
      'The agent changed after this request was raised. Re-open it against the current configuration so you approve what you are reading.',
    )
  }

  if (input.decision === 'reject') {
    await ctx.sql`
      UPDATE agent_change_requests
      SET status = 'rejected', decided_by = ${actor.userId}, decided_at = now(),
          decision_note = ${input.note ?? null}
      WHERE organization_id = ${ctx.organizationId} AND id = ${input.changeRequestId}`
    await writeAudit(ctx, {
      actorType: actor.type,
      actorId: actor.userId,
      action: 'agent.change_rejected',
      entityType: 'agent',
      entityId: request.agentId,
      after: { note: input.note ?? null },
    })
    return getChangeRequest(ctx, actor, input.changeRequestId)
  }

  const proposed = request.proposed
  const [version] = await ctx.sql<{ id: string; ordinal: number }[]>`
    INSERT INTO agent_versions (
      organization_id, agent_id, ordinal, snapshot, justification,
      published_by, second_approver_id, created_by
    )
    SELECT ${ctx.organizationId}, ${request.agentId},
           coalesce(max(ordinal), 0) + 1, ${ctx.sql.json(asJson(proposed))},
           ${request.justification}, ${request.requestedBy}, ${actor.userId}, ${ctx.userId}
    FROM agent_versions
    WHERE organization_id = ${ctx.organizationId} AND agent_id = ${request.agentId}
    RETURNING id, ordinal`

  await applySnapshot(ctx, request.agentId, proposed, actor.userId)

  // Publishing *is* a recertification: two people have just read this configuration and one of
  // them signed it off with a fresh password. Recording it here is what stops the column being
  // a second, parallel record that drifts from the one the approval flow already keeps — and it
  // means a company that publishes regularly never sees an overdue agent, which is correct
  // (ADR 0068).
  await ctx.sql`
    UPDATE agents
    SET recertified_at = now(), recertified_by = ${actor.userId},
        recertified_version = ${version!.ordinal},
        recertification_note = ${`Approved version ${version!.ordinal}: ${request.justification}`}
    WHERE organization_id = ${ctx.organizationId} AND id = ${request.agentId}`

  await ctx.sql`
    UPDATE agent_change_requests
    SET status = 'published', decided_by = ${actor.userId}, decided_at = now(),
        decision_note = ${input.note ?? null}, published_version_id = ${version!.id}
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.changeRequestId}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'agent.published',
    entityType: 'agent',
    entityId: request.agentId,
    before: personaSnapshot(agent) as unknown as Record<string, unknown>,
    after: proposed as unknown as Record<string, unknown>,
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'published',
    entityType: 'agent',
    entityId: request.agentId,
    entityLabel: proposed.name,
    summary:
      `Published version ${version!.ordinal} of "${proposed.name}", proposed by ${request.requestedByName ?? 'a colleague'}. ` +
      `${request.justification}`,
  })

  return getChangeRequest(ctx, actor, input.changeRequestId)
}

async function applySnapshot(
  ctx: TenantContext,
  agentId: string,
  snapshot: PersonaDraft,
  publishedBy: string,
): Promise<void> {
  await ctx.sql`
    UPDATE agents SET
      name = ${snapshot.name},
      purpose = ${snapshot.purpose},
      owner_user_id = ${snapshot.ownerUserId},
      scope_department_id = ${snapshot.scopeDepartmentId},
      mode = ${snapshot.mode}::sw_agent_mode,
      tool_grants = ${snapshot.toolGrants},
      data_scopes = ${snapshot.dataScopes},
      max_sensitivity = ${snapshot.maxSensitivity}::sw_sensitivity,
      schedule_cron = ${snapshot.scheduleCron},
      escalation_user_id = ${snapshot.escalationUserId},
      autopilot_daily_action_cap = ${snapshot.autopilotDailyActionCap},
      autopilot_weekly_cost_cap_cents = ${snapshot.autopilotWeeklyCostCapCents},
      digest_day = ${snapshot.digestDay},
      status = 'active'::sw_agent_status,
      paused_reason = NULL,
      published_by = ${publishedBy},
      published_at = now(),
      version = version + 1
    WHERE organization_id = ${ctx.organizationId} AND id = ${agentId}`
}

export interface AgentVersionView {
  id: string
  ordinal: number
  snapshot: PersonaDraft
  justification: string | null
  publishedByName: string | null
  secondApproverName: string | null
  createdAt: Date
}

export async function listAgentVersions(
  ctx: TenantContext,
  actor: Actor,
  agentId: string,
): Promise<AgentVersionView[]> {
  guard(actor, ctx, 'agent:read')
  return ctx.sql<AgentVersionView[]>`
    SELECT v.id, v.ordinal, v.snapshot, v.justification,
           p.name AS "publishedByName", s.name AS "secondApproverName", v.created_at AS "createdAt"
    FROM agent_versions v
    LEFT JOIN users p ON p.id = v.published_by
    LEFT JOIN users s ON s.id = v.second_approver_id
    WHERE v.organization_id = ${ctx.organizationId} AND v.agent_id = ${agentId} AND v.deleted_at IS NULL
    ORDER BY v.ordinal DESC`
}

/**
 * Rolling back to a version that was already approved needs no second approver: it
 * restores a state this organization has already signed off, and making it slow is how
 * you end up leaving a bad agent running.
 */
export async function rollbackAgent(
  ctx: TenantContext,
  actor: Actor,
  input: { agentId: string; versionId: string; reason: string },
): Promise<AgentPersona> {
  const agent = await getAgent(ctx, actor, input.agentId)
  guard(actor, ctx, 'agent:update', agent.scopeDepartmentId)
  // "Previously approved" is not the same as "no wider than now": an earlier version can
  // be the *more* permissive one, so a rollback is another way to widen an agent and
  // carries the same requirement as publishing (§4.1).
  assertSteppedUp(actor, 'agent.rollback')
  if (!input.reason.trim()) throw new ValidationError('Say why you are rolling back — it goes in the agent’s history.')

  const [version] = await ctx.sql<{ snapshot: PersonaDraft; ordinal: number }[]>`
    SELECT snapshot, ordinal FROM agent_versions
    WHERE organization_id = ${ctx.organizationId} AND agent_id = ${input.agentId}
      AND id = ${input.versionId} AND deleted_at IS NULL`
  if (!version) throw new NotFoundError()

  await applySnapshot(ctx, input.agentId, version.snapshot, actor.userId)
  await ctx.sql`
    UPDATE agent_change_requests SET status = 'rolled_back'
    WHERE organization_id = ${ctx.organizationId} AND agent_id = ${input.agentId}
      AND status = 'published' AND published_version_id IN (
        SELECT id FROM agent_versions
        WHERE organization_id = ${ctx.organizationId} AND agent_id = ${input.agentId} AND ordinal > ${version.ordinal}
      )`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'agent.rolled_back',
    entityType: 'agent',
    entityId: input.agentId,
    before: personaSnapshot(agent) as unknown as Record<string, unknown>,
    after: version.snapshot as unknown as Record<string, unknown>,
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'rolled back',
    entityType: 'agent',
    entityId: input.agentId,
    entityLabel: agent.name,
    summary: `Rolled "${agent.name}" back to version ${version.ordinal}. ${input.reason}`,
  })

  return getAgent(ctx, actor, input.agentId)
}

/**
 * Says an agent may still do everything it may do (ADR 0068).
 *
 * The act publishing cannot express, because publishing is about a change. An agent that has
 * not changed is never re-examined by any flow this product has: the person who approved it in
 * March approved it once, and nothing since has asked whether `email:send` and `restricted`
 * reading are still what this thing needs.
 *
 * **Step-up, and a note.** Re-attesting a capability is the same weight as granting one — the
 * step-up catalogue calls it "saying an agent may still do everything it may do" — and the note
 * is what makes it a review rather than a click. Both are what stop a periodic control becoming
 * a periodic formality. The step-up is also what refuses an agent actor: `assertSteppedUp` will
 * not take a fresh proof of identity from something that has none, and says so by name, so an
 * assistant cannot vouch for its own capability.
 *
 * **Against a version, not a date.** The ordinal is recorded beside the timestamp, so a later
 * publication makes the attestation stale immediately rather than at the end of the interval.
 *
 * The owner of an agent may recertify their own — access review is the owner attesting, and in
 * a company with one administrator any other rule would mean nobody could ever do it. What is
 * recorded is who, so a reviewer reading the trail can see when an agent has only ever been
 * vouched for by the person who runs it.
 */
export async function recertifyAgent(
  ctx: TenantContext,
  actor: Actor,
  input: { agentId: string; note: string },
): Promise<AgentPersona> {
  const agent = await getAgent(ctx, actor, input.agentId)
  guard(actor, ctx, 'agent:update', agent.scopeDepartmentId)
  assertSteppedUp(actor, 'agent.recertify')

  if (agent.status === 'draft') {
    throw new ValidationError(
      'This is still a draft, so there is nothing running to stand behind. Publish it and the ' +
        'approval records who read it.',
    )
  }

  const note = input.note.trim()
  if (note.length < 8) {
    throw new ValidationError(
      'Say what you checked. A recertification with nothing written on it is a date, and the ' +
        'next person to read the trail cannot tell it from a click.',
    )
  }

  await ctx.sql`
    UPDATE agents
    SET recertified_at = now(), recertified_by = ${actor.userId},
        recertified_version = ${agent.publishedVersion}, recertification_note = ${note}
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.agentId} AND deleted_at IS NULL`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: 'agent.recertified',
    entityType: 'agent',
    entityId: input.agentId,
    before: { recertifiedAt: agent.recertifiedAt, recertifiedVersion: agent.recertifiedVersion },
    after: {
      recertifiedVersion: agent.publishedVersion,
      note,
      // What was being stood behind, so the trail says more than that somebody pressed it.
      mode: agent.mode,
      maxSensitivity: agent.maxSensitivity,
      toolGrants: agent.toolGrants,
    },
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: 'recertified',
    entityType: 'agent',
    entityId: input.agentId,
    entityLabel: agent.name,
    summary:
      `${actor.displayName} confirmed ${agent.name} may still do what it does, on version ` +
      `${agent.publishedVersion}. ${note}`,
  })

  return getAgent(ctx, actor, input.agentId)
}

export async function setAgentStatus(
  ctx: TenantContext,
  actor: Actor,
  input: { agentId: string; status: 'active' | 'paused' | 'retired'; reason?: string },
): Promise<AgentPersona> {
  const agent = await getAgent(ctx, actor, input.agentId)
  guard(actor, ctx, 'agent:update', agent.scopeDepartmentId)
  if (agent.status === 'draft' && input.status === 'active') {
    throw new ValidationError('A draft becomes active by being published through a change request, not by being switched on.')
  }
  if (input.status !== 'active' && !input.reason?.trim()) {
    throw new ValidationError('Say why it is being stopped — whoever depends on it will want to know.')
  }

  await ctx.sql`
    UPDATE agents SET status = ${input.status}::sw_agent_status, paused_reason = ${input.reason ?? null}
    WHERE organization_id = ${ctx.organizationId} AND id = ${input.agentId}`

  await writeAudit(ctx, {
    actorType: actor.type,
    actorId: actor.userId,
    action: `agent.${input.status}`,
    entityType: 'agent',
    entityId: input.agentId,
    before: { status: agent.status },
    after: { status: input.status, reason: input.reason ?? null },
  })
  await writeActivity(ctx, {
    actorType: actor.type,
    actorUserId: actor.userId,
    actorLabel: actor.displayName,
    verb: input.status === 'active' ? 'resumed' : input.status === 'paused' ? 'paused' : 'retired',
    entityType: 'agent',
    entityId: input.agentId,
    entityLabel: agent.name,
    summary: `${agent.name} is now ${input.status}.${input.reason ? ` ${input.reason}` : ''}`,
  })

  return getAgent(ctx, actor, input.agentId)
}

// ---------------------------------------------------------------------------
// Simulations — stored here, produced by the runtime (§27.3)
// ---------------------------------------------------------------------------

export interface SimulationProposal {
  occasion: string
  request: string
  summary: string
  steps: { tool: string; riskTier: string; intent: string; allowed: boolean; reason: string; preview: string[] }[]
  requiresApproval: boolean
  estimatedCostCents: number
}

export interface SimulationView {
  id: string
  agentId: string
  agentName: string
  snapshot: PersonaDraft
  windowFrom: Date
  windowTo: Date
  status: string
  proposals: SimulationProposal[]
  totals: {
    occasions: number
    stepsProposed: number
    stepsBlocked: number
    wouldRequireApproval: number
    wouldRunUnattended: number
    byTool: Record<string, number>
  }
  findings: { severity: 'low' | 'medium' | 'high'; message: string }[]
  costCents: number
  finishedAt: Date | null
  createdAt: Date
}

export async function saveSimulation(
  ctx: TenantContext,
  input: {
    agentId: string
    snapshot: PersonaDraft
    windowFrom: Date
    windowTo: Date
    proposals: SimulationProposal[]
    totals: SimulationView['totals']
    findings: SimulationView['findings']
    costCents: number
    status?: string
  },
): Promise<string> {
  const [row] = await ctx.sql<{ id: string }[]>`
    INSERT INTO agent_simulations (
      organization_id, agent_id, snapshot, window_from, window_to, status,
      proposals, totals, findings, cost_cents, finished_at, created_by
    ) VALUES (
      ${ctx.organizationId}, ${input.agentId}, ${ctx.sql.json(asJson(input.snapshot))},
      ${input.windowFrom}, ${input.windowTo}, ${input.status ?? 'succeeded'},
      ${ctx.sql.json(asJson(input.proposals))}, ${ctx.sql.json(asJson(input.totals))},
      ${ctx.sql.json(asJson(input.findings))}, ${input.costCents}, now(), ${ctx.userId}
    ) RETURNING id`
  return row!.id
}

export async function getSimulation(ctx: TenantContext, actor: Actor, id: string): Promise<SimulationView> {
  guard(actor, ctx, 'agent:read')
  const [row] = await ctx.sql<SimulationView[]>`
    SELECT s.id, s.agent_id AS "agentId", a.name AS "agentName", s.snapshot,
           s.window_from AS "windowFrom", s.window_to AS "windowTo", s.status,
           s.proposals, s.totals, s.findings, s.cost_cents::float8 AS "costCents",
           s.finished_at AS "finishedAt", s.created_at AS "createdAt"
    FROM agent_simulations s
    JOIN agents a ON a.id = s.agent_id
    WHERE s.organization_id = ${ctx.organizationId} AND s.id = ${id} AND s.deleted_at IS NULL`
  if (!row) throw new NotFoundError()
  return row
}

export async function listSimulations(
  ctx: TenantContext,
  actor: Actor,
  agentId: string,
  limit = 10,
): Promise<SimulationView[]> {
  guard(actor, ctx, 'agent:read')
  return ctx.sql<SimulationView[]>`
    SELECT s.id, s.agent_id AS "agentId", a.name AS "agentName", s.snapshot,
           s.window_from AS "windowFrom", s.window_to AS "windowTo", s.status,
           s.proposals, s.totals, s.findings, s.cost_cents::float8 AS "costCents",
           s.finished_at AS "finishedAt", s.created_at AS "createdAt"
    FROM agent_simulations s
    JOIN agents a ON a.id = s.agent_id
    WHERE s.organization_id = ${ctx.organizationId} AND s.agent_id = ${agentId} AND s.deleted_at IS NULL
    ORDER BY s.created_at DESC
    LIMIT ${Math.min(limit, 50)}`
}

/**
 * The persona the runtime enforces. Returned for any agent by key, including the
 * built-in orchestrator, so there is one definition of "what may this agent do".
 */
export async function personaForKey(ctx: TenantContext, key: string): Promise<{
  agentId: string
  key: string
  name: string
  purpose: string
  mode: AgentMode
  status: string
  toolGrants: string[]
  maxSensitivity: Sensitivity
  autopilotDailyActionCap: number
  autopilotWeeklyCostCapCents: number
  autopilotPausedUntil: Date | null
  scheduleCron: string | null
  ownerUserId: string
  /** What the runtime needs to decide whether anybody still stands behind this (ADR 0068). */
  publishedVersion: number
  recertifiedAt: Date | null
  recertifiedVersion: number | null
  recertifiedByName: string | null
  recertificationDays: number
} | null> {
  const [row] = await ctx.sql<
    {
      agentId: string
      key: string
      name: string
      purpose: string
      mode: AgentMode
      status: string
      toolGrants: string[]
      maxSensitivity: Sensitivity
      autopilotDailyActionCap: number
      autopilotWeeklyCostCapCents: number
      autopilotPausedUntil: Date | null
      scheduleCron: string | null
      ownerUserId: string
      publishedVersion: number
      recertifiedAt: Date | null
      recertifiedVersion: number | null
      recertifiedByName: string | null
      recertificationDays: number
    }[]
  >`
    SELECT a.id AS "agentId", a.key, a.name, a.purpose, a.mode, a.status::text AS status,
           a.tool_grants AS "toolGrants", a.max_sensitivity AS "maxSensitivity",
           a.autopilot_daily_action_cap AS "autopilotDailyActionCap",
           a.autopilot_weekly_cost_cap_cents AS "autopilotWeeklyCostCapCents",
           a.autopilot_paused_until AS "autopilotPausedUntil",
           a.schedule_cron AS "scheduleCron", a.owner_user_id AS "ownerUserId",
           (SELECT coalesce(max(v.ordinal), 0) FROM agent_versions v
             WHERE v.organization_id = a.organization_id AND v.agent_id = a.id) AS "publishedVersion",
           a.recertified_at AS "recertifiedAt", a.recertified_version AS "recertifiedVersion",
           r.name AS "recertifiedByName",
           coalesce(
             (SELECT m.agent_recertification_days FROM monitoring_policies m
               WHERE m.organization_id = a.organization_id AND m.deleted_at IS NULL),
             ${DEFAULT_RECERTIFICATION_DAYS}
           ) AS "recertificationDays"
    FROM agents a
    LEFT JOIN users r ON r.id = a.recertified_by
    WHERE a.organization_id = ${ctx.organizationId} AND a.key = ${key} AND a.deleted_at IS NULL`
  return row ?? null
}
