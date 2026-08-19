'use client'

import { useState } from 'react'
import { Link } from '@/components/Link'
import { useRouter } from 'next/navigation'

/**
 * What a task is waiting for, and who is waiting for it (§12.1).
 *
 * Both directions on one screen, because the second one is the half people never see: the
 * briefing tells you that your work is holding up three colleagues, and this is where you
 * find out which three.
 */

export interface EdgeRow {
  id: string
  taskId: string
  taskTitle: string
  taskStatus: string
  assigneeName: string | null
  reason: string | null
}

export interface DependencyData {
  blockedBy: EdgeRow[]
  blocking: EdgeRow[]
  isBlocked: boolean
}

export interface TaskOption {
  id: string
  title: string
}

const DONE = ['completed', 'cancelled']

export function TaskDependencies({
  taskId,
  dependencies,
  candidates,
}: {
  taskId: string
  dependencies: DependencyData
  candidates: TaskOption[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [dependsOn, setDependsOn] = useState('')
  const [reason, setReason] = useState('')

  async function post(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    const response = await fetch(`/api/tasks/${taskId}/dependencies`, {
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
    setDependsOn('')
    setReason('')
    router.refresh()
  }

  const row = (edge: EdgeRow, direction: 'blocked_by' | 'blocking') => (
    <tr key={edge.id} data-testid={direction === 'blocked_by' ? 'blocked-by-row' : 'blocking-row'}>
      <td>
        <Link href={`/tasks/${edge.taskId}`}>{edge.taskTitle}</Link>
        {edge.reason ? <div className="small muted">{edge.reason}</div> : null}
      </td>
      <td>
        <span className={DONE.includes(edge.taskStatus) ? 'chip chip-positive' : 'chip'}>
          {edge.taskStatus.replace(/_/g, ' ')}
        </span>
      </td>
      <td className="small secondary">{edge.assigneeName ?? 'unassigned'}</td>
      <td>
        {direction === 'blocked_by' ? (
          <button
            className="btn btn-ghost small"
            data-testid="dependency-remove"
            disabled={busy}
            onClick={() => post({ action: 'remove', dependencyId: edge.id })}
          >
            Remove
          </button>
        ) : null}
      </td>
    </tr>
  )

  return (
    <section className="panel" data-testid="task-dependencies">
      <div className="panel-header">
        <h2>Waiting on, and waited on</h2>
        <span className="small muted">
          {dependencies.isBlocked
            ? 'This cannot be completed yet'
            : dependencies.blocking.length > 0
              ? `${dependencies.blocking.length} ${dependencies.blocking.length === 1 ? 'task is' : 'tasks are'} waiting for this`
              : 'Nothing is in the way'}
        </span>
      </div>

      <div className="panel-body stack stack-5">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        <div className="stack stack-3">
          <span className="micro">This waits for</span>
          {dependencies.blockedBy.length === 0 ? (
            <div className="empty small secondary">Nothing. It can be completed whenever it is done.</div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Task</th>
                    <th style={{ width: 130 }}>Status</th>
                    <th style={{ width: 160 }}>Who</th>
                    <th style={{ width: 100 }} />
                  </tr>
                </thead>
                <tbody>{dependencies.blockedBy.map((edge) => row(edge, 'blocked_by'))}</tbody>
              </table>
            </div>
          )}
        </div>

        {adding ? (
          <div className="stack stack-4" data-testid="dependency-editor">
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <label className="stack stack-2" style={{ flex: '2 1 320px' }} htmlFor="dependency-task">
                <span className="micro">It waits for</span>
                <select
                  id="dependency-task"
                  className="select"
                  value={dependsOn}
                  onChange={(event) => setDependsOn(event.target.value)}
                >
                  <option value="">Choose a task…</option>
                  {candidates.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.title}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="stack stack-2" htmlFor="dependency-reason">
              <span className="micro">Why? (optional, but the first person to hit this will want it)</span>
              <input
                id="dependency-reason"
                className="input"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Cannot ship before the paperwork exists."
              />
            </label>
            <p className="small muted" style={{ margin: 0 }}>
              While this waits for something unfinished, completing it is refused rather than warned
              about. A loop is refused outright — neither task could ever be completed.
            </p>
            <div className="row">
              <button
                className="btn btn-primary"
                data-testid="dependency-add-confirm"
                disabled={busy || !dependsOn}
                onClick={() => post({ action: 'add', dependsOnTaskId: dependsOn, reason: reason || undefined })}
              >
                Record it
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="row">
            <button
              className="btn"
              data-testid="dependency-add"
              disabled={busy}
              onClick={() => {
                setAdding(true)
                setError(null)
              }}
            >
              Say what it waits for
            </button>
          </div>
        )}

        <div className="stack stack-3 hairline-top" style={{ paddingTop: 16 }}>
          <span className="micro">Waiting for this</span>
          {dependencies.blocking.length === 0 ? (
            <div className="empty small secondary">Nobody is held up by this one.</div>
          ) : (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Task</th>
                    <th style={{ width: 130 }}>Status</th>
                    <th style={{ width: 160 }}>Who</th>
                    <th style={{ width: 100 }} />
                  </tr>
                </thead>
                <tbody>{dependencies.blocking.map((edge) => row(edge, 'blocking'))}</tbody>
              </table>
            </div>
          )}
          {dependencies.blocking.length > 0 ? (
            <p className="small muted" style={{ margin: 0 }}>
              Finishing this tells whoever it was the last thing standing in the way of.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  )
}
