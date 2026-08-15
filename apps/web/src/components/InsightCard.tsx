'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * An insight with no evidence must not render; one with no recommended action is noise
 * (§9.2). Dismissing asks *why*, and the answer is read: a watcher people call wrong stops
 * running, one people had already handled is re-timed instead (ADR 0031). The four answers
 * are not four ways of saying the same thing, so the question does not lead with one.
 */

export interface InsightView {
  id: string
  title: string
  body: string
  severity: string
  watcher: string
  status: string
  evidence: { claim: string }[]
  recommendedActions: { label: string; tool: string; args: Record<string, unknown> }[]
  createdAt: string
}

const DISMISS_REASONS = [
  { id: 'not_useful', label: 'Not useful' },
  { id: 'wrong', label: 'Wrong' },
  { id: 'already_handled', label: 'Already handled' },
  { id: 'not_my_job', label: 'Not my job' },
] as const

export function InsightCard({ insight }: { insight: InsightView }) {
  const router = useRouter()
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  /** Set when a dismissal was refused for permission — the rating alone is still allowed. */
  const [refusedReason, setRefusedReason] = useState<string | null>(null)

  if (insight.evidence.length === 0 || insight.recommendedActions.length === 0) return null

  const severityChip =
    insight.severity === 'critical' || insight.severity === 'high' ? 'chip chip-attention' : 'chip'

  async function send(body: Record<string, unknown>) {
    setBusy(true)
    const response = await fetch(`/api/insights/${insight.id}/feedback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    setBusy(false)
    setAsking(false)
    if (response.ok) {
      setRefusedReason(null)
      router.refresh()
      return
    }
    // The server's words, not a shrug. When dismissing is refused for permission it says so
    // and says the rating on its own would be accepted — so offer exactly that, rather than
    // quietly sending something different from what was pressed.
    const payload = await response.json().catch(() => ({ error: 'That could not be saved. Try again.' }))
    setNote(payload.error ?? 'That could not be saved. Try again.')
    setRefusedReason(
      payload.failureClass === 'permission' && body['status'] ? String(body['reason'] ?? '') : null,
    )
  }

  async function act(action: InsightView['recommendedActions'][number]) {
    if (action.tool === 'navigate') {
      router.push(String(action.args['route'] ?? '/'))
      return
    }
    setBusy(true)
    const response = await fetch('/api/agent/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: String(action.args['request'] ?? action.label),
        mode: String(action.args['mode'] ?? 'execute'),
        uiContext: { route: '/insights', insightId: insight.id },
      }),
    })
    setBusy(false)
    if (response.ok) {
      await send({ helpful: true, status: 'in_progress' })
      setNote('Started. Watch the agent rail — the plan will need your approval before anything changes.')
    } else {
      const body = await response.json().catch(() => ({ error: 'That could not be started.' }))
      setNote(body.error)
    }
  }

  return (
    <article className="panel">
      <div className="panel-header">
        <div className="row-tight">
          <span className={severityChip}>{insight.severity}</span>
          <h3>{insight.title}</h3>
        </div>
        <span className="small muted mono">{insight.watcher.replace(/_/g, ' ')}</span>
      </div>

      <div className="panel-body stack stack-5">
        <pre
          className="small secondary"
          style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: 0 }}
        >
          {insight.body}
        </pre>

        <details>
          <summary className="small" style={{ cursor: 'pointer', color: 'var(--ink-secondary)' }}>
            Why this was raised — {insight.evidence.length} {insight.evidence.length === 1 ? 'piece' : 'pieces'} of evidence
          </summary>
          <ul className="stack stack-2 small secondary" style={{ margin: 'var(--s-4) 0 0', paddingLeft: 'var(--s-7)' }}>
            {insight.evidence.map((item, index) => (
              <li key={index}>{item.claim}</li>
            ))}
          </ul>
        </details>

        {note ? <div className="banner banner-accent">{note}</div> : null}

        {refusedReason ? (
          <div className="row wrap" data-testid="insight-rating-only">
            <button
              className="btn btn-sm"
              disabled={busy}
              onClick={() => send({ helpful: false, reason: refusedReason })}
            >
              Record what I said, without dismissing it
            </button>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setRefusedReason(null)}>
              Leave it
            </button>
          </div>
        ) : null}

        {asking ? (
          <div className="stack stack-4">
            <span className="micro">Why are you dismissing this?</span>
            <span className="small muted">
              Read, not filed: &ldquo;wrong&rdquo; and &ldquo;not useful&rdquo; count against the
              watcher, &ldquo;already handled&rdquo; means it was right and slow, and &ldquo;not my
              job&rdquo; means it reached the wrong person.
            </span>
            <div className="row wrap">
              {DISMISS_REASONS.map((reason) => (
                <button
                  key={reason.id}
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => send({ helpful: false, reason: reason.id, status: 'dismissed' })}
                >
                  {reason.label}
                </button>
              ))}
              <button className="btn btn-ghost btn-sm" onClick={() => setAsking(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="row wrap">
            {insight.recommendedActions.map((action) => (
              <button key={action.label} className="btn btn-primary btn-sm" disabled={busy} onClick={() => act(action)}>
                {action.label}
              </button>
            ))}
            <button className="btn btn-sm" disabled={busy} onClick={() => send({ helpful: true, status: 'acknowledged' })}>
              Acknowledge
            </button>
            <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => setAsking(true)}>
              Dismiss
            </button>
          </div>
        )}
      </div>
    </article>
  )
}
