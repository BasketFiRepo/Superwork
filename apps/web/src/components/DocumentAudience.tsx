'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Who can find this document (§4.6).
 *
 * The consequential moment is the first grant: until then the document is findable by
 * anybody whose classification allows it, and the instant one name is on the list everybody
 * else stops being able to retrieve it or see it cited. So the first grant is the one that
 * warns, and reopening is a separate control rather than the side effect of removing the
 * last name.
 */

export interface AudienceEntryRow {
  id: string
  subjectType: 'user' | 'department' | 'role'
  subjectName: string
  relation: string
  reason: string | null
  grantedByName: string | null
}

export interface AudienceData {
  restricted: boolean
  sensitivity: string
  entries: AudienceEntryRow[]
  blockedByClassification: string[]
}

export interface Candidate {
  id: string
  name: string
}

const KIND: Record<AudienceEntryRow['subjectType'], string> = {
  user: 'person',
  department: 'department',
  role: 'role',
}

export function DocumentAudience({
  documentId,
  audience,
  people,
  departments,
}: {
  documentId: string
  audience: AudienceData
  people: Candidate[]
  departments: Candidate[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [subjectType, setSubjectType] = useState<'user' | 'department' | 'role'>('user')
  const [subject, setSubject] = useState('')
  const [reason, setReason] = useState('')
  const [removing, setRemoving] = useState<string | null>(null)
  const [removeReason, setRemoveReason] = useState('')
  const [opening, setOpening] = useState(false)

  async function post(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    const response = await fetch(`/api/documents/${documentId}/audience`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(false)
    if (!response.ok) {
      setError(payload.error)
      return false
    }
    setAdding(false)
    setRemoving(null)
    setOpening(false)
    setSubject('')
    setReason('')
    setRemoveReason('')
    router.refresh()
    return true
  }

  const options = subjectType === 'user' ? people : subjectType === 'department' ? departments : []
  const roles = ['owner', 'admin', 'manager', 'member', 'viewer', 'guest'].filter(
    (role) => !audience.blockedByClassification.includes(role),
  )

  return (
    <section className="panel" data-testid="document-audience">
      <div className="panel-header">
        <h2>Who can find this</h2>
        <span className="small muted">
          {audience.restricted ? 'Restricted circulation' : 'Anybody whose classification allows it'}
        </span>
      </div>

      <div className="panel-body stack stack-4">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        <p className="prose small secondary" style={{ margin: 0 }}>
          {audience.restricted ? (
            <>
              Only the people below can retrieve this document or see it quoted in an answer — including
              administrators, who are not exempt. Opening the document&rsquo;s own page is a separate
              question, governed by permissions.
            </>
          ) : (
            <>
              This document is findable by anybody whose role may read {audience.sensitivity} material.
              Naming even one person below turns that off for everybody else.
            </>
          )}
        </p>

        {audience.restricted ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Who</th>
                  <th style={{ width: 110 }}>Kind</th>
                  <th>Why, and who added them</th>
                  <th style={{ width: 100 }} />
                </tr>
              </thead>
              <tbody>
                {audience.entries.map((entry) => (
                  <tr key={entry.id} data-testid="audience-row">
                    <td>{entry.subjectName}</td>
                    <td className="small secondary">{KIND[entry.subjectType]}</td>
                    <td className="small secondary">
                      {entry.reason}
                      {entry.grantedByName ? <div className="small muted">Added by {entry.grantedByName}</div> : null}
                    </td>
                    <td>
                      <button
                        className="btn btn-ghost small"
                        data-testid="audience-remove"
                        disabled={busy}
                        onClick={() => {
                          setRemoving(removing === entry.id ? null : entry.id)
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
        ) : null}

        {removing ? (
          <div className="stack stack-3" data-testid="audience-remove-editor">
            <label className="stack stack-2" htmlFor="audience-remove-reason">
              <span className="micro">Why do they no longer need it?</span>
              <input
                id="audience-remove-reason"
                className="input"
                value={removeReason}
                onChange={(event) => setRemoveReason(event.target.value)}
                placeholder="Left the deal team."
              />
            </label>
            <div className="row">
              <button
                className="btn btn-danger"
                data-testid="audience-remove-confirm"
                disabled={busy || removeReason.trim().length < 4}
                onClick={() => post({ action: 'revoke', entryId: removing, reason: removeReason })}
              >
                Remove them
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setRemoving(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {adding ? (
          <div className="stack stack-4" data-testid="audience-editor">
            {!audience.restricted ? (
              <div className="banner banner-attention">
                <span>
                  This is the first name on the list. The moment it is saved, everybody else loses the
                  ability to find this document.
                </span>
              </div>
            ) : null}
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <label className="stack stack-2" style={{ flex: '0 0 150px' }} htmlFor="audience-kind">
                <span className="micro">Add a</span>
                <select
                  id="audience-kind"
                  className="select"
                  value={subjectType}
                  onChange={(event) => {
                    setSubjectType(event.target.value as typeof subjectType)
                    setSubject('')
                  }}
                >
                  <option value="user">person</option>
                  <option value="department">department</option>
                  <option value="role">role</option>
                </select>
              </label>
              <label className="stack stack-2" style={{ flex: '1 1 240px' }} htmlFor="audience-subject">
                <span className="micro">Which</span>
                <select
                  id="audience-subject"
                  className="select"
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                >
                  <option value="">Choose…</option>
                  {subjectType === 'role'
                    ? roles.map((role) => (
                        <option key={role} value={role}>
                          Everyone with the {role} role
                        </option>
                      ))
                    : options.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.name}
                        </option>
                      ))}
                </select>
              </label>
            </div>
            {subjectType === 'role' && audience.blockedByClassification.length > 0 ? (
              <p className="small muted" style={{ margin: 0 }}>
                Not offered: {audience.blockedByClassification.join(', ')} — those roles may not read{' '}
                {audience.sensitivity} material at all, so adding them here would change nothing.
              </p>
            ) : null}
            <label className="stack stack-2" htmlFor="audience-reason">
              <span className="micro">Why do they need it?</span>
              <input
                id="audience-reason"
                className="input"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Running the Halden renewal."
              />
            </label>
            <div className="row">
              <button
                className="btn btn-primary"
                data-testid="audience-add-confirm"
                disabled={busy || !subject || reason.trim().length < 4}
                onClick={() =>
                  post({
                    action: 'grant',
                    subjectType,
                    subjectId: subjectType === 'role' ? null : subject,
                    subjectRole: subjectType === 'role' ? subject : null,
                    reason,
                  })
                }
              >
                {audience.restricted ? 'Add them' : 'Restrict to this list'}
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {opening ? (
          <div className="stack stack-3" data-testid="audience-open-editor">
            <label className="stack stack-2" htmlFor="audience-open-reason">
              <span className="micro">Why does it no longer need restricting?</span>
              <input
                id="audience-open-reason"
                className="input"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Deal closed; the terms are public now."
              />
            </label>
            <div className="row">
              <button
                className="btn btn-danger"
                data-testid="audience-open-confirm"
                disabled={busy || reason.trim().length < 4}
                onClick={() => post({ action: 'open', reason })}
              >
                Open it to everybody
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setOpening(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {!adding && !opening ? (
          <div className="row">
            <button
              className={audience.restricted ? 'btn' : 'btn btn-primary'}
              data-testid="audience-add"
              disabled={busy}
              onClick={() => {
                setAdding(true)
                setError(null)
                setReason('')
              }}
            >
              {audience.restricted ? 'Add somebody' : 'Restrict who can find this'}
            </button>
            {audience.restricted ? (
              <button
                className="btn btn-ghost"
                data-testid="audience-open"
                disabled={busy}
                onClick={() => {
                  setOpening(true)
                  setError(null)
                  setReason('')
                }}
              >
                Remove the restriction
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}
