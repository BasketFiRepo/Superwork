'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Who is on this project (§17, ADR 0032).
 *
 * Deliberately a different panel from "Shared with", and said so on the screen. A share is
 * what you give somebody outside the work; a roster is the work's own answer to who is
 * doing it. Until now the product could express the first and not the second — the table
 * has existed since migration 0002 and nothing read it — so this page answered "who is
 * doing this?" with one chip naming the owner.
 *
 * Being on it lends a read of the project and of the work inside it, and nothing else. The
 * owner's row is derived from the project itself and cannot be edited here, because who
 * owns a project is a property of the project.
 */

export interface RosterRow {
  userId: string
  name: string
  role: 'owner' | 'lead' | 'contributor' | 'reviewer'
  reason: string | null
  derived: boolean
  addedByName: string | null
  joinedAt: string
}

export interface Candidate {
  id: string
  name: string
}

const ROLES = [
  { id: 'lead', label: 'is running it' },
  { id: 'contributor', label: 'is working on it' },
  { id: 'reviewer', label: 'is reviewing it' },
]

const ROLE_LABEL: Record<string, string> = {
  owner: 'owns it',
  lead: 'is running it',
  contributor: 'is working on it',
  reviewer: 'is reviewing it',
}

export function ProjectRoster({
  projectId,
  members,
  people,
  canEdit,
}: {
  projectId: string
  members: RosterRow[]
  people: Candidate[]
  canEdit: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [subject, setSubject] = useState('')
  const [role, setRole] = useState('contributor')
  const [reason, setReason] = useState('')

  async function post(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    const response = await fetch(`/api/projects/${projectId}/members`, {
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
    setSubject('')
    setReason('')
    router.refresh()
  }

  const onIt = new Set(members.map((member) => member.userId))
  const candidates = people.filter((person) => !onIt.has(person.id))

  return (
    <section className="panel" data-testid="project-roster">
      <div className="panel-header">
        <h2>Who is on it</h2>
        <span className="small muted">
          {members.length} {members.length === 1 ? 'person' : 'people'}
        </span>
      </div>

      <div className="panel-body stack stack-4">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        <p className="prose small secondary" style={{ margin: 0 }} data-testid="roster-reach">
          Being on a project lets somebody read it and the work inside it, up to their own
          clearance — it lends a read, never a say. That is different from sharing it, which is
          what you do for somebody outside the work. Who owns it comes from the project itself.
        </p>

        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Who</th>
                <th style={{ width: 150 }}>Doing what</th>
                <th>Why, and who added them</th>
                {canEdit ? <th style={{ width: 90 }} /> : null}
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.userId} data-testid="roster-row">
                  <td>
                    {member.name}
                    <div className="small muted">joined {member.joinedAt.slice(0, 10)}</div>
                  </td>
                  <td className="small secondary">{ROLE_LABEL[member.role] ?? member.role}</td>
                  <td className="small secondary">
                    {member.reason ?? '—'}
                    {member.addedByName ? <div className="small muted">{member.addedByName}</div> : null}
                  </td>
                  {canEdit ? (
                    <td>
                      <button
                        className="btn btn-ghost small"
                        data-testid="roster-remove"
                        disabled={busy || member.derived}
                        title={
                          member.derived
                            ? 'The owner cannot be taken off their own project. Hand the project to somebody else and the roster follows.'
                            : undefined
                        }
                        onClick={() =>
                          post({ action: 'remove', userId: member.userId, reason: 'No longer working on this.' })
                        }
                      >
                        Remove
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
            <div className="stack stack-4" data-testid="roster-editor">
              <div className="row wrap" style={{ alignItems: 'flex-end' }}>
                <label className="stack stack-2" style={{ flex: '1 1 220px' }} htmlFor="roster-subject">
                  <span className="micro">Who</span>
                  <select
                    id="roster-subject"
                    className="select"
                    value={subject}
                    onChange={(event) => setSubject(event.target.value)}
                  >
                    <option value="">Choose…</option>
                    {candidates.map((person) => (
                      <option key={person.id} value={person.id}>
                        {person.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="stack stack-2" style={{ flex: '0 0 190px' }} htmlFor="roster-role">
                  <span className="micro">Doing what</span>
                  <select
                    id="roster-role"
                    className="select"
                    value={role}
                    onChange={(event) => setRole(event.target.value)}
                  >
                    {ROLES.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="stack stack-2" htmlFor="roster-reason">
                <span className="micro">Why they are joining</span>
                <input
                  id="roster-reason"
                  className="input"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Covering the customs work until the renewal ships."
                />
              </label>
              <div className="row wrap">
                <button
                  className="btn btn-primary"
                  data-testid="roster-confirm"
                  disabled={busy || !subject || reason.trim().length < 4}
                  onClick={() => post({ action: 'add', userId: subject, role, reason: reason.trim() })}
                >
                  {busy ? 'Working…' : 'Put them on it'}
                </button>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setAdding(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="row">
              <button className="btn" data-testid="roster-add" disabled={busy} onClick={() => setAdding(true)}>
                Put somebody on it
              </button>
            </div>
          )
        ) : (
          <p className="small muted" style={{ margin: 0 }}>
            Changing who is on a project needs a say over the project.
          </p>
        )}
      </div>
    </section>
  )
}
