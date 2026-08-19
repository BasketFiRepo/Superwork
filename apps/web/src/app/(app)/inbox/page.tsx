import { Link } from '@/components/Link'
import { requireSession, withActor } from '@/lib/session'
import { inboxCounts, listConversations, listSavedViews } from '@superwork/core'
import { SavedViews } from '@/components/SavedViews'
import { InboxQueue } from '@/components/InboxQueue'
import { TriageButton } from '@/components/TriageButton'

export const dynamic = 'force-dynamic'

const VIEWS = [
  { id: 'queue', label: 'Queue' },
  { id: 'mine', label: 'Mine' },
  { id: 'waiting', label: 'Waiting on others' },
  { id: 'snoozed', label: 'Snoozed' },
  { id: 'archived', label: 'Archived' },
] as const

/** Smart Inbox (§12.3). Primary action: clear the queue. */
export default async function InboxPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const session = await requireSession()
  const params = await searchParams
  const view = (params.view ?? 'queue') as (typeof VIEWS)[number]['id']

  const { conversations, counts, views } = await withActor(session, async (ctx, actor) => ({
    conversations: await listConversations(ctx, actor, { view, limit: 100 }),
    counts: await inboxCounts(ctx),
    views: await listSavedViews(ctx, actor, 'inbox'),
  }))

  const active = views.find((saved) => saved.query.view === view) ?? null

  return (
    <div className="stack stack-8">
      <header className="spread">
        <div className="stack stack-2">
          <span className="micro">Communicate</span>
          <h1>Inbox</h1>
          <p className="prose secondary">
            {counts.pastSla > 0
              ? `${counts.pastSla} ${counts.pastSla === 1 ? 'thread is' : 'threads are'} past their account SLA and sort to the top.`
              : 'Nothing is past its account SLA.'}{' '}
            {counts.untriaged > 0 ? `${counts.untriaged} have not been classified yet.` : 'Everything here is classified.'}
          </p>
        </div>
        <TriageButton untriaged={counts.untriaged} />
      </header>

      <SavedViews
        entity="inbox"
        views={views}
        current={view === 'queue' ? {} : { view }}
        activeId={active?.id ?? null}
      />

      <div className="row wrap">
        {VIEWS.map((option) => (
          <Link
            key={option.id}
            href={`/inbox?view=${option.id}`}
            className={`btn btn-sm${view === option.id ? ' btn-primary' : ''}`}
          >
            {option.label}
            {option.id === 'queue' && counts.queue ? ` · ${counts.queue}` : ''}
            {option.id === 'waiting' && counts.waiting ? ` · ${counts.waiting}` : ''}
            {option.id === 'snoozed' && counts.snoozed ? ` · ${counts.snoozed}` : ''}
          </Link>
        ))}
      </div>

      <InboxQueue
        view={view}
        items={conversations.map((c) => ({
          id: c.id,
          subject: c.subject,
          companyName: c.companyName,
          ownerName: c.ownerName,
          category: c.category,
          priority: c.priority,
          sentiment: c.sentiment,
          daysWaiting: c.daysWaiting,
          pastSla: c.pastSla,
          slaDays: c.slaDays,
          messageCount: c.messageCount,
          waitingFor: c.waitingFor,
          hasFlaggedContent: c.hasFlaggedContent,
          triagedAt: c.triagedAt ? c.triagedAt.toISOString() : null,
          lastDirection: c.lastDirection,
        }))}
      />
    </div>
  )
}
