'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * The reporting chart (§26.1, §29.5).
 *
 * What this screen is for, stated on it: a reporting line decides where an escalation about
 * somebody goes and who may be asked to decide what they proposed. It is deliberately not a
 * management view — there is no rollup of a report's work here or anywhere else, and saying
 * so on the screen where somebody would look for one is cheaper than a conversation about
 * why it is missing.
 */

export interface LineRow {
  id: string
  personId: string
  personName: string
  managerId: string
  managerName: string
  type: 'functional' | 'dotted'
  reason: string | null
  setByName: string | null
}

export interface PersonRow {
  id: string
  name: string
  role: string
}

export function OrgChart({ lines, people }: { lines: LineRow[]; people: PersonRow[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [adding, setAdding] = useState(false)
  const [person, setPerson] = useState('')
  const [manager, setManager] = useState('')
  const [type, setType] = useState<'functional' | 'dotted'>('functional')
  const [reason, setReason] = useState('')

  const [removing, setRemoving] = useState<string | null>(null)
  const [removeReason, setRemoveReason] = useState('')

  async function post(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/org-chart', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(false)
    if (!response.ok) {
      setError(payload.error)
      return
    }
    setAdding(false)
    setRemoving(null)
    setPerson('')
    setManager('')
    setReason('')
    setRemoveReason('')
    router.refresh()
  }

  const functional = lines.filter((line) => line.type === 'functional')
  const unmanaged = people.filter((p) => !functional.some((line) => line.personId === p.id))

  return (
    <div className="stack stack-8">
      {error ? (
        <div className="banner banner-critical" role="alert">
          {error}
        </div>
      ) : null}

      <section className="panel" data-testid="org-chart">
        <div className="panel-header">
          <h2>Who answers to whom</h2>
          <span className="small muted">
            {functional.length} functional · {lines.length - functional.length} dotted
          </span>
        </div>

        <div className="panel-body">
          <p className="prose small secondary" style={{ margin: 0 }} data-testid="org-chart-purpose">
            A reporting line does two things: it decides who an overdue item is escalated to
            after the person has been asked themselves, and it decides who may be asked to
            decide something they proposed. It is <strong>not</strong> a view onto anybody&rsquo;s
            work — there is no rollup of a report&rsquo;s activity here or anywhere else in
            Superwork, and there is no setting that adds one. When something about a person does
            reach their manager, it appears on that person&rsquo;s own record.
          </p>
        </div>

        {lines.length === 0 ? (
          <div className="panel-body">
            <div className="empty small secondary">
              No lines recorded. Nothing escalates to anybody, and an approval that needs a
              senior decision goes to whoever holds the role rather than to the person
              answerable.
            </div>
          </div>
        ) : (
          <div className="panel-body-flush table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th style={{ width: 200 }}>Answers to</th>
                  <th style={{ width: 110 }}>Line</th>
                  <th>Why, and who set it</th>
                  <th style={{ width: 90 }} />
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id} data-testid="org-chart-row">
                    <td>{line.personName}</td>
                    <td>{line.managerName}</td>
                    <td>
                      <span className={line.type === 'dotted' ? 'chip' : 'chip chip-positive'}>{line.type}</span>
                    </td>
                    <td className="small secondary">
                      {line.reason ?? '—'}
                      {line.setByName ? <div className="small muted">{line.setByName}</div> : null}
                    </td>
                    <td>
                      <button
                        className="btn btn-ghost small"
                        data-testid="org-chart-remove"
                        disabled={busy}
                        onClick={() => {
                          setRemoving(removing === line.id ? null : line.id)
                          setRemoveReason('')
                          setError(null)
                        }}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {removing ? (
          <div className="panel-body hairline-top stack stack-4" data-testid="org-chart-remove-editor">
            <label className="stack stack-2" htmlFor="remove-reason">
              <span className="micro">Why is this line being removed?</span>
              <input
                id="remove-reason"
                className="input"
                value={removeReason}
                onChange={(event) => setRemoveReason(event.target.value)}
                placeholder="Moved to the new operations team under Lena."
              />
            </label>
            <p className="small muted" style={{ margin: 0 }}>
              The line is closed rather than deleted, so &ldquo;who did they report to in
              March&rdquo; stays answerable.
            </p>
            <div className="row">
              <button
                className="btn btn-primary"
                data-testid="org-chart-remove-confirm"
                disabled={busy || removeReason.trim().length < 6}
                onClick={() => post({ action: 'remove', lineId: removing, reason: removeReason })}
              >
                Remove it
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setRemoving(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {unmanaged.length > 0 ? (
        <section className="panel" data-testid="org-chart-unmanaged">
          <div className="panel-header">
            <h2>Nobody answers for these people</h2>
            <span className="small muted">{unmanaged.length}</span>
          </div>
          <div className="panel-body stack stack-3">
            <div className="row wrap">
              {unmanaged.map((p) => (
                <span className="chip" key={p.id}>
                  {p.name}
                </span>
              ))}
            </div>
            <p className="small muted" style={{ margin: 0 }}>
              An overdue item of theirs has nowhere to escalate to, so that rung is skipped
              rather than sent to them about themselves. This is listed rather than hidden
              because the alternative is a ladder that quietly stops.
            </p>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-header">
          <h2>Set a line</h2>
          <span className="small muted">one functional manager each; dotted lines are extra</span>
        </div>
        {adding ? (
          <div className="panel-body stack stack-4" data-testid="org-chart-editor">
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <label className="stack stack-2" style={{ flex: '1 1 220px' }} htmlFor="line-person">
                <span className="micro">Who</span>
                <select
                  id="line-person"
                  className="select"
                  value={person}
                  onChange={(event) => setPerson(event.target.value)}
                >
                  <option value="">Choose…</option>
                  {people.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.role})
                    </option>
                  ))}
                </select>
              </label>
              <label className="stack stack-2" style={{ flex: '1 1 220px' }} htmlFor="line-manager">
                <span className="micro">Answers to</span>
                <select
                  id="line-manager"
                  className="select"
                  value={manager}
                  onChange={(event) => setManager(event.target.value)}
                >
                  <option value="">Choose…</option>
                  {people
                    .filter((p) => p.id !== person)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.role})
                      </option>
                    ))}
                </select>
              </label>
              <label className="stack stack-2" style={{ flex: '0 0 160px' }} htmlFor="line-type">
                <span className="micro">Kind of line</span>
                <select
                  id="line-type"
                  className="select"
                  value={type}
                  onChange={(event) => setType(event.target.value as 'functional' | 'dotted')}
                >
                  <option value="functional">functional</option>
                  <option value="dotted">dotted</option>
                </select>
              </label>
            </div>

            <label className="stack stack-2" htmlFor="line-reason">
              <span className="micro">Why? (the person auditing this next year will want it)</span>
              <input
                id="line-reason"
                className="input"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Joined the renewals team in the March reorganisation."
              />
            </label>

            <p className="small muted" style={{ margin: 0 }}>
              {type === 'functional'
                ? 'A functional line replaces any existing one, and is what an escalation follows. Setting one that would close a loop is refused by the database.'
                : 'A dotted line is context. It is shown on the chart and never used to route an escalation, because two answers to “who is answerable” is no answer.'}
            </p>

            <div className="row">
              <button
                className="btn btn-primary"
                data-testid="org-chart-save"
                disabled={busy || !person || !manager || reason.trim().length < 6}
                onClick={() => post({ action: 'set', personId: person, managerId: manager, type, reason })}
              >
                Set it
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="panel-body row">
            <button
              className="btn"
              data-testid="org-chart-add"
              disabled={busy}
              onClick={() => {
                setAdding(true)
                setError(null)
              }}
            >
              Set a reporting line
            </button>
          </div>
        )}
      </section>
    </div>
  )
}
