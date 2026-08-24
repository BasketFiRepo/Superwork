'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * The file behind a document (ADR 0085).
 *
 * `StorageProvider` was declared since Phase 2 with no implementation at all, so every document
 * here was markdown somebody had pasted in. There was no way to keep the contract itself.
 *
 * The download is a plain link to a route that asks `can()` on every request. There is no signed
 * URL and no token: a link that works on possession can be forwarded, logged by a proxy, or opened
 * from a browser history after the person's clearance changed.
 */

export interface DocumentFileProps {
  documentId: string
  fileName: string | null
  contentType: string
  bytes: number | null
  canAttach: boolean
  refusal: string | null
  attachable: string[]
  maxBytes: number
}

const size = (bytes: number): string =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))}KB` : `${(bytes / 1024 / 1024).toFixed(1)}MB`

export function DocumentFile(props: DocumentFileProps) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function upload(file: File) {
    setBusy(true)
    setError(null)
    const form = new FormData()
    form.set('file', file)
    const response = await fetch(`/api/documents/${props.documentId}/file`, { method: 'POST', body: form })
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(false)
    if (!response.ok) {
      setError(payload.error)
      return
    }
    router.refresh()
  }

  return (
    <section className="panel" data-testid="document-file">
      <div className="panel-header">
        <h2>File</h2>
        <span className="small muted">
          {props.fileName ? size(props.bytes ?? 0) : 'nothing attached'}
        </span>
      </div>

      <div className="panel-body stack stack-4">
        {error ? (
          <div className="banner banner-critical" role="alert" data-testid="document-file-error">
            {error}
          </div>
        ) : null}

        {props.fileName ? (
          <div className="row wrap">
            {/*
              A plain link, and deliberately so. The route asks `can()` again on every request, and
              serves the bytes as an attachment with nosniff — a PDF rendered in this origin is one
              parser bug away from being script on the product's own domain.
            */}
            <a
              className="btn btn-primary btn-sm"
              href={`/api/documents/${props.documentId}/file`}
              data-testid="document-file-download"
            >
              Download {props.fileName}
            </a>
            <span className="chip">{props.contentType}</span>
          </div>
        ) : (
          <p className="small secondary prose" style={{ margin: 0 }} data-testid="document-file-empty">
            Nothing is attached. The text above is what Superwork indexes and cites; a file kept
            here is the original somebody signed, and it is behind exactly the clearance this
            document is behind.
          </p>
        )}

        {props.canAttach ? (
          <label className="stack stack-2">
            <span className="micro">
              {props.fileName ? 'Replace it' : 'Attach the original'} — up to{' '}
              {props.maxBytes / 1024 / 1024}MB
            </span>
            <input
              className="input"
              type="file"
              data-testid="document-file-input"
              disabled={busy}
              accept={props.attachable.join(',')}
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void upload(file)
              }}
            />
            <span className="small muted">
              Superwork keeps PDFs, plain text, CSV, images and Office documents. Anything a browser
              would run is refused rather than filtered.
            </span>
          </label>
        ) : props.refusal ? (
          <div className="empty small secondary" data-testid="document-file-denied">
            {props.refusal}
          </div>
        ) : null}
      </div>
    </section>
  )
}
