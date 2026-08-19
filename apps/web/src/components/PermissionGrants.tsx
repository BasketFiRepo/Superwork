'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useStepUp } from './StepUp'

/**
 * Exceptions: one capability, for one person (§4.2, ADR 0055).
 *
 * The policy engine has always ended its check with the role's grants *plus this person's own*,
 * and nothing could write the second half. An administrator who needed to give somebody one
 * extra capability had to change their role, which hands them everything else that role carries.
 *
 * The screen says the three things a person reviewing this in six months needs: what it lets
 * them do, why, and when it ends — with "no end date" written out rather than left blank.
 */

export interface GrantRow {
  id: string
  userId: string
  userName: string
  role: string
  permission: string
  reason: string
  grantedByName: string | null
  grantedAt: string
  expiresAt: string | null
  live: boolean
  revokedAt: string | null
  revokedByName: string | null
  revokeReason: string | null
}

export interface MemberOption {
  id: string
  name: string
  role: string
}

export function PermissionGrants({
  grants,
  members,
  canEdit,
}: {
  grants: GrantRow[]
  members: MemberOption[]
  canEdit: boolean
}) {
  const router = useRouter()
  const stepUp = useStepUp()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const [userId, setUserId] = useState('')
  const [permission, setPermission] = useState('')
  const [reason, setReason] = useState('')
  const [expiresAt, setExpiresAt] = useState('')

  const [revoking, setRevoking] = useState<string | null>(null)
  const [revokeReason, setRevokeReason] = useState('')

  async function post(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    // Granting one needs fresh proof of identity; taking one back does not. `run` holds the
    // call, asks, and replays it, so the person presses their button once (§4.1).
    const response = await stepUp.run(() =>
      fetch('/api/permission-grants', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
    setBusy(false)
    if (!response) return
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    if (!response.ok) {
      setError(payload.error)
      return
    }
    setAdding(false)
    setUserId('')
    setPermission('')
    setReason('')
    setExpiresAt('')
    setRevoking(null)
    setRevokeReason('')
    router.refresh()
  }

  const live = grants.filter((grant) => grant.live)
  const past = grants.filter((grant) => !grant.live)

  return (
    <section className="panel" data-testid="permission-grants">
      {stepUp.prompt}
      <div className="panel-header">
        <h2>Exceptions</h2>
        <span className="small muted">{live.length} in force</span>
      </div>

      <div className="panel-body stack stack-4">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        <p className="prose small secondary" style={{ margin: 0 }} data-testid="grants-explainer">
          One capability, for one person, that their role does not carry — so nobody has to be made
          an administrator to be given one thing. An exception cannot be a wildcard, cannot be
          something the role already has, and cannot be granted by somebody who does not have it
          themselves. Each one says who gave it, why, and when it ends; the person it is for is
          told at the same time.
        </p>

        {live.length === 0 ? (
          <div className="empty small secondary" data-testid="grants-empty">
            Nobody has an exception. Everybody can do exactly what their role says.
          </div>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th style={{ width: 220 }}>May also</th>
                  <th>Why</th>
                  <th style={{ width: 150 }}>Ends</th>
                  {canEdit ? <th style={{ width: 90 }} /> : null}
                </tr>
              </thead>
              <tbody>
                {live.map((grant) => (
                  <tr key={grant.id} data-testid="grant-row">
                    <td>
                      {grant.userName}
                      <div className="micro muted">{grant.role}</div>
                    </td>
                    <td className="mono small">{grant.permission}</td>
                    <td className="small secondary">
                      {grant.reason}
                      <div className="micro muted">
                        {grant.grantedByName ? `Given by ${grant.grantedByName}` : 'Given by somebody since removed'}
                        {' · '}
                        {grant.grantedAt.slice(0, 10)}
                      </div>
                    </td>
                    <td className="small secondary" data-testid="grant-ends">
                      {grant.expiresAt ? (
                        grant.expiresAt.slice(0, 10)
                      ) : (
                        <span className="muted">No end date</span>
                      )}
                    </td>
                    {canEdit ? (
                      <td>
                        {revoking === grant.id ? null : (
                          <button
                            className="btn btn-ghost small"
                            data-testid="grant-revoke"
                            disabled={busy}
                            onClick={() => {
                              setRevoking(grant.id)
                              setRevokeReason('')
                            }}
                          >
                            Take off
                          </button>
                        )}
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {revoking ? (
          <div className="stack stack-2" data-testid="grant-revoke-editor">
            <label className="stack stack-2" htmlFor="grant-revoke-reason">
              <span className="micro">Why it is being taken off</span>
              <input
                id="grant-revoke-reason"
                className="input"
                data-testid="grant-revoke-reason"
                value={revokeReason}
                onChange={(event) => setRevokeReason(event.target.value)}
                placeholder="They have moved off that account"
              />
            </label>
            <div className="row">
              <button
                className="btn btn-primary small"
                data-testid="grant-revoke-confirm"
                disabled={busy || revokeReason.trim().length < 4}
                onClick={() => post({ action: 'revoke', grantId: revoking, reason: revokeReason.trim() })}
              >
                {busy ? 'Working…' : 'Take it off'}
              </button>
              <button className="btn btn-ghost small" disabled={busy} onClick={() => setRevoking(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {canEdit ? (
          adding ? (
            <div className="stack stack-3" data-testid="grant-editor">
              <div className="row wrap" style={{ alignItems: 'flex-end' }}>
                <label className="stack stack-2" style={{ flex: '0 0 220px' }} htmlFor="grant-user">
                  <span className="micro">Person</span>
                  <select
                    id="grant-user"
                    className="select"
                    data-testid="grant-user"
                    value={userId}
                    onChange={(event) => setUserId(event.target.value)}
                  >
                    <option value="">Choose somebody</option>
                    {members.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name} ({member.role})
                      </option>
                    ))}
                  </select>
                </label>
                <label className="stack stack-2" style={{ flex: '1 1 240px' }} htmlFor="grant-permission">
                  <span className="micro">May also</span>
                  <input
                    id="grant-permission"
                    className="input mono"
                    data-testid="grant-permission"
                    value={permission}
                    onChange={(event) => setPermission(event.target.value)}
                    placeholder="document:update:department"
                  />
                  <span className="micro muted">A thing, a verb, and how far it reaches.</span>
                </label>
                <label className="stack stack-2" style={{ flex: '0 0 180px' }} htmlFor="grant-expires">
                  <span className="micro">Ends</span>
                  <input
                    id="grant-expires"
                    type="date"
                    className="input"
                    data-testid="grant-expires"
                    value={expiresAt}
                    onChange={(event) => setExpiresAt(event.target.value)}
                  />
                  <span className="micro muted">Leave it blank for no end date.</span>
                </label>
              </div>
              <label className="stack stack-2" htmlFor="grant-reason">
                <span className="micro">Why they need it</span>
                <input
                  id="grant-reason"
                  className="input"
                  data-testid="grant-reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Covering the Felixstowe desk while Omar is on leave"
                />
              </label>
              <div className="row wrap">
                <button
                  className="btn btn-primary"
                  data-testid="grant-confirm"
                  disabled={busy || !userId || permission.trim().length < 5 || reason.trim().length < 12}
                  onClick={() =>
                    post({
                      action: 'grant',
                      userId,
                      permission: permission.trim(),
                      reason: reason.trim(),
                      expiresAt: expiresAt ? new Date(`${expiresAt}T12:00:00Z`).toISOString() : null,
                    })
                  }
                >
                  {busy ? 'Working…' : 'Grant it'}
                </button>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setAdding(false)}>
                  Cancel
                </button>
                <span className="small muted">Granting one asks for your password first.</span>
              </div>
            </div>
          ) : (
            <div className="row">
              <button className="btn" data-testid="grant-add" disabled={busy} onClick={() => setAdding(true)}>
                Grant an exception
              </button>
            </div>
          )
        ) : (
          <p className="small muted" style={{ margin: 0 }}>
            Granting an exception needs administrator access.
          </p>
        )}

        {past.length > 0 ? (
          <details data-testid="grants-past">
            <summary className="small secondary">
              {past.length} that {past.length === 1 ? 'has' : 'have'} ended
            </summary>
            <ul className="stack stack-2 small secondary" style={{ marginTop: 'var(--s-3)', paddingLeft: 'var(--s-6)' }}>
              {past.map((grant) => (
                <li key={grant.id}>
                  <span className="mono">{grant.permission}</span> — {grant.userName}
                  {grant.revokedAt
                    ? ` · taken off by ${grant.revokedByName ?? 'somebody since removed'}: ${grant.revokeReason ?? ''}`
                    : ` · ended ${grant.expiresAt?.slice(0, 10) ?? ''}`}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </section>
  )
}
