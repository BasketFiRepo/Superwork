'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Which team a task belongs to (§4.3).
 *
 * Scoping work to a team is a change to who can reach it, in both directions: people on the
 * team gain it, and anybody whose only route to it was a team-scoped grant loses it. The
 * control says so rather than reading like a label.
 */
export function TaskTeam({
  taskId,
  teamId,
  teams,
}: {
  taskId: string
  teamId: string | null
  teams: { id: string; name: string; memberCount: number }[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [value, setValue] = useState(teamId ?? '')

  const current = teams.find((team) => team.id === value)

  return (
    <section className="panel" data-testid="task-team">
      <div className="panel-header">
        <h2>Whose work this is</h2>
        <span className="small muted">
          {teamId ? 'Scoped to a team' : 'Not scoped to a team'}
        </span>
      </div>
      <div className="panel-body stack stack-4">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        <label className="stack stack-2" htmlFor="task-team">
          <span className="micro">Team</span>
          <select
            id="task-team"
            className="select"
            value={value}
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
          >
            <option value="">No team — visible by department and role as usual</option>
            {teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.name} ({team.memberCount} {team.memberCount === 1 ? 'person' : 'people'})
              </option>
            ))}
          </select>
        </label>

        <p className="small muted" style={{ margin: 0 }}>
          {current
            ? `The ${current.memberCount} people on ${current.name} will be able to reach this. ` +
              'Anybody whose only route to it is a team-scoped role — a guest, for instance — loses it ' +
              'unless they are on that team.'
            : 'Without a team, this is reachable the ordinary way: by department, by role, or because it is yours.'}
        </p>

        <div className="row">
          <button
            className="btn btn-primary"
            data-testid="task-team-save"
            disabled={busy || value === (teamId ?? '')}
            onClick={async () => {
              setBusy(true)
              setError(null)
              const response = await fetch(`/api/tasks/${taskId}/team`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ teamId: value || null }),
              })
              const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
              setBusy(false)
              if (!response.ok) {
                setError(payload.error)
                return
              }
              router.refresh()
            }}
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </section>
  )
}
