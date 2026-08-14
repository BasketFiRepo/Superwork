import Link from 'next/link'
import { describeCron, listWorkflows } from '@superwork/core'
import { requireSession, withActor } from '@/lib/session'
import { WorkflowComposer } from '@/components/WorkflowComposer'

export const dynamic = 'force-dynamic'

const EXAMPLES = [
  'Every weekday at 9, find customer threads with no reply for 5 days and draft a follow-up.',
  'Each morning, find overdue tasks and create a follow-up task for the owner.',
]

/**
 * Workflows (§10). A workflow is a versioned DAG with durable, resumable runs. Nothing can
 * be activated until a dry run against real data has passed.
 */
export default async function WorkflowsPage() {
  const session = await requireSession()
  const workflows = await withActor(session, (ctx, actor) => listWorkflows(ctx, actor))

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Operate</span>
        <h1>Workflows</h1>
        <p className="prose secondary">
          Describe what should happen and Superwork compiles it into a graph you can read. Nothing
          is activated until a dry run against real data has shown what it would have done — that
          single rule prevents most automation disasters.
        </p>
      </header>

      <WorkflowComposer examples={EXAMPLES} />

      <section className="panel">
        <div className="panel-header">
          <h2>Your workflows</h2>
          <span className="small muted">
            {workflows.length} {workflows.length === 1 ? 'workflow' : 'workflows'}
          </span>
        </div>
        {workflows.length === 0 ? (
          <div className="empty stack stack-3">
            <p className="secondary">No workflows yet.</p>
            <p className="small muted">Describe one above and it will appear here as a draft.</p>
          </div>
        ) : (
          <div className="panel-body-flush table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Workflow</th>
                  <th style={{ width: 160 }}>Owner</th>
                  <th style={{ width: 110 }}>Status</th>
                  <th style={{ width: 220 }}>Schedule</th>
                  <th style={{ width: 200 }}>Dry run</th>
                </tr>
              </thead>
              <tbody>
                {workflows.map((workflow) => (
                  <tr key={workflow.id}>
                    <td>
                      <Link href={`/workflows/${workflow.id}`}>{workflow.name}</Link>
                      {workflow.readback ? (
                        <div className="small muted" style={{ marginTop: 'var(--s-2)' }}>
                          {workflow.readback}
                        </div>
                      ) : null}
                    </td>
                    <td className="small secondary">{workflow.ownerName ?? 'unassigned'}</td>
                    <td className="small secondary">{workflow.status}</td>
                    <td className="small secondary">
                      {workflow.scheduleCron && workflow.scheduleEnabled
                        ? describeCron(workflow.scheduleCron, workflow.scheduleTimezone ?? 'UTC')
                        : 'when somebody runs it'}
                    </td>
                    <td>
                      {workflow.simulatedOk ? (
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
        )}
      </section>
    </div>
  )
}
