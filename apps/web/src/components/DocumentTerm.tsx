'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * The term a document is in force for (§7.3, ADR 0042).
 *
 * `effective_from` was carried into every passage and stated in the header the model reads.
 * `effective_to` was written by nothing — so a contract whose term had ended was retrieved,
 * ranked and cited as current. Expired is not deleted: the passage stays findable, because
 * "what did the old contract say" is a real question, and stops being authoritative.
 */

export function DocumentTerm({
  documentId,
  effectiveFrom,
  effectiveTo,
  expired,
}: {
  documentId: string
  effectiveFrom: string | null
  effectiveTo: string | null
  expired: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [from, setFrom] = useState(effectiveFrom ?? '')
  const [to, setTo] = useState(effectiveTo ?? '')

  async function post(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/document-term', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ documentId, ...body }),
    })
    const result = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(false)
    if (!response.ok) {
      setError(result.error)
      return
    }
    setEditing(false)
    router.refresh()
  }

  return (
    <section className="panel" data-testid="document-term">
      <div className="panel-header">
        <h2>In force</h2>
        <span className="small muted">
          {expired ? 'Expired' : effectiveTo ? `Until ${effectiveTo}` : effectiveFrom ? `From ${effectiveFrom}` : 'No term set'}
        </span>
      </div>

      <div className="panel-body stack stack-3">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        {expired ? (
          <div className="banner banner-attention" data-testid="term-expired">
            This stopped applying on {effectiveTo}. It is still searchable and still citable —
            “what did the old one say” is a real question — but the assistant ranks it well below
            anything current and says it has expired whenever it quotes it.
          </div>
        ) : null}

        <p className="small secondary" style={{ margin: 0 }} data-testid="term-summary">
          {effectiveFrom || effectiveTo ? (
            <>
              In force {effectiveFrom ? `from ${effectiveFrom}` : ''}
              {effectiveTo ? ` until ${effectiveTo}` : effectiveFrom ? ' with no end date' : ''}.
            </>
          ) : (
            <>
              No term is set, so this is treated as current indefinitely. A contract or policy
              with an end date should say so — otherwise it goes on being quoted as if it still
              applied.
            </>
          )}{' '}
          Superseding a document sets the end date of the one it replaces, so that half is
          usually filled in for you.
        </p>

        {editing ? (
          <div className="row wrap" style={{ alignItems: 'flex-end' }} data-testid="term-editor">
            <label className="stack stack-2" style={{ flex: '0 0 180px' }} htmlFor="term-from">
              <span className="micro">In force from</span>
              <input id="term-from" className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </label>
            <label className="stack stack-2" style={{ flex: '0 0 180px' }} htmlFor="term-to">
              <span className="micro">Until</span>
              <input id="term-to" className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </label>
            <button
              className="btn btn-primary"
              data-testid="term-confirm"
              disabled={busy}
              onClick={() => post({ effectiveFrom: from || null, effectiveTo: to || null })}
            >
              {busy ? 'Saving…' : 'Save the term'}
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="row">
            <button className="btn" data-testid="term-edit" disabled={busy} onClick={() => setEditing(true)}>
              {effectiveFrom || effectiveTo ? 'Change the term' : 'Set the term'}
            </button>
          </div>
        )}

        <p className="small muted" style={{ margin: 0 }}>
          The term reaches every passage the assistant reads straight away. Nothing needs
          re-indexing: the term is a fact retrieval reads from the record, not a phrase inside
          the passage.
        </p>
      </div>
    </section>
  )
}
