'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * How this document got into company memory, and how to put it back (§7.1).
 *
 * The post-index check has run on every ingestion since Phase 1 and its result was thrown
 * away — flattened into `documents.index_error`, a column that also holds failure messages,
 * so "indexed, but two sections are hard to find" and "did not index" read the same. Here
 * they do not.
 */

export interface DocumentIngestionRow {
  id: string
  status: string
  reason: string | null
  attempts: number
  chunksWritten: number
  lastError: string | null
  gaveUp: boolean
  createdAt: string
  verification: { sampled: number; answerable: number; warnings: string[] } | null
}

export function DocumentIndexing({
  documentId,
  history,
}: {
  documentId: string
  history: DocumentIngestionRow[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [reason, setReason] = useState('')

  async function reindex() {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/ingestion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reindex', documentId, reason: reason.trim() || undefined }),
    })
    const result = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(false)
    if (!response.ok) {
      setError(result.error)
      return
    }
    setAsking(false)
    setReason('')
    router.refresh()
  }

  const latest = history[0]
  const warnings = latest?.verification?.warnings ?? []

  return (
    <section className="panel" data-testid="document-indexing">
      <div className="panel-header">
        <h2>Indexing</h2>
        <span className="small muted">
          {history.length === 0 ? 'No record' : `${history.length} ${history.length === 1 ? 'attempt' : 'attempts'}`}
        </span>
      </div>

      <div className="panel-body stack stack-3">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        {warnings.length > 0 ? (
          <div className="banner banner-attention" data-testid="verification-warnings">
            It indexed, but the post-index check could only find {latest!.verification!.answerable} of{' '}
            {latest!.verification!.sampled} sampled sections by their own words. {warnings.join(' ')}{' '}
            Re-indexing sometimes clears it; if it does not, the wording itself is the problem.
          </div>
        ) : null}

        {history.length === 0 ? (
          <div className="empty small secondary">
            Nothing recorded. This document was indexed before the product kept a record of
            indexing, or it has never been indexed at all.
          </div>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 130 }}>When</th>
                  <th style={{ width: 110 }}>Outcome</th>
                  <th style={{ width: 80 }}>Sections</th>
                  <th>Why, and what happened</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.id} data-testid="indexing-row">
                    <td className="small secondary">{row.createdAt.slice(0, 10)}</td>
                    <td className="small secondary">
                      <span className={`chip${row.gaveUp ? ' chip-critical' : ''}`}>
                        {row.gaveUp ? 'gave up' : row.status}
                      </span>
                    </td>
                    <td className="num small secondary">{row.chunksWritten}</td>
                    <td className="small secondary">
                      {row.reason ?? '—'}
                      {row.lastError ? <div className="small muted">{row.lastError}</div> : null}
                      {row.verification ? (
                        <div className="small muted">
                          Checked {row.verification.sampled}, found {row.verification.answerable}.
                        </div>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {asking ? (
          <div className="row wrap" style={{ alignItems: 'flex-end' }} data-testid="reindex-editor">
            <label className="stack stack-2" style={{ flex: '1 1 260px' }} htmlFor="reindex-reason">
              <span className="micro">Why (optional)</span>
              <input
                id="reindex-reason"
                className="input"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="The finance section never comes back in search."
              />
            </label>
            <button className="btn btn-primary" data-testid="reindex-confirm" disabled={busy} onClick={reindex}>
              {busy ? 'Queueing…' : 'Queue it'}
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => setAsking(false)}>
              Cancel
            </button>
          </div>
        ) : (
          <div className="row">
            <button className="btn" data-testid="reindex-ask" disabled={busy} onClick={() => setAsking(true)}>
              Index it again
            </button>
          </div>
        )}

        <p className="small muted" style={{ margin: 0 }}>
          Re-indexing writes a new version and supersedes the old passages, so it needs a say over
          the document rather than a read of it. It happens in the background — nothing is lost if
          you close this page.
        </p>
      </div>
    </section>
  )
}
