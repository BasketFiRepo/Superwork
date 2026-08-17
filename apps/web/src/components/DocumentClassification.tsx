'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useStepUp } from './StepUp'

/**
 * Who decided this was confidential (§4.3, ADR 0044).
 *
 * `documents.sensitivity_source` was written by nothing and could not be: there was no way for a
 * person to change a classification at all. So every level in Superwork was a regex's opinion
 * recorded as though nobody had one, a misclassification had no fix, and an auditor could not
 * tell a weighed decision from a guessed one.
 */

const LEVELS = ['public', 'internal', 'confidential', 'restricted'] as const
const RANK: Record<string, number> = { public: 0, internal: 1, confidential: 2, restricted: 3 }

export function DocumentClassification({
  documentId,
  sensitivity,
  source,
  auto,
  setByName,
  setAt,
  reason,
}: {
  documentId: string
  sensitivity: string
  source: 'auto' | 'human'
  auto: string | null
  setByName: string | null
  setAt: string | null
  reason: string | null
}) {
  const router = useRouter()
  const stepUp = useStepUp()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [level, setLevel] = useState(sensitivity)
  const [why, setWhy] = useState('')

  const classifierReads = auto ?? sensitivity
  const lowering = RANK[level]! < RANK[classifierReads]!

  async function post(body: Record<string, unknown>, stepped: boolean) {
    setBusy(true)
    setError(null)
    const send = () =>
      fetch('/api/document-classification', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ documentId, ...body }),
      })
    const response = stepped ? await stepUp.run(send) : await send()
    setBusy(false)
    if (!response) return
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    if (!response.ok) {
      setError(payload.error)
      return
    }
    setEditing(false)
    setWhy('')
    router.refresh()
  }

  return (
    <section className="panel" data-testid="document-classification">
      {/* Asked for beside the thing it protects, not at the top of the page. */}
      {stepUp.prompt}

      <div className="panel-header">
        <h2>Classification</h2>
        <span className="small muted">
          {sensitivity} · {source === 'human' ? 'decided by a person' : 'read by the classifier'}
        </span>
      </div>

      <div className="panel-body stack stack-3">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        <p className="small secondary" style={{ margin: 0 }} data-testid="classification-summary">
          {source === 'human' ? (
            <>
              <strong>{setByName ?? 'Somebody'}</strong> set this to <strong>{sensitivity}</strong> on{' '}
              {setAt?.slice(0, 10)}. {reason}
              {auto && auto !== sensitivity ? (
                <>
                  {' '}
                  The classifier reads the content as <strong>{auto}</strong>; the person's decision
                  stands, and re-indexing will not put the classifier's back.
                </>
              ) : null}
            </>
          ) : (
            <>
              Read as <strong>{sensitivity}</strong> by the classifier, from patterns in the content.
              Nobody has weighed it. If that is wrong, say so — a classification nobody can
              attribute is one nobody can check.
            </>
          )}
        </p>

        {editing ? (
          <div className="stack stack-3" data-testid="classification-editor">
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <label className="stack stack-2" style={{ flex: '0 0 180px' }} htmlFor="classification-level">
                <span className="micro">Set it to</span>
                <select
                  id="classification-level"
                  className="input"
                  value={level}
                  onChange={(event) => setLevel(event.target.value)}
                >
                  {LEVELS.map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
              <label className="stack stack-2" style={{ flex: '1 1 260px' }} htmlFor="classification-reason">
                <span className="micro">Why</span>
                <input
                  id="classification-reason"
                  className="input"
                  value={why}
                  onChange={(event) => setWhy(event.target.value)}
                  placeholder="The salary figure is an example, not a real one."
                />
              </label>
            </div>

            {lowering ? (
              <div className="banner banner-attention" data-testid="classification-lowering">
                That is below what the classifier read in the content, so it widens who can retrieve
                this document. You will be asked to confirm your password — raising it never asks,
                because raising only ever narrows.
              </div>
            ) : null}

            <div className="row wrap">
              <button
                className="btn btn-primary"
                data-testid="classification-confirm"
                disabled={busy || why.trim().length < 4}
                onClick={() => post({ action: 'set', sensitivity: level, reason: why.trim() }, lowering)}
              >
                {busy ? 'Saving…' : 'Set the classification'}
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="row wrap">
            <button className="btn" data-testid="classification-edit" disabled={busy} onClick={() => setEditing(true)}>
              {source === 'human' ? 'Change it' : 'Decide it yourself'}
            </button>
            {source === 'human' ? (
              <button
                className="btn btn-ghost"
                data-testid="classification-hand-back"
                disabled={busy}
                onClick={() =>
                  post({ action: 'hand_back', reason: 'Handed back to the classifier.' }, false)
                }
              >
                Hand it back to the classifier
              </button>
            ) : null}
          </div>
        )}

        <p className="small muted" style={{ margin: 0 }}>
          A person's decision reaches every passage of the document, which is what retrieval
          actually filters on. Nobody can file something above what they can read themselves.
        </p>
      </div>
    </section>
  )
}
