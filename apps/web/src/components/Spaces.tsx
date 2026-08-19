'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Link } from '@/components/Link'

/**
 * Shelves (§8.1, ADR 0036).
 *
 * ADR 0025 said it plainly and left it: spaces are read, shared and filed into, and not
 * authored. Until now the only shelf any organization had was the one the seed made, so
 * "file this under…" offered exactly one answer.
 *
 * A space's default classification is what documents filed into it start at — not a
 * statement about the space — and it cannot be set above what the person creating it may
 * read themselves.
 */

export interface SpaceRow {
  id: string
  name: string
  slug: string
  description: string | null
  defaultSensitivity: string
  documentCount: number
}

export function Spaces({ spaces, canEdit }: { spaces: SpaceRow[]; canEdit: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [sensitivity, setSensitivity] = useState('internal')

  async function post(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/spaces', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(false)
    if (!response.ok) {
      setError(payload.error)
      return
    }
    setAdding(false)
    setName('')
    setDescription('')
    router.refresh()
  }

  return (
    <section className="panel" data-testid="spaces">
      <div className="panel-header">
        <h2>Spaces</h2>
        <span className="small muted">{spaces.length}</span>
      </div>

      <div className="panel-body stack stack-4">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        {spaces.length === 0 ? (
          <div className="empty small secondary">No shelves yet.</div>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Space</th>
                  <th style={{ width: 140 }}>Filed here</th>
                  <th style={{ width: 150 }}>New documents</th>
                  {canEdit ? <th style={{ width: 100 }} /> : null}
                </tr>
              </thead>
              <tbody>
                {spaces.map((space) => (
                  <tr key={space.id} data-testid="space-row">
                    <td>
                      <Link href={`/knowledge/spaces/${space.id}`}>{space.name}</Link>
                      {space.description ? <div className="small muted">{space.description}</div> : null}
                    </td>
                    <td className="num">{space.documentCount}</td>
                    <td className="small secondary">start {space.defaultSensitivity}</td>
                    {canEdit ? (
                      <td>
                        <button
                          className="btn btn-ghost small"
                          data-testid="space-archive"
                          disabled={busy}
                          onClick={() =>
                            post({ action: 'archive', id: space.id, reason: 'This shelf is not used any more.' })
                          }
                        >
                          Archive
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {canEdit ? (
          adding ? (
            <div className="stack stack-3" data-testid="space-editor">
              <div className="row wrap" style={{ alignItems: 'flex-end' }}>
                <label className="stack stack-2" style={{ flex: '1 1 220px' }} htmlFor="space-name">
                  <span className="micro">Name</span>
                  <input
                    id="space-name"
                    className="input"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    placeholder="Customs procedures"
                  />
                </label>
                <label className="stack stack-2" style={{ flex: '0 0 190px' }} htmlFor="space-sensitivity">
                  <span className="micro">Documents start at</span>
                  <select
                    id="space-sensitivity"
                    className="select"
                    value={sensitivity}
                    onChange={(event) => setSensitivity(event.target.value)}
                  >
                    {['public', 'internal', 'confidential', 'restricted'].map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="stack stack-2" htmlFor="space-description">
                <span className="micro">What belongs on it (optional)</span>
                <input
                  id="space-description"
                  className="input"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
              <p className="small muted" style={{ margin: 0 }}>
                A shelf is a container: sharing it lends a read of what is filed on it, never a say.
                Each document is still checked against its own classification.
              </p>
              <div className="row wrap">
                <button
                  className="btn btn-primary"
                  data-testid="space-confirm"
                  disabled={busy || name.trim().length < 2}
                  onClick={() =>
                    post({
                      action: 'create',
                      name: name.trim(),
                      description: description.trim() || null,
                      defaultSensitivity: sensitivity,
                    })
                  }
                >
                  {busy ? 'Working…' : 'Make the shelf'}
                </button>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setAdding(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="row">
              <button className="btn" data-testid="space-add" disabled={busy} onClick={() => setAdding(true)}>
                Make a space
              </button>
            </div>
          )
        ) : null}
      </div>
    </section>
  )
}
