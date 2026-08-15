'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Follow-ups on a thread (§13).
 *
 * `create_follow_up@v1` says it records a follow-up "so it resurfaces if no reply arrives".
 * It never resurfaced: nothing read the table and no worker swept it, so every follow-up the
 * agent had recorded was still open and invisible.
 *
 * One is closed automatically when the customer writes back — being chased about a thread
 * that has already been answered is how people learn to ignore a product — and what is left
 * tells its owner when it comes due. Nothing is sent outward: drafting the reply is still a
 * person's act.
 */

export interface FollowUpRow {
  id: string
  dueAt: string
  reason: string | null
  ownerName: string | null
  status: 'open' | 'done' | 'cancelled'
  resolution: string | null
  resolutionNote: string | null
  resolvedByName: string | null
  due: boolean
  byAgent: boolean
}

const RESOLUTION_LABEL: Record<string, string> = {
  done: 'dealt with',
  cancelled: 'called off',
  replied: 'closed itself — they wrote back',
}

export function FollowUps({
  conversationId,
  followUps,
}: {
  conversationId: string
  followUps: FollowUpRow[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [dueOn, setDueOn] = useState('')
  const [reason, setReason] = useState('')

  async function post(payload: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/follow-ups', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const result = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(false)
    if (!response.ok) {
      setError(result.error)
      return
    }
    setAdding(false)
    setDueOn('')
    setReason('')
    router.refresh()
  }

  const open = followUps.filter((row) => row.status === 'open')
  const closed = followUps.filter((row) => row.status !== 'open')

  return (
    <section className="panel" data-testid="follow-ups">
      <div className="panel-header">
        <h2>Follow-ups</h2>
        <span className="small muted">{open.length === 0 ? 'None open' : `${open.length} open`}</span>
      </div>

      <div className="panel-body stack stack-4">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        {open.length === 0 && closed.length === 0 ? (
          <div className="empty small secondary">
            Nothing is set on this thread. A follow-up resurfaces on the day you choose, and closes
            itself if they write back first.
          </div>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 130 }}>When</th>
                  <th>What for</th>
                  <th style={{ width: 150 }}>Whose</th>
                  <th style={{ width: 170 }} />
                </tr>
              </thead>
              <tbody>
                {[...open, ...closed].map((row) => (
                  <tr key={row.id} data-testid="follow-up-row" style={row.status !== 'open' ? { opacity: 0.6 } : undefined}>
                    <td className="small secondary">
                      {row.dueAt.slice(0, 10)}
                      {row.due && row.status === 'open' ? (
                        <div>
                          <span className="chip chip-attention">due</span>
                        </div>
                      ) : null}
                    </td>
                    <td className="small secondary">
                      {row.reason ?? '—'}
                      {row.byAgent ? <div className="small muted">recorded by the assistant</div> : null}
                      {row.resolution ? (
                        <div className="small muted">
                          {RESOLUTION_LABEL[row.resolution] ?? row.resolution}
                          {row.resolvedByName ? ` · ${row.resolvedByName}` : ''}
                          {row.resolutionNote ? ` · ${row.resolutionNote}` : ''}
                        </div>
                      ) : null}
                    </td>
                    <td className="small secondary">{row.ownerName ?? 'nobody'}</td>
                    <td>
                      {row.status === 'open' ? (
                        <div className="row-tight">
                          <button
                            className="btn btn-ghost small"
                            data-testid="follow-up-done"
                            disabled={busy}
                            onClick={() => post({ action: 'resolve', id: row.id, resolution: 'done' })}
                          >
                            Dealt with
                          </button>
                          <button
                            className="btn btn-ghost small"
                            disabled={busy}
                            onClick={() => post({ action: 'resolve', id: row.id, resolution: 'cancelled' })}
                          >
                            Call it off
                          </button>
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {adding ? (
          <div className="stack stack-3" data-testid="follow-up-editor">
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <label className="stack stack-2" style={{ flex: '0 0 200px' }} htmlFor="follow-up-due">
                <span className="micro">Come back to it on</span>
                <input
                  id="follow-up-due"
                  className="input"
                  type="date"
                  value={dueOn}
                  onChange={(event) => setDueOn(event.target.value)}
                />
              </label>
              <label className="stack stack-2" style={{ flex: '1 1 240px' }} htmlFor="follow-up-reason">
                <span className="micro">What for</span>
                <input
                  id="follow-up-reason"
                  className="input"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Chase the signed addendum if they have not sent it."
                />
              </label>
            </div>
            <div className="row wrap">
              <button
                className="btn btn-primary"
                data-testid="follow-up-confirm"
                disabled={busy || !dueOn || reason.trim().length < 4}
                onClick={() => post({ action: 'create', conversationId, dueOn, reason: reason.trim() })}
              >
                {busy ? 'Saving…' : 'Set the follow-up'}
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="row">
            <button className="btn" data-testid="follow-up-add" disabled={busy} onClick={() => setAdding(true)}>
              Set a follow-up
            </button>
          </div>
        )}

        <p className="small muted" style={{ margin: 0 }}>
          A follow-up coming due tells you and nobody else. Nothing is sent to the customer —
          replying is still something you do.
        </p>
      </div>
    </section>
  )
}
