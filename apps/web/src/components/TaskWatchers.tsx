'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Following a task (§12).
 *
 * Until now the only person a task told anything to was its assignee. Following it means
 * hearing when it changes hands, changes status, is renamed or moves — and nothing else.
 *
 * Watching grants nothing: you can only follow what you can already read, and every message
 * is written after re-checking that you could still open the task. It is also not a
 * monitoring surface — the list says who is following this task, not what anybody is doing.
 */

export interface WatcherRow {
  userId: string
  name: string
  isYou: boolean
}

export function TaskWatchers({ taskId, watchers }: { taskId: string; watchers: WatcherRow[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const following = watchers.some((row) => row.isYou)
  const others = watchers.filter((row) => !row.isYou)

  async function post(action: 'watch' | 'unwatch') {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/task-watchers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, taskId }),
    })
    const result = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(false)
    if (!response.ok) {
      setError(result.error)
      return
    }
    router.refresh()
  }

  return (
    <section className="panel" data-testid="task-watchers">
      <div className="panel-header">
        <h2>Following</h2>
        <span className="small muted">
          {watchers.length === 0 ? 'Nobody' : `${watchers.length} ${watchers.length === 1 ? 'person' : 'people'}`}
        </span>
      </div>

      <div className="panel-body stack stack-3">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        <div className="row wrap">
          <button
            className={`btn${following ? '' : ' btn-primary'}`}
            data-testid={following ? 'task-unwatch' : 'task-watch'}
            disabled={busy}
            onClick={() => post(following ? 'unwatch' : 'watch')}
          >
            {busy ? 'Saving…' : following ? 'Stop following' : 'Follow this task'}
          </button>
        </div>

        {others.length === 0 ? (
          <p className="small muted" style={{ margin: 0 }}>
            {following
              ? 'Only you. You will hear when it changes hands, changes status, is renamed or the date moves.'
              : 'Nobody is following this. Following it tells you when it changes hands, changes status, is renamed or the date moves — and nothing else.'}
          </p>
        ) : (
          <p className="small secondary" style={{ margin: 0 }} data-testid="task-watcher-names">
            {others.map((row) => row.name).join(', ')}
            {following ? ' and you' : ''} {others.length === 1 && !following ? 'is' : 'are'} following this.
          </p>
        )}
      </div>
    </section>
  )
}
