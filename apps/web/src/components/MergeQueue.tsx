'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface Candidate {
  id: string
  similarity: number
  reasons: string[]
  primary: { id: string; name: string; emails: string[]; title: string | null }
  duplicate: { id: string; name: string; emails: string[]; title: string | null }
}

/**
 * Guided merge with field-level resolution (§12.6). Nothing merges automatically, and the
 * loser is tombstoned rather than deleted so history still resolves.
 */
export function MergeQueue({ candidates }: { candidates: Candidate[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [keep, setKeep] = useState<Record<string, Record<string, 'primary' | 'duplicate'>>>({})
  const [note, setNote] = useState<string | null>(null)

  if (candidates.length === 0) return null

  async function resolve(candidateId: string, action: 'merge' | 'reject') {
    setBusy(true)
    const response = await fetch('/api/contacts/merge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, candidateId, keep: keep[candidateId] ?? {} }),
    })
    setBusy(false)
    setNote(response.ok ? (action === 'merge' ? 'Merged.' : 'Kept both.') : 'That could not be applied.')
    router.refresh()
  }

  const setField = (candidateId: string, field: string, value: 'primary' | 'duplicate') =>
    setKeep((current) => ({ ...current, [candidateId]: { ...(current[candidateId] ?? {}), [field]: value } }))

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Possible duplicates — {candidates.length}</h2>
        {note ? <span className="small muted">{note}</span> : null}
      </div>
      <div className="panel-body stack stack-6">
        {candidates.map((candidate) => (
          <div className="stack stack-4" key={candidate.id}>
            <div className="row wrap">
              <strong className="small">
                {candidate.primary.name} · {candidate.duplicate.name}
              </strong>
              <span className="chip">{(candidate.similarity * 100).toFixed(0)}% match</span>
              {candidate.reasons.map((reason) => (
                <span className="small muted" key={reason}>
                  {reason}
                </span>
              ))}
            </div>

            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 110 }}>Field</th>
                    <th>Keep this…</th>
                    <th>…or this</th>
                  </tr>
                </thead>
                <tbody>
                  {(['name', 'title'] as const).map((field) => (
                    <tr key={field}>
                      <td className="small muted">{field}</td>
                      <td>
                        <label className="row-tight small">
                          <input
                            type="radio"
                            name={`${candidate.id}-${field}`}
                            defaultChecked
                            onChange={() => setField(candidate.id, field, 'primary')}
                          />
                          {candidate.primary[field] ?? '—'}
                        </label>
                      </td>
                      <td>
                        <label className="row-tight small">
                          <input
                            type="radio"
                            name={`${candidate.id}-${field}`}
                            onChange={() => setField(candidate.id, field, 'duplicate')}
                          />
                          {candidate.duplicate[field] ?? '—'}
                        </label>
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td className="small muted">emails</td>
                    <td className="small mono" colSpan={2}>
                      {[...new Set([...candidate.primary.emails, ...candidate.duplicate.emails])].join(', ')}
                      <span className="small muted"> — both kept; losing a way to reach someone is worse</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="row">
              <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => resolve(candidate.id, 'merge')}>
                Merge
              </button>
              <button className="btn btn-sm" disabled={busy} onClick={() => resolve(candidate.id, 'reject')}>
                They are different people
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
