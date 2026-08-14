'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'

/**
 * What the assistant thinks it has learned, and the one place a person decides (§9.3).
 *
 * Nothing on this screen is in use until somebody agrees with it. That is the whole
 * arrangement: the assistant notices, a person decides, and every fact keeps the passage
 * it came from so it can be argued with rather than merely trusted.
 */

export interface FactRow {
  id: string
  subject: string
  predicate: string
  object: string
  scopeLabel: string
  confidence: number
  volatile: boolean
  stale: boolean
  documentId: string | null
  documentTitle: string | null
  anchor: string | null
  snippet: string | null
  agreedOn: string | null
  confirmedByName: string | null
  createdAt: string
}

export interface MemoryData {
  candidates: FactRow[]
  confirmed: FactRow[]
  conflicts: { candidate: FactRow; confirmed: FactRow }[]
  stale: FactRow[]
}

function Source({ fact }: { fact: FactRow }) {
  if (!fact.documentId) return <span className="small muted">source removed</span>
  return (
    <Link className="small" href={`/knowledge/${fact.documentId}`}>
      {fact.documentTitle}
      {fact.anchor ? ` › ${fact.anchor}` : ''}
    </Link>
  )
}

export function MemoryReview({ memory }: { memory: MemoryData }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [object, setObject] = useState('')
  const [reason, setReason] = useState('')

  async function post(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/memory', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(false)
    if (!response.ok) {
      setError(payload.error)
      return false
    }
    setEditing(null)
    router.refresh()
    return true
  }

  const editor = (fact: FactRow, mode: 'correct' | 'forget') => (
    <div className="panel-body stack stack-4" data-testid="memory-editor">
      {mode === 'correct' ? (
        <label className="stack stack-2" htmlFor="memory-object">
          <span className="micro">What is it instead?</span>
          <input
            id="memory-object"
            className="input"
            value={object}
            onChange={(event) => setObject(event.target.value)}
          />
        </label>
      ) : null}
      <label className="stack stack-2" htmlFor="memory-reason">
        <span className="micro">{mode === 'correct' ? 'Why did it change?' : 'Why is it being forgotten?'}</span>
        <input
          id="memory-reason"
          className="input"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={mode === 'correct' ? 'Renegotiated in the 2026 contract.' : 'It was never true of this company.'}
        />
      </label>
      <p className="small muted" style={{ margin: 0 }}>
        {mode === 'correct'
          ? 'The old answer is kept and marked superseded, with your name on the change. Nothing is overwritten.'
          : 'The fact stops being recalled. It stays on the record until retention takes it, because “we used ' +
            'to believe this” is a question somebody will ask about an older answer.'}
      </p>
      <div className="row">
        <button
          className={mode === 'correct' ? 'btn btn-primary' : 'btn btn-danger'}
          data-testid={`memory-${mode}-confirm`}
          disabled={busy || reason.trim().length < 4 || (mode === 'correct' && object.trim().length === 0)}
          onClick={() =>
            post(
              mode === 'correct'
                ? { action: 'correct', id: fact.id, object, reason }
                : { action: 'forget', id: fact.id, reason },
            )
          }
        >
          {mode === 'correct' ? 'Save the correction' : 'Forget it'}
        </button>
        <button className="btn btn-ghost" disabled={busy} onClick={() => setEditing(null)}>
          Cancel
        </button>
      </div>
    </div>
  )

  return (
    <div className="stack stack-8">
      {error ? (
        <div className="banner banner-critical" role="alert">
          {error}
        </div>
      ) : null}

      {memory.conflicts.length > 0 ? (
        <section className="panel" data-testid="memory-conflicts" style={{ borderColor: 'var(--attention)' }}>
          <div className="panel-header">
            <h2>Two answers to the same question</h2>
            <span className="small muted">Nothing changes until you pick one</span>
          </div>
          <div className="panel-body stack stack-5">
            {memory.conflicts.map(({ candidate, confirmed }) => (
              <div className="stack stack-3" key={candidate.id} data-testid="memory-conflict">
                <span className="micro">
                  {confirmed.subject} · {confirmed.predicate}
                </span>
                <div className="row wrap" style={{ gap: 16 }}>
                  <div className="stack stack-2" style={{ flex: '1 1 260px' }}>
                    <span className="chip">agreed</span>
                    <strong>{confirmed.object}</strong>
                    <Source fact={confirmed} />
                  </div>
                  <div className="stack stack-2" style={{ flex: '1 1 260px' }}>
                    <span className="chip chip-attention">now says</span>
                    <strong>{candidate.object}</strong>
                    <Source fact={candidate} />
                  </div>
                </div>
                <div className="row">
                  <button
                    className="btn"
                    data-testid="memory-conflict-accept"
                    disabled={busy}
                    onClick={() => {
                      setEditing(`conflict-correct:${confirmed.id}`)
                      setObject(candidate.object)
                      setReason('')
                    }}
                  >
                    Take the new one
                  </button>
                  <button
                    className="btn btn-ghost"
                    disabled={busy}
                    onClick={() => {
                      setEditing(`conflict-forget:${candidate.id}`)
                      setReason('')
                    }}
                  >
                    Keep what we had
                  </button>
                </div>
                {/* Keyed per section: the same fact appears here and in the table below,
                    and a shared key opens both editors at once. */}
                {editing === `conflict-correct:${confirmed.id}` ? editor(confirmed, 'correct') : null}
                {editing === `conflict-forget:${candidate.id}` ? editor(candidate, 'forget') : null}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="panel" data-testid="memory-candidates">
        <div className="panel-header">
          <h2>Noticed, not yet agreed</h2>
          <span className="small muted">The assistant never uses these until somebody says so</span>
        </div>
        {memory.candidates.length === 0 ? (
          <div className="empty small secondary">
            Nothing is waiting. Facts appear here after the assistant answers a question from a document.
          </div>
        ) : (
          <div className="panel-body-flush">
            {memory.candidates.map((fact) => (
              <div className="panel-body hairline-bottom stack stack-3" key={fact.id} data-testid="memory-candidate">
                <div className="row wrap" style={{ justifyContent: 'space-between', gap: 12 }}>
                  <div className="stack stack-2" style={{ flex: '1 1 400px' }}>
                    <span>
                      <strong>{fact.subject}</strong> {fact.predicate} <strong>{fact.object}</strong>
                    </span>
                    <span className="small muted">
                      About {fact.scopeLabel} · <Source fact={fact} />
                      {fact.volatile ? ' · this is the kind of figure that moves' : ''}
                    </span>
                  </div>
                  <div className="row">
                    <button
                      className="btn"
                      data-testid="memory-confirm"
                      disabled={busy}
                      onClick={() => post({ action: 'confirm', id: fact.id })}
                    >
                      Yes, that&rsquo;s right
                    </button>
                    <button
                      className="btn btn-ghost"
                      data-testid="memory-correct"
                      disabled={busy}
                      onClick={() => {
                        setEditing(`candidate-correct:${fact.id}`)
                        setObject(fact.object)
                        setReason('')
                      }}
                    >
                      Not quite
                    </button>
                    <button
                      className="btn btn-ghost"
                      disabled={busy}
                      onClick={() => {
                        setEditing(`candidate-forget:${fact.id}`)
                        setReason('')
                      }}
                    >
                      Drop it
                    </button>
                  </div>
                </div>
                {fact.snippet ? (
                  <blockquote className="small secondary" style={{ margin: 0 }}>
                    “{fact.snippet.slice(0, 240)}”
                  </blockquote>
                ) : null}
                {editing === `candidate-correct:${fact.id}` ? editor(fact, 'correct') : null}
                {editing === `candidate-forget:${fact.id}` ? editor(fact, 'forget') : null}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel" data-testid="memory-confirmed">
        <div className="panel-header">
          <h2>What we take to be true</h2>
          <span className="small muted">
            {memory.confirmed.length} agreed {memory.confirmed.length === 1 ? 'fact' : 'facts'}
            {memory.stale.length > 0 ? ` · ${memory.stale.length} worth checking again` : ''}
          </span>
        </div>
        {memory.confirmed.length === 0 ? (
          <div className="empty small secondary">
            Nothing has been agreed yet, so the assistant answers only from documents it reads each time.
          </div>
        ) : (
          <div className="panel-body-flush table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>What</th>
                  <th style={{ width: 150 }}>About</th>
                  <th style={{ width: 200 }}>Source</th>
                  <th style={{ width: 170 }}>Agreed</th>
                  <th style={{ width: 150 }} />
                </tr>
              </thead>
              <tbody>
                {memory.confirmed.map((fact) => (
                  <tr key={fact.id} data-testid="memory-fact">
                    <td>
                      {fact.subject} {fact.predicate} <strong>{fact.object}</strong>
                      {fact.stale ? (
                        <div className="small muted">
                          Agreed a while ago and this kind of figure moves — worth checking.
                        </div>
                      ) : null}
                    </td>
                    <td className="small secondary">{fact.scopeLabel}</td>
                    <td>
                      <Source fact={fact} />
                    </td>
                    <td className="small secondary">
                      {fact.agreedOn?.slice(0, 10)}
                      {fact.confirmedByName ? ` · ${fact.confirmedByName}` : ''}
                    </td>
                    <td>
                      <div className="row">
                        <button
                          className="btn btn-ghost small"
                          data-testid="memory-fact-correct"
                          disabled={busy}
                          onClick={() => {
                            setEditing(`correct:${fact.id}`)
                            setObject(fact.object)
                            setReason('')
                          }}
                        >
                          Correct
                        </button>
                        <button
                          className="btn btn-ghost small"
                          disabled={busy}
                          onClick={() => {
                            setEditing(`forget:${fact.id}`)
                            setReason('')
                          }}
                        >
                          Forget
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {memory.confirmed.map((fact) =>
          editing === `correct:${fact.id}` ? (
            <div key={`c-${fact.id}`}>{editor(fact, 'correct')}</div>
          ) : editing === `forget:${fact.id}` ? (
            <div key={`f-${fact.id}`}>{editor(fact, 'forget')}</div>
          ) : null,
        )}
      </section>
    </div>
  )
}
