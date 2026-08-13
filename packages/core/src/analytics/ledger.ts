import type { TenantContext } from '@superwork/db'
import { can, type Actor } from '@superwork/auth'
import { PermissionError } from '../errors.js'
import { formatInZone, localParts, zonedTimeToUtc } from '../time.js'

/**
 * The accountability ledger (§24, Phase 3 acceptance).
 *
 * "An admin can answer, from the UI alone, exactly what the AI read, proposed, executed
 * and cost last month — per department."
 *
 * Everything here is SQL over rows the runtime already wrote: citations for what was
 * read, plan steps for what was proposed, tool calls for what was executed, usage records
 * for what it cost. No number in this module is computed anywhere but the database.
 *
 * It aggregates by department and by agent, and deliberately offers no per-person
 * breakdown. Ranking people by how much AI they used is exactly the report §29.5
 * prohibits, and the easiest way not to ship it is not to be able to compute it.
 */

export interface LedgerPeriod {
  /** First instant of the period, inclusive. */
  from: Date
  /** First instant after the period, exclusive. */
  to: Date
  label: string
  /** `YYYY-MM` in the organization's timezone. */
  key: string
}

export interface ReadSource {
  sourceType: string
  label: string
  documentId: string | null
  times: number
}

export interface ProposedTool {
  tool: string
  riskTier: string
  proposed: number
  executed: number
  failed: number
}

export interface DepartmentLedger {
  departmentId: string | null
  departmentName: string
  runs: number
  runsByMode: Record<string, number>
  runsByStatus: Record<string, number>
  /** Runs that read content nobody in the company wrote. */
  runsWithUntrustedContent: number
  runsCapabilityDowngraded: number
  passagesRead: number
  distinctDocumentsRead: number
  topSources: ReadSource[]
  stepsProposed: number
  toolsProposed: ProposedTool[]
  actionsExecuted: number
  actionsByRiskTier: Record<string, number>
  approvalsRequested: number
  approvalsApproved: number
  approvalsRejected: number
  runsUndone: number
  costCents: number
  tokensIn: number
  tokensOut: number
}

export interface LedgerReport {
  period: LedgerPeriod
  basis: string
  organization: {
    runs: number
    costCents: number
    actionsExecuted: number
    approvalsRequested: number
    runsUndone: number
    passagesRead: number
  }
  departments: DepartmentLedger[]
  agents: { agentId: string | null; agentName: string; runs: number; costCents: number; actionsExecuted: number }[]
  /** Empty when every department the actor may read is included. */
  restrictedTo: string[] | null
}

/** The month containing `instant`, in the organization's timezone. */
export function monthPeriod(instant: Date, timeZone: string): LedgerPeriod {
  const parts = localParts(instant, timeZone)
  const from = zonedTimeToUtc({ year: parts.year, month: parts.month, day: 1, hour: 0, minute: 0 }, timeZone)
  const nextMonth = parts.month === 12 ? 1 : parts.month + 1
  const nextYear = parts.month === 12 ? parts.year + 1 : parts.year
  const to = zonedTimeToUtc({ year: nextYear, month: nextMonth, day: 1, hour: 0, minute: 0 }, timeZone)
  return {
    from,
    to,
    label: formatInZone(from, timeZone, { month: 'long', year: 'numeric' }),
    key: `${parts.year}-${String(parts.month).padStart(2, '0')}`,
  }
}

/** Shifts a period by whole months, so "last month" is a click rather than a date picker. */
export function shiftMonth(period: LedgerPeriod, months: number, timeZone: string): LedgerPeriod {
  const [year, month] = period.key.split('-').map(Number)
  const zeroBased = (year! * 12 + (month! - 1)) + months
  const anchor = zonedTimeToUtc(
    { year: Math.floor(zeroBased / 12), month: (zeroBased % 12) + 1, day: 2, hour: 12, minute: 0 },
    timeZone,
  )
  return monthPeriod(anchor, timeZone)
}

export function parseMonthKey(key: string | null | undefined, timeZone: string, now = new Date()): LedgerPeriod {
  const match = /^(\d{4})-(\d{2})$/.exec(key ?? '')
  if (!match) return monthPeriod(now, timeZone)
  const anchor = zonedTimeToUtc(
    { year: Number(match[1]), month: Number(match[2]), day: 2, hour: 12, minute: 0 },
    timeZone,
  )
  return monthPeriod(anchor, timeZone)
}

interface DepartmentRow {
  id: string | null
  name: string
}

export async function ledgerReport(
  ctx: TenantContext,
  actor: Actor,
  period: LedgerPeriod,
): Promise<LedgerReport> {
  const sql = ctx.sql
  const org = ctx.organizationId

  const departments = await sql<DepartmentRow[]>`
    SELECT id, name FROM departments
    WHERE organization_id = ${org} AND deleted_at IS NULL
    ORDER BY path, name`

  // Which departments may this actor read? An admin sees the organization; a manager
  // sees their own. The same `can()` that guards the API guards the rows.
  const visible: DepartmentRow[] = []
  for (const department of [...departments, { id: null, name: 'No department' }]) {
    const decision = can(actor, 'agent_run:read', {
      type: 'agent_run',
      organizationId: org,
      departmentId: department.id,
    })
    if (decision.allow) visible.push(department)
  }
  if (visible.length === 0) {
    throw new PermissionError(
      'You can see the AI ledger for departments you manage. Ask an admin for the organization-wide view.',
    )
  }

  const visibleIds = visible.filter((d): d is { id: string; name: string } => d.id !== null).map((d) => d.id)
  const includeNoDepartment = visible.some((d) => d.id === null)

  // `department` is resolved once, from the membership of the human the run acted for.
  const scope = sql`
    WITH scoped AS (
      SELECT r.*, m.department_id
      FROM agent_runs r
      LEFT JOIN memberships m
        ON m.user_id = r.principal_user_id AND m.organization_id = r.organization_id AND m.deleted_at IS NULL
      WHERE r.organization_id = ${org} AND r.deleted_at IS NULL
        AND r.created_at >= ${period.from} AND r.created_at < ${period.to}
        AND (
          m.department_id = ANY(${visibleIds}::uuid[])
          ${includeNoDepartment ? sql`OR m.department_id IS NULL` : sql``}
        )
    )`

  const runRows = await sql<
    {
      department_id: string | null
      mode: string
      status: string
      runs: string
      untrusted: string
      downgraded: string
      undone: string
      cost: string
      tokens_in: string
      tokens_out: string
    }[]
  >`
    ${scope}
    SELECT department_id, mode, status,
           count(*)::text AS runs,
           count(*) FILTER (WHERE contains_untrusted_content)::text AS untrusted,
           count(*) FILTER (WHERE capability_downgraded)::text AS downgraded,
           count(*) FILTER (WHERE undone_at IS NOT NULL)::text AS undone,
           coalesce(sum(cost_cents), 0)::text AS cost,
           coalesce(sum(tokens_in), 0)::text AS tokens_in,
           coalesce(sum(tokens_out), 0)::text AS tokens_out
    FROM scoped
    GROUP BY department_id, mode, status`

  const readRows = await sql<
    { department_id: string | null; passages: string; documents: string }[]
  >`
    ${scope}
    SELECT s.department_id,
           count(c.id)::text AS passages,
           count(DISTINCT c.document_id)::text AS documents
    FROM scoped s
    JOIN citations c ON c.run_id = s.id AND c.organization_id = ${org} AND c.deleted_at IS NULL
    GROUP BY s.department_id`

  const sourceRows = await sql<
    { department_id: string | null; source_type: string; document_id: string | null; label: string; times: string }[]
  >`
    ${scope}
    SELECT s.department_id, c.source_type, c.document_id,
           coalesce(d.title, initcap(replace(c.source_type, '_', ' '))) AS label,
           count(*)::text AS times
    FROM scoped s
    JOIN citations c ON c.run_id = s.id AND c.organization_id = ${org} AND c.deleted_at IS NULL
    LEFT JOIN documents d ON d.id = c.document_id AND d.organization_id = ${org}
    GROUP BY s.department_id, c.source_type, c.document_id, d.title
    ORDER BY count(*) DESC`

  // Proposed comes from the plan, executed from the tool call — the gap between them is
  // the most interesting column on the screen.
  const proposedRows = await sql<
    { department_id: string | null; tool: string; proposed: string }[]
  >`
    ${scope}
    -- The run stores the plan alongside the gate decision that was taken on it.
    SELECT s.department_id, regexp_replace(step->>'tool', '@v\\d+$', '') AS tool, count(*)::text AS proposed
    FROM scoped s,
         jsonb_array_elements(coalesce(s.plan->'plan'->'steps', s.plan->'steps', '[]'::jsonb)) AS step
    WHERE step->>'tool' IS NOT NULL
    GROUP BY s.department_id, regexp_replace(step->>'tool', '@v\\d+$', '')`

  const executedRows = await sql<
    { department_id: string | null; tool: string; risk_tier: string; executed: string; failed: string }[]
  >`
    ${scope}
    -- Plans name a tool, calls name a tool *version*. Comparing proposed with executed
    -- only means something once both sides say the same thing.
    SELECT s.department_id, regexp_replace(t.tool_name, '@v\\d+$', '') AS tool,
           t.risk_tier::text AS risk_tier,
           count(*) FILTER (WHERE t.ok)::text AS executed,
           count(*) FILTER (WHERE t.ok IS false)::text AS failed
    FROM scoped s
    JOIN tool_calls t ON t.run_id = s.id AND t.organization_id = ${org} AND t.deleted_at IS NULL
    GROUP BY s.department_id, regexp_replace(t.tool_name, '@v\\d+$', ''), t.risk_tier`

  const approvalRows = await sql<
    { department_id: string | null; status: string; count: string }[]
  >`
    ${scope}
    SELECT s.department_id, a.status::text AS status, count(*)::text AS count
    FROM scoped s
    JOIN approvals a ON a.agent_run_id = s.id AND a.organization_id = ${org} AND a.deleted_at IS NULL
    GROUP BY s.department_id, a.status`

  const agentRows = await sql<
    { agent_id: string | null; agent_name: string; runs: string; cost: string; actions: string }[]
  >`
    ${scope}
    SELECT s.agent_id,
           coalesce(a.name, 'Superwork (ad hoc)') AS agent_name,
           count(DISTINCT s.id)::text AS runs,
           coalesce(sum(s.cost_cents), 0)::text AS cost,
           count(t.id) FILTER (WHERE t.ok AND t.risk_tier <> 'read')::text AS actions
    FROM scoped s
    LEFT JOIN agents a ON a.id = s.agent_id AND a.organization_id = ${org}
    LEFT JOIN tool_calls t ON t.run_id = s.id AND t.organization_id = ${org} AND t.deleted_at IS NULL
    GROUP BY s.agent_id, a.name
    ORDER BY count(DISTINCT s.id) DESC`

  const byDepartment = new Map<string | null, DepartmentLedger>()
  for (const department of visible) {
    byDepartment.set(department.id, blank(department.id, department.name))
  }
  const bucket = (id: string | null): DepartmentLedger => {
    const found = byDepartment.get(id)
    if (found) return found
    const created = blank(id, 'No department')
    byDepartment.set(id, created)
    return created
  }

  for (const row of runRows) {
    const entry = bucket(row.department_id)
    const runs = Number(row.runs)
    entry.runs += runs
    entry.runsByMode[row.mode] = (entry.runsByMode[row.mode] ?? 0) + runs
    entry.runsByStatus[row.status] = (entry.runsByStatus[row.status] ?? 0) + runs
    entry.runsWithUntrustedContent += Number(row.untrusted)
    entry.runsCapabilityDowngraded += Number(row.downgraded)
    entry.runsUndone += Number(row.undone)
    entry.costCents += Number(row.cost)
    entry.tokensIn += Number(row.tokens_in)
    entry.tokensOut += Number(row.tokens_out)
  }

  for (const row of readRows) {
    const entry = bucket(row.department_id)
    entry.passagesRead += Number(row.passages)
    entry.distinctDocumentsRead += Number(row.documents)
  }

  for (const row of sourceRows) {
    const entry = bucket(row.department_id)
    if (entry.topSources.length >= 8) continue
    entry.topSources.push({
      sourceType: row.source_type,
      label: row.label,
      documentId: row.document_id,
      times: Number(row.times),
    })
  }

  const toolIndex = new Map<string, ProposedTool>()
  const toolKey = (departmentId: string | null, tool: string) => `${departmentId ?? 'none'}::${tool}`
  for (const row of proposedRows) {
    const entry = bucket(row.department_id)
    const tool = { tool: row.tool, riskTier: 'unknown', proposed: Number(row.proposed), executed: 0, failed: 0 }
    toolIndex.set(toolKey(row.department_id, row.tool), tool)
    entry.toolsProposed.push(tool)
    entry.stepsProposed += tool.proposed
  }
  for (const row of executedRows) {
    const entry = bucket(row.department_id)
    const existing = toolIndex.get(toolKey(row.department_id, row.tool))
    const executed = Number(row.executed)
    const failed = Number(row.failed)
    if (existing) {
      existing.executed += executed
      existing.failed += failed
      existing.riskTier = row.risk_tier
    } else {
      const tool = { tool: row.tool, riskTier: row.risk_tier, proposed: 0, executed, failed }
      toolIndex.set(toolKey(row.department_id, row.tool), tool)
      entry.toolsProposed.push(tool)
    }
    if (row.risk_tier !== 'read') {
      entry.actionsExecuted += executed
      entry.actionsByRiskTier[row.risk_tier] = (entry.actionsByRiskTier[row.risk_tier] ?? 0) + executed
    }
  }

  for (const row of approvalRows) {
    const entry = bucket(row.department_id)
    const count = Number(row.count)
    entry.approvalsRequested += count
    if (row.status === 'approved') entry.approvalsApproved += count
    if (row.status === 'rejected') entry.approvalsRejected += count
  }

  const departmentsOut = [...byDepartment.values()].sort((a, b) => b.runs - a.runs || a.departmentName.localeCompare(b.departmentName))
  for (const entry of departmentsOut) {
    entry.toolsProposed.sort((a, b) => b.proposed + b.executed - (a.proposed + a.executed))
  }

  const organization = departmentsOut.reduce(
    (totals, entry) => ({
      runs: totals.runs + entry.runs,
      costCents: totals.costCents + entry.costCents,
      actionsExecuted: totals.actionsExecuted + entry.actionsExecuted,
      approvalsRequested: totals.approvalsRequested + entry.approvalsRequested,
      runsUndone: totals.runsUndone + entry.runsUndone,
      passagesRead: totals.passagesRead + entry.passagesRead,
    }),
    { runs: 0, costCents: 0, actionsExecuted: 0, approvalsRequested: 0, runsUndone: 0, passagesRead: 0 },
  )

  const everything = visible.length === departments.length + 1

  return {
    period,
    basis:
      `Counted from agent runs, citations, tool calls, approvals and usage records between ` +
      `${formatInZone(period.from, ctx.timezone, { day: 'numeric', month: 'short' })} and ` +
      `${formatInZone(new Date(period.to.getTime() - 1), ctx.timezone, { day: 'numeric', month: 'short', year: 'numeric' })}, ` +
      `${ctx.timezone}.`,
    organization,
    departments: departmentsOut,
    agents: agentRows.map((row) => ({
      agentId: row.agent_id,
      agentName: row.agent_name,
      runs: Number(row.runs),
      costCents: Number(row.cost),
      actionsExecuted: Number(row.actions),
    })),
    restrictedTo: everything ? null : visible.map((d) => d.name),
  }
}

function blank(departmentId: string | null, departmentName: string): DepartmentLedger {
  return {
    departmentId,
    departmentName,
    runs: 0,
    runsByMode: {},
    runsByStatus: {},
    runsWithUntrustedContent: 0,
    runsCapabilityDowngraded: 0,
    passagesRead: 0,
    distinctDocumentsRead: 0,
    topSources: [],
    stepsProposed: 0,
    toolsProposed: [],
    actionsExecuted: 0,
    actionsByRiskTier: {},
    approvalsRequested: 0,
    approvalsApproved: 0,
    approvalsRejected: 0,
    runsUndone: 0,
    costCents: 0,
    tokensIn: 0,
    tokensOut: 0,
  }
}

/**
 * The runs behind a cell. Every figure on the ledger has to be openable, or it is a
 * dashboard number nobody can check (§16.9).
 */
export async function ledgerRuns(
  ctx: TenantContext,
  actor: Actor,
  input: { departmentId: string | null; period: LedgerPeriod; limit?: number },
): Promise<
  {
    id: string
    request: string
    mode: string
    status: string
    trigger: string
    principalName: string
    agentName: string | null
    costCents: number
    actions: number
    createdAt: Date
    undoneAt: Date | null
  }[]
> {
  const decision = can(actor, 'agent_run:read', {
    type: 'agent_run',
    organizationId: ctx.organizationId,
    departmentId: input.departmentId,
  })
  if (!decision.allow) throw new PermissionError(decision.reason)

  const sql = ctx.sql
  return sql<
    {
      id: string
      request: string
      mode: string
      status: string
      trigger: string
      principalName: string
      agentName: string | null
      costCents: number
      actions: number
      createdAt: Date
      undoneAt: Date | null
    }[]
  >`
    SELECT r.id, r.request, r.mode::text AS mode, r.status::text AS status, r.trigger,
           u.name AS "principalName", a.name AS "agentName",
           r.cost_cents::float8 AS "costCents",
           (SELECT count(*) FROM tool_calls t
             WHERE t.run_id = r.id AND t.organization_id = r.organization_id
               AND t.ok AND t.risk_tier <> 'read' AND t.deleted_at IS NULL)::int AS actions,
           r.created_at AS "createdAt", r.undone_at AS "undoneAt"
    FROM agent_runs r
    JOIN users u ON u.id = r.principal_user_id
    LEFT JOIN agents a ON a.id = r.agent_id
    LEFT JOIN memberships m
      ON m.user_id = r.principal_user_id AND m.organization_id = r.organization_id AND m.deleted_at IS NULL
    WHERE r.organization_id = ${ctx.organizationId} AND r.deleted_at IS NULL
      AND r.created_at >= ${input.period.from} AND r.created_at < ${input.period.to}
      AND m.department_id IS NOT DISTINCT FROM ${input.departmentId}
    ORDER BY r.created_at DESC
    LIMIT ${Math.min(input.limit ?? 50, 200)}`
}
