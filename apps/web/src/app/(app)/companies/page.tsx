import Link from 'next/link'
import { requireSession, withActor } from '@/lib/session'
import { listCompanies, listMergeCandidates } from '@superwork/core'
import { MergeQueue } from '@/components/MergeQueue'

export const dynamic = 'force-dynamic'

/** CRM (§12.6). Primary action: advance the relationship. */
export default async function CompaniesPage({ searchParams }: { searchParams: Promise<{ type?: string; search?: string }> }) {
  const session = await requireSession()
  const params = await searchParams

  const { companies, merges } = await withActor(session, async (ctx, actor) => ({
    companies: await listCompanies(ctx, actor, {
      ...(params.type ? { type: params.type } : {}),
      ...(params.search ? { search: params.search } : {}),
      limit: 200,
    }),
    merges: await listMergeCandidates(ctx, actor),
  }))

  const types = ['customer', 'vendor', 'partner', 'prospect']

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Communicate</span>
        <h1>Companies</h1>
        <p className="prose secondary">
          Inbound mail associates to an account by domain. A new contact is proposed for
          confirmation rather than silently created.
        </p>
      </header>

      <div className="row wrap">
        <Link href="/companies" className={`btn btn-sm${!params.type ? ' btn-primary' : ''}`}>
          All
        </Link>
        {types.map((type) => (
          <Link key={type} href={`/companies?type=${type}`} className={`btn btn-sm${params.type === type ? ' btn-primary' : ''}`}>
            {type}
          </Link>
        ))}
      </div>

      <MergeQueue
        candidates={merges.map((m) => ({
          id: m.id,
          similarity: m.similarity,
          reasons: m.reasons,
          primary: { id: m.primary.id, name: m.primary.name, emails: m.primary.emails, title: m.primary.title },
          duplicate: { id: m.duplicate.id, name: m.duplicate.name, emails: m.duplicate.emails, title: m.duplicate.title },
        }))}
      />

      <div className="panel">
        <div className="panel-body-flush table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Company</th>
                <th style={{ width: 100 }}>Type</th>
                <th style={{ width: 130 }}>Owner</th>
                <th style={{ width: 110 }}>Threads</th>
                <th style={{ width: 110 }}>Last touch</th>
                <th style={{ width: 130 }}>Renewal</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.id} data-testid="company-row">
                  <td>
                    <Link href={`/companies/${c.id}`}>{c.name}</Link>
                  </td>
                  <td className="small secondary">{c.type}</td>
                  <td className="small secondary">{c.ownerName ?? '—'}</td>
                  <td className="num">{c.openConversations}</td>
                  <td
                    className="num small"
                    style={
                      c.daysSinceInteraction !== null && c.daysSinceInteraction > c.checkInDays
                        ? { color: 'var(--attention)' }
                        : undefined
                    }
                  >
                    {c.daysSinceInteraction === null ? '—' : `${c.daysSinceInteraction}d`}
                  </td>
                  <td className="small secondary">
                    {c.contractRenewsOn ? c.contractRenewsOn.toISOString().slice(0, 10) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
