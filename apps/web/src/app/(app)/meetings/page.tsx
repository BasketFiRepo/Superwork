import Link from 'next/link'
import { requireSession, withActor } from '@/lib/session'
import { listDecisions, listMeetings } from '@superwork/core'

export const dynamic = 'force-dynamic'

/** Meetings (§12.5). Primary action: turn talk into tasks. */
export default async function MeetingsPage() {
  const session = await requireSession()
  const { meetings, decisions } = await withActor(session, async (ctx, actor) => ({
    meetings: await listMeetings(ctx, actor, { limit: 50 }),
    decisions: await listDecisions(ctx, { limit: 20 }),
  }))

  const upcoming = meetings.filter((m) => m.startsAt.getTime() > Date.now())
  const past = meetings.filter((m) => m.startsAt.getTime() <= Date.now())
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: session.timezone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d)

  return (
    <div className="stack stack-8">
      <header className="stack stack-2">
        <span className="micro">Communicate</span>
        <h1>Meetings</h1>
        <p className="prose secondary">
          Transcripts are indexed into company memory with segment timestamps as citation
          anchors, so a decision can always be traced to the moment it was said.
        </p>
      </header>

      {upcoming.length > 0 ? (
        <section className="panel">
          <div className="panel-header">
            <h2>Upcoming</h2>
          </div>
          <div className="panel-body-flush table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Meeting</th>
                  <th style={{ width: 190 }}>When</th>
                  <th style={{ width: 140 }}>Account</th>
                  <th style={{ width: 110 }}>People</th>
                </tr>
              </thead>
              <tbody>
                {upcoming.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <Link href={`/meetings/${m.id}`}>{m.title}</Link>
                    </td>
                    <td className="small">{fmt(m.startsAt)}</td>
                    <td className="small secondary">{m.companyName ?? 'Internal'}</td>
                    <td className="num">{m.participantCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-header">
          <h2>Past meetings</h2>
        </div>
        {past.length === 0 ? (
          <div className="empty small secondary">No meetings recorded yet.</div>
        ) : (
          <div className="panel-body-flush table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Meeting</th>
                  <th style={{ width: 190 }}>When</th>
                  <th style={{ width: 140 }}>Account</th>
                  <th style={{ width: 120 }}>Transcript</th>
                  <th style={{ width: 110 }}>Decisions</th>
                </tr>
              </thead>
              <tbody>
                {past.map((m) => (
                  <tr key={m.id} data-testid="meeting-row">
                    <td>
                      <Link href={`/meetings/${m.id}`}>{m.title}</Link>
                      {m.seriesOrdinal ? <span className="small muted"> · #{m.seriesOrdinal} in series</span> : null}
                    </td>
                    <td className="small">{fmt(m.startsAt)}</td>
                    <td className="small secondary">{m.companyName ?? 'Internal'}</td>
                    <td>
                      {m.hasTranscript ? (
                        <span className="chip chip-positive">attached</span>
                      ) : (
                        <span className="chip">none</span>
                      )}
                    </td>
                    <td className="num">{m.decisionCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Decision log</h2>
          <span className="small muted">The most valuable and most neglected artifact in project work</span>
        </div>
        {decisions.length === 0 ? (
          <div className="empty small secondary">
            No decisions recorded. Summarize a meeting with a transcript to populate this.
          </div>
        ) : (
          <div className="panel-body-flush table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Decision</th>
                  <th style={{ width: 110 }}>Status</th>
                  <th style={{ width: 170 }}>From</th>
                  <th style={{ width: 120 }}>Confirmed</th>
                </tr>
              </thead>
              <tbody>
                {decisions.map((d) => (
                  <tr key={d.id}>
                    <td className="small">{d.summary}</td>
                    <td>
                      <span className={d.status === 'deferred' ? 'chip chip-attention' : 'chip chip-positive'}>
                        {d.status}
                      </span>
                    </td>
                    <td className="small secondary">
                      {d.meetingId ? <Link href={`/meetings/${d.meetingId}`}>{d.meetingTitle}</Link> : '—'}
                    </td>
                    <td className="small muted">{d.confirmedAt ? 'yes' : 'not yet'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
