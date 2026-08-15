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
  counts: { people: number; children: number; tasks: number; projects: number }
}

export function Departments({ departments, canEdit }: { departments: DepartmentRow[]; canEdit: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [parentId, setParentId] = useState('')

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

        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Department</th>
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
