import Link from 'next/link'
import { requireSession, withActor } from '@/lib/session'
import { personalRecord, sharedWith } from '@superwork/core'
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
  const { record, shares } = await withActor(session, async (ctx, actor) => ({
    record: await personalRecord(ctx, actor, actor.userId),
    // The other half of "what is known about you": what you were *given*, and by whom.
    shares: await sharedWith(ctx, actor, actor.userId),
  }))

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

      <section className="panel" data-testid="shared-with-you">
        <div className="panel-header">
          <h2>Shared with you</h2>
          <span className="small muted">
            {shares.length === 0 ? 'Nothing beyond your role' : `${shares.length} beyond your role`}
          </span>
        </div>
        {shares.length === 0 ? (
          <div className="empty small secondary">
            Nothing has been shared with you individually. Everything you can reach, you reach
            through your role, your department or a team.
          </div>
        ) : (
          <div className="panel-body-flush table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>What</th>
                  <th style={{ width: 110 }}>You may</th>
                  <th style={{ width: 140 }}>Reached through</th>
                  <th>Why, and who gave it</th>
                  <th style={{ width: 120 }}>Until</th>
                </tr>
              </thead>
              <tbody>
                {shares.map((entry) => (
                  <tr key={entry.id} data-testid="shared-row">
                    <td>
                      {entry.objectLabel ?? entry.objectType}
                      <div className="small muted">{entry.objectType.replace(/_/g, ' ')}</div>
                    </td>
                    <td className="small secondary">{entry.relation}</td>
                    <td className="small secondary">
                      {entry.via === 'you' ? 'you, by name' : `your ${entry.via} · ${entry.subjectName ?? ''}`}
                    </td>
                    <td className="small secondary">
                      {entry.reason ?? '—'}
                      {entry.grantedByName ? <div className="small muted">{entry.grantedByName}</div> : null}
                    </td>
                    <td className="small secondary">
                      {entry.expiresAt ? when(entry.expiresAt).slice(0, 12) : 'no end date'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="panel-body hairline-top small muted">
          A share adds access to one specific thing and changes nothing about your role. This
          list is the answer to “why can I see that?”.
        </div>
      </section>

      <section className="panel" data-testid="reporting-line">
        <div className="panel-header">
          <h2>Your reporting line</h2>
          <span className="small muted">where an escalation about you would go</span>
        </div>
        <div className="panel-body stack stack-4">
          <div className="row wrap">
            <span className="micro" style={{ flex: '0 0 140px' }}>You report to</span>
            {record.reporting.managers.length === 0 ? (
              <span className="small muted">Nobody. An escalation about your work has nowhere to go.</span>
            ) : (
              record.reporting.managers.map((line) => (
                <span className="chip" key={`${line.name}-${line.type}`}>
                  {line.name}
                  {line.type === 'dotted' ? ' · dotted' : ''}
                </span>
              ))
            )}
          </div>
          <div className="row wrap">
            <span className="micro" style={{ flex: '0 0 140px' }}>Reporting to you</span>
            {record.reporting.reports.length === 0 ? (
              <span className="small muted">Nobody.</span>
            ) : (
              record.reporting.reports.map((line) => (
                <span className="chip" key={`${line.name}-${line.type}`}>
                  {line.name}
                  {line.type === 'dotted' ? ' · dotted' : ''}
                </span>
              ))
            )}
          </div>
        </div>
        <div className="panel-body hairline-top small muted">
          A reporting line decides who an overdue item of yours is escalated to, and who may be
          asked to decide something you proposed. It is not a window onto your work: there is no
          view here or anywhere else that shows a manager what their reports are doing. When
          something about you does reach somebody, it appears in{' '}
          <strong>what has been shared about you</strong> below — you see it because it happened,
          not because you asked.
        </div>
      </section>

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
