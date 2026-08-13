'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Upload and ingest in one step: a document that is not indexed is not memory.
 * The result reports the classification and any verification warnings rather than
 * silently succeeding.
 */
export function UploadDocument() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [docType, setDocType] = useState('document')
  const [untrusted, setUntrusted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  async function submit() {
    setBusy(true)
    setResult(null)
    const response = await fetch('/api/documents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, body, docType, untrusted }),
    })
    setBusy(false)
    const payload = await response.json()
    if (!response.ok) {
      setResult(payload.error ?? 'That could not be indexed.')
      return
    }
    setResult(
      payload.status === 'quarantined'
        ? `Quarantined: ${payload.quarantineReason}`
        : `Indexed ${payload.chunks} passages · classified ${payload.sensitivity}${
            payload.warnings?.length ? ` · ${payload.warnings.join(' ')}` : ''
          }`,
    )
    setTitle('')
    setBody('')
    router.refresh()
  }

  if (!open) {
    return (
      <div className="row">
        <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
          Add a document
        </button>
        {result ? <span className="small muted">{result}</span> : null}
      </div>
    )
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h2>Add to company memory</h2>
        <button className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      <div className="panel-body stack stack-5">
        <label className="stack stack-2">
          <span className="micro">Title</span>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Vendor Payment SOP" />
        </label>
        <div className="row">
          <label className="stack stack-2 grow">
            <span className="micro">Type</span>
            <select className="select" value={docType} onChange={(e) => setDocType(e.target.value)}>
              {['document', 'sop', 'policy', 'contract', 'invoice', 'report', 'note'].map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
          <label className="row-tight small" style={{ alignSelf: 'flex-end', height: 34 }}>
            <input type="checkbox" checked={untrusted} onChange={(e) => setUntrusted(e.target.checked)} />
            Came from outside the organization
          </label>
        </div>
        <label className="stack stack-2">
          <span className="micro">Content (Markdown)</span>
          <textarea
            className="textarea"
            style={{ minHeight: 200 }}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={'# Heading\n\nStructure-aware chunking keeps headings and tables intact.'}
          />
        </label>
        {result ? <div className="banner banner-accent">{result}</div> : null}
        <div className="row">
          <button className="btn btn-primary" disabled={busy || !title.trim() || !body.trim()} onClick={submit}>
            {busy ? 'Indexing…' : 'Index it'}
          </button>
          <span className="small muted">
            Content marked as external is scanned for embedded instructions before indexing.
          </span>
        </div>
      </div>
    </div>
  )
}
