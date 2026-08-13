'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * The approval card (§11.2). Without a click it shows: what will happen (the rendered
 * preview diff), why it was proposed (evidence), what it affects, who proposed it, the
 * risk tier and the expiry.
 */

export interface ApprovalCardView {
  id: string
  title: string
  kind: string
  status: string
  riskTier: string
  requestedByLabel: string
  agentRunId: string | null
  slaHours: number
  hoursWaiting: number
  createdAt: string
  preview: {
    operation: string
    entityType: string
    entityLabel: string
    changes: { field: string; from?: string | null; to: string | null }[]
    riskTier: string
    reversible: boolean
  }[]
  evidence: { claim: string; sourceType: string; documentId?: string | null; anchor?: string | null }[]
  decisionReason: string | null
}

export function ApprovalCard({ approval }: { approval: ApprovalCardView }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const pending = approval.status === 'pending'
  const breached = approval.hoursWaiting > approval.slaHours

  async function decide(decision: 'approve' | 'reject') {
    if (decision === 'reject' && !reason.trim()) {
      setError('A rejection needs a reason — it is the signal that improves future proposals.')
      return
    }
    setBusy(true)
    setError(null)
    const response = await fetch(`/api/approvals/${approval.id}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision, reason: decision === 'reject' ? reason : undefined }),
    })
    setBusy(false)
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: 'The decision could not be recorded.' }))
      setError(body.error)
      return
    }
    setRejecting(false)
    router.refresh()
  }

  return (
    <article className="panel">
      <div className="panel-header">
        <div className="stack stack-2">
          <div className="row-tight">
            <span className={approval.riskTier === 'high' ? 'chip chip-critical' : 'chip'}>
              {approval.riskTier === 'high' ? 'irreversible' : approval.riskTier}
            </span>
            <h3>{approval.title}</h3>
          </div>
          <span className="small muted">
            Proposed by {approval.requestedByLabel} · waiting {approval.hoursWaiting.toFixed(1)}h of a{' '}
            {approval.slaHours}h SLA
            {breached ? ' · past SLA' : ''}
          </span>
        </div>
        <span className={`chip${approval.status === 'pending' ? '' : approval.status === 'rejected' ? ' chip-critical' : ' chip-positive'}`}>
          {approval.status.replace(/_/g, ' ')}
        </span>
      </div>

      <div className="panel-body stack stack-6">
        <section className="stack stack-3">
          <span className="micro">
            What will happen — {approval.preview.length} {approval.preview.length === 1 ? 'change' : 'changes'}
          </span>
          <div className="stack stack-4">
            {approval.preview.map((line, index) => (
              <div key={index} className="stack stack-2" style={{ paddingLeft: 'var(--s-5)', borderLeft: '1px solid var(--hairline)' }}>
                <div className="row-tight">
                  <strong className="small">{line.operation}</strong>
                  <span className="small secondary">{line.entityLabel}</span>
                  {line.reversible ? null : <span className="chip chip-critical">cannot be undone</span>}
                </div>
                {line.changes.map((change, changeIndex) => (
                  <div className="diff-line" key={changeIndex}>
                    <span className="diff-field">{change.field}</span>
                    {change.from ? <span className="diff-from">{change.from}</span> : null}
                    <span className="diff-to">{change.to}</span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>

        <section className="stack stack-3">
          <span className="micro">
            Why — {approval.evidence.length} {approval.evidence.length === 1 ? 'piece' : 'pieces'} of evidence
          </span>
          <ul className="stack stack-2 small secondary" style={{ margin: 0, paddingLeft: 'var(--s-7)' }}>
            {approval.evidence.map((item, index) => (
              <li key={index}>
                {item.claim}{' '}
                {item.documentId ? (
                  <a className="citation" href={`/knowledge/${item.documentId}`}>
                    source
                  </a>
                ) : null}
              </li>
            ))}
          </ul>
        </section>

        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        {approval.decisionReason ? (
          <div className="banner">
            <span>Reason given: {approval.decisionReason}</span>
          </div>
        ) : null}

        {pending ? (
          rejecting ? (
            <div className="stack stack-4">
              <label className="stack stack-2">
                <span className="micro">Why are you rejecting this?</span>
                <textarea
                  className="textarea"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="The tone is wrong for this account…"
                />
              </label>
              <div className="row">
                <button className="btn btn-danger" onClick={() => decide('reject')} disabled={busy}>
                  Reject
                </button>
                <button className="btn btn-ghost" onClick={() => setRejecting(false)} disabled={busy}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="row wrap">
              <button className="btn btn-primary" onClick={() => decide('approve')} disabled={busy}>
                {busy ? 'Working…' : 'Approve'}
              </button>
              <button className="btn" onClick={() => setRejecting(true)} disabled={busy}>
                Reject with reason
              </button>
              {approval.agentRunId ? (
                <a className="btn btn-ghost" href={`/activity?run=${approval.agentRunId}`}>
                  See the full run
                </a>
              ) : null}
              <button
                className="btn btn-ghost"
                disabled
                title="Editing a draft inline lands in Phase 2. Reject with a reason for now — the reason is fed back as a learning signal."
              >
                Approve with edits
                <span className="chip">Coming soon</span>
              </button>
            </div>
          )
        ) : null}
      </div>
    </article>
  )
}
