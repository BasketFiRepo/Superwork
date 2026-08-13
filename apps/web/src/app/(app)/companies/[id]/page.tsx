import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireSession, withActor } from '@/lib/session'
import { listContacts, listInteractions, NotFoundError, relationship360 } from '@superwork/core'
import { AccountSummaryPanel } from '@/components/AccountSummaryPanel'

export const dynamic = 'force-dynamic'

export default async function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params

  try {
    const { view, contacts, interactions } = await withActor(session, async (ctx, actor) => ({
      view: await relationship360(ctx, actor, id),
      contacts: await listContacts(ctx, actor, { companyId: id }),
      interactions: await listInteractions(ctx, id, 10),
    }))

    return (
      <div className="stack stack-8">
        <header className="stack stack-3">
          <Link className="small secondary" href="/companies">
            ← Companies
          </Link>
          <h1>{view.company.name}</h1>
          <div className="row wrap">
            <span className="chip">{view.company.type}</span>
            <span className="chip">owner {view.company.ownerName ?? 'unassigned'}</span>
            <span className="chip">SLA {view.company.replySlaDays} days</span>
            {view.company.domains.map((d) => (
              <span className="chip mono" key={d}>
                {d}
              </span>
            ))}
          </div>
        </header>

        {view.risks.length > 0 ? (
          <div className="banner banner-attention">
            <div className="stack stack-2">
              <strong>Worth watching</strong>
              {view.risks.map((risk) => (
                <span key={risk}>{risk}</span>
              ))}
            </div>
          </div>
        ) : null}

        <AccountSummaryPanel companyId={id} companyName={view.company.name} />

        <section className="grid-2">
          <div className="panel">
            <div className="panel-header">
              <h2>Open threads</h2>
              <Link className="btn btn-ghost btn-sm" href="/inbox">
                Inbox
              </Link>
            </div>
            {view.openThreads.length === 0 ? (
              <div className="empty small secondary">No open threads.</div>
            ) : (
              <div className="panel-body-flush table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Subject</th>
                      <th style={{ width: 90 }}>Waiting</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.openThreads.map((t) => (
                      <tr key={t.id}>
                        <td className="small">
                          <Link href={`/inbox/${t.id}`}>{t.subject}</Link>
                        </td>
                        <td className="num small" style={t.pastSla ? { color: 'var(--attention)' } : undefined}>
                          {t.daysWaiting}d
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="panel">
            <div className="panel-header">
              <h2>Commitments</h2>
              <Link className="btn btn-ghost btn-sm" href="/commitments">
                Ledger
              </Link>
            </div>
            <div className="panel-body stack stack-4">
              <div className="stack stack-2">
                <span className="micro">We owe them — {view.commitmentsWeOwe.length}</span>
                {view.commitmentsWeOwe.length === 0 ? (
                  <span className="small muted">Nothing outstanding.</span>
                ) : (
                  view.commitmentsWeOwe.slice(0, 5).map((c) => (
                    <span className="small" key={c.id}>
                      {c.obligation.slice(0, 90)} <span className="chip">{c.status}</span>
                    </span>
                  ))
                )}
              </div>
              <div className="stack stack-2 hairline-top" style={{ paddingTop: 'var(--s-4)' }}>
                <span className="micro">They owe us — {view.commitmentsTheyOwe.length}</span>
                {view.commitmentsTheyOwe.length === 0 ? (
                  <span className="small muted">Nothing outstanding.</span>
                ) : (
                  view.commitmentsTheyOwe.slice(0, 5).map((c) => (
                    <span className="small" key={c.id}>
                      {c.obligation.slice(0, 90)} <span className="chip">{c.status}</span>
                    </span>
                  ))
                )}
              </div>
            </div>
          </div>
        </section>

        <section className="grid-2">
          <div className="panel">
            <div className="panel-header">
              <h2>Contacts</h2>
            </div>
            {contacts.length === 0 ? (
              <div className="empty small secondary">No contacts recorded.</div>
            ) : (
              <div className="panel-body-flush table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Email</th>
                      <th style={{ width: 110 }}>Last touch</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contacts.map((c) => (
                      <tr key={c.id}>
                        <td className="small">
                          {c.name}
                          {c.title ? <span className="small muted"> · {c.title}</span> : null}
                        </td>
                        <td className="small mono">{c.emails[0] ?? '—'}</td>
                        <td className="small muted">
                          {c.lastInteractionAt ? c.lastInteractionAt.toISOString().slice(0, 10) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="panel">
            <div className="panel-header">
              <h2>Recent interactions</h2>
            </div>
            {interactions.length === 0 ? (
              <div className="empty small secondary">Nothing logged yet.</div>
            ) : (
              <div className="panel-body stack stack-3">
                {interactions.map((i) => (
                  <div className="stack stack-1" key={i.id}>
                    <span className="small">{i.summary}</span>
                    <span className="small muted mono">
                      {i.kind} · {i.occurredAt.toISOString().slice(0, 10)} · {i.userName ?? 'system'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {view.documents.length > 0 ? (
          <section className="panel">
            <div className="panel-header">
              <h2>Documents</h2>
            </div>
            <div className="panel-body row wrap">
              {view.documents.map((d) => (
                <Link className="chip" key={d.id} href={`/knowledge/${d.id}`}>
                  {d.title}
                </Link>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    )
  } catch (error) {
    if (error instanceof NotFoundError) notFound()
    throw error
  }
}
