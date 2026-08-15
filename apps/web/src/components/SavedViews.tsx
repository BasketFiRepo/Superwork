'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Saved views on a list screen (§17).
 *
 * A view is a saved *question*, not a share. Opening one runs the same scope-aware read as
 * the screen it lives on, so two people opening the same shared view can see different rows —
 * which is the only way a shared view can be safe.
 */

export interface SavedViewRow {
  id: string
  name: string
  entity: 'task' | 'inbox'
  query: { filter?: string; q?: string; view?: string }
  shared: boolean
  mine: boolean
  ownerName: string | null
}

function href(entity: 'task' | 'inbox', query: SavedViewRow['query']): string {
  const params = new URLSearchParams()
  if (entity === 'task') {
    if (query.filter) params.set('filter', query.filter)
    if (query.q) params.set('q', query.q)
  } else if (query.view) {
    params.set('view', query.view)
  }
  const path = entity === 'task' ? '/tasks' : '/inbox'
  const search = params.toString()
  return search ? `${path}?${search}` : path
}

export function SavedViews({
  entity,
  views,
  current,
  activeId,
}: {
  entity: 'task' | 'inbox'
  views: SavedViewRow[]
  /** What the screen is showing right now — what "Save this view" would save. */
  current: { filter?: string; q?: string; view?: string }
  activeId: string | null
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [shared, setShared] = useState(false)

  const empty = Object.values(current).every((value) => !value)

  async function post(payload: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/saved-views', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const result = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(false)
    if (!response.ok) {
      setError(result.error)
      return
    }
    setNaming(false)
    setName('')
    setShared(false)
    router.refresh()
  }

  return (
    <div className="stack stack-2" data-testid="saved-views">
      {error ? (
        <div className="banner banner-critical" role="alert">
          {error}
        </div>
      ) : null}

      <div className="row wrap" style={{ alignItems: 'center' }}>
        {views.length === 0 ? (
          <span className="small muted">
            No saved views yet. Filter or search, then save what you are looking at.
          </span>
        ) : (
          views.map((view) => (
            <span key={view.id} className="row-tight" data-testid="saved-view">
              <a
                href={href(view.entity, view.query)}
                className={`btn btn-sm${activeId === view.id ? ' btn-primary' : ''}`}
              >
                {view.name}
                {view.shared && !view.mine ? (
                  <span className="small muted"> · {view.ownerName ?? 'a colleague'}</span>
                ) : null}
                {view.shared && view.mine ? <span className="small muted"> · shared</span> : null}
              </a>
              {view.mine ? (
                <button
                  className="btn btn-ghost small"
                  data-testid="saved-view-delete"
                  aria-label={`Delete the view ${view.name}`}
                  disabled={busy}
                  onClick={() => post({ action: 'delete', id: view.id })}
                >
                  ×
                </button>
              ) : null}
            </span>
          ))
        )}

        {naming ? null : (
          <button
            className="btn btn-sm"
            data-testid="saved-view-add"
            disabled={busy || empty}
            title={empty ? 'Choose a filter or type a search first.' : undefined}
            onClick={() => setNaming(true)}
          >
            Save this view
          </button>
        )}
      </div>

      {naming ? (
        <div className="row wrap" style={{ alignItems: 'flex-end' }} data-testid="saved-view-editor">
          <label className="stack stack-2" style={{ flex: '1 1 240px' }} htmlFor="saved-view-name">
            <span className="micro">Call it</span>
            <input
              id="saved-view-name"
              className="input"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Mine, overdue"
            />
          </label>
          <label className="row-tight small secondary" htmlFor="saved-view-shared">
            <input
              id="saved-view-shared"
              type="checkbox"
              checked={shared}
              onChange={(event) => setShared(event.target.checked)}
            />
            Share it with everybody
          </label>
          <button
            className="btn btn-primary"
            data-testid="saved-view-confirm"
            disabled={busy || name.trim().length < 2}
            onClick={() => post({ action: 'save', name: name.trim(), entity, query: current, shared })}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button className="btn btn-ghost" disabled={busy} onClick={() => setNaming(false)}>
            Cancel
          </button>
        </div>
      ) : null}

      {naming ? (
        <p className="small muted" style={{ margin: 0 }}>
          A shared view is a saved question, not access. Everybody who opens it sees the rows they
          could already see — which for two people is often not the same rows.
        </p>
      ) : null}
    </div>
  )
}
