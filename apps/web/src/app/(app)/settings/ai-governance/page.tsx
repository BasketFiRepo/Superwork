import { requireSession, withActor } from '@/lib/session'
import { can, describeEffectiveCapability, ROLE_MAX_SENSITIVITY } from '@superwork/auth'
import {
  agentGrants,
  certificationState,
  formatCents,
  monitoringPolicy,
  spendSnapshot,
  trustLedger,
} from '@superwork/core'
import { allTools } from '@superwork/tools'
import { GovernanceControls } from '@/components/GovernanceControls'
import { KillSwitch } from '@/components/KillSwitch'

export const dynamic = 'force-dynamic'

/**
 * Settings → AI Governance (§17, §27).
 *
 * This is the screen an enterprise security reviewer asks to see first: what the agent
 * may do, who is accountable for it, what it cost, and how to stop it.
 */
export default async function AiGovernancePage() {
  const session = await requireSession()

  const data = await withActor(session, async (ctx, actor) => {
    const agents = await ctx.sql<
      {
        id: string
        key: string
        name: string
        purpose: string
        mode: string
        status: string
        ownerName: string
        maxSensitivity: string
        toolGrants: string[]
        budget: Record<string, number>
        recertifiedAt: Date | null
        recertifiedVersion: number | null
        recertifiedByName: string | null
        publishedVersion: number
      }[]
    >`
      SELECT a.id, a.key, a.name, a.purpose, a.mode, a.status, u.name AS "ownerName",
             a.max_sensitivity AS "maxSensitivity", a.tool_grants AS "toolGrants",
             a.budget, a.recertified_at AS "recertifiedAt",
             a.recertified_version AS "recertifiedVersion",
             (SELECT coalesce(max(v.ordinal), 0) FROM agent_versions v
               WHERE v.organization_id = a.organization_id AND v.agent_id = a.id) AS "publishedVersion",
             (SELECT r.name FROM users r WHERE r.id = a.recertified_by) AS "recertifiedByName"
      FROM agents a JOIN users u ON u.id = a.owner_user_id
      WHERE a.organization_id = ${ctx.organizationId} AND a.deleted_at IS NULL
      ORDER BY a.is_subagent, a.name`

    // The two controls this screen's own refusal message has always pointed at.
    const grants = await agentGrants(ctx, actor)
    const monitoring = await monitoringPolicy(ctx, actor)
    const departments = await ctx.sql<{ id: string; name: string }[]>`
      SELECT id, name FROM departments
      WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL ORDER BY name`
    const canEdit = can(actor, 'settings:update', {
      type: 'settings',
      organizationId: ctx.organizationId,
      riskTier: 'high',
    }).allow

    const [runStats] = await ctx.sql<{ total: number; undone: number; failed: number; downgraded: number }[]>`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE undone_at IS NOT NULL)::int AS undone,
             count(*) FILTER (WHERE status = 'failed')::int AS failed,
             count(*) FILTER (WHERE capability_downgraded)::int AS downgraded
      FROM agent_runs WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL`

    return {
      agents,
      grants,
      runStats: runStats ?? { total: 0, undone: 0, failed: 0, downgraded: 0 },
      spend: await spendSnapshot(ctx, 'business'),
      ledger: await trustLedger(ctx),
      monitoring,
      recertificationDays: monitoring.agentRecertificationDays,
      departments,
      canEdit,
      capability: describeEffectiveCapability({
        ...actor,
        type: 'agent',
        agent: {
          agentId: 'orchestrator',
          agentName: 'Superwork',
          mode: 'execute',
          orgGrant: [],
          denied: [],
          toolGrants: ['*'],
          maxSensitivity: 'confidential',
          capabilityDowngraded: false,
        },
      }),
    }
  })

  const tools = allTools()
  const byTier = {
    read: tools.filter((t) => t.riskTier === 'read'),
    low: tools.filter((t) => t.riskTier === 'low'),
    high: tools.filter((t) => t.riskTier === 'high'),
  }

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Admin</span>
        <h1>AI governance</h1>
        <p className="prose secondary">
          What the agent may read, suggest, draft and execute — and the one control that stops all
          of it.
        </p>
      </header>

      <KillSwitch engaged={session.killSwitch} />

      <section className="panel">
        <div className="panel-header">
          <h2>Effective capability</h2>
          <span className="small muted">Computed from the full intersection, in plain language</span>
        </div>
        <div className="panel-body stack stack-4">
          <p className="prose">{data.capability}</p>
          <div className="row wrap">
            <span className="chip">Your clearance: {ROLE_MAX_SENSITIVITY['owner']}</span>
            <span className="chip">{data.runStats.total} runs recorded</span>
            <span className="chip">{data.runStats.undone} undone</span>
            <span className="chip">{data.runStats.failed} failed</span>
            {data.runStats.downgraded > 0 ? (
              <span className="chip chip-attention">
                {data.runStats.downgraded} downgraded after reading untrusted content
              </span>
            ) : null}
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Agents</h2>
          <span className="small muted">Every agent has a named accountable human</span>
        </div>
        <div className="panel-body-flush table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Agent</th>
                <th style={{ width: 150 }}>Owner</th>
                <th style={{ width: 90 }}>Mode</th>
                <th style={{ width: 100 }}>Status</th>
                <th style={{ width: 130 }}>Reads up to</th>
                <th style={{ width: 130 }}>Daily action cap</th>
                <th style={{ width: 200 }}>Who stands behind it</th>
              </tr>
            </thead>
            <tbody>
              {data.agents.map((agent) => (
                <tr key={agent.id}>
                  <td>
                    <div className="stack stack-1">
                      <span>{agent.name}</span>
                      <span className="small muted">{agent.purpose}</span>
                    </div>
                  </td>
                  <td className="small secondary">{agent.ownerName}</td>
                  <td className="small secondary">{agent.mode}</td>
                  <td>
                    <span className={agent.status === 'active' ? 'chip chip-positive' : 'chip'}>{agent.status}</span>
                  </td>
                  <td className="small secondary">{agent.maxSensitivity}</td>
                  <td className="num">{agent.budget?.maxActionsDay ?? agent.budget?.maxActionsPerDay ?? '—'}</td>
                  <td className="small" data-testid="agent-certification">
                    {(() => {
                      // `recertified_at` was selected on this very screen and rendered nowhere
                      // for twenty increments, which is how a column with no writer stays
                      // invisible. The same rule the runtime uses for the mode ceiling.
                      const state = certificationState(
                        {
                          name: agent.name,
                          publishedVersion: agent.publishedVersion,
                          recertifiedAt: agent.recertifiedAt,
                          recertifiedVersion: agent.recertifiedVersion,
                          recertifiedByName: agent.recertifiedByName,
                        },
                        data.recertificationDays,
                      )
                      return state.stale ? (
                        <span className="chip chip-attention">
                          {state.state === 'never'
                            ? 'never reviewed'
                            : state.state === 'changed'
                              ? 'changed since'
                              : `overdue by ${state.daysOverdue}d`}
                        </span>
                      ) : (
                        <span className="secondary">
                          {agent.recertifiedByName} · {agent.recertifiedAt?.toISOString().slice(0, 10)}
                        </span>
                      )
                    })()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel-body hairline-top small muted">
          Publishing an agent, or granting it high-risk capability, requires a second approver
          <em> and</em> step-up authentication: the person proposing a change cannot be the one who
          signs it off, and the one who signs it off re-enters their password first. Both are
          enforced where the change is written, not where the button is drawn. Create, permission,
          simulate and publish an agent on the{' '}
          <a href="/settings/agents">agents screen</a>.
        </div>
      </section>

      <GovernanceControls
        canEdit={data.canEdit}
        departments={data.departments}
        monitoring={{
          jurisdictionProfile: data.monitoring.jurisdictionProfile,
          nudgeBudgetPerPersonPerDay: data.monitoring.nudgeBudgetPerPersonPerDay,
          noSurprisesReviewHours: data.monitoring.noSurprisesReviewHours,
          ceiling: data.monitoring.ceiling,
          reason: data.monitoring.reason,
          setByName: data.monitoring.setByName,
          prohibited: data.monitoring.prohibited,
        }}
        grants={data.grants.map((grant) => ({
          id: grant.id,
          capability: grant.capability,
          toolPattern: grant.toolPattern,
          effect: grant.effect,
          maxSensitivity: grant.maxSensitivity,
          departmentName: grant.departmentName,
          reason: grant.reason,
          grantedByName: grant.grantedByName,
        }))}
      />

      <section className="grid-2">
        <div className="panel">
          <div className="panel-header">
            <h2>Tool registry</h2>
          </div>
          <div className="panel-body stack stack-5">
            {(['read', 'low', 'high'] as const).map((tier) => (
              <div className="stack stack-3" key={tier}>
                <span className="micro">
                  {tier === 'read' ? 'Read' : tier === 'low' ? 'Reversible writes' : 'Irreversible or external'} —{' '}
                  {byTier[tier].length}
                </span>
                <div className="row wrap">
                  {byTier[tier].map((tool) => (
                    <span
                      key={tool.name}
                      className={tier === 'high' ? 'chip chip-critical' : 'chip'}
                      title={`${tool.description}${tool.inverse ? ` Inverse: ${tool.inverse}.` : ' No inverse — approval required.'}`}
                    >
                      {tool.name.replace(/@v\d+$/, '')}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="stack stack-6">
          <div className="panel">
            <div className="panel-header">
              <h2>Spend</h2>
            </div>
            <div className="panel-body stack stack-4">
              <div className="spread">
                <span className="small secondary">This month</span>
                <span className="metric">{formatCents(data.spend.monthToDateCents, session.currency)}</span>
              </div>
              <div className="spread">
                <span className="small secondary">Organization cap</span>
                <span className="metric">{data.spend.capCents ? formatCents(data.spend.capCents, session.currency) : 'none'}</span>
              </div>
              <div className="spread">
                <span className="small secondary">Your spend today</span>
                <span className="metric">{formatCents(data.spend.userTodayCents, session.currency)}</span>
              </div>
              <p className="small muted">
                Soft warning at 80%, hard stop at the cap. Quality is never silently degraded — the
                agent stops and says so.
              </p>
            </div>
          </div>

        </div>
      </section>

      {data.ledger.length > 0 ? (
        <section className="panel">
          <div className="panel-header">
            <h2>Trust ledger</h2>
            <span className="small muted">Used to justify — and to earn — expanded autonomy</span>
          </div>
          <div className="panel-body-flush table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Action type</th>
                  <th style={{ width: 110 }}>Proposed</th>
                  <th style={{ width: 110 }}>Approved</th>
                  <th style={{ width: 110 }}>Rejected</th>
                  <th style={{ width: 140 }}>Approval rate</th>
                </tr>
              </thead>
              <tbody>
                {data.ledger.map((row) => (
                  <tr key={row.actionType}>
                    <td>{row.actionType.replace(/_/g, ' ')}</td>
                    <td className="num">{row.proposed}</td>
                    <td className="num">{row.approved}</td>
                    <td className="num">{row.rejected}</td>
                    <td className="num">{(row.approvalRate * 100).toFixed(0)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  )
}
