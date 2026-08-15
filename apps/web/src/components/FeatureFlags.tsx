'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Feature flags (§2.3).
 *
 * Two layers, shown as two layers rather than as one toggle that mysteriously disagrees
 * with what you set. A flag that currently controls nothing says so and offers no switch,
 * because a control that changes nothing is worse than an absent one — somebody will use it
 * and believe it worked.
 */

export interface FlagRow {
  flag: string
  label: string
  controls: string
  defaultValue: boolean
  organizationValue: boolean | null
  userValue: boolean | null
  effective: boolean
  source: 'default' | 'organization' | 'you'
  reason: string | null
  setByName: string | null
}

const SOURCE: Record<FlagRow['source'], string> = {
  default: 'the default',
  organization: 'this organization',
  you: 'you',
}

export function FeatureFlags({ flags, canAdmin }: { flags: FlagRow[]; canAdmin: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [next, setNext] = useState(false)

  async function post(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/flags', {
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
    setEditing(null)
    setReason('')
    router.refresh()
  }

  const live = flags.filter((flag) => flag.controls)
  const inert = flags.filter((flag) => !flag.controls)

  return (
    <div className="stack stack-8">
      {error ? (
        <div className="banner banner-critical" role="alert">
          {error}
        </div>
      ) : null}

      <section className="panel" data-testid="flags">
        <div className="panel-header">
          <h2>Features</h2>
          <span className="small muted">Default, then the organization, then you</span>
        </div>
        <div className="panel-body-flush table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Feature</th>
                <th style={{ width: 110 }}>In force</th>
                <th style={{ width: 150 }}>Set by</th>
                <th>What it changes</th>
                <th style={{ width: 200 }} />
              </tr>
            </thead>
            <tbody>
              {live.map((flag) => (
                <tr key={flag.flag} data-testid="flag-row">
                  <td>{flag.label}</td>
                  <td>
                    <span className={flag.effective ? 'chip chip-positive' : 'chip'}>
                      {flag.effective ? 'on' : 'off'}
                    </span>
                  </td>
                  <td className="small secondary">
                    {SOURCE[flag.source]}
                    {flag.setByName ? <div className="small muted">{flag.setByName}</div> : null}
                    {flag.reason ? <div className="small muted">{flag.reason}</div> : null}
                  </td>
                  <td className="small secondary">{flag.controls}</td>
                  <td>
                    <div className="row">
                      <button
                        className="btn btn-ghost small"
                        data-testid="flag-set-me"
                        disabled={busy}
                        onClick={() =>
                          post({ action: 'set', flag: flag.flag, enabled: !flag.effective, scope: 'user' })
                        }
                      >
                        {flag.effective ? 'Off for me' : 'On for me'}
                      </button>
                      {canAdmin ? (
                        <button
                          className="btn btn-ghost small"
                          data-testid="flag-set-org"
                          disabled={busy}
                          onClick={() => {
                            setEditing(editing === flag.flag ? null : flag.flag)
                            setNext(!(flag.organizationValue ?? flag.defaultValue))
                            setReason('')
                            setError(null)
                          }}
                        >
                          For everybody
                        </button>
                      ) : null}
                      {flag.userValue !== null ? (
                        <button
                          className="btn btn-ghost small"
                          data-testid="flag-clear-me"
                          disabled={busy}
                          onClick={() => post({ action: 'clear', flag: flag.flag, scope: 'user' })}
                        >
                          reset
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {editing ? (
          <div className="panel-body stack stack-4" data-testid="flag-editor">
            <p className="prose small" style={{ margin: 0 }}>
              Turning <strong>{flags.find((flag) => flag.flag === editing)?.label}</strong>{' '}
              <strong>{next ? 'on' : 'off'}</strong> for everybody in this organization. Anybody who has
              set it for themselves keeps their own choice — the person layer sits on top.
            </p>
            <label className="stack stack-2" htmlFor="flag-reason">
              <span className="micro">Why does this organization differ?</span>
              <input
                id="flag-reason"
                className="input"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Works council has not signed off on meeting transcription yet."
              />
            </label>
            <div className="row">
              <button
                className="btn btn-primary"
                data-testid="flag-org-confirm"
                disabled={busy || reason.trim().length < 4}
                onClick={() => post({ action: 'set', flag: editing, enabled: next, scope: 'organization', reason })}
              >
                {next ? 'Turn it on for everybody' : 'Turn it off for everybody'}
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </section>

      {inert.length > 0 ? (
        <section className="panel" data-testid="flags-inert">
          <div className="panel-header">
            <h2>Declared, but controlling nothing yet</h2>
            <span className="small muted">No switch, because there is nothing behind it</span>
          </div>
          <div className="panel-body stack stack-3">
            <p className="prose small secondary" style={{ margin: 0 }}>
              These names exist in the flag set and nothing reads them. They are listed rather than
              hidden so nobody goes looking for the screen they are named after — and no switch is
              offered, because a control that changes nothing is worse than one that is missing.
            </p>
            <div className="row wrap">
              {inert.map((flag) => (
                <span className="chip" key={flag.flag} data-testid="flag-inert">
                  {flag.label}
                </span>
              ))}
            </div>
          </div>
        </section>
      ) : null}
    </div>
  )
}
