'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * What is on its way out, and the button that stops it (§5.7, ADR 0054).
 *
 * `send_email` has returned a `recallWindowSeconds` since Phase 2 and nothing could recall
 * anything: the window was a delay with no button behind it. This is the button.
 *
 * The countdown starts from the number the server rendered and only begins ticking after mount,
 * so the first client render matches the server's exactly. A clock that renders a different
 * second on each side is the hydration mismatch this product has already been bitten by once.
 */

export interface OutgoingRow {
  id: string
  subject: string | null
  toAddresses: string[]
  secondsLeft: number
  dispatching: boolean
  sentByName: string | null
  mine: boolean
}

export function OutgoingMail({ outgoing }: { outgoing: OutgoingRow[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reasonFor, setReasonFor] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  // Seconds elapsed since this component mounted, added to nothing until the first tick.
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (outgoing.length === 0) return
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [outgoing.length])

  // Once everything on the list has run out of window, ask the server what happened to it.
  useEffect(() => {
    if (outgoing.length === 0) return
    const longest = Math.max(...outgoing.map((row) => row.secondsLeft))
    if (elapsed > longest + 2) router.refresh()
  }, [elapsed, outgoing, router])

  if (outgoing.length === 0) return null

  async function recall(sendId: string) {
    setBusy(sendId)
    setError(null)
    const response = await fetch('/api/email-sends', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'recall', sendId, reason: reason.trim() }),
    })
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(null)
    if (!response.ok) {
      setError(payload.error)
      return
    }
    setReasonFor(null)
    setReason('')
    router.refresh()
  }

  return (
    <section className="panel" data-testid="outgoing-mail">
      <div className="panel-header">
        <h2>On its way out</h2>
        <span className="small muted">{outgoing.length}</span>
      </div>

      <div className="panel-body stack stack-4">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        <p className="prose small secondary" style={{ margin: 0 }} data-testid="outgoing-explainer">
          Approved email waits here before it leaves, so a change of mind still counts. Stopping
          one puts it back to a draft — sending it again needs approving again, because what was
          approved is the thing you no longer want sent. Once the send has begun it cannot be
          called back, and this says so rather than pretending.
        </p>

        <ul className="stack stack-3" style={{ margin: 0, paddingLeft: 0, listStyle: 'none' }}>
          {outgoing.map((row) => {
            const left = Math.max(0, row.secondsLeft - elapsed)
            // Once the window closes the dispatcher may take it at any moment — but until it
            // does, a person can still win. Hiding the button then would take away a stop that
            // would have worked; the label says what the odds are instead.
            const stoppable = !row.dispatching
            return (
              <li key={row.id} className="stack stack-2" data-testid="outgoing-row">
                <div className="row-tight wrap">
                  <strong>{row.subject ?? 'An email'}</strong>
                  <span className="small muted">to {row.toAddresses.join(', ') || 'nobody named'}</span>
                  {row.sentByName ? <span className="small muted">· {row.sentByName}</span> : null}
                </div>
                <div className="row-tight wrap">
                  <span className="mono small" data-testid="outgoing-countdown">
                    {row.dispatching
                      ? 'going out now'
                      : left > 0
                        ? `${left}s left`
                        : 'window closed — it goes on the next sweep'}
                  </span>
                  {stoppable && reasonFor !== row.id ? (
                    <button
                      className="btn btn-ghost small"
                      data-testid="outgoing-stop"
                      disabled={busy !== null}
                      onClick={() => {
                        setReasonFor(row.id)
                        setReason('')
                      }}
                    >
                      Stop it
                    </button>
                  ) : null}
                  {row.dispatching ? (
                    <span className="small muted" data-testid="outgoing-too-late">
                      Too late to stop — the send has begun.
                    </span>
                  ) : left === 0 ? (
                    <span className="small muted" data-testid="outgoing-closed">
                      The window has closed. Stopping it still works, but only until the send
                      begins.
                    </span>
                  ) : null}
                </div>
                {reasonFor === row.id ? (
                  <div className="stack stack-2" data-testid="outgoing-stop-editor">
                    <input
                      className="input"
                      aria-label={`Why “${row.subject ?? 'this email'}” is being stopped`}
                      data-testid="outgoing-reason"
                      value={reason}
                      onChange={(event) => setReason(event.target.value)}
                      placeholder="The figure in it is wrong"
                    />
                    <div className="row">
                      <button
                        className="btn btn-primary small"
                        data-testid="outgoing-stop-confirm"
                        disabled={busy !== null || reason.trim().length < 3}
                        onClick={() => recall(row.id)}
                      >
                        {busy === row.id ? 'Stopping…' : 'Stop it going'}
                      </button>
                      <button
                        className="btn btn-ghost small"
                        disabled={busy !== null}
                        onClick={() => setReasonFor(null)}
                      >
                        Leave it
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}
