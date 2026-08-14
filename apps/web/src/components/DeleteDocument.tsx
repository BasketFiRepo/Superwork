'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Deleting a document, and saying what went with it (§25.13).
 *
 * The indexed passages, the citations and the memories derived from this document are
 * removed in the same transaction — that is the whole point of the control, and the only
 * way anybody can tell is if it says so. So it says so before, as a count, and after, as
 * what it actually removed.
 */
export function DeleteDocument({
  documentId,
  title,
  chunkCount,
  citationCount,
}: {
  documentId: string
  title: string
  chunkCount: number
  citationCount: number
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (!open) {
    return (
      <button className="btn btn-ghost" data-testid="delete-document" onClick={() => setOpen(true)}>
        Delete this document
      </button>
    )
  }

  return (
    <div className="panel" data-testid="delete-document-panel" style={{ borderColor: 'var(--critical)' }}>
      <div className="panel-body stack stack-4">
        <div className="stack stack-2">
          <span className="micro">Delete “{title}”</span>
          <p className="prose small" style={{ margin: 0 }}>
            This removes the document and everything derived from it:{' '}
            <strong>{chunkCount} indexed passages</strong>, <strong>{citationCount} citations</strong>, and any
            memories the assistant formed from it. Leaving those behind would be both a compliance hole
            and a source of answers citing a document that no longer exists.
          </p>
        </div>
        <label className="stack stack-2" htmlFor="delete-reason">
          <span className="micro">Why is it being deleted?</span>
          <input
            id="delete-reason"
            className="input"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Superseded by the 2026 policy."
          />
        </label>
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}
        <div className="row">
          <button
            className="btn btn-danger"
            data-testid="delete-document-confirm"
            disabled={busy || reason.trim().length < 4}
            onClick={async () => {
              setBusy(true)
              setError(null)
              const response = await fetch(`/api/documents/${documentId}/delete`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ reason }),
              })
              const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
              setBusy(false)
              if (!response.ok) {
                setError(payload.error)
                return
              }
              router.push('/knowledge')
              router.refresh()
            }}
          >
            {busy ? 'Deleting…' : 'Delete it and everything derived from it'}
          </button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
