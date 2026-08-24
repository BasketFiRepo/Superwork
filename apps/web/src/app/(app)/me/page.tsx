import { Link } from '@/components/Link'
import { requireSession, withActor } from '@/lib/session'
import { myAuditTrail, myMailboxes, personalRecord, sharedWith } from '@superwork/core'
import { emailMode } from '@superwork/integrations'
import { Mailboxes } from '@/components/Mailboxes'
import { mfaStatus } from '@superwork/auth'
import { PersonalExportButton } from '@/components/PersonalExportButton'
import { SecondFactor } from '@/components/SecondFactor'

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
  // Their own factor, on their own record. Nobody else's is readable from here (ADR 0043).
  const factor = await mfaStatus(session.userId)
  const { record, shares, trail, mailboxes } = await withActor(session, async (ctx, actor) => ({
    record: await personalRecord(ctx, actor, actor.userId),
    // The audit trail an administrator can now read is the same trail you can read about
    // yourself. §29.3 says nothing about a person reaches their manager that the person has
    // not already seen, and this is what makes that true rather than a promise (ADR 0079).
    trail: await myAuditTrail(ctx, actor, 50),
    // The other half of "what is known about you": what you were *given*, and by whom.
    shares: await sharedWith(ctx, actor, actor.userId),
    // Your own mailboxes, on your own record — because a person connects their own and nobody
    // else's, and this is the screen that is about you (ADR 0084).
    mailboxes: await myMailboxes(ctx, actor),
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

      <SecondFactor
        status={{
          enabled: factor.enabled,
          pending: factor.pending,
          recoveryCodesLeft: factor.recoveryCodesLeft,
          confirmedAt: factor.confirmedAt ? factor.confirmedAt.toISOString() : null,
        }}
      />

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
          list is the answer to “why can I see that?”, together with the projects you are on.
        </div>
      </section>

      <section className="panel" data-testid="on-projects">
        <div className="panel-header">
          <h2>Projects you are on</h2>
          <span className="small muted">
            {record.projects.length === 0 ? 'None' : `${record.projects.length}`}
          </span>
        </div>
        {record.projects.length === 0 ? (
          <div className="panel-body">
            <div className="empty small secondary">
              You are not on any project&rsquo;s roster. You reach projects through your role,
              department or team instead.
            </div>
          </div>
        ) : (
          <div className="panel-body-flush table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Project</th>
                  <th style={{ width: 140 }}>Doing what</th>
                  <th>Why you were put on it</th>
                </tr>
              </thead>
              <tbody>
                {record.projects.map((entry) => (
                  <tr key={`${entry.name}-${entry.role}`} data-testid="on-project-row">
                    <td>{entry.name}</td>
                    <td className="small secondary">{entry.role}</td>
                    <td className="small secondary">{entry.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="panel-body hairline-top small muted">
          Being on a project lets you read it and the work inside it, up to your own clearance.
          It gives you no say over either.
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

      <Mailboxes
        simulated={emailMode() === 'mock'}
        mailboxes={mailboxes.map((mailbox) => ({
          id: mailbox.id,
          address: mailbox.address,
          provider: mailbox.provider,
          status: mailbox.status,
          lastSyncAt: mailbox.lastSyncAt ? mailbox.lastSyncAt.toISOString() : null,
          lastError: mailbox.lastError,
        }))}
      />

      <section className="panel" data-testid="my-trail">
        <div className="panel-header">
          <h2>What you did, as the record has it</h2>
          <span className="small muted">The same rows an administrator can read</span>
        </div>
        <p className="small muted" style={{ margin: 0, padding: '0 var(--s-5)' }} data-testid="my-trail-explainer">
          Superwork keeps a forensic record of changes, and an administrator may read it. This is
          that record, about you — so nothing in it can reach anybody without your being able to
          see the same thing. It is append-only: neither you nor an administrator can edit or
          delete a line of it.
        </p>
        {trail.length === 0 ? (
          <div className="empty small secondary">Nothing of yours has been recorded yet.</div>
        ) : (
          <div className="panel-body-flush table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 150 }}>When</th>
                  <th style={{ width: 200 }}>What you did</th>
                  <th>To what</th>
                </tr>
              </thead>
              <tbody>
                {trail.map((entry) => (
                  <tr key={entry.id} data-testid="my-trail-row">
                    <td className="small mono muted">
                      {entry.occurredAt.toISOString().slice(0, 16).replace('T', ' ')}
                    </td>
                    <td className="small mono">{entry.action}</td>
                    <td className="small secondary">
                      {entry.entityType}
                      {entry.agentName ? (
                        <span className="small muted"> · by {entry.agentName} on your behalf</span>
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
