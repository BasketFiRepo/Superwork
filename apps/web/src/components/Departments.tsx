'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Departments (§4.3, ADR 0036).
 *
 * A department is where somebody sits: one per person, and it decides what
 * `department`-scoped permissions reach, which department's agents hold which grants, and
 * how the run queue splits its fair share. It has been read everywhere and written by the
 * seed alone, so an organization could be governed by a tree it could not change.
 *
 * The panel says the difference from a team out loud, because the two are easy to confuse
 * and only one of them is an employment fact.
 */

export interface DepartmentRow {
  id: string
  name: string
  path: string
  depth: number
  parentId: string | null
  holidayCalendar: string | null
  effectiveHolidayCalendar: string | null
  holidayCalendarFrom: string | null
  closures: {
    id: string
    date: string
    label: string
    from: string
    own: boolean
    setBy: string | null
  }[]
  counts: { people: number; children: number; tasks: number; projects: number }
}

export interface CalendarOption {
  id: string
  label: string
  description: string
}

export function Departments({
  departments,
  calendars,
  canEdit,
}: {
  departments: DepartmentRow[]
  calendars: CalendarOption[]
  canEdit: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [parentId, setParentId] = useState('')
  // Which department is having a closed day added, and which closure is being taken back off.
  const [closing, setClosing] = useState<string | null>(null)
  const [closeDate, setCloseDate] = useState('')
  const [closeLabel, setCloseLabel] = useState('')
  const [reopening, setReopening] = useState<string | null>(null)
  const [reopenReason, setReopenReason] = useState('')

  async function post(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/departments', {
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
    setName('')
    setParentId('')
    setClosing(null)
    setCloseDate('')
    setCloseLabel('')
    setReopening(null)
    setReopenReason('')
    router.refresh()
  }

  return (
    <section className="panel" data-testid="departments">
      <div className="panel-header">
        <h2>Departments</h2>
        <span className="small muted">{departments.length}</span>
      </div>

      <div className="panel-body stack stack-4">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        <p className="prose small secondary" style={{ margin: 0 }} data-testid="department-explainer">
          A department is where somebody sits — one each — and it decides what
          department-scoped permissions reach, which agents hold which grants, and how the queue
          splits its fair share. A team is what somebody is working on, several at a time. Moving
          a department moves everything under it, including the path every screen shows.
        </p>

        <p className="prose small secondary" style={{ margin: 0 }} data-testid="calendar-explainer">
          The working calendar decides which days the system will not chase these people on.
          Set it once near the top of the tree and everything underneath inherits it. It can
          only ever quieten the reminders — nothing here makes the product chase anybody
          harder, or on a day it otherwise would not.
        </p>

        <p className="prose small secondary" style={{ margin: 0 }} data-testid="closure-explainer">
          A closed day is one this department does not work that no calendar knows about: the
          week between Christmas and New Year, the day the depot moves, a public holiday
          somewhere none of the calendars above cover. Unlike the calendar, closed days add up
          rather than replace each other — a day set higher in the tree also closes everything
          underneath it, and is taken back off where it was set.
        </p>

        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Department</th>
                <th style={{ width: 220 }}>Working calendar</th>
                <th style={{ width: 260 }}>Closed days ahead</th>
                <th style={{ width: 90 }}>People</th>
                <th style={{ width: 90 }}>Tasks</th>
                <th style={{ width: 100 }}>Projects</th>
                {canEdit ? <th style={{ width: 100 }} /> : null}
              </tr>
            </thead>
            <tbody>
              {departments.map((department) => (
                <tr key={department.id} data-testid="department-row">
                  <td>
                    <span style={{ paddingLeft: `calc(${department.depth} * var(--s-5))` }}>
                      {department.name}
                    </span>
                    {department.depth > 0 ? <div className="small muted">{department.path}</div> : null}
                  </td>
                  <td className="small secondary">
                    {canEdit ? (
                      <select
                        className="input"
                        aria-label={`Working calendar for ${department.name}`}
                        data-testid="department-calendar"
                        disabled={busy}
                        value={department.holidayCalendar ?? ''}
                        onChange={(event) =>
                          post({
                            action: 'update',
                            id: department.id,
                            holidayCalendar: event.target.value || null,
                          })
                        }
                      >
                        <option value="">
                          {department.holidayCalendarFrom
                            ? `Inherited from ${department.holidayCalendarFrom}`
                            : 'Not set — every day is chased'}
                        </option>
                        {calendars.map((calendar) => (
                          <option key={calendar.id} value={calendar.id}>
                            {calendar.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      calendars.find((calendar) => calendar.id === department.effectiveHolidayCalendar)?.label ??
                      'Not set'
                    )}
                    {!department.holidayCalendar && department.holidayCalendarFrom ? (
                      <div className="small muted">
                        {calendars.find((c) => c.id === department.effectiveHolidayCalendar)?.label}
                      </div>
                    ) : null}
                  </td>
                  <td className="small secondary" data-testid="department-closures">
                    {department.closures.length === 0 ? (
                      <span className="muted">None — only its calendar</span>
                    ) : (
                      <ul className="stack stack-2" style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
                        {department.closures.map((closure) => (
                          <li key={closure.id} data-testid="department-closure">
                            <span className="mono">{closure.date}</span> {closure.label}
                            <div className="micro muted">
                              {closure.own
                                ? closure.setBy
                                  ? `Set by ${closure.setBy}`
                                  : 'Set here'
                                : `Inherited from ${closure.from}`}
                            </div>
                            {canEdit && closure.own ? (
                              reopening === closure.id ? (
                                <div className="stack stack-2" data-testid="department-reopen-editor">
                                  <input
                                    className="input"
                                    aria-label={`Why ${closure.label} is being worked after all`}
                                    data-testid="department-reopen-reason"
                                    value={reopenReason}
                                    onChange={(event) => setReopenReason(event.target.value)}
                                    placeholder="The stocktake moved"
                                  />
                                  <div className="row">
                                    <button
                                      className="btn btn-ghost small"
                                      data-testid="department-reopen-confirm"
                                      disabled={busy || reopenReason.trim().length < 4}
                                      onClick={() =>
                                        post({
                                          action: 'reopen',
                                          closureId: closure.id,
                                          reason: reopenReason.trim(),
                                        })
                                      }
                                    >
                                      {busy ? 'Working…' : 'Reopen it'}
                                    </button>
                                    <button
                                      className="btn btn-ghost small"
                                      disabled={busy}
                                      onClick={() => {
                                        setReopening(null)
                                        setReopenReason('')
                                      }}
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                <button
                                  className="btn btn-ghost small"
                                  data-testid="department-reopen"
                                  disabled={busy}
                                  onClick={() => {
                                    setReopening(closure.id)
                                    setReopenReason('')
                                  }}
                                >
                                  Reopen
                                </button>
                              )
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    )}

                    {canEdit ? (
                      closing === department.id ? (
                        <div className="stack stack-2" data-testid="department-closure-editor">
                          <label className="stack stack-2">
                            <span className="micro">Day</span>
                            <input
                              type="date"
                              className="input"
                              aria-label={`Day ${department.name} is closed`}
                              data-testid="department-closure-date"
                              value={closeDate}
                              onChange={(event) => setCloseDate(event.target.value)}
                            />
                          </label>
                          <label className="stack stack-2">
                            <span className="micro">What the day is</span>
                            <input
                              className="input"
                              aria-label={`What ${department.name} is closed for`}
                              data-testid="department-closure-label"
                              value={closeLabel}
                              onChange={(event) => setCloseLabel(event.target.value)}
                              placeholder="Stocktake shutdown"
                            />
                          </label>
                          <div className="row">
                            <button
                              className="btn btn-primary small"
                              data-testid="department-closure-confirm"
                              disabled={busy || closeLabel.trim().length < 3 || closeDate.length !== 10}
                              onClick={() =>
                                post({
                                  action: 'close',
                                  id: department.id,
                                  date: closeDate,
                                  label: closeLabel.trim(),
                                })
                              }
                            >
                              {busy ? 'Working…' : 'Close that day'}
                            </button>
                            <button className="btn btn-ghost small" disabled={busy} onClick={() => setClosing(null)}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button
                          className="btn btn-ghost small"
                          data-testid="department-close-day"
                          disabled={busy}
                          onClick={() => {
                            setClosing(department.id)
                            setCloseDate('')
                            setCloseLabel('')
                          }}
                        >
                          Add a closed day
                        </button>
                      )
                    ) : null}
                  </td>
                  <td className="num">{department.counts.people}</td>
                  <td className="num">{department.counts.tasks}</td>
                  <td className="num">{department.counts.projects}</td>
                  {canEdit ? (
                    <td>
                      <button
                        className="btn btn-ghost small"
                        data-testid="department-archive"
                        disabled={busy}
                        onClick={() =>
                          post({ action: 'archive', id: department.id, reason: 'No longer part of the company.' })
                        }
                      >
                        Archive
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {canEdit ? (
          adding ? (
            <div className="stack stack-3" data-testid="department-editor">
              <div className="row wrap" style={{ alignItems: 'flex-end' }}>
                <label className="stack stack-2" style={{ flex: '1 1 220px' }} htmlFor="department-name">
                  <span className="micro">Name</span>
                  <input
                    id="department-name"
                    className="input"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Customs"
                  />
                </label>
                <label className="stack stack-2" style={{ flex: '0 0 240px' }} htmlFor="department-parent">
                  <span className="micro">Sits under</span>
                  <select
                    id="department-parent"
                    className="select"
                    value={parentId}
                    onChange={(event) => setParentId(event.target.value)}
                  >
                    <option value="">Nothing — top level</option>
                    {departments.map((department) => (
                      <option key={department.id} value={department.id}>
                        {department.path}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="row wrap">
                <button
                  className="btn btn-primary"
                  data-testid="department-confirm"
                  disabled={busy || name.trim().length < 2}
                  onClick={() => post({ action: 'create', name: name.trim(), parentId: parentId || null })}
                >
                  {busy ? 'Working…' : 'Create it'}
                </button>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setAdding(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="row">
              <button className="btn" data-testid="department-add" disabled={busy} onClick={() => setAdding(true)}>
                Add a department
              </button>
            </div>
          )
        ) : (
          <p className="small muted" style={{ margin: 0 }}>
            Changing the structure needs administrator access.
          </p>
        )}
      </div>
    </section>
  )
}
