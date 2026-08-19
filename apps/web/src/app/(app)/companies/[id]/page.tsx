import { Link } from '@/components/Link'
import { notFound } from 'next/navigation'
import { requireSession, withActor } from '@/lib/session'
import {
  listContacts,
  listInteractions,
  listShares,
  listTeams,
  NotFoundError,
  PermissionError,
  relationship360,
  shareableRelations,
} from '@superwork/core'
import { can } from '@superwork/auth'
import { AccountSummaryPanel } from '@/components/AccountSummaryPanel'
import { LogInteraction } from '@/components/LogInteraction'
import { ShareObject } from '@/components/ShareObject'

export const dynamic = 'force-dynamic'

export default async function CompanyPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession()
  const { id } = await params

  try {
    const { view, contacts, interactions, shares, relations, people, teams, canLog } = await withActor(
      session,
      async (ctx, actor) => ({
        view: await relationship360(ctx, actor, id),
        contacts: await listContacts(ctx, actor, { companyId: id }),
        interactions: await listInteractions(ctx, id, 10),
        shares: await listShares(ctx, actor, 'company', id),
        relations: shareableRelations(actor, 'company', id, ctx.organizationId),
        teams: await listTeams(ctx, actor).catch(() => []),
        // The same gate `log_interaction@v1` declares, so the tool layer and this screen cannot
        // disagree about who may write to the timeline (ADR 0057).
        canLog: can(actor, 'note:create', {
          type: 'note',
          organizationId: ctx.organizationId,
          ownerId: actor.userId,
          riskTier: 'low',
        }).allow,
        people: await ctx.sql<{ id: string; name: string }[]>`
          SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = ${ctx.organizationId} AND m.deleted_at IS NULL AND m.status = 'active'
            AND m.user_id <> ${actor.userId}
          ORDER BY u.name`,
      }),
    )

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

        <ShareObject
          objectType="company"
          objectId={view.company.id}
          relations={relations}
          shares={shares.map((entry) => ({
            id: entry.id,
            subjectType: entry.subjectType,
            subjectName: entry.subjectName,
            relation: entry.relation,
            reason: entry.reason,
            grantedByName: entry.grantedByName,
            expiresAt: entry.expiresAt ? entry.expiresAt.toISOString() : null,
            expired: entry.expired,
            canRevoke: entry.canRevoke,
          }))}
          people={people}
          teams={teams.map((team) => ({ id: team.id, name: team.name }))}
        />

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
            {/* Only an agent could add to this timeline until ADR 0057, so an account somebody
                rang this morning could still be counted as quiet. */}
            <LogInteraction
              companyId={id}
              companyName={view.company.name}
              contacts={contacts.map((contact) => ({ id: contact.id, name: contact.name }))}
              canLog={canLog}
            />
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
    if (error instanceof PermissionError) {
      return (
        <div className="panel">
          <div className="empty small secondary">{error.message}</div>
        </div>
      )
    }
    throw error
  }
}
