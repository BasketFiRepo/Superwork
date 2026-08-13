import { requireSession, withActor } from '@/lib/session'

export const dynamic = 'force-dynamic'

/**
 * Workflows (§10). Phase 1 ships the durable model and the dry-run requirement; the
 * visual DAG editor and natural-language authoring land in Phase 2. Controls that are
 * not built render disabled with the phase named, never as live-looking no-ops (§0.2).
 */
export default async function WorkflowsPage() {
  const session = await requireSession()

  const workflows = await withActor(session, async (ctx) => {
    return ctx.sql<{ id: string; name: string; status: string; simulated_ok: boolean; owner: string | null }[]>`
      SELECT w.id, w.name, w.status, w.simulated_ok, u.name AS owner
      FROM workflows w LEFT JOIN users u ON u.id = w.owner_user_id
      WHERE w.organization_id = ${ctx.organizationId} AND w.deleted_at IS NULL
      ORDER BY w.name`
  })

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Operate</span>
        <h1>Workflows</h1>
        <p className="prose secondary">
          A workflow is a versioned DAG with durable, resumable runs. Nothing can be activated
          until a dry run against real data has passed — that single rule prevents most automation
          disasters.
        </p>
      </header>

      {workflows.length === 0 ? (
        <div className="panel">
          <div className="empty stack stack-4">
            <p className="secondary">No workflows yet.</p>
            <p className="prose small muted" style={{ margin: '0 auto' }}>
              The engine, the versioned graph, the durable run tables and the simulation gate are
              built. Authoring — describing an automation in plain language, seeing the DAG and its
              readback, and dry-running it against the last thirty days — lands in Phase 2.
            </p>
            <div className="row" style={{ justifyContent: 'center' }}>
              <button className="btn btn-primary" disabled title="Natural-language authoring lands in Phase 2.">
                Describe an automation
                <span className="chip">Coming soon</span>
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="panel">
          <div className="panel-body-flush table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Workflow</th>
                  <th style={{ width: 140 }}>Owner</th>
                  <th style={{ width: 110 }}>Status</th>
                  <th style={{ width: 140 }}>Simulated</th>
                </tr>
              </thead>
              <tbody>
                {workflows.map((workflow) => (
                  <tr key={workflow.id}>
                    <td>{workflow.name}</td>
                    <td className="small secondary">{workflow.owner ?? 'unassigned'}</td>
                    <td className="small secondary">{workflow.status}</td>
                    <td>
                      {workflow.simulated_ok ? (
                        <span className="chip chip-positive">passed</span>
                      ) : (
                        <span className="chip chip-attention">required before activation</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
