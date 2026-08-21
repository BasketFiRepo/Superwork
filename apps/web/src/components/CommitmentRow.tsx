'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Link } from '@/components/Link'

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
  /** The work that discharges it, if anybody has made any (ADR 0066). */
  taskId: string | null
  taskTitle: string | null
  taskStatus: string | null
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

  async function plan() {
    setBusy(true)
    setError(null)
    const result = await fetch(`/api/commitments/${commitment.id}/task`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    setBusy(false)
    if (!result.ok) {
      const body = await result.json().catch(() => ({ error: 'That could not be recorded.' }))
      setError(body.error)
      return
    }
    router.refresh()
  }

  const proposed = commitment.status === 'proposed'
  // A promise they made is discharged by them, so there is nothing here for us to plan.
  const ours = commitment.direction === 'we_owe'
  const outstanding = commitment.status === 'confirmed'
  const hasWork = commitment.taskTitle !== null

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

        {commitment.taskId ? (
          <p className="small secondary prose" style={{ margin: 0 }} data-testid="commitment-task">
            {hasWork ? (
              <>
                The work for this is{' '}
                <Link href={`/tasks/${commitment.taskId}`}>
                  <strong>{commitment.taskTitle}</strong>
                </Link>
                {commitment.taskStatus === 'completed'
                  ? ' — finished, which is what marked this kept.'
                  : ` — ${commitment.taskStatus?.replace(/_/g, ' ')}. Finishing it marks this kept.`}
              </>
            ) : (
              <>The task for this has been deleted. The promise stands.</>
            )}
          </p>
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
            ) : hasWork ? (
              <span className="small muted" data-testid="commitment-done-elsewhere">
                Finished on the task, not here.
              </span>
            ) : (
              <button className="btn btn-sm" disabled={busy} onClick={() => respond('complete')}>
                Done
              </button>
            )}
            {ours && outstanding && !hasWork ? (
              <button
                className="btn btn-sm"
                data-testid="commitment-plan"
                disabled={busy}
                onClick={plan}
              >
                {busy ? 'Saving…' : 'Make this a task'}
              </button>
            ) : null}
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
