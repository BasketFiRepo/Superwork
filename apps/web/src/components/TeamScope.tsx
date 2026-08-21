'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Which team this belongs to (§4.3, ADR 0064).
 *
 * One control for tasks, projects and documents. Scoping work to a team changes who can reach
 * it in both directions — people on the team gain it, and anybody whose only route was a
 * team-scoped grant loses it — so it says what will happen before it happens, and asks why.
 *
 * The counts beside each team are the point of the sentence rather than decoration: a team
 * whose members read below this row's classification is a scope that grants nothing, and
 * somebody should learn that from the picker rather than from nobody mentioning the file.
 */

export interface TeamScopeOption {
  id: string
  name: string
  memberCount: number
  clearedCount: number
}

const NOUN: Record<string, string> = {
  task: 'task',
  project: 'project',
  document: 'document',
}

export function TeamScope({
  entity,
  id,
  sensitivity,
  teamId,
  teamName,
  options,
  canScope,
  refusal,
}: {
  entity: 'task' | 'project' | 'document'
  id: string
  sensitivity: string
  teamId: string | null
  teamName: string | null
  options: TeamScopeOption[]
  canScope: boolean
  refusal: string | null
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [value, setValue] = useState(teamId ?? '')
  const [reason, setReason] = useState('')

  const chosen = options.find((option) => option.id === value)
  const changed = value !== (teamId ?? '')
  const noun = NOUN[entity] ?? 'work'

  async function save() {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/team-scope', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entity, id, teamId: value || null, reason }),
    })
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(false)
    if (!response.ok) {
      setError(payload.error)
      return
    }
    setReason('')
    router.refresh()
  }

  return (
    <section className="panel" data-testid="team-scope">
      <div className="panel-header">
        <h2>Whose work this is</h2>
        <span className="small muted" data-testid="team-scope-state">
          {teamName ? `Scoped to ${teamName}` : 'Not scoped to a team'}
        </span>
      </div>

      <div className="panel-body stack stack-4">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        {options.length === 0 ? (
          <p className="small muted" style={{ margin: 0 }}>
            There are no teams yet. A team is what a guest, or anybody with a team-scoped
            exception, reads through — until one exists there is nothing to scope this to.
          </p>
        ) : !canScope ? (
          <p className="small muted" style={{ margin: 0 }} data-testid="team-scope-refusal">
            {refusal ??
              `Scoping a ${noun} to a team is a change to who can reach it, so it needs a say over the work.`}
          </p>
        ) : (
          <>
            <label className="stack stack-2" htmlFor="team-scope-team">
              <span className="micro">Team</span>
              <select
                id="team-scope-team"
                className="select"
                value={value}
                disabled={busy}
                onChange={(event) => setValue(event.target.value)}
              >
                <option value="">No team — reachable by department and role as usual</option>
                {options.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name} ({option.memberCount}{' '}
                    {option.memberCount === 1 ? 'person' : 'people'})
                  </option>
                ))}
              </select>
            </label>

            <p className="small secondary prose" style={{ margin: 0 }} data-testid="team-scope-effect">
              {chosen ? (
                chosen.memberCount === 0 ? (
                  <>
                    <strong>{chosen.name}</strong> has nobody on it, so this would reach no one
                    new. Add people to the team first.
                  </>
                ) : chosen.clearedCount === chosen.memberCount ? (
                  <>
                    All {chosen.memberCount} people on <strong>{chosen.name}</strong> will be
                    able to reach this. Anybody whose only route to it is a team-scoped grant —
                    a guest, for instance — loses it unless they are on that team.
                  </>
                ) : (
                  <>
                    <strong>{chosen.clearedCount}</strong> of the {chosen.memberCount} people on{' '}
                    <strong>{chosen.name}</strong> will be able to reach this; the rest read
                    below <strong>{sensitivity}</strong> and will not see it even once it is
                    theirs. Reclassify it, or raise their access, if that is not what you meant.
                  </>
                )
              ) : (
                <>
                  Without a team, this is reachable the ordinary way: by department, by role, or
                  because it is yours.
                </>
              )}
            </p>

            <label className="stack stack-2" htmlFor="team-scope-reason">
              <span className="micro">Why</span>
              <input
                id="team-scope-reason"
                className="input"
                data-testid="team-scope-reason"
                value={reason}
                disabled={busy || !changed}
                placeholder="Access wants a reason — the same one asked for when a person joins a team"
                onChange={(event) => setReason(event.target.value)}
              />
            </label>

            <div className="row">
              <button
                className="btn btn-primary"
                data-testid="team-scope-save"
                disabled={busy || !changed || reason.trim().length < 4}
                onClick={save}
              >
                {busy ? 'Saving…' : value ? 'Put it in this team' : 'Take it out of the team'}
              </button>
            </div>
          </>
        )}
      </div>
    </section>
  )
}
