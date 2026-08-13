import Link from 'next/link'
import { requireSession, withActor } from '@/lib/session'
import { listRuns } from '@superwork/core'
import { formatCents } from '@superwork/core'

export const dynamic = 'force-dynamic'

/** Agent (§17). Primary action: ask or delegate. The composer lives in the rail. */
export default async function AgentPage() {
  const session = await requireSession()
  const runs = await withActor(session, (ctx) => listRuns(ctx, { limit: 25 }))

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Know</span>
        <h1>Agent</h1>
        <p className="prose secondary">
          Every run is recorded with its plan, its steps, its sources, its cost and its inverse.
          Ask in the rail on the right; the history of what has been asked is here.
        </p>
      </header>

      <section className="grid-3">
        <div className="panel">
          <div className="panel-body stack stack-2">
            <span className="micro">Runs recorded</span>
            <span className="metric" style={{ fontSize: 28, fontWeight: 600 }}>{runs.length}</span>
          </div>
        </div>
        <div className="panel">
          <div className="panel-body stack stack-2">
            <span className="micro">Total cost</span>
            <span className="metric" style={{ fontSize: 28, fontWeight: 600 }}>
              {formatCents(runs.reduce((sum, run) => sum + run.costCents, 0))}
            </span>
          </div>
        </div>
        <div className="panel">
          <div className="panel-body stack stack-2">
            <span className="micro">Undone</span>
            <span className="metric" style={{ fontSize: 28, fontWeight: 600 }}>
              {runs.filter((run) => run.undoneAt).length}
            </span>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Run history</h2>
        </div>
        {runs.length === 0 ? (
          <div className="empty stack stack-3">
            <p className="secondary">No runs yet.</p>
            <p className="small muted">Ask something in the rail. Try “What is our liability cap for Halden Foods?”</p>
          </div>
        ) : (
          <div className="panel-body-flush table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Request</th>
                  <th style={{ width: 90 }}>Mode</th>
                  <th style={{ width: 130 }}>Status</th>
                  <th style={{ width: 90 }}>Steps</th>
                  <th style={{ width: 110 }}>Cost</th>
                  <th style={{ width: 100 }}>Run</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td className="small">{run.request}</td>
                    <td className="small secondary">{run.mode}</td>
                    <td>
                      <span
                        className={
                          run.status === 'succeeded'
                            ? 'chip chip-positive'
                            : run.status === 'awaiting_approval'
                              ? 'chip chip-attention'
                              : run.status === 'failed'
                                ? 'chip chip-critical'
                                : 'chip'
                        }
                      >
                        {run.status.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="num">{run.stepsUsed}</td>
                    <td className="num">{formatCents(run.costCents)}</td>
                    <td>
                      <Link className="small" href={`/activity?run=${run.id}`}>
                        inspect
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
