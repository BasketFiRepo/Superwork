'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * The dates a project is judged against (§17, ADR 0036).
 *
 * Milestones have been on every project page and counted in the health score since Phase 1,
 * written by the seed and by nothing else — a project could show them and never gain one.
 *
 * Cancelling and removing are both offered, and they are different: a cancelled milestone
 * stays on the record as something the project decided not to do, and a removed one was
 * never real. The score counts neither.
 */

export interface MilestoneRow {
  id: string
  name: string
  dueOn: string | null
  status: string
  late: boolean
}

export function Milestones({
  projectId,
  milestones,
  canEdit,
}: {
  projectId: string
  milestones: MilestoneRow[]
  canEdit: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [dueOn, setDueOn] = useState('')

  async function post(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    const response = await fetch(`/api/projects/${projectId}/milestones`, {
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
    setDueOn('')
    router.refresh()
  }

  return (
    <section className="panel" data-testid="milestones">
      <div className="panel-header">
        <h2>Milestones</h2>
        <span className="small muted">{milestones.length === 0 ? 'None set' : `${milestones.length}`}</span>
      </div>

      <div className="panel-body stack stack-4">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        {milestones.length === 0 ? (
          <div className="empty small secondary">
            No milestones on this project. A missed one costs the health score a quarter of its
            weight, so they are worth setting honestly rather than generously.
          </div>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Milestone</th>
                  <th style={{ width: 140 }}>Due</th>
                  <th style={{ width: 120 }}>Status</th>
                  {canEdit ? <th style={{ width: 220 }} /> : null}
                </tr>
              </thead>
              <tbody>
                {milestones.map((milestone) => (
                  <tr key={milestone.id} data-testid="milestone-row">
                    <td>{milestone.name}</td>
                    <td className="small secondary">
                      {canEdit ? (
                        <input
                          className="input"
                          type="date"
                          style={{ maxWidth: 150 }}
                          defaultValue={milestone.dueOn ? milestone.dueOn.slice(0, 10) : ''}
                          disabled={busy}
                          data-testid="milestone-due"
                          onChange={(event) =>
                            post({
                              action: 'reschedule',
                              milestoneId: milestone.id,
                              dueOn: event.target.value || null,
                            })
                          }
                        />
                      ) : (
                        (milestone.dueOn?.slice(0, 10) ?? '—')
                      )}
                    </td>
                    <td>
                      <span className={milestone.late ? 'chip chip-critical' : 'chip'}>
                        {milestone.late ? 'past due' : milestone.status}
                      </span>
                    </td>
                    {canEdit ? (
                      <td>
                        <div className="row-tight">
                          <button
                            className="btn btn-ghost small"
                            data-testid="milestone-done"
                            disabled={busy || milestone.status === 'done'}
                            onClick={() =>
                              post({ action: 'status', milestoneId: milestone.id, status: 'done' })
                            }
                          >
                            Reached
                          </button>
                          <button
                            className="btn btn-ghost small"
                            disabled={busy || milestone.status === 'cancelled'}
                            onClick={() =>
                              post({ action: 'status', milestoneId: milestone.id, status: 'cancelled' })
                            }
                          >
                            Not doing it
                          </button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {canEdit ? (
          adding ? (
            <div className="stack stack-3" data-testid="milestone-editor">
              <div className="row wrap" style={{ alignItems: 'flex-end' }}>
                <label className="stack stack-2" style={{ flex: '1 1 240px' }} htmlFor="milestone-name">
                  <span className="micro">What has to be true</span>
                  <input
                    id="milestone-name"
                    className="input"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Broker consolidation decision"
                  />
                </label>
                <label className="stack stack-2" style={{ flex: '0 0 180px' }} htmlFor="milestone-date">
                  <span className="micro">By when</span>
                  <input
                    id="milestone-date"
                    className="input"
                    type="date"
                    value={dueOn}
                    onChange={(event) => setDueOn(event.target.value)}
                  />
                </label>
              </div>
              <div className="row wrap">
                <button
                  className="btn btn-primary"
                  data-testid="milestone-confirm"
                  disabled={busy || name.trim().length < 2}
                  onClick={() => post({ action: 'add', name: name.trim(), dueOn: dueOn || null })}
                >
                  {busy ? 'Working…' : 'Add it'}
                </button>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setAdding(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="row">
              <button className="btn" data-testid="milestone-add" disabled={busy} onClick={() => setAdding(true)}>
                Add a milestone
              </button>
            </div>
          )
        ) : null}
      </div>
    </section>
  )
}
