'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface CommitmentState {
  id: string
  obligation: string
  direction: string
  status: string
  ownerName: string | null
  companyName: string | null
  dueAt: string | null
  confidence: number | null
  sourceExcerpt: string | null
  isMine: boolean
}

/**
 * "I need more time", "this is blocked" and "this isn't mine" are all first-class,
 * non-penalized answers that stop the chasing (§29.2).
 */
export function CommitmentRow({ commitment }: { commitment: CommitmentState }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'idle' | 'renegotiate' | 'dispute'>('idle')
  const [newDate, setNewDate] = useState('')
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function respond(response: string, extra: Record<string, unknown> = {}) {
    setBusy(true)
    setError(null)
    const result = await fetch(`/api/commitments/${commitment.id}/respond`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ response, ...extra }),
    })
    setBusy(false)
    if (!result.ok) {
      const body = await result.json().catch(() => ({ error: 'That could not be recorded.' }))
      setError(body.error)
      return
    }
    setMode('idle')
    router.refresh()
  }

  const proposed = commitment.status === 'proposed'

  return (
    <article className="panel">
      <div className="panel-body stack stack-4">
        <div className="spread">
          <span className="small">{commitment.obligation}</span>
          <div className="row-tight">
            <span className="chip">{commitment.direction === 'we_owe' ? 'we owe' : 'they owe'}</span>
            {commitment.companyName ? <span className="chip">{commitment.companyName}</span> : null}
            <span
              className={
                proposed
                  ? 'chip chip-attention'
                  : commitment.status === 'kept'
                    ? 'chip chip-positive'
                    : commitment.status === 'renegotiated'
                      ? 'chip chip-positive'
                      : commitment.status === 'disputed'
                        ? 'chip chip-critical'
                        : 'chip'
              }
            >
              {proposed ? 'needs confirmation' : commitment.status}
            </span>
          </div>
        </div>

        <div className="row wrap small muted">
          <span>owner {commitment.ownerName ?? 'not identified'}</span>
          {commitment.dueAt ? <span>due {commitment.dueAt.slice(0, 10)}</span> : <span>no date</span>}
          {commitment.confidence !== null ? <span>confidence {(commitment.confidence * 100).toFixed(0)}%</span> : null}
        </div>

        {commitment.sourceExcerpt ? (
          <details>
            <summary className="small" style={{ cursor: 'pointer', color: 'var(--ink-secondary)' }}>
              What was actually said
            </summary>
            <p className="small secondary" style={{ marginTop: 'var(--s-3)' }}>
              &ldquo;{commitment.sourceExcerpt}&rdquo;
            </p>
          </details>
        ) : null}

        {error ? <div className="banner banner-critical">{error}</div> : null}

        {mode === 'renegotiate' ? (
          <div className="stack stack-3">
            <label className="stack stack-2">
              <span className="micro">New date</span>
              <input className="input" type="date" value={newDate} onChange={(e) => setNewDate(e.target.value)} />
            </label>
            <label className="stack stack-2">
              <span className="micro">Why (optional — it travels with the item)</span>
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <div className="row">
              <button
                className="btn btn-primary btn-sm"
                disabled={busy || !newDate}
                onClick={() => respond('renegotiate', { newDueAt: new Date(`${newDate}T17:00:00Z`).toISOString(), reason })}
              >
                Set the new date
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setMode('idle')}>
                Cancel
              </button>
            </div>
            <span className="small muted">
              Moving a date in advance is recorded as renegotiated, not missed.
            </span>
          </div>
        ) : mode === 'dispute' ? (
          <div className="stack stack-3">
            <label className="stack stack-2">
              <span className="micro">Why is this not yours?</span>
              <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
            </label>
            <div className="row">
              <button className="btn btn-sm" disabled={busy || !reason.trim()} onClick={() => respond('dispute', { reason })}>
                Record the dispute
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setMode('idle')}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="row wrap">
            {proposed ? (
              <button className="btn btn-primary btn-sm" disabled={busy || !commitment.isMine} onClick={() => respond('confirm')}>
                {commitment.isMine ? 'Yes, that is mine' : 'Only the owner can confirm'}
              </button>
            ) : (
              <button className="btn btn-sm" disabled={busy} onClick={() => respond('complete')}>
                Done
              </button>
            )}
            <button className="btn btn-sm" disabled={busy} onClick={() => setMode('renegotiate')}>
              I need more time
            </button>
            <button className="btn btn-sm" disabled={busy} onClick={() => setMode('dispute')}>
              This is not mine
            </button>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => respond('cancel')}>
              No longer needed
            </button>
          </div>
        )}
      </div>
    </article>
  )
}
