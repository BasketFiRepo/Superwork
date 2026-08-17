'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Work that comes back (§12.1, ADR 0041).
 *
 * `tasks.recurrence_rule` was written by nothing, so every recurring obligation was retyped
 * or forgotten. The grammar is the one workflow schedules already use, so the presets below
 * are the same expressions the automation screen accepts and mean the same thing.
 */

export interface RecurrenceRow {
  rule: string
  description: string
  nextDueAt: string | null
  nextIsNonWorking: string | null
  timezone: string
  history: { id: string; title: string; status: string; dueAt: string | null }[]
}

const PRESETS = [
  { label: 'Every weekday', rule: '0 9 * * 1-5' },
  { label: 'Every Monday', rule: '0 9 * * 1' },
  { label: 'Monthly, on the 1st', rule: '0 9 1 * *' },
  { label: 'Quarterly', rule: '0 9 1 1,4,7,10 *' },
]

export function TaskRecurrence({
  taskId,
  recurrence,
  hasDueDate,
}: {
  taskId: string
  recurrence: RecurrenceRow | null
  hasDueDate: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [rule, setRule] = useState(recurrence?.rule ?? '0 9 * * 1')

  async function post(next: string | null) {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/task-recurrence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskId, rule: next }),
    })
    const result = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(false)
    if (!response.ok) {
      setError(result.error)
      return
    }
    setEditing(false)
    router.refresh()
  }

  return (
    <section className="panel" data-testid="task-recurrence">
      <div className="panel-header">
        <h2>Repeats</h2>
        <span className="small muted">{recurrence ? recurrence.description : 'One-off'}</span>
      </div>

      <div className="panel-body stack stack-3">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        {recurrence ? (
          <>
            <p className="small secondary" style={{ margin: 0 }} data-testid="recurrence-summary">
              This repeats {recurrence.description}.{' '}
              {recurrence.nextDueAt ? (
                <>
                  Finishing it will make the next one, due{' '}
                  <strong>{recurrence.nextDueAt.slice(0, 10)}</strong>.
                </>
              ) : (
                <>That rule has no date left in it, so nothing further will be made.</>
              )}{' '}
              Only one is ever open at a time.
            </p>

            {recurrence.nextIsNonWorking ? (
              <div className="banner banner-attention" data-testid="recurrence-non-working">
                That date is {recurrence.nextIsNonWorking} where the owner works. The date is left
                as it is — it is a promise, not a delivery — but nobody is chased about it until
                the next working day.
              </div>
            ) : null}

            {recurrence.history.length > 0 ? (
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 130 }}>Due</th>
                      <th style={{ width: 120 }}>Outcome</th>
                      <th>Earlier in this series</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recurrence.history.map((row) => (
                      <tr key={row.id} data-testid="recurrence-history-row">
                        <td className="small secondary">{row.dueAt?.slice(0, 10) ?? '—'}</td>
                        <td className="small secondary">{row.status.replace(/_/g, ' ')}</td>
                        <td className="small">
                          <a href={`/tasks/${row.id}`}>{row.title}</a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </>
        ) : (
          <p className="small secondary" style={{ margin: 0 }}>
            {hasDueDate
              ? 'This happens once. Set a repeat and finishing it will make the next one, with the same owner, project and estimate.'
              : 'Give it a due date first — a repeat has to have something to count from.'}
          </p>
        )}

        {editing ? (
          <div className="stack stack-3" data-testid="recurrence-editor">
            <div className="row wrap">
              {PRESETS.map((preset) => (
                <button
                  key={preset.rule}
                  className={`btn btn-sm${rule === preset.rule ? ' btn-primary' : ''}`}
                  disabled={busy}
                  onClick={() => setRule(preset.rule)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <label className="stack stack-2" htmlFor="recurrence-rule">
              <span className="micro">Or a schedule of your own</span>
              <input
                id="recurrence-rule"
                className="input mono"
                value={rule}
                onChange={(event) => setRule(event.target.value)}
                placeholder="0 9 * * 1-5"
              />
            </label>
            <p className="small muted" style={{ margin: 0 }}>
              The same schedules the automations screen accepts — five cron fields, or an alias
              like @weekly — read in the timezone the person doing it works in.
            </p>
            <div className="row wrap">
              <button
                className="btn btn-primary"
                data-testid="recurrence-confirm"
                disabled={busy || rule.trim().length === 0}
                onClick={() => post(rule.trim())}
              >
                {busy ? 'Saving…' : 'Save the repeat'}
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="row wrap">
            <button
              className="btn"
              data-testid="recurrence-edit"
              disabled={busy || !hasDueDate}
              onClick={() => setEditing(true)}
            >
              {recurrence ? 'Change how often' : 'Make it repeat'}
            </button>
            {recurrence ? (
              <button className="btn btn-ghost" data-testid="recurrence-stop" disabled={busy} onClick={() => post(null)}>
                Stop repeating
              </button>
            ) : null}
          </div>
        )}

        {recurrence ? (
          <p className="small muted" style={{ margin: 0 }}>
            Cancelling one occurrence does not stop the series — “nothing to do this week” is not
            “stop doing this”. Stopping is the button above, and the ones already made stay.
          </p>
        ) : null}
      </div>
    </section>
  )
}
