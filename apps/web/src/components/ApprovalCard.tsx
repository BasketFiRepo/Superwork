'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * The approval card (§11.2). Without a click it shows: what will happen (the rendered
 * preview diff), why it was proposed (evidence), what it affects, who proposed it, the
 * risk tier and the expiry.
 *
 * Fields the tool marked editable can be corrected in place. Correcting is not the same
 * as approving: the edited plan is re-gated on the server before anything runs, and the
 * edit is recorded in the trust ledger, because "approved after a tweak" is a different
 * signal from "approved as proposed".
 */

export interface EditableField {
  arg: string
  multiline?: boolean
  help?: string
}

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
  /** Why this is being asked, in the deciding policy's own words (§11.1). */
  policyReason: string | null
  policyName: string | null
  /** Set when a policy named a role rather than a person. */
  approverRole: string | null
  preview: {
    operation: string
    entityType: string
    entityLabel: string
    changes: { field: string; from?: string | null; to: string | null; editable?: EditableField }[]
    riskTier: string
    reversible: boolean
    stepId?: string
  }[]
  evidence: { claim: string; sourceType: string; documentId?: string | null; anchor?: string | null }[]
  decisionReason: string | null
}

type Draft = Record<string, Record<string, string>>

export function ApprovalCard({ approval }: { approval: ApprovalCardView }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [rejecting, setRejecting] = useState(false)
  const [editing, setEditing] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const pending = approval.status === 'pending'
  const breached = approval.hoursWaiting > approval.slaHours

  const original = useMemo<Draft>(() => {
    const out: Draft = {}
    for (const line of approval.preview) {
      if (!line.stepId) continue
      for (const change of line.changes) {
        if (!change.editable) continue
        ;(out[line.stepId] ??= {})[change.editable.arg] = change.to ?? ''
      }
    }
    return out
  }, [approval.preview])

  const [draft, setDraft] = useState<Draft>(original)
  const editable = Object.keys(original).length > 0

  const changed = useMemo(() => {
    const out: Draft = {}
    for (const [stepId, args] of Object.entries(draft)) {
      for (const [arg, value] of Object.entries(args)) {
        if (value !== original[stepId]?.[arg]) (out[stepId] ??= {})[arg] = value
      }
    }
    return out
  }, [draft, original])
  const hasEdits = Object.keys(changed).length > 0

  function set(stepId: string, arg: string, value: string) {
    setDraft((current) => ({ ...current, [stepId]: { ...current[stepId], [arg]: value } }))
  }

  async function decide(decision: 'approve' | 'approve_with_edits' | 'reject') {
    if (decision === 'reject' && !reason.trim()) {
      setError('A rejection needs a reason — it is the signal that improves future proposals.')
      return
    }
    if (decision === 'approve_with_edits' && !hasEdits) {
      setError('Nothing has been changed yet. Approve it as proposed if it is right as it stands.')
      return
    }
    setBusy(true)
    setError(null)
    const response = await fetch(`/api/approvals/${approval.id}/decide`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        decision,
        reason: decision === 'reject' ? reason : reason.trim() || undefined,
        edits: decision === 'approve_with_edits' ? { steps: changed } : undefined,
      }),
    })
    setBusy(false)
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: 'The decision could not be recorded.' }))
      setError(body.error)
      return
    }
    setRejecting(false)
    setEditing(false)
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
            {approval.approverRole ? ` · a ${approval.approverRole} decides this` : ''}
          </span>
        </div>
        <span className={`chip${approval.status === 'pending' ? '' : approval.status === 'rejected' ? ' chip-critical' : ' chip-positive'}`}>
          {approval.status.replace(/_/g, ' ')}
        </span>
      </div>

      <div className="panel-body stack stack-6">
        {approval.policyReason ? (
          <p className="small secondary" style={{ margin: 0 }} data-testid="approval-why">
            <strong>Why you are being asked:</strong> {approval.policyReason}
            {approval.policyName ? (
              <>
                {' '}
                <a href="/settings/approvals">See the rule</a>.
              </>
            ) : null}
          </p>
        ) : null}

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
                {line.changes.map((change, changeIndex) => {
                  const field = change.editable
                  const stepId = line.stepId
                  if (editing && pending && field && stepId) {
                    const value = draft[stepId]?.[field.arg] ?? ''
                    const id = `${approval.id}-${stepId}-${field.arg}`
                    return (
                      <label className="stack stack-2" data-testid="editable-field" key={changeIndex} htmlFor={id}>
                        <span className="micro">
                          {change.field}
                          {value !== original[stepId]?.[field.arg] ? ' · edited' : ''}
                        </span>
                        {field.multiline ? (
                          <textarea
                            id={id}
                            className="textarea"
                            rows={6}
                            value={value}
                            onChange={(event) => set(stepId, field.arg, event.target.value)}
                          />
                        ) : (
                          <input
                            id={id}
                            className="input"
                            value={value}
                            onChange={(event) => set(stepId, field.arg, event.target.value)}
                          />
                        )}
                        {field.help ? <span className="small muted">{field.help}</span> : null}
                      </label>
                    )
                  }
                  return (
                    <div className="diff-line" key={changeIndex}>
                      <span className="diff-field">{change.field}</span>
                      {change.from ? <span className="diff-from">{change.from}</span> : null}
                      <span className="diff-to">{change.to}</span>
                    </div>
                  )
                })}
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
          ) : editing ? (
            <div className="stack stack-4">
              <label className="stack stack-2">
                <span className="micro">What did you change, and why? (optional, but it teaches)</span>
                <input
                  className="input"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Softer close — this account prefers it."
                />
              </label>
              <p className="small muted" style={{ margin: 0 }}>
                Your edits are re-checked against the same permission rules before anything runs. If an edit
                makes the plan riskier than what you were shown, it comes back for a fresh decision.
              </p>
              <div className="row wrap">
                <button className="btn btn-primary" onClick={() => decide('approve_with_edits')} disabled={busy || !hasEdits}>
                  {busy ? 'Working…' : 'Approve with my edits'}
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    setDraft(original)
                    setEditing(false)
                    setError(null)
                  }}
                  disabled={busy}
                >
                  Discard edits
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
                className="btn"
                data-testid="approve-with-edits"
                onClick={() => setEditing(true)}
                disabled={busy || !editable}
                title={
                  editable
                    ? 'Correct the wording or the details, then approve what you actually want.'
                    : 'Nothing on this card is editable. Reject with a reason instead.'
                }
              >
                Approve with edits
              </button>
            </div>
          )
        ) : null}
      </div>
    </article>
  )
}
