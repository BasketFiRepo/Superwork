import Link from 'next/link'
import { requireSession, withActor } from '@/lib/session'
import { latestBriefing } from '@superwork/agent'
import { asOfLabel } from '@superwork/core'
import { BriefingPanel } from '@/components/BriefingPanel'

export const dynamic = 'force-dynamic'

/**
 * The daily briefing (§9.4). Deterministic scaffold, model-written prose, every figure
 * computed in SQL in the reader's timezone and drill-throughable to its rows.
 */
export default async function BriefingPage({ searchParams }: { searchParams: Promise<{ kind?: string }> }) {
  const session = await requireSession()
  const params = await searchParams
  const kind = params.kind === 'end_of_day' ? 'end_of_day' : 'daily'

  const briefing = await withActor(session, (ctx) => latestBriefing(ctx, session.userId, kind))

  return (
    <div className="stack stack-8">
      <header className="spread">
        <div className="stack stack-2">
          <span className="micro">Work</span>
          <h1>{kind === 'daily' ? 'Daily briefing' : 'End of day'}</h1>
          <p className="prose secondary">
            Generated in {session.timezone}. Every number here was computed from the database — the
            model writes the sentences between them and nothing else.
          </p>
        </div>
        <div className="row-tight">
          <Link href="/briefing?kind=daily" className={`btn btn-sm${kind === 'daily' ? ' btn-primary' : ''}`}>
            Morning
          </Link>
          <Link href="/briefing?kind=end_of_day" className={`btn btn-sm${kind === 'end_of_day' ? ' btn-primary' : ''}`}>
            End of day
          </Link>
        </div>
      </header>

      <BriefingPanel
        kind={kind}
        initial={
          briefing
            ? {
                narrative: briefing.narrative,
                counts: briefing.facts.counts as unknown as Record<string, number>,
                citations: briefing.citations,
                recommendation: briefing.recommendation,
                generatedAt: briefing.generatedAt.toISOString(),
                simulated: briefing.simulated,
                localDate: briefing.localDate,
              }
            : null
        }
      />

      {briefing ? (
        <section className="grid-2">
          <FactList
            title="Meetings today"
            empty="Nothing in the calendar."
            items={briefing.facts.meetings.map((m) => `${m.localTime} · ${m.title} (${m.minutes} min)`)}
            route="/meetings"
          />
          <FactList
            title="Overdue"
            empty="Nothing overdue."
            items={briefing.facts.overdue.map((t) => `${t.title} — ${t.daysOverdue} days late`)}
            route="/tasks?filter=overdue"
          />
          <FactList
            title="Approvals waiting on you"
            empty="No approvals waiting."
            items={briefing.facts.approvals.map((a) => `${a.title} — ${Math.round(a.hoursWaiting)}h`)}
            route="/approvals"
          />
          <FactList
            title="Commitments you confirmed"
            empty="No confirmed commitments due."
            items={briefing.facts.commitments.map((c) => `${c.obligation.slice(0, 90)}${c.companyName ? ` (${c.companyName})` : ''}`)}
            route="/commitments"
          />
          <FactList
            title="You are the blocker"
            empty="Nothing is waiting on you."
            items={briefing.facts.blockingOthers.map((b) => `${b.title} — ${b.waitingCount} waiting`)}
            route="/tasks?filter=mine"
          />
          <FactList
            title="Customers past SLA"
            empty="Every account is inside its SLA."
            items={briefing.facts.staleThreads.map((s) => `${s.companyName} — ${s.daysWaiting} days`)}
            route="/inbox"
          />
          <FactList
            title="Waiting for you here"
            empty="Nothing was held back for the briefing."
            items={briefing.facts.waiting.map((n) => `${n.title}${n.body ? ` — ${n.body.slice(0, 90)}` : ''}`)}
            route="/reminders"
          />
          {kind === 'end_of_day' ? (
            <>
              <FactList
                title="Completed today"
                empty="Nothing marked complete."
                items={briefing.facts.completedToday.map((t) => t.title)}
                route="/tasks"
              />
              <FactList
                title="What I did on your behalf"
                empty="I took no actions on your behalf today."
                items={briefing.facts.agentActions.map((a) => a.summary.slice(0, 120))}
                route="/agent"
              />
            </>
          ) : null}
        </section>
      ) : null}

      <p className="small muted">{asOfLabel(session.timezone)}</p>
    </div>
  )
}

function FactList({ title, items, empty, route }: { title: string; items: string[]; empty: string; route: string }) {
  return (
    <div className="panel">
      <div className="panel-header">
        <h2>{title}</h2>
        <Link className="btn btn-ghost btn-sm" href={route}>
          Open
        </Link>
      </div>
      <div className="panel-body stack stack-2">
        {items.length === 0 ? (
          <span className="small muted">{empty}</span>
        ) : (
          items.map((item, index) => (
            <span className="small" key={index}>
              {item}
            </span>
          ))
        )}
      </div>
    </div>
  )
}
