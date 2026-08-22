import { requireSession, withActor } from '@/lib/session'
import { readAuditLog, PermissionError } from '@superwork/core'

export const dynamic = 'force-dynamic'

/**
 * The forensic record (§3.6, ADR 0079).
 *
 * `writeAudit` has been called from all over this product since Phase 0 and nothing ever read
 * the table, while `audit:read:org` sat in the administrator's grant list. A trail nobody can
 * look at is not a trail; it is a table that grows.
 *
 * There are no totals on this screen and there is no chart. Grouping these rows by person is one
 * query away from a productivity measure, which §29.5 forbids by construction — so the screen
 * shows what happened, and the arithmetic that would turn it into a measure of somebody is not
 * written anywhere.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ entity?: string; action?: string }>
}) {
  const session = await requireSession()
  const params = await searchParams

  let entries: Awaited<ReturnType<typeof readAuditLog>> | null = null
  let denied: string | null = null
  try {
    entries = await withActor(session, (ctx, actor) =>
      readAuditLog(ctx, actor, {
        entityType: params.entity || undefined,
        action: params.action || undefined,
        limit: 200,
      }),
    )
  } catch (error) {
    if (error instanceof PermissionError) denied = error.message
    else throw error
  }

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Admin</span>
        <h1>Audit trail</h1>
        <p className="prose secondary">
          Every change this product records, in the order it happened. Nothing here can be edited,
          by anybody, including whoever holds the database — a record somebody can tidy is not
          evidence. Lines leave only when the retention policy removes them, on the schedule set
          under Retention, and never one at a time.
        </p>
      </header>

      {denied ? (
        <div className="panel">
          <div className="empty small secondary" data-testid="audit-denied">
            {denied}
          </div>
        </div>
      ) : (
        <section className="panel" data-testid="audit-log">
          <div className="panel-header">
            <h2>What happened</h2>
            <span className="small muted">{entries!.length} entries, most recent first</span>
          </div>

          <p className="small muted" style={{ margin: 0, padding: '0 var(--s-5)' }} data-testid="audit-explainer">
            Sensitive values are never written here: a change to one is recorded as having
            happened, with the field named and the value left out. There are no totals on this
            page and none anywhere behind it — what somebody did is a fact, and how much they did
            is a measure Superwork does not keep.
          </p>

          {entries!.length === 0 ? (
            <div className="empty small secondary">Nothing has been recorded yet.</div>
          ) : (
            <div className="panel-body-flush table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 150 }}>When</th>
                    <th style={{ width: 170 }}>Who</th>
                    <th style={{ width: 190 }}>Did what</th>
                    <th>To what</th>
                    <th style={{ width: 90 }}>Password</th>
                  </tr>
                </thead>
                <tbody>
                  {entries!.map((entry) => (
                    <tr key={entry.id} data-testid="audit-entry">
                      <td className="small mono muted">
                        {entry.occurredAt.toISOString().slice(0, 16).replace('T', ' ')}
                      </td>
                      <td className="small">
                        {entry.agentName ? (
                          <>
                            <span className="chip">agent</span> {entry.agentName}
                            {/* An agent's work is attributed to the person it ran for: the
                                question an auditor asks is who is answerable. */}
                            {entry.actorName ? (
                              <span className="small muted"> for {entry.actorName}</span>
                            ) : null}
                          </>
                        ) : (
                          (entry.actorName ?? <span className="muted">the system</span>)
                        )}
                      </td>
                      <td className="small mono">{entry.action}</td>
                      <td className="small secondary">
                        {entry.entityType}
                        {Object.keys(entry.diff).length > 0 ? (
                          <span className="small muted"> · {Object.keys(entry.diff).join(', ')}</span>
                        ) : null}
                        {entry.redactedFields.length > 0 ? (
                          <span className="chip" style={{ marginLeft: 6 }} data-testid="audit-redacted">
                            {entry.redactedFields.length} not recorded
                          </span>
                        ) : null}
                      </td>
                      <td className="small">
                        {entry.steppedUp ? (
                          <span className="chip chip-positive">confirmed</span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  )
}
