import Link from 'next/link'
import { requireSession, withActor } from '@/lib/session'
import { personalRecord } from '@superwork/core'
import { PersonalExportButton } from '@/components/PersonalExportButton'

export const dynamic = 'force-dynamic'

/**
 * "What is known about me" (§29.3, §24 Phase 3 acceptance).
 *
 * One screen, self-service, no request to anybody. It shows what is held, who can see it,
 * what has been reported about you and to whom, and — stated as flatly as the rest — what
 * is never collected at all.
 */
export default async function MePage() {
  const session = await requireSession()
  const record = await withActor(session, (ctx, actor) => personalRecord(ctx, actor, actor.userId))

  const when = (date: Date) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: session.timezone,
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(date)

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">You</span>
        <h1>What is known about you</h1>
        <p className="prose secondary">
          Everything Superwork holds about {record.name}, who can see it, and every time
          something about you was reported to somebody else. Nobody else can open this page
          for you — not your manager, not an admin.
        </p>
      </header>

      <section className="panel" data-testid="tracked">
        <div className="panel-header">
          <h2>What is held</h2>
          <span className="small muted">{record.tracked.length} categories</span>
        </div>
        <div className="panel-body-flush table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Category</th>
                <th style={{ width: 90 }}>Records</th>
                <th>Who can see it</th>
                <th style={{ width: 90 }}>Open</th>
              </tr>
            </thead>
            <tbody>
              {record.tracked.map((category) => (
                <tr key={category.key} data-testid="tracked-row">
                  <td>
                    <div className="stack stack-1">
                      <strong className="small">{category.label}</strong>
                      <span className="small muted">{category.description}</span>
                    </div>
                  </td>
                  <td className="num">{category.count}</td>
                  <td className="small secondary">{category.visibility}</td>
                  <td className="small">{category.route ? <Link href={category.route}>open</Link> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" data-testid="disclosures">
        <div className="panel-header">
          <h2>What was reported about you, and to whom</h2>
          <span className="small muted">{record.disclosures.length} disclosures</span>
        </div>
        {record.disclosures.length === 0 ? (
          <div className="empty stack stack-2">
            <p className="secondary">Nothing about you has been reported to anybody.</p>
            <p className="small muted">
              Weekly digests, department reports and exports appear here the moment they are
              sent — you see them at the same time as the recipient, never later.
            </p>
          </div>
        ) : (
          <div className="panel-body-flush table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 170 }}>When</th>
                  <th style={{ width: 150 }}>Kind</th>
                  <th>To whom</th>
                  <th>What</th>
                </tr>
              </thead>
              <tbody>
                {record.disclosures.map((disclosure) => (
                  <tr key={disclosure.id} data-testid="disclosure-row">
                    <td className="small mono">{when(disclosure.disclosedAt)}</td>
                    <td>
                      <span className="chip">{disclosure.kind.replace(/_/g, ' ')}</span>
                    </td>
                    <td className="small">{disclosure.recipientLabel}</td>
                    <td className="small secondary">
                      {disclosure.summary}
                      {disclosure.authorizationNote ? (
                        <span className="small muted"> — authorized by {disclosure.authorizedByName}: {disclosure.authorizationNote}</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel" data-testid="never-collected">
        <div className="panel-header">
          <h2>What is never collected</h2>
          <span className="small muted">Enforced by the database, not by a setting</span>
        </div>
        <div className="panel-body stack stack-3">
          {record.neverCollected.map((line) => (
            <div className="row-tight" key={line}>
              <span className="chip chip-positive">never</span>
              <span className="small">{line}</span>
            </div>
          ))}
          <p className="small muted">
            These are refused by a constraint on the monitoring policy table. An administrator
            cannot switch them on, because a row that turns one on cannot be stored. This
            organization runs the <strong>{record.monitoring.jurisdictionProfile}</strong> profile:
            anything about you that reaches your manager is visible to you at least{' '}
            {record.monitoring.noSurprisesReviewHours} hours first, and nothing may contact you
            more than {record.monitoring.nudgeBudgetPerDay} times a day.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Your rights</h2>
        </div>
        <div className="panel-body stack stack-4">
          {record.rights.map((right) => (
            <div className="spread" key={right.action}>
              <div className="stack stack-1">
                <strong className="small">{right.label}</strong>
                <span className="small muted">{right.description}</span>
              </div>
              {right.action === 'export' ? (
                <PersonalExportButton />
              ) : (
                <Link className="btn btn-sm" href="/commitments">
                  Dispute a commitment
                </Link>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
