import { Link } from '@/components/Link'
import { requireSession, withActor } from '@/lib/session'
import { listAgents, listChangeRequests, PermissionError } from '@superwork/core'
import { NewAgentForm } from '@/components/NewAgentForm'

export const dynamic = 'force-dynamic'

/**
 * The agent studio (§27, §24 Phase 3 acceptance). Personas are created, permissioned,
 * simulated and published here — by an administrator, without an engineer.
 */
export default async function AgentsPage() {
  const session = await requireSession()

  let data: { agents: Awaited<ReturnType<typeof listAgents>>; open: Awaited<ReturnType<typeof listChangeRequests>> } | null =
    null
  let denied: string | null = null
  try {
    data = await withActor(session, async (ctx, actor) => ({
      agents: await listAgents(ctx, actor),
      open: await listChangeRequests(ctx, actor, { open: true }),
    }))
  } catch (error) {
    if (error instanceof PermissionError) denied = error.message
    else throw error
  }

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Admin</span>
        <h1>Agents</h1>
        <p className="prose secondary">
          An agent is a persona with an owner, a purpose, a named list of tools and a mode
          ceiling. Changing any of those is a reviewed change: simulate it, write down why,
          and somebody else approves it.
        </p>
      </header>

      {denied ? (
        <div className="panel">
          <div className="empty small secondary">{denied}</div>
        </div>
      ) : null}

      {data ? (
        <>
          {data.open.length > 0 ? (
            <section className="panel" data-testid="open-changes">
              <div className="panel-header">
                <h2>Waiting for a second approver</h2>
                <span className="chip chip-attention">{data.open.length}</span>
              </div>
              <div className="panel-body-flush">
                {data.open.map((change) => (
                  <div className="spread panel-body hairline-top" key={change.id}>
                    <div className="stack stack-1">
                      <strong className="small">{change.agentName}</strong>
                      <span className="small muted">
                        {change.requestedByName} — {change.justification}
                      </span>
                      <div className="row-tight">
                        {change.diff.map((field) => (
                          <span className={`chip${field.widens ? ' chip-attention' : ''}`} key={String(field.field)}>
                            {String(field.field)}
                            {field.widens ? ' widens' : ''}
                          </span>
                        ))}
                      </div>
                    </div>
                    <Link className="btn btn-sm" href={`/settings/agents/${change.agentId}`}>
                      Review
                    </Link>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <section className="panel">
            <div className="panel-header">
              <h2>Personas</h2>
              <span className="small muted">{data.agents.length} defined</span>
            </div>
            <div className="panel-body-flush table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th style={{ width: 110 }}>Status</th>
                    <th style={{ width: 110 }}>Mode</th>
                    <th style={{ width: 130 }}>Clearance</th>
                    <th>Tools</th>
                    <th style={{ width: 140 }}>Owner</th>
                  </tr>
                </thead>
                <tbody>
                  {data.agents.map((agent) => (
                    <tr key={agent.agentId} data-testid="agent-row">
                      <td>
                        <Link href={`/settings/agents/${agent.agentId}`}>{agent.name}</Link>
                        <div className="small muted">{agent.purpose}</div>
                      </td>
                      <td>
                        <span
                          className={`chip${agent.status === 'active' ? ' chip-positive' : agent.status === 'paused' ? ' chip-attention' : ''}`}
                        >
                          {agent.status}
                        </span>
                      </td>
                      <td className="small">{agent.mode}</td>
                      <td className="small secondary">{agent.maxSensitivity}</td>
                      <td className="small mono">
                        {agent.toolGrants.length === 0
                          ? '—'
                          : agent.toolGrants.includes('*')
                            ? 'every tool'
                            : agent.toolGrants.join(', ')}
                      </td>
                      <td className="small secondary">{agent.ownerName ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <NewAgentForm />
        </>
      ) : null}
    </div>
  )
}
