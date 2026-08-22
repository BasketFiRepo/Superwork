'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Writing down an email that reached somebody another way (ADR 0076).
 *
 * Superwork has no mailbox — the whole product runs with zero external credentials — so the
 * answer to "every thread here was put there by the seed" is not an integration. It is this:
 * paste what actually arrived, and the record stops being a fixture.
 *
 * There is no control here for how far the content is trusted. The direction decides it, at the
 * repository, and an inbound message is treated as adversarial whoever files it.
 */
export function RecordCorrespondence({
  conversationId,
  companies,
}: {
  /** Appending to a thread, or omitted to start one. */
  conversationId?: string
  companies?: { id: string; name: string }[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [direction, setDirection] = useState<'inbound' | 'outbound' | 'internal'>('inbound')
  const [subject, setSubject] = useState('')
  const [companyId, setCompanyId] = useState('')
  const [fromAddress, setFromAddress] = useState('')
  const [fromName, setFromName] = useState('')
  const [toAddresses, setToAddresses] = useState('')
  const [sentAt, setSentAt] = useState('')
  const [body, setBody] = useState('')

  const starting = !conversationId
  const ready = body.trim().length > 1 && fromAddress.trim().length > 2 && (!starting || subject.trim().length > 1)

  async function save() {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/correspondence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversationId,
        subject: starting ? subject.trim() : undefined,
        companyId: starting && companyId ? companyId : null,
        direction,
        fromAddress: fromAddress.trim(),
        fromName: fromName.trim() || null,
        toAddresses: toAddresses
          .split(/[,;\s]+/)
          .map((address) => address.trim())
          .filter(Boolean),
        sentAt: sentAt ? new Date(sentAt).toISOString() : undefined,
        body,
      }),
    })
    setBusy(false)
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    if (!response.ok) {
      setError(payload.error)
      return
    }
    setOpen(false)
    setSubject('')
    setBody('')
    setFromAddress('')
    setFromName('')
    setToAddresses('')
    setSentAt('')
    if (starting && payload.conversationId) router.push(`/inbox/${payload.conversationId}`)
    else router.refresh()
  }

  if (!open) {
    return (
      <button className="btn btn-sm" data-testid="record-open" onClick={() => setOpen(true)}>
        {starting ? 'Record an email' : 'Record a reply'}
      </button>
    )
  }

  return (
    <section className="panel" data-testid="record-editor">
      <div className="panel-header">
        <h2>{starting ? 'Record an email' : 'Record a message on this thread'}</h2>
        <span className="small muted">Superwork has no mailbox — this is what actually arrived</span>
      </div>

      <div className="panel-body stack stack-3">
        {error ? (
          <div className="banner banner-critical" role="alert" data-testid="record-error">
            {error}
          </div>
        ) : null}

        <div className="row">
          <label className="stack stack-2" style={{ flex: '0 0 150px' }}>
            <span className="micro">Which way</span>
            <select
              className="select"
              id="record-direction"
              value={direction}
              onChange={(event) => setDirection(event.target.value as typeof direction)}
            >
              <option value="inbound">They sent it</option>
              <option value="outbound">We sent it</option>
              <option value="internal">Internal note</option>
            </select>
          </label>
          <label className="stack stack-2" style={{ flex: '1 1 220px' }}>
            <span className="micro">From</span>
            <input
              className="input"
              id="record-from"
              placeholder="ingrid@haldenfoods.example"
              value={fromAddress}
              onChange={(event) => setFromAddress(event.target.value)}
            />
          </label>
          <label className="stack stack-2" style={{ flex: '1 1 180px' }}>
            <span className="micro">Their name</span>
            <input
              className="input"
              id="record-from-name"
              placeholder="Ingrid Solberg"
              value={fromName}
              onChange={(event) => setFromName(event.target.value)}
            />
          </label>
        </div>

        <div className="row">
          <label className="stack stack-2" style={{ flex: '1 1 220px' }}>
            <span className="micro">To</span>
            <input
              className="input"
              id="record-to"
              placeholder="ops@northwind.example"
              value={toAddresses}
              onChange={(event) => setToAddresses(event.target.value)}
            />
          </label>
          <label className="stack stack-2" style={{ flex: '0 0 210px' }}>
            <span className="micro">When it was sent</span>
            <input
              className="input"
              id="record-sent-at"
              type="datetime-local"
              value={sentAt}
              onChange={(event) => setSentAt(event.target.value)}
            />
          </label>
        </div>

        {starting ? (
          <div className="row">
            <label className="stack stack-2" style={{ flex: '1 1 260px' }}>
              <span className="micro">Subject</span>
              <input
                className="input"
                id="record-subject"
                placeholder="Peak season capacity — revised volumes"
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
              />
            </label>
            <label className="stack stack-2" style={{ flex: '0 0 230px' }}>
              <span className="micro">Account</span>
              <select
                className="select"
                id="record-company"
                value={companyId}
                onChange={(event) => setCompanyId(event.target.value)}
              >
                {/* Blank is not "none": the repository falls back to the domain rule the CRM
                    already uses, so an address at a known customer files itself. */}
                <option value="">Work it out from the address</option>
                {(companies ?? []).map((company) => (
                  <option key={company.id} value={company.id}>
                    {company.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}

        <label className="stack stack-2">
          <span className="micro">What it said</span>
          <textarea
            className="input"
            id="record-body"
            rows={7}
            placeholder="Paste the message."
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </label>

        <p className="small muted" style={{ margin: 0 }} data-testid="record-explainer">
          {direction === 'inbound'
            ? 'Anything that came from outside is treated as adversarial: it is scanned for instructions aimed at the assistant, its remote images are blocked and its links are shown as text. There is no setting for that.'
            : 'A message we sent is our own words, so it is not scanned as outside content — and it moves the thread’s clock, which is what stops the queue chasing a thread you have already answered.'}
        </p>

        <div className="row-tight">
          <button
            className="btn btn-primary btn-sm"
            data-testid="record-confirm"
            disabled={busy || !ready}
            onClick={save}
          >
            {busy ? 'Recording…' : 'Record it'}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            data-testid="record-cancel"
            disabled={busy}
            onClick={() => setOpen(false)}
          >
            Cancel
          </button>
        </div>
      </div>
    </section>
  )
}
