'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Link } from '@/components/Link'

/**
 * What the system asked you, and what it told you (§29.2, §29.3).
 *
 * The ladder's last two rungs are declared `in_app` and there was nowhere in the app for
 * them to arrive; every delivery wrote a `notifications` row that nothing read. So the
 * product chased people, escalated to their managers, and showed none of it to anybody.
 *
 * The five answers do what they say here. Answering also calls off the rest of the ladder,
 * which is the reason somebody answers at all — before, you could say "done" three times
 * and still be escalated to your manager.
 */

export interface ReminderRow {
  id: string
  stage: number
  message: string
  subjectType: string
  subjectId: string
  subjectLabel: string | null
  actions: string[]
  deliveredAt: string | null
  respondedAt: string | null
  response: string | null
  responseNote: string | null
  aboutSomebodyElse: boolean
}

export interface NotificationRow {
  id: string
  type: string
  title: string
  body: string | null
  url: string | null
  readAt: string | null
  createdAt: string
}

export interface Candidate {
  id: string
  name: string
}

const ANSWERS: Record<string, string> = {
  done: 'Done',
  snooze: 'Not yet',
  renegotiate: 'New date',
  reassign: 'Somebody else',
  blocked: 'Blocked',
}

const STAGE_LABEL: Record<number, string> = {
  1: 'heads-up',
  2: 'due today',
  3: 'follow-up',
  4: 'you were waiting on this',
  5: 'escalated',
}

const TYPE_LABEL: Record<string, string> = {
  workflow: 'a workflow ran',
  task_unblocked: 'work you can start',
  agent_needs_input: 'the assistant needs a decision',
  'briefing.ready': 'your briefing',
  approval_delegated: 'an approval somebody handed you',
  insight_returned: 'an insight you put off',
}

export function Reminders({
  reminders,
  notifications,
  people,
}: {
  reminders: ReminderRow[]
  notifications: NotificationRow[]
  people: Candidate[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [answering, setAnswering] = useState<{ id: string; action: string } | null>(null)
  const [text, setText] = useState('')
  const [date, setDate] = useState('')
  const [who, setWho] = useState('')

  async function post(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/reminders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(false)
    if (!response.ok) {
      setError(payload.error)
      return null
    }
    setAnswering(null)
    setText('')
    setDate('')
    setWho('')
    router.refresh()
    return payload
  }

  async function answer(id: string, action: string) {
    // Two answers need something else from the person before they mean anything.
    if (action === 'renegotiate' || action === 'reassign') {
      setAnswering({ id, action })
      setError(null)
      return
    }
    const payload = await post({ action: 'answer', nudgeId: id, response: action })
    if (payload?.outcome) setNote(payload.outcome.effect)
  }

  const open = reminders.filter((row) => !row.respondedAt)
  const answered = reminders.filter((row) => row.respondedAt)
  const unread = notifications.filter((row) => !row.readAt)

  return (
    <div className="stack stack-8">
      {error ? (
        <div className="banner banner-critical" role="alert">
          {error}
        </div>
      ) : null}
      {note ? <div className="banner banner-accent">{note}</div> : null}

      <section className="panel" data-testid="reminders-open">
        <div className="panel-header">
          <h2>What you have been asked</h2>
          <span className="small muted">{open.length === 0 ? 'Nothing outstanding' : `${open.length} waiting`}</span>
        </div>

        {open.length === 0 ? (
          <div className="panel-body">
            <div className="empty stack stack-3">
              <p className="secondary">Nobody is chasing you.</p>
              <p className="small muted">
                Reminders arrive here when something of yours is close to its date or past it, and
                when somebody is waiting on your work.
              </p>
            </div>
          </div>
        ) : (
          <div className="panel-body stack stack-5">
            {open.map((row) => (
              <div key={row.id} className="stack stack-3" data-testid="reminder-row">
                <div className="row-tight wrap">
                  <span className={row.stage >= 4 ? 'chip chip-attention' : 'chip'}>
                    {STAGE_LABEL[row.stage] ?? `stage ${row.stage}`}
                  </span>
                  {row.subjectLabel ? (
                    <Link href={`/${row.subjectType}s/${row.subjectId}`}>{row.subjectLabel}</Link>
                  ) : (
                    <span className="small muted">{row.subjectType.replace(/_/g, ' ')}</span>
                  )}
                  <span className="small muted">
                    {row.deliveredAt ? row.deliveredAt.slice(0, 16).replace('T', ' ') : ''}
                  </span>
                </div>
                <p className="prose" style={{ margin: 0 }}>
                  {row.message}
                </p>
                {row.aboutSomebodyElse ? (
                  <p className="small muted" style={{ margin: 0 }}>
                    This is about somebody else&rsquo;s work. Answering records what you say and does
                    not change their task.
                  </p>
                ) : null}

                {answering?.id === row.id ? (
                  <div className="stack stack-3" data-testid="reminder-editor">
                    {answering.action === 'renegotiate' ? (
                      <label className="stack stack-2" htmlFor={`due-${row.id}`}>
                        <span className="micro">When will it be done?</span>
                        <input
                          id={`due-${row.id}`}
                          className="input"
                          type="date"
                          value={date}
                          onChange={(event) => setDate(event.target.value)}
                        />
                      </label>
                    ) : (
                      <label className="stack stack-2" htmlFor={`who-${row.id}`}>
                        <span className="micro">Who is taking it?</span>
                        <select
                          id={`who-${row.id}`}
                          className="select"
                          value={who}
                          onChange={(event) => setWho(event.target.value)}
                        >
                          <option value="">Choose…</option>
                          {people.map((person) => (
                            <option key={person.id} value={person.id}>
                              {person.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <label className="stack stack-2" htmlFor={`note-${row.id}`}>
                      <span className="micro">Anything to add (optional)</span>
                      <input
                        id={`note-${row.id}`}
                        className="input"
                        value={text}
                        onChange={(event) => setText(event.target.value)}
                      />
                    </label>
                    <div className="row wrap">
                      <button
                        className="btn btn-primary btn-sm"
                        data-testid="reminder-confirm"
                        disabled={busy || (answering.action === 'renegotiate' ? !date : !who)}
                        onClick={async () => {
                          const payload = await post({
                            action: 'answer',
                            nudgeId: row.id,
                            response: answering.action,
                            note: text.trim() || undefined,
                            ...(answering.action === 'renegotiate' ? { newDueAt: date } : { reassignTo: who }),
                          })
                          if (payload?.outcome) setNote(payload.outcome.effect)
                        }}
                      >
                        {busy ? 'Working…' : 'Answer'}
                      </button>
                      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setAnswering(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="row wrap">
                    {row.actions.map((action) => (
                      <button
                        key={action}
                        className={action === 'done' ? 'btn btn-primary btn-sm' : 'btn btn-sm'}
                        data-testid={`reminder-${action}`}
                        disabled={busy}
                        onClick={() => answer(row.id, action)}
                      >
                        {ANSWERS[action] ?? action}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
        <div className="panel-body hairline-top small muted">
          Answering stops the rest of the ladder. Nobody but you can read this page — a list of
          what somebody has been chased about is a record of that person.
        </div>
      </section>

      <section className="panel" data-testid="notifications">
        <div className="panel-header">
          <h2>What the system told you</h2>
          <div className="row-tight">
            <span className="small muted">{unread.length} unread</span>
            {unread.length > 0 ? (
              <button
                className="btn btn-ghost small"
                data-testid="mark-all-read"
                disabled={busy}
                onClick={() => post({ action: 'mark_read', all: true })}
              >
                Mark all read
              </button>
            ) : null}
          </div>
        </div>
        {notifications.length === 0 ? (
          <div className="panel-body">
            <div className="empty small secondary">Nothing yet.</div>
          </div>
        ) : (
          <div className="panel-body-flush table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>What</th>
                  <th style={{ width: 200 }}>Kind</th>
                  <th style={{ width: 140 }}>When</th>
                  <th style={{ width: 90 }} />
                </tr>
              </thead>
              <tbody>
                {notifications.map((row) => (
                  <tr key={row.id} data-testid="notification-row" style={row.readAt ? { opacity: 0.6 } : undefined}>
                    <td>
                      {row.url ? <Link href={row.url}>{row.title}</Link> : row.title}
                      {row.body ? <div className="small secondary">{row.body}</div> : null}
                    </td>
                    <td className="small secondary">{TYPE_LABEL[row.type] ?? row.type.replace(/_/g, ' ')}</td>
                    <td className="small secondary">{row.createdAt.slice(0, 16).replace('T', ' ')}</td>
                    <td>
                      {row.readAt ? (
                        <span className="small muted">read</span>
                      ) : (
                        <button
                          className="btn btn-ghost small"
                          disabled={busy}
                          onClick={() => post({ action: 'mark_read', ids: [row.id] })}
                        >
                          Mark read
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {answered.length > 0 ? (
        <section className="panel" data-testid="reminders-answered">
          <div className="panel-header">
            <h2>Already answered</h2>
            <span className="small muted">{answered.length}</span>
          </div>
          <div className="panel-body-flush table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>About</th>
                  <th style={{ width: 140 }}>You said</th>
                  <th>And added</th>
                  <th style={{ width: 140 }}>When</th>
                </tr>
              </thead>
              <tbody>
                {answered.map((row) => (
                  <tr key={row.id}>
                    <td>{row.subjectLabel ?? row.subjectType}</td>
                    <td className="small secondary">{ANSWERS[row.response ?? ''] ?? row.response}</td>
                    <td className="small secondary">{row.responseNote ?? '—'}</td>
                    <td className="small secondary">
                      {row.respondedAt ? row.respondedAt.slice(0, 10) : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  )
}
