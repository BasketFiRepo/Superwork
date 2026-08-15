'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Teams (§4.3).
 *
 * A team is not a department. A department is where somebody sits and there is one of them
 * per person; a team is what somebody is working on, there can be several, and people join
 * and leave constantly. Membership here is a grant of access — everything scoped to the
 * team becomes readable on the member's next request — so it asks for a reason, the way
 * every other grant in this product does.
 */

export interface TeamMemberRow {
  userId: string
  name: string
  role: 'lead' | 'member'
  reason: string | null
}

export interface TeamRow {
  id: string
  name: string
  purpose: string | null
  departmentName: string | null
  members: TeamMemberRow[]
  counts: { tasks: number; projects: number; documents: number }
}

export interface PersonRow {
  id: string
  name: string
  role: string
}

export function TeamsAdmin({ teams, people }: { teams: TeamRow[]; people: PersonRow[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [purpose, setPurpose] = useState('')
  const [joining, setJoining] = useState<string | null>(null)
  const [who, setWho] = useState('')
  // One state per editor. Sharing a single `reason` meant typing into the join editor
  // silently changed what the disband editor would submit, and vice versa.
  const [memberReason, setMemberReason] = useState('')
  const [archiveReason, setArchiveReason] = useState('')
  const [leadRole, setLeadRole] = useState<'lead' | 'member'>('member')
  const [archiving, setArchiving] = useState<string | null>(null)

  async function post(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/teams', {
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
    setCreating(false)
    setJoining(null)
    setArchiving(null)
    setName('')
    setPurpose('')
    setWho('')
    setMemberReason('')
    setArchiveReason('')
    router.refresh()
  }

  return (
    <div className="stack stack-8">
      {error ? (
        <div className="banner banner-critical" role="alert">
          {error}
        </div>
      ) : null}

      <section className="panel" data-testid="teams">
        <div className="panel-header">
          <h2>Teams</h2>
          <span className="small muted">
            {teams.length === 0 ? 'None yet' : `${teams.length} ${teams.length === 1 ? 'team' : 'teams'}`}
          </span>
        </div>

        {teams.length === 0 ? (
          <div className="empty small secondary">
            No teams. Anything scoped to a team is invisible until somebody is on it — including to
            people who would otherwise be able to read it.
          </div>
        ) : (
          <div className="panel-body-flush">
            {teams.map((team) => (
              <div className="panel-body hairline-bottom stack stack-3" key={team.id} data-testid="team-row">
                <div className="row wrap" style={{ justifyContent: 'space-between', gap: 12 }}>
                  <div className="stack stack-2" style={{ flex: '1 1 320px' }}>
                    <strong>{team.name}</strong>
                    {team.purpose ? <span className="small secondary">{team.purpose}</span> : null}
                    <span className="small muted">
                      {team.departmentName ? `${team.departmentName} · ` : ''}
                      {team.counts.tasks} tasks · {team.counts.projects} projects ·{' '}
                      {team.counts.documents} documents scoped to it
                    </span>
                  </div>
                  <div className="row">
                    <button
                      className="btn btn-ghost small"
                      data-testid="team-add-member"
                      disabled={busy}
                      onClick={() => {
                        setJoining(joining === team.id ? null : team.id)
                        setArchiving(null)
                        setMemberReason('')
                        setWho('')
                        setError(null)
                      }}
                    >
                      Add somebody
                    </button>
                    <button
                      className="btn btn-ghost small"
                      data-testid="team-archive"
                      disabled={busy}
                      onClick={() => {
                        setArchiving(archiving === team.id ? null : team.id)
                        setJoining(null)
                        setArchiveReason('')
                        setError(null)
                      }}
                    >
                      Disband
                    </button>
                  </div>
                </div>

                {team.members.length === 0 ? (
                  <span className="small muted">Nobody is on it, so nothing scoped to it is reachable.</span>
                ) : (
                  <div className="row wrap">
                    {team.members.map((member) => (
                      <span className="row-tight small" key={member.userId} data-testid="team-member">
                        <span className={member.role === 'lead' ? 'chip chip-accent' : 'chip'}>
                          {member.name}
                          {member.role === 'lead' ? ' · lead' : ''}
                        </span>
                        <button
                          className="btn btn-ghost small"
                          disabled={busy}
                          onClick={() =>
                            post({
                              action: 'remove_member',
                              teamId: team.id,
                              userId: member.userId,
                              reason: 'Removed from the team.',
                            })
                          }
                        >
                          remove
                        </button>
                      </span>
                    ))}
                  </div>
                )}

                {joining === team.id ? (
                  <div className="stack stack-3" data-testid="team-member-editor">
                    <div className="row wrap" style={{ alignItems: 'flex-end' }}>
                      <label className="stack stack-2" style={{ flex: '1 1 220px' }} htmlFor="team-who">
                        <span className="micro">Who</span>
                        <select
                          id="team-who"
                          className="select"
                          value={who}
                          onChange={(event) => setWho(event.target.value)}
                        >
                          <option value="">Choose…</option>
                          {people
                            .filter((person) => !team.members.some((member) => member.userId === person.id))
                            .map((person) => (
                              <option key={person.id} value={person.id}>
                                {person.name} · {person.role}
                              </option>
                            ))}
                        </select>
                      </label>
                      <label className="stack stack-2" style={{ flex: '0 0 130px' }} htmlFor="team-role">
                        <span className="micro">As</span>
                        <select
                          id="team-role"
                          className="select"
                          value={leadRole}
                          onChange={(event) => setLeadRole(event.target.value as 'lead' | 'member')}
                        >
                          <option value="member">member</option>
                          <option value="lead">lead</option>
                        </select>
                      </label>
                    </div>
                    <label className="stack stack-2" htmlFor="team-reason">
                      <span className="micro">Why do they need it?</span>
                      <input
                        id="team-reason"
                        className="input"
                        value={memberReason}
                        onChange={(event) => setMemberReason(event.target.value)}
                        placeholder="Running the commercial terms."
                      />
                    </label>
                    <p className="small muted" style={{ margin: 0 }}>
                      Everything scoped to this team becomes readable by them on their next request.
                    </p>
                    <div className="row">
                      <button
                        className="btn btn-primary"
                        data-testid="team-member-confirm"
                        disabled={busy || !who || memberReason.trim().length < 4}
                        onClick={() =>
                          post({
                            action: 'add_member',
                            teamId: team.id,
                            userId: who,
                            role: leadRole,
                            reason: memberReason,
                          })
                        }
                      >
                        Add them
                      </button>
                      <button className="btn btn-ghost" disabled={busy} onClick={() => setJoining(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}

                {archiving === team.id ? (
                  <div className="stack stack-3" data-testid="team-archive-editor">
                    <label className="stack stack-2" htmlFor="team-archive-reason">
                      <span className="micro">Why is it being disbanded?</span>
                      <input
                        id="team-archive-reason"
                        className="input"
                        value={archiveReason}
                        onChange={(event) => setArchiveReason(event.target.value)}
                        placeholder="Renewal closed; the work moved to Commercial."
                      />
                    </label>
                    <p className="small muted" style={{ margin: 0 }}>
                      Refused while anything is still scoped to it — everybody who reached that work
                      through this team would lose it with no visible reason.
                    </p>
                    <div className="row">
                      <button
                        className="btn btn-danger"
                        data-testid="team-archive-confirm"
                        disabled={busy || archiveReason.trim().length < 4}
                        onClick={() => post({ action: 'archive', teamId: team.id, reason: archiveReason })}
                      >
                        Disband it
                      </button>
                      <button className="btn btn-ghost" disabled={busy} onClick={() => setArchiving(null)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}

        <div className="panel-body">
          {creating ? (
            <div className="stack stack-4" data-testid="team-editor">
              <label className="stack stack-2" htmlFor="team-name">
                <span className="micro">Name</span>
                <input
                  id="team-name"
                  className="input"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Halden renewal"
                />
              </label>
              <label className="stack stack-2" htmlFor="team-purpose">
                <span className="micro">What is it for?</span>
                <input
                  id="team-purpose"
                  className="input"
                  value={purpose}
                  onChange={(event) => setPurpose(event.target.value)}
                  placeholder="Everything touching the 2026 Halden renewal."
                />
              </label>
              <div className="row">
                <button
                  className="btn btn-primary"
                  data-testid="team-create-confirm"
                  disabled={busy || name.trim().length < 2}
                  onClick={() => post({ action: 'create', name, purpose: purpose || null })}
                >
                  Create it
                </button>
                <button className="btn btn-ghost" disabled={busy} onClick={() => setCreating(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button className="btn btn-primary" data-testid="team-create" onClick={() => setCreating(true)}>
              New team
            </button>
          )}
        </div>
      </section>
    </div>
  )
}
