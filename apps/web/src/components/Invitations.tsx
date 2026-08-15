'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Invitations (§4.1, §23.2).
 *
 * The link is shown once, on the screen that created it, and never again — the database has
 * a hash and not the token. That is the same contract as an API key, and the screen says so
 * rather than letting somebody discover it by coming back tomorrow.
 *
 * Nothing is emailed. No provider in this product calls out of the process, so the honest
 * thing is to hand the link over and say whose job it is to deliver it.
 */

export interface InvitationRow {
  id: string
  email: string
  role: string
  departmentName: string | null
  reason: string | null
  invitedByName: string | null
  expiresAt: string
  acceptedUserName: string | null
  revokedByName: string | null
  revokedReason: string | null
  state: 'pending' | 'accepted' | 'revoked' | 'expired'
}

export interface DepartmentOption {
  id: string
  name: string
}

const ROLES = [
  { id: 'member', label: 'Member — creates and does the work' },
  { id: 'manager', label: 'Manager — decides for their department' },
  { id: 'admin', label: 'Admin — configures the organization' },
  { id: 'viewer', label: 'Viewer — reads, changes nothing' },
  { id: 'guest', label: 'Guest — one team’s work only' },
]

const STATE_CHIP: Record<InvitationRow['state'], string> = {
  pending: 'chip',
  accepted: 'chip chip-positive',
  revoked: 'chip',
  expired: 'chip chip-attention',
}

export function Invitations({
  invitations,
  departments,
  maxRole,
}: {
  invitations: InvitationRow[]
  departments: DepartmentOption[]
  /** Roles above the signed-in person's are not offered — the API refuses them anyway. */
  maxRole: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [issued, setIssued] = useState<{ email: string; link: string } | null>(null)

  const [adding, setAdding] = useState(false)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('member')
  const [department, setDepartment] = useState('')
  const [reason, setReason] = useState('')

  const [revoking, setRevoking] = useState<string | null>(null)
  const [revokeReason, setRevokeReason] = useState('')

  const rank = ['guest', 'viewer', 'member', 'manager', 'admin', 'owner']
  const offered = ROLES.filter((option) => rank.indexOf(option.id) <= rank.indexOf(maxRole))

  async function post(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/invitations', {
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
    if (payload.token) {
      setIssued({ email: String(body['email']), link: `${window.location.origin}/invite/${payload.token}` })
    }
    setAdding(false)
    setRevoking(null)
    setEmail('')
    setReason('')
    setRevokeReason('')
    router.refresh()
  }

  const open = invitations.filter((row) => row.state === 'pending')

  return (
    <div className="stack stack-8">
      {error ? (
        <div className="banner banner-critical" role="alert">
          {error}
        </div>
      ) : null}

      {issued ? (
        <div className="banner banner-positive" data-testid="invitation-link">
          <div className="stack stack-3">
            <strong>The link for {issued.email} — copy it now</strong>
            <code className="mono small" style={{ wordBreak: 'break-all' }}>
              {issued.link}
            </code>
            <span className="small">
              This is shown once. Superwork stores a hash of it, so there is no screen that can
              show it again — if it is lost, withdraw the invitation and send another.{' '}
              <strong>Nothing was emailed.</strong> No part of this product calls out of the
              process, so delivering this is your job.
            </span>
            <div className="row">
              <button className="btn btn-sm" onClick={() => setIssued(null)}>
                I have copied it
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <section className="panel" data-testid="invitations">
        <div className="panel-header">
          <h2>Invitations</h2>
          <span className="small muted">
            {open.length === 0 ? 'None outstanding' : `${open.length} outstanding`}
          </span>
        </div>

        {invitations.length === 0 ? (
          <div className="panel-body">
            <div className="empty small secondary">
              Nobody has been invited. Until now there was no way to add a person to an
              organization at all except the seed or a directory sync.
            </div>
          </div>
        ) : (
          <div className="panel-body-flush table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Who</th>
                  <th style={{ width: 110 }}>As</th>
                  <th style={{ width: 110 }}>State</th>
                  <th>Why, and who sent it</th>
                  <th style={{ width: 100 }} />
                </tr>
              </thead>
              <tbody>
                {invitations.map((row) => (
                  <tr
                    key={row.id}
                    data-testid="invitation-row"
                    style={row.state === 'pending' ? undefined : { opacity: 0.6 }}
                  >
                    <td className="mono small">{row.email}</td>
                    <td className="small secondary">{row.role}</td>
                    <td>
                      <span className={STATE_CHIP[row.state]}>{row.state}</span>
                      {row.state === 'pending' ? (
                        <div className="small muted">until {row.expiresAt.slice(0, 10)}</div>
                      ) : null}
                    </td>
                    <td className="small secondary">
                      {row.state === 'revoked' ? row.revokedReason : row.reason}
                      <div className="small muted">
                        {row.state === 'accepted'
                          ? `now ${row.acceptedUserName}`
                          : row.state === 'revoked'
                            ? `withdrawn by ${row.revokedByName}`
                            : (row.invitedByName ?? 'unknown')}
                      </div>
                    </td>
                    <td>
                      {row.state === 'pending' ? (
                        <button
                          className="btn btn-ghost small"
                          data-testid="invitation-revoke"
                          disabled={busy}
                          onClick={() => {
                            setRevoking(revoking === row.id ? null : row.id)
                            setRevokeReason('')
                            setError(null)
                          }}
                        >
                          Withdraw
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {revoking ? (
          <div className="panel-body hairline-top stack stack-4" data-testid="invitation-revoke-editor">
            <label className="stack stack-2" htmlFor="revoke-reason">
              <span className="micro">Why is this being withdrawn?</span>
              <input
                id="revoke-reason"
                className="input"
                value={revokeReason}
                onChange={(event) => setRevokeReason(event.target.value)}
                placeholder="They are not joining after all."
              />
            </label>
            <p className="small muted" style={{ margin: 0 }}>
              The link stops working immediately. The invitation is kept, not deleted — &ldquo;who
              invited that contractor and who called it off&rdquo; is a question an access review
              asks.
            </p>
            <div className="row">
              <button
                className="btn btn-primary"
                data-testid="invitation-revoke-confirm"
                disabled={busy || revokeReason.trim().length < 6}
                onClick={() => post({ action: 'revoke', invitationId: revoking, reason: revokeReason })}
              >
                Withdraw it
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setRevoking(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Invite somebody</h2>
          <span className="small muted">you cannot invite above your own role</span>
        </div>
        {adding ? (
          <div className="panel-body stack stack-4" data-testid="invitation-editor">
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <label className="stack stack-2" style={{ flex: '2 1 280px' }} htmlFor="invite-email">
                <span className="micro">Their email</span>
                <input
                  id="invite-email"
                  className="input"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="jordan@northwind.example"
                />
              </label>
              <label className="stack stack-2" style={{ flex: '1 1 260px' }} htmlFor="invite-role">
                <span className="micro">Joining as</span>
                <select
                  id="invite-role"
                  className="select"
                  value={role}
                  onChange={(event) => setRole(event.target.value)}
                >
                  {offered.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {departments.length > 0 ? (
              <label className="stack stack-2" style={{ maxWidth: 320 }} htmlFor="invite-department">
                <span className="micro">Department (optional)</span>
                <select
                  id="invite-department"
                  className="select"
                  value={department}
                  onChange={(event) => setDepartment(event.target.value)}
                >
                  <option value="">None</option>
                  {departments.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            <label className="stack stack-2" htmlFor="invite-reason">
              <span className="micro">Why do they need access?</span>
              <input
                id="invite-reason"
                className="input"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Joining the renewals team on Monday."
              />
            </label>

            <p className="small muted" style={{ margin: 0 }}>
              The link lasts 14 days, works once, and can be withdrawn before it is used.
            </p>

            <div className="row">
              <button
                className="btn btn-primary"
                data-testid="invitation-send"
                disabled={busy || !email.includes('@') || reason.trim().length < 6}
                onClick={() =>
                  post({
                    action: 'invite',
                    email,
                    role,
                    departmentId: department || null,
                    reason,
                  })
                }
              >
                Create the link
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
              data-testid="invitation-add"
              disabled={busy}
              onClick={() => {
                setAdding(true)
                setError(null)
              }}
            >
              Invite somebody
            </button>
          </div>
        )}
      </section>
    </div>
  )
}
