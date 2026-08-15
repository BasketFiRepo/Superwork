import Link from 'next/link'
import { requireSession, withActor } from '@/lib/session'
import { listCitations, listRunMessages, listSteps, listToolCalls, listUndoOperations, getRun } from '@superwork/core'
import { TraceRail } from '@/components/TraceRail'
import { UndoRunButton } from '@/components/UndoRunButton'

export const dynamic = 'force-dynamic'

const ACTOR_FILTERS = [
  { id: 'all', label: 'Everyone' },
  { id: 'agent', label: 'AI' },
  { id: 'user', label: 'People' },
  { id: 'system', label: 'System' },
] as const

/** Activity (§17). Primary action: reconstruct what happened. */
export default async function ActivityPage({
  searchParams,
}: {
  searchParams: Promise<{ actor?: string; run?: string }>
}) {
  const session = await requireSession()
  const params = await searchParams
  const actorFilter = params.actor ?? 'all'

  const data = await withActor(session, async (ctx) => {
    const activities = await ctx.sql<
      {
        id: string
        actorType: string
        actorLabel: string
        verb: string
        entityType: string
        entityId: string
        entityLabel: string
        summary: string
        agentRunId: string | null
        occurredAt: Date
      }[]
    >`
      SELECT id, actor_type AS "actorType", actor_label AS "actorLabel", verb,
             entity_type AS "entityType", entity_id AS "entityId", entity_label AS "entityLabel",
             summary, agent_run_id AS "agentRunId", occurred_at AS "occurredAt"
      FROM activities
      WHERE organization_id = ${ctx.organizationId} AND deleted_at IS NULL
        ${actorFilter !== 'all' ? ctx.sql`AND actor_type = ${actorFilter}::sw_actor_type` : ctx.sql``}
      ORDER BY occurred_at DESC
      LIMIT 60`

    if (!params.run) return { activities, run: null, steps: [], citations: [], toolCalls: [], undo: [], messages: [] }

    return {
      activities,
      run: await getRun(ctx, params.run),
      steps: await listSteps(ctx, params.run),
      citations: await listCitations(ctx, params.run),
      toolCalls: await listToolCalls(ctx, params.run),
      messages: await listRunMessages(ctx, params.run),
      undo: await listUndoOperations(ctx, params.run),
    }
  })

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Operate</span>
        <h1>Activity</h1>
        <p className="prose secondary">
          The human-readable timeline. Every entry names who acted — a person, the AI, an
          integration or the system. The forensic audit log sits behind it and is append-only.
        </p>
      </header>

      {data.run ? (
        <section className="panel">
          <div className="panel-header">
            <div className="stack stack-2">
              <h2>Run inspector</h2>
              <span className="small muted mono">
                trace {data.run.traceId} · {data.run.aiMode} · {(data.run.costCents / 100).toFixed(4)} GBP ·{' '}
                {data.run.tokensIn}/{data.run.tokensOut} tokens
              </span>
            </div>
            <div className="row-tight">
              <span className={data.run.status === 'succeeded' ? 'chip chip-positive' : 'chip'}>{data.run.status}</span>
              <Link className="btn btn-ghost btn-sm" href="/activity">
                Close
              </Link>
            </div>
          </div>
          <div className="panel-body stack stack-6">
            <div className="stack stack-2">
              <span className="micro">Request</span>
              <p className="prose">{data.run.request}</p>
            </div>

            <TraceRail
              steps={data.steps.map((step) => ({
                ordinal: step.ordinal,
                phase: step.phase,
                label: step.label,
                status: step.status,
                durationMs: step.durationMs,
                startedAt: step.startedAt ? step.startedAt.toISOString() : null,
                errorMessage: step.errorMessage,
              }))}
              narrative={data.run.summary}
              citations={data.citations.map((c) => ({
                claim: c.claim,
                documentTitle: c.documentTitle,
                documentId: c.documentId,
                anchor: c.anchor,
                sourceType: c.sourceType,
              }))}
            />

            {data.run.injectionFlags && (data.run.injectionFlags as unknown[]).length > 0 ? (
              <div className="banner banner-critical">
                This run read untrusted external content that attempted to give it instructions. It
                was reported, not obeyed, and the run was capability-downgraded.
              </div>
            ) : null}

            {data.messages.length > 0 ? (
              <details data-testid="run-messages">
                <summary className="small" style={{ cursor: 'pointer', color: 'var(--ink-secondary)' }}>
                  Model calls — {data.messages.length}
                </summary>
                <div className="table-scroll" style={{ marginTop: 'var(--s-4)' }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th style={{ width: 170 }}>What for</th>
                        <th style={{ width: 150 }}>Model</th>
                        <th style={{ width: 110 }}>Tokens</th>
                        <th style={{ width: 90 }}>Took</th>
                        <th style={{ width: 90 }}>Cost</th>
                        <th>What it said</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.messages.map((message) => (
                        <tr key={message.id} data-testid="run-message-row">
                          <td className="small secondary">
                            {message.taskClass ?? '—'}
                            {message.simulated ? (
                              <div>
                                <span className="chip">simulated</span>
                              </div>
                            ) : null}
                          </td>
                          <td className="mono small">{message.model ?? '—'}</td>
                          <td className="num small">
                            {message.tokensIn} in · {message.tokensOut} out
                          </td>
                          <td className="num small">{message.latencyMs ?? 0}ms</td>
                          <td className="num small">{(message.costCents / 100).toFixed(4)}</td>
                          <td className="small secondary">{message.content.slice(0, 140)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="small muted" style={{ marginTop: 'var(--s-3)' }}>
                  The run’s tokens and cost are the sum of these rows — kept by the database, so
                  the figure above and the rows here cannot disagree.
                </p>
              </details>
            ) : null}

            {data.toolCalls.length > 0 ? (
              <details>
                <summary className="small" style={{ cursor: 'pointer', color: 'var(--ink-secondary)' }}>
                  Tool calls — {data.toolCalls.length}
                </summary>
                <div className="table-scroll" style={{ marginTop: 'var(--s-4)' }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Tool</th>
                        <th style={{ width: 80 }}>Risk</th>
                        <th style={{ width: 70 }}>OK</th>
                        <th style={{ width: 90 }}>Duration</th>
                        <th>Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.toolCalls.map((call) => (
                        <tr key={call.id}>
                          <td className="mono">{call.toolName}</td>
                          <td className="small secondary">{call.riskTier}</td>
                          <td>{call.ok ? '✓' : '✗'}</td>
                          <td className="num">{call.durationMs ?? 0}ms</td>
                          <td className="small secondary">{call.errorCode ?? JSON.stringify(call.output).slice(0, 80)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ) : null}

            {data.undo.length > 0 ? (
              <div className="stack stack-4">
                <span className="micro">Reversible changes — {data.undo.length}</span>
                <ul className="stack stack-2 small secondary" style={{ margin: 0, paddingLeft: 'var(--s-7)' }}>
                  {data.undo.map((operation) => (
                    <li key={operation.id}>
                      {operation.description}
                      {operation.undoneAt ? ' — already undone' : ''}
                      {operation.undoError ? ` — failed: ${operation.undoError}` : ''}
                    </li>
                  ))}
                </ul>
                {data.run.undoneAt ? (
                  <span className="chip chip-positive">This run was undone</span>
                ) : (
                  <UndoRunButton runId={data.run.id} count={data.undo.filter((o) => !o.undoneAt).length} />
                )}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}

      <div className="row wrap">
        {ACTOR_FILTERS.map((option) => (
          <Link
            key={option.id}
            href={`/activity?actor=${option.id}`}
            className={`btn btn-sm${actorFilter === option.id ? ' btn-primary' : ''}`}
          >
            {option.label}
          </Link>
        ))}
      </div>

      <div className="panel">
        {data.activities.length === 0 ? (
          <div className="empty small secondary">Nothing has happened under this filter yet.</div>
        ) : (
          <div className="panel-body-flush table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 150 }}>When</th>
                  <th style={{ width: 90 }}>Actor</th>
                  <th>What happened</th>
                  <th style={{ width: 110 }}>Run</th>
                </tr>
              </thead>
              <tbody>
                {data.activities.map((activity) => (
                  <tr key={activity.id}>
                    <td className="mono muted">
                      {new Intl.DateTimeFormat('en-GB', {
                        timeZone: session.timezone,
                        day: '2-digit',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      }).format(activity.occurredAt)}
                    </td>
                    <td>
                      <span className={activity.actorType === 'agent' ? 'chip chip-accent' : 'chip'}>
                        {activity.actorType === 'agent' ? 'AI' : activity.actorType}
                      </span>
                    </td>
                    <td className="small">{activity.summary}</td>
                    <td>
                      {activity.agentRunId ? (
                        <Link className="small" href={`/activity?run=${activity.agentRunId}`}>
                          inspect
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
