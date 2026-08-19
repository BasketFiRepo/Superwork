'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Logging what was said, and when (§12.6, ADR 0057).
 *
 * The company screen has always shown a relationship timeline and only an agent could add to it:
 * `logInteraction` was reachable through `log_interaction@v1` and from nowhere else. Somebody who
 * rang a customer this morning could watch the product decide the account had gone quiet.
 *
 * The date defaults to blank rather than to now, and blank means now on the server. A date input
 * pre-filled from the browser's clock is the hydration mismatch this product has already been
 * bitten by, and it would also invite somebody to change a date they had not thought about.
 */

export interface LogInteractionProps {
  companyId: string
  companyName: string
  contacts: { id: string; name: string }[]
  canLog: boolean
}

const KINDS = ['call', 'meeting', 'email', 'note', 'task'] as const

export function LogInteraction({ companyId, companyName, contacts, canLog }: LogInteractionProps) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  const [kind, setKind] = useState<string>('call')
  const [summary, setSummary] = useState('')
  const [contactId, setContactId] = useState('')
  const [occurredOn, setOccurredOn] = useState('')

  if (!canLog) return null

  async function submit() {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/interactions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        companyId,
        contactId: contactId || null,
        kind,
        summary: summary.trim(),
        // A date with no time means the middle of that day, so logging "yesterday" cannot land
        // in the future in a timezone ahead of the server's.
        occurredAt: occurredOn ? new Date(`${occurredOn}T12:00:00Z`).toISOString() : null,
      }),
    })
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(false)
    if (!response.ok) {
      setError(payload.error)
      return
    }
    setOpen(false)
    setSummary('')
    setContactId('')
    setOccurredOn('')
    router.refresh()
  }

  return (
    <div className="panel-body stack stack-3" data-testid="log-interaction">
      {error ? (
        <div className="banner banner-critical" role="alert">
          {error}
        </div>
      ) : null}

      {open ? (
        <div className="stack stack-3" data-testid="log-interaction-editor">
          <div className="row wrap" style={{ alignItems: 'flex-end' }}>
            <label className="stack stack-2" style={{ flex: '0 0 130px' }} htmlFor="interaction-kind">
              <span className="micro">What it was</span>
              <select
                id="interaction-kind"
                className="select"
                data-testid="interaction-kind"
                value={kind}
                onChange={(event) => setKind(event.target.value)}
              >
                {KINDS.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            </label>
            <label className="stack stack-2" style={{ flex: '0 0 200px' }} htmlFor="interaction-contact">
              <span className="micro">With</span>
              <select
                id="interaction-contact"
                className="select"
                data-testid="interaction-contact"
                value={contactId}
                onChange={(event) => setContactId(event.target.value)}
              >
                <option value="">{companyName}, nobody in particular</option>
                {contacts.map((contact) => (
                  <option key={contact.id} value={contact.id}>
                    {contact.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="stack stack-2" style={{ flex: '0 0 170px' }} htmlFor="interaction-date">
              <span className="micro">When</span>
              <input
                id="interaction-date"
                type="date"
                className="input"
                data-testid="interaction-date"
                value={occurredOn}
                onChange={(event) => setOccurredOn(event.target.value)}
              />
              <span className="micro muted">Leave it blank for just now.</span>
            </label>
          </div>
          <label className="stack stack-2" htmlFor="interaction-summary">
            <span className="micro">What happened</span>
            <textarea
              id="interaction-summary"
              className="input"
              data-testid="interaction-summary"
              rows={2}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              placeholder="Rang about the reefer handover — they are happy with 14:00 from Monday."
            />
          </label>
          <div className="row wrap">
            <button
              className="btn btn-primary"
              data-testid="interaction-confirm"
              disabled={busy || summary.trim().length < 3}
              onClick={submit}
            >
              {busy ? 'Logging…' : 'Log it'}
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => setOpen(false)}>
              Cancel
            </button>
            <span className="small muted">
              This is what keeps the account from being counted as quiet.
            </span>
          </div>
        </div>
      ) : (
        <div className="row">
          <button className="btn" data-testid="log-interaction-open" disabled={busy} onClick={() => setOpen(true)}>
            Log a call or a meeting
          </button>
        </div>
      )}
    </div>
  )
}
