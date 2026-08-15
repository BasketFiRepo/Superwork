'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * The indexing queue (§7.1).
 *
 * Before this, a document that failed to index left nothing behind: the failure rolled back
 * with the transaction it happened in, and there was no way to try again. What is on screen
 * here is the difference — what is waiting, what is being retried, and what the queue gave up
 * on and is now a person's decision.
 */

export interface IngestionJobRow {
  id: string
  documentId: string
  documentTitle: string
  status: string
  reason: string | null
  attempts: number
  chunksWritten: number
  lastError: string | null
  nextAttemptAt: string | null
  gaveUp: boolean
  verification: { sampled: number; answerable: number; warnings: string[] } | null
}

const LABEL: Record<string, string> = {
  pending: 'waiting',
  processing: 'indexing now',
  failed: 'failed',
  indexed: 'indexed',
  quarantined: 'quarantined',
  skipped: 'skipped',
}

export function IngestionQueue({
  counts,
  jobs,
}: {
  counts: { waiting: number; running: number; retrying: number; gaveUp: number }
  jobs: IngestionJobRow[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function retry(documentId: string) {
    setBusy(documentId)
    setError(null)
    const response = await fetch('/api/ingestion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'reindex', documentId, reason: 'Retried from the knowledge screen.' }),
    })
    const result = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(null)
    if (!response.ok) {
      setError(result.error)
      return
    }
    router.refresh()
  }

  const nothing = counts.waiting + counts.running + counts.retrying + counts.gaveUp === 0

  return (
    <section className="panel" data-testid="ingestion-queue">
      <div className="panel-header">
        <h2>Indexing</h2>
        <span className="small muted">
          {nothing
            ? 'Nothing waiting'
            : [
                counts.waiting ? `${counts.waiting} waiting` : null,
                counts.running ? `${counts.running} running` : null,
                counts.retrying ? `${counts.retrying} retrying` : null,
                counts.gaveUp ? `${counts.gaveUp} gave up` : null,
              ]
                .filter(Boolean)
                .join(' · ')}
        </span>
      </div>

      <div className="panel-body stack stack-3">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        {nothing ? (
          <div className="empty small secondary">
            Everything that was asked for has been indexed. A document that fails is retried on a
            widening delay, and after five tries it stops and appears here rather than being
            retried for ever in silence.
          </div>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Document</th>
                  <th style={{ width: 120 }}>State</th>
                  <th style={{ width: 80 }}>Tries</th>
                  <th>What happened</th>
                  <th style={{ width: 120 }} />
                </tr>
              </thead>
              <tbody>
                {jobs.map((job) => (
                  <tr key={job.id} data-testid="ingestion-row">
                    <td className="small">
                      <a href={`/knowledge/${job.documentId}`}>{job.documentTitle}</a>
                      {job.reason ? <div className="small muted">{job.reason}</div> : null}
                    </td>
                    <td className="small secondary">
                      {job.gaveUp ? (
                        <span className="chip chip-critical" data-testid="ingestion-gave-up">
                          gave up
                        </span>
                      ) : (
                        <span className="chip">{LABEL[job.status] ?? job.status}</span>
                      )}
                    </td>
                    <td className="num small secondary">{job.attempts}</td>
                    <td className="small secondary">
                      {job.lastError ?? (job.status === 'pending' ? 'Queued.' : '—')}
                      {job.verification && job.verification.warnings.length > 0 ? (
                        <div className="small muted">
                          Indexed, but {job.verification.warnings.length} of{' '}
                          {job.verification.sampled} sampled sections may be hard to find.
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {job.gaveUp ? (
                        <button
                          className="btn btn-sm"
                          data-testid="ingestion-retry"
                          disabled={busy === job.documentId}
                          onClick={() => retry(job.documentId)}
                        >
                          {busy === job.documentId ? 'Queueing…' : 'Try again'}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="small muted" style={{ margin: 0 }}>
          Indexing happens in the background, so it survives the request that asked for it.
          Trying again keeps the count of what already failed — it is a new decision, not a
          fresh start.
        </p>
      </div>
    </section>
  )
}
