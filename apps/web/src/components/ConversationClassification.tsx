'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useStepUp } from './StepUp'

/**
 * How far a thread of correspondence may travel (§4.3, ADR 0061).
 *
 * `conversations.sensitivity` has carried `internal` since Phase 0, written by nothing and read
 * by nothing: no repository put it in the resource the policy engine checks, so it decided
 * nothing. Every member holds `conversation:read:org`, so every member read every thread in the
 * organization — and a thread with a customer's pricing, or somebody's grievance, could not be
 * marked as anything else.
 */

const LEVELS = ['public', 'internal', 'confidential', 'restricted'] as const
const RANK: Record<string, number> = { public: 0, internal: 1, confidential: 2, restricted: 3 }

/** Who a level actually reaches, in the roles this product has. */
const REACH: Record<string, string> = {
  public: 'everybody here, including guests from outside',
  internal: 'everybody with an account here',
  confidential: 'managers, administrators and the owner',
  restricted: 'administrators and the owner',
}

export function ConversationClassification({
  conversationId,
  sensitivity,
  source,
  setByName,
  setAt,
  reason,
}: {
  conversationId: string
  sensitivity: string
  source: 'unset' | 'human'
  setByName: string | null
  setAt: string | null
  reason: string | null
}) {
  const router = useRouter()
  const stepUp = useStepUp()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [level, setLevel] = useState(sensitivity)
  const [why, setWhy] = useState('')

  const lowering = RANK[level]! < RANK[sensitivity]!

  async function save() {
    setBusy(true)
    setError(null)
    const send = () =>
      fetch('/api/conversation-classification', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ conversationId, sensitivity: level, reason: why.trim() }),
      })
    const response = lowering ? await stepUp.run(send) : await send()
    setBusy(false)
    if (!response) return
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    if (!response.ok) {
      setError(payload.error)
      return
    }
    setEditing(false)
    setWhy('')
    router.refresh()
  }

  return (
    <section className="panel" data-testid="conversation-classification">
      {/* Asked for beside the thing it protects, not at the top of the page. */}
      {stepUp.prompt}

      <div className="panel-header">
        <h2>Who can read this</h2>
        <span className="small muted" data-testid="classification-level">
          {sensitivity} · {source === 'human' ? 'decided by a person' : 'nobody has said'}
        </span>
      </div>

      <div className="panel-body stack stack-3">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        <p className="small secondary" style={{ margin: 0 }} data-testid="classification-summary">
          {source === 'human' ? (
            <>
              <strong>{setByName ?? 'Somebody'}</strong> set this to <strong>{sensitivity}</strong> on{' '}
              {setAt?.slice(0, 10)}. {reason} It reaches {REACH[sensitivity]}.
            </>
          ) : (
            <>
              Nobody has classified this thread, so it sits at <strong>internal</strong> — the
              default, not a decision. That reaches {REACH['internal']}. A thread carrying a
              customer&rsquo;s pricing, or something somebody said in confidence, should say so.
            </>
          )}
        </p>

        {editing ? (
          <div className="stack stack-3" data-testid="classification-editor">
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <label className="stack stack-2" style={{ flex: '0 0 180px' }} htmlFor="conversation-level">
                <span className="micro">Set it to</span>
                <select
                  id="conversation-level"
                  className="input"
                  value={level}
                  onChange={(event) => setLevel(event.target.value)}
                >
                  {LEVELS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label className="stack stack-2" style={{ flex: '1 1 260px' }} htmlFor="conversation-reason">
                <span className="micro">Why</span>
                <input
                  id="conversation-reason"
                  className="input"
                  value={why}
                  onChange={(event) => setWhy(event.target.value)}
                  placeholder="Contract terms the account team has not agreed yet."
                />
              </label>
            </div>

            <p className="small muted" style={{ margin: 0 }} data-testid="classification-reach">
              {level === sensitivity
                ? `It already reaches ${REACH[level]}.`
                : `It will reach ${REACH[level]} instead of ${REACH[sensitivity]}.`}
            </p>

            {lowering ? (
              <div className="banner banner-attention" data-testid="classification-lowering">
                That widens who can read this thread, and every message already in it. You will be
                asked to confirm your password — raising it never asks, because raising only ever
                narrows.
              </div>
            ) : null}

            <div className="row wrap">
              <button
                className="btn btn-primary"
                data-testid="classification-confirm"
                disabled={busy || why.trim().length < 4}
                onClick={save}
              >
                {busy ? 'Saving…' : 'Set it'}
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="row wrap">
            <button className="btn" data-testid="classification-edit" disabled={busy} onClick={() => setEditing(true)}>
              {source === 'human' ? 'Change it' : 'Classify this thread'}
            </button>
          </div>
        )}

        <p className="small muted" style={{ margin: 0 }}>
          The level reaches every message in the thread, which is what the agent&rsquo;s reads are
          filtered on too. A thread above your own clearance is not listed and does not open.
          Nobody can file one above what they can read themselves.
        </p>
      </div>
    </section>
  )
}
