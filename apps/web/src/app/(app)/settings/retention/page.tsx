import { listErasures, PermissionError, retentionPolicies } from '@superwork/core'
import { requireSession, withActor } from '@/lib/session'
import { RetentionAdmin } from '@/components/RetentionAdmin'

export const dynamic = 'force-dynamic'

/**
 * Retention and erasure (§21). How long each class of data is kept, who decided that and
 * why, what the last purge removed — and the one screen from which a person can be erased,
 * which shows the whole list before it will do anything.
 */
export default async function RetentionPage() {
  const session = await requireSession()

  let data: {
    policies: Awaited<ReturnType<typeof retentionPolicies>>
    members: { id: string; name: string; role: string }[]
    erasures: Awaited<ReturnType<typeof listErasures>>
  } | null = null
  let denied: string | null = null

  try {
    data = await withActor(session, async (ctx, actor) => ({
      policies: await retentionPolicies(ctx, actor),
      members: await ctx.sql<{ id: string; name: string; role: string }[]>`
        SELECT u.id, u.name, m.role FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.organization_id = ${ctx.organizationId} AND m.deleted_at IS NULL AND m.status = 'active'
          AND m.user_id <> ${actor.userId}
        ORDER BY u.name`,
      erasures: await listErasures(ctx, actor),
    }))
  } catch (error) {
    if (error instanceof PermissionError) denied = error.message
    else throw error
  }

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Admin</span>
        <h1>Retention and erasure</h1>
        <p className="prose secondary">
          Superwork keeps what it needs for as long as somebody decided it should, and can remove
          one person from the record on request — saying in advance exactly what will go, what will
          stay with the name taken off, and what is kept on a stated basis.
        </p>
      </header>

      {denied ? (
        <div className="panel">
          <div className="empty small secondary">{denied}</div>
        </div>
      ) : (
        <>
          <RetentionAdmin
            policies={(data?.policies ?? []).map((policy) => ({
              ...policy,
              lastAppliedAt: policy.lastAppliedAt ? policy.lastAppliedAt.toISOString() : null,
            }))}
            members={data?.members ?? []}
          />

          <section className="panel" data-testid="erasure-history">
            <div className="panel-header">
              <h2>Erasures carried out</h2>
              <span className="small muted">The record that outlives the person, on purpose</span>
            </div>
            {(data?.erasures ?? []).length === 0 ? (
              <div className="empty small secondary">Nobody has been erased.</div>
            ) : (
              <div className="panel-body-flush table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 240 }}>Who</th>
                      <th>Why</th>
                      <th style={{ width: 160 }}>Requested by</th>
                      <th style={{ width: 130 }}>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.erasures ?? []).map((erasure) => (
                      <tr key={erasure.id}>
                        <td>{erasure.subjectLabel}</td>
                        <td className="small secondary">{erasure.reason}</td>
                        <td className="small secondary">{erasure.requestedByName ?? '—'}</td>
                        <td className="small secondary">
                          {erasure.completedAt ? erasure.completedAt.toISOString().slice(0, 10) : erasure.status}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}
