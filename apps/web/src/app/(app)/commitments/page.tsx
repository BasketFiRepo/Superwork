import { requireSession, withActor } from '@/lib/session'
import { ledgerSummary, listCommitments } from '@superwork/core'
import { CommitmentRow } from '@/components/CommitmentRow'

export const dynamic = 'force-dynamic'

/**
 * The commitment ledger (§29.1). A detected promise is a suggestion until its owner
 * accepts it, and a renegotiated date is a success rather than a failure.
 */
export default async function CommitmentsPage({ searchParams }: { searchParams: Promise<{ scope?: string }> }) {
  const session = await requireSession()
  const params = await searchParams
  const mine = params.scope !== 'all'

  const { commitments, summary } = await withActor(session, async (ctx, actor) => ({
    commitments: await listCommitments(ctx, actor, {
      ...(mine ? { ownerUserId: 'me' as const } : {}),
      limit: 100,
    }),
    summary: await ledgerSummary(ctx, mine ? { ownerUserId: session.userId } : {}),
  }))

  const proposed = commitments.filter((c) => c.status === 'proposed')
  const active = commitments.filter((c) => c.status !== 'proposed')

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Communicate</span>
        <h1>Commitments</h1>
        <p className="prose secondary">
          Promises detected in email and meetings. Nothing here counts, appears in a rollup or
          triggers a chase until the named owner confirms it.
        </p>
      </header>

      <section className="grid-3">
        <Tile label="Kept" value={summary.kept} />
        <Tile label="Renegotiated in advance" value={summary.renegotiated} tone="positive" />
        <Tile label="Silently missed" value={summary.slipped} tone={summary.slipped > 0 ? 'critical' : 'neutral'} />
        <Tile label="Awaiting confirmation" value={summary.proposed} tone={summary.proposed > 0 ? 'attention' : 'neutral'} />
        <Tile label="Disputed" value={summary.disputed} />
      </section>

      <div className="row wrap">
        <a href="/commitments" className={`btn btn-sm${mine ? ' btn-primary' : ''}`}>
          Mine
        </a>
        <a href="/commitments?scope=all" className={`btn btn-sm${!mine ? ' btn-primary' : ''}`}>
          Everyone
        </a>
      </div>

      <section className="stack stack-5">
        <h2>Awaiting your confirmation</h2>
        {proposed.length === 0 ? (
          <div className="panel">
            <div className="empty small secondary">Nothing is waiting on you to confirm.</div>
          </div>
        ) : (
          proposed.map((c) => (
            <CommitmentRow
              key={c.id}
              commitment={{
                id: c.id,
                obligation: c.obligation,
                direction: c.direction,
                status: c.status,
                ownerName: c.ownerName,
                companyName: c.companyName,
                dueAt: c.dueAt ? c.dueAt.toISOString() : null,
                confidence: c.confidence ? Number(c.confidence) : null,
                sourceExcerpt: c.sourceExcerpt,
                isMine: c.ownerUserId === session.userId,
              }}
            />
          ))
        )}
      </section>

      {active.length > 0 ? (
        <section className="stack stack-5">
          <h2>Confirmed and closed</h2>
          {active.map((c) => (
            <CommitmentRow
              key={c.id}
              commitment={{
                id: c.id,
                obligation: c.obligation,
                direction: c.direction,
                status: c.status,
                ownerName: c.ownerName,
                companyName: c.companyName,
                dueAt: c.dueAt ? c.dueAt.toISOString() : null,
                confidence: c.confidence ? Number(c.confidence) : null,
                sourceExcerpt: c.sourceExcerpt,
                isMine: c.ownerUserId === session.userId,
              }}
            />
          ))}
        </section>
      ) : null}
    </div>
  )
}

function Tile({ label, value, tone = 'neutral' }: { label: string; value: number; tone?: string }) {
  const color =
    tone === 'critical' ? 'var(--critical)' : tone === 'attention' ? 'var(--attention)' : tone === 'positive' ? 'var(--positive)' : 'var(--ink)'
  return (
    <div className="panel">
      <div className="panel-body stack stack-2">
        <span className="micro">{label}</span>
        <span className="metric" style={{ fontSize: 24, fontWeight: 600, color }}>
          {value}
        </span>
      </div>
    </div>
  )
}
