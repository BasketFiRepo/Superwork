'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Where a project has got to (§17, ADR 0049).
 *
 * Creating something with no way to close it is half a feature: a project list that can only
 * grow is one people stop reading. `completed` is a claim about the work and is refused while
 * the work is still open; `cancelled` is a decision about the project and is always available.
 */

const STATUSES = [
  { value: 'planning', label: 'Planning', hint: 'Being shaped. Not yet work anybody is doing.' },
  { value: 'active', label: 'Active', hint: 'Being worked on now.' },
  { value: 'on_hold', label: 'On hold', hint: 'Paused on purpose, and expected back.' },
  { value: 'completed', label: 'Completed', hint: 'Finished. Refused while its work is still open.' },
  { value: 'cancelled', label: 'Cancelled', hint: 'Abandoned. Allowed with work still open — that is what abandoning looks like.' },
] as const

export function ProjectStatus({
  projectId,
  status,
  canEdit,
  denialReason,
}: {
  projectId: string
  status: string
  canEdit: boolean
  denialReason: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [next, setNext] = useState(status)
  const [reason, setReason] = useState('')

  const chosen = STATUSES.find((option) => option.value === next)

  async function save() {
    setBusy(true)
    setError(null)
    const response = await fetch(`/api/projects/${projectId}/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: next, reason: reason.trim() }),
    })
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(false)
    if (!response.ok) {
      setError(payload.error)
      return
    }
    setEditing(false)
    setReason('')
    router.refresh()
  }

  return (
    <section className="panel" data-testid="project-status">
      <div className="panel-header">
        <h2>Where it has got to</h2>
        <span className="chip">{status.replace(/_/g, ' ')}</span>
      </div>

      <div className="panel-body stack stack-3">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        {editing ? (
          <div className="stack stack-3" data-testid="project-status-editor">
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <label className="stack stack-2" style={{ flex: '0 0 180px' }} htmlFor="project-status-select">
                <span className="micro">Set it to</span>
                <select
                  id="project-status-select"
                  className="select"
                  value={next}
                  onChange={(event) => setNext(event.target.value)}
                >
                  {STATUSES.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="stack stack-2" style={{ flex: '1 1 260px' }} htmlFor="project-status-reason">
                <span className="micro">Why</span>
                <input
                  id="project-status-reason"
                  className="input"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="The customer has pushed the go-live to the spring."
                />
              </label>
            </div>

            <p className="small secondary" style={{ margin: 0 }}>
              {chosen?.hint}
            </p>

            <div className="row wrap">
              <button
                className="btn btn-primary"
                data-testid="project-status-confirm"
                disabled={busy || reason.trim().length < 4 || next === status}
                onClick={save}
              >
                {busy ? 'Saving…' : 'Set it'}
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
              data-testid="project-status-edit"
              disabled={!canEdit}
              title={canEdit ? undefined : denialReason}
              onClick={() => setEditing(true)}
            >
              Change where it has got to
            </button>
            {canEdit ? null : <span className="small muted">{denialReason}</span>}
          </div>
        )}

        <p className="small muted" style={{ margin: 0 }}>
          A project cannot be called completed while its tasks or milestones are still open. It can
          always be cancelled, and the name it was using is free again once it is.
        </p>
      </div>
    </section>
  )
}
