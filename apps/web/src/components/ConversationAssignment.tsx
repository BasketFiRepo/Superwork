'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Whose thread this is to answer (ADR 0063).
 *
 * `conversations.assigned_to` has existed since migration 0010 and nothing has ever written it,
 * while the inbox offers a **My work** view that reads it, the personal record counts it, and the
 * policy engine's `own` scope accepts it. A filter on the busiest screen here, half of which
 * could never match anything.
 *
 * The list of people is filtered by clearance before it reaches this component, so it does not
 * offer somebody the hand-over would be refused for. The refusal still exists on the way in — a
 * list is a convenience and never a control.
 */

export interface AssignablePerson {
  id: string
  name: string
}

export function ConversationAssignment({
  conversationId,
  assignedToId,
  assignedToName,
  assignedByName,
  assignedAt,
  people,
  canAssign,
}: {
  conversationId: string
  assignedToId: string | null
  assignedToName: string | null
  assignedByName: string | null
  assignedAt: string | null
  people: AssignablePerson[]
  canAssign: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [choosing, setChoosing] = useState(false)
  const [who, setWho] = useState('')

  async function post(assigneeId: string | null) {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/conversation-assignment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ conversationId, assigneeId }),
    })
    const result = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(false)
    if (!response.ok) {
      setError(result.error)
      return
    }
    setChoosing(false)
    setWho('')
    router.refresh()
  }

  return (
    <section className="panel" data-testid="conversation-assignment">
      <div className="panel-header">
        <h2>Whose this is</h2>
        <span className="small muted" data-testid="assignment-state">
          {assignedToName ? `assigned to ${assignedToName}` : 'nobody yet'}
        </span>
      </div>

      <div className="panel-body stack stack-3">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        <p className="small secondary prose" style={{ margin: 0 }} data-testid="assignment-summary">
          {assignedToName ? (
            <>
              <strong>{assignedToName}</strong> is answering this. {assignedByName ?? 'Somebody'}{' '}
              handed it over{assignedAt ? ` on ${assignedAt.slice(0, 10)}` : ''}. It is on their{' '}
              <strong>My work</strong> list, and being given a thread is what lets somebody act on
              one they do not own.
            </>
          ) : (
            <>
              Nobody has been handed this thread. It sits in the queue for whoever gets to it, and
              appears on no one&rsquo;s <strong>My work</strong> list.
            </>
          )}
        </p>

        {!canAssign ? (
          <p className="small muted" style={{ margin: 0 }}>
            Handing a thread over needs a say over it, not a read of it.
          </p>
        ) : choosing ? (
          <div className="row wrap" style={{ alignItems: 'flex-end' }} data-testid="assignment-editor">
            <label className="stack stack-2" style={{ flex: '1 1 240px' }} htmlFor="assignment-person">
              <span className="micro">Hand it to</span>
              <select
                id="assignment-person"
                className="input"
                value={who}
                onChange={(event) => setWho(event.target.value)}
              >
                <option value="">Choose somebody</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="btn btn-primary"
              data-testid="assignment-confirm"
              disabled={busy || who === ''}
              onClick={() => post(who)}
            >
              {busy ? 'Saving…' : 'Hand it over'}
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => setChoosing(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="row wrap">
            <button className="btn" data-testid="assignment-open" disabled={busy} onClick={() => setChoosing(true)}>
              {assignedToId ? 'Hand it to somebody else' : 'Hand it to somebody'}
            </button>
            {assignedToId ? (
              <button
                className="btn btn-ghost"
                data-testid="assignment-clear"
                disabled={busy}
                onClick={() => post(null)}
              >
                Take it back off them
              </button>
            ) : null}
          </div>
        )}

        <p className="small muted" style={{ margin: 0 }}>
          Only people whose clearance reaches this thread are offered. Somebody given one they
          cannot open would have it disappear into a queue they cannot see.
        </p>
      </div>
    </section>
  )
}
