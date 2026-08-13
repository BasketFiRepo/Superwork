'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * One capability. Connecting runs a real health check against the resolved provider and
 * stores what it said — the row never claims a state it has not observed (§13.3).
 */
export function ConnectionRow({
  capability,
  label,
  degradesTo,
  vendorHint,
  mode,
  connection,
}: {
  capability: string
  label: string
  degradesTo: string
  vendorHint: string
  mode: string
  connection: {
    status: string
    vendor: string
    mode: string
    connectedByName: string | null
    lastSyncAt: string | null
    lastError: string | null
    health: { ok?: boolean; message?: string; checkedAt?: string }
    scopes: string[]
  } | null
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function act(action: 'connect' | 'test' | 'disconnect') {
    const reason = action === 'disconnect' ? window.prompt(`Why disconnect ${label}? ${degradesTo}`) : null
    if (action === 'disconnect' && !reason) return
    setBusy(action)
    setError(null)
    const response = await fetch('/api/integrations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ capability, action, reason }),
    })
    setBusy(null)
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: 'That did not work.' }))
      setError(body.error)
      return
    }
    router.refresh()
  }

  const connected = connection?.status === 'connected' || connection?.status === 'degraded'

  return (
    <div className="panel-body hairline-top spread" data-testid="connection-row">
      <div className="stack stack-2" style={{ minWidth: 0 }}>
        <div className="row-tight">
          <strong className="small">{label}</strong>
          {connected ? (
            <span className={`chip${connection?.status === 'degraded' ? ' chip-attention' : ' chip-positive'}`}>
              {connection?.status}
            </span>
          ) : (
            <span className="chip">not connected</span>
          )}
          <span className="chip chip-accent">{connection?.mode ?? mode}</span>
        </div>
        <span className="small muted">{vendorHint}</span>
        {connected ? (
          <span className="small secondary">
            {connection?.health?.message ?? 'No health check recorded yet.'}
            {connection?.connectedByName ? ` · connected by ${connection.connectedByName}` : ''}
            {connection?.lastSyncAt ? ` · last checked ${connection.lastSyncAt.slice(0, 16).replace('T', ' ')}` : ''}
          </span>
        ) : (
          <span className="small secondary">Without it: {degradesTo}</span>
        )}
        {connection?.lastError ? <span className="small" style={{ color: 'var(--critical)' }}>{connection.lastError}</span> : null}
        {error ? <span className="small" style={{ color: 'var(--critical)' }}>{error}</span> : null}
      </div>

      <div className="row-tight">
        {connected ? (
          <>
            <button className="btn btn-sm" onClick={() => act('test')} disabled={busy !== null}>
              {busy === 'test' ? 'Checking…' : 'Check health'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => act('disconnect')} disabled={busy !== null}>
              Disconnect
            </button>
          </>
        ) : (
          <button className="btn btn-sm" onClick={() => act('connect')} disabled={busy !== null}>
            {busy === 'connect' ? 'Connecting…' : 'Connect simulated'}
          </button>
        )}
      </div>
    </div>
  )
}
