'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Issuing and revoking keys. The secret is shown once, at creation, and the screen says so
 * before you create it rather than after you have lost it (§22.1).
 */
export function ApiKeyManager({
  scopes,
  keys,
}: {
  scopes: string[]
  keys: {
    id: string
    name: string
    prefix: string
    scopes: string[]
    principalName: string | null
    rateLimitPerMinute: number
    lastUsedAt: string | null
    revokedAt: string | null
    requestsLastDay: number
  }[]
}) {
  const router = useRouter()
  const [name, setName] = useState('')
  const [chosen, setChosen] = useState<string[]>(['tasks:read'])
  const [busy, setBusy] = useState(false)
  const [issued, setIssued] = useState<{ secret: string; name: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function create() {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, scopes: chosen }),
    })
    setBusy(false)
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: 'That could not be issued.' }))
      setError(body.error)
      return
    }
    const payload = await response.json()
    setIssued({ secret: payload.secret, name: payload.name })
    setName('')
    router.refresh()
  }

  async function revoke(keyId: string, keyName: string) {
    if (!window.confirm(`Revoke "${keyName}"? Anything using it stops working immediately.`)) return
    setBusy(true)
    await fetch('/api/keys', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ keyId }),
    })
    setBusy(false)
    router.refresh()
  }

  return (
    <div className="stack stack-6">
      {issued ? (
        <div className="banner banner-accent stack stack-2" data-testid="issued-key">
          <strong>Copy this now — it is not shown again.</strong>
          <code className="mono small" style={{ wordBreak: 'break-all' }}>
            {issued.secret}
          </code>
          <button className="btn btn-sm" onClick={() => setIssued(null)}>
            I have copied it
          </button>
        </div>
      ) : null}

      <section className="panel">
        <div className="panel-header">
          <h2>Keys</h2>
          <span className="small muted">{keys.filter((key) => !key.revokedAt).length} active</span>
        </div>
        {keys.length === 0 ? (
          <div className="empty small secondary">No keys yet.</div>
        ) : (
          <div className="panel-body-flush table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th style={{ width: 160 }}>Prefix</th>
                  <th>Scopes</th>
                  <th style={{ width: 140 }}>Acts as</th>
                  <th style={{ width: 120 }}>Calls (24h)</th>
                  <th style={{ width: 110 }}></th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id} data-testid="api-key-row">
                    <td className="small">
                      {key.name}
                      {key.revokedAt ? <span className="chip chip-critical" style={{ marginLeft: 8 }}>revoked</span> : null}
                    </td>
                    <td className="mono small secondary">{key.prefix}…</td>
                    <td className="small mono">{key.scopes.join(' ')}</td>
                    <td className="small secondary">{key.principalName ?? '—'}</td>
                    <td className="num">{key.requestsLastDay}</td>
                    <td>
                      {key.revokedAt ? null : (
                        <button className="btn btn-ghost btn-sm" onClick={() => revoke(key.id, key.name)} disabled={busy}>
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Issue a key</h2>
          <span className="small muted">It will act as you</span>
        </div>
        <div className="panel-body stack stack-4">
          <label className="stack stack-1">
            <span className="micro">Name — what is going to use it</span>
            <input
              className="input"
              value={name}
              placeholder="Warehouse dashboard"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <div className="stack stack-2">
            <span className="micro">Scopes</span>
            <div className="row wrap">
              {scopes.map((scope) => {
                const active = chosen.includes(scope)
                return (
                  <button
                    key={scope}
                    type="button"
                    className={`chip${active ? ' chip-accent' : ''}`}
                    style={{ cursor: 'pointer', border: '1px solid var(--hairline)' }}
                    onClick={() =>
                      setChosen(active ? chosen.filter((value) => value !== scope) : [...chosen, scope])
                    }
                  >
                    {scope}
                  </button>
                )
              })}
            </div>
          </div>
          {error ? <div className="banner banner-critical">{error}</div> : null}
          <div className="row">
            <button
              className="btn btn-primary"
              onClick={create}
              disabled={busy || !name.trim() || chosen.length === 0}
              data-testid="issue-key"
            >
              {busy ? 'Issuing…' : 'Issue key'}
            </button>
            <span className="small muted">The secret is shown once and stored only as a hash.</span>
          </div>
        </div>
      </section>
    </div>
  )
}
