'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Who this is shared with (§4.6).
 *
 * A share is additive and specific: it grants one subject one relation on this one thing,
 * and changes nobody's role. That is the difference from a circulation list, which narrows
 * who may reach a document, and from a team, which is a standing group. The panel says so,
 * because the three are easy to confuse and only one of them takes access away.
 */

export interface ShareRow {
  id: string
  subjectType: 'user' | 'team' | 'department'
  subjectName: string | null
  relation: string
  reason: string | null
  grantedByName: string | null
  expiresAt: string | null
  expired: boolean
  canRevoke: boolean
}

export interface Candidate {
  id: string
  name: string
}

const RELATIONS = [
  { id: 'viewer', label: 'can read it' },
  { id: 'editor', label: 'can change it' },
  { id: 'approver', label: 'can decide on it' },
  { id: 'owner', label: 'owns it' },
]

/** What a share of this kind of thing reaches beyond the thing itself. */
const REACH: Partial<Record<string, string>> = {
  project:
    'Sharing a project also lets them read the work inside it — its tasks — because a project they cannot see the work of is not much of a share. It lends a read, never a say: changing a task still needs access to that task.',
}

export function ShareObject({
  objectType,
  objectId,
  shares,
  people,
  teams,
  relations = ['viewer', 'editor', 'approver', 'owner'],
}: {
  objectType: 'task' | 'document' | 'project' | 'company' | 'knowledge_space'
  objectId: string
  shares: ShareRow[]
  people: Candidate[]
  teams: Candidate[]
  /**
   * The relations this person could actually grant. Offering all four to everybody meant a
   * member could fill the form in and be refused on submit.
   */
  relations?: string[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const [subjectType, setSubjectType] = useState<'user' | 'team'>('user')
  const [subject, setSubject] = useState('')
  const [relation, setRelation] = useState(relations[0] ?? 'viewer')
  const [reason, setReason] = useState('')
  const [expires, setExpires] = useState('')

  async function post(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/shares', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, objectType, objectId }),
    })
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(false)
    if (!response.ok) {
      setError(payload.error)
      return
    }
    setAdding(false)
    setSubject('')
    setReason('')
    setExpires('')
    router.refresh()
  }

  const options = subjectType === 'user' ? people : teams
  const live = shares.filter((entry) => !entry.expired)
  const offered = RELATIONS.filter((option) => relations.includes(option.id))
  const reach = REACH[objectType]

  return (
    <section className="panel" data-testid="share-object">
      <div className="panel-header">
        <h2>Shared with</h2>
        <span className="small muted">
          {live.length === 0 ? 'Nobody in particular' : `${live.length} ${live.length === 1 ? 'grant' : 'grants'}`}
        </span>
      </div>

      <div className="panel-body stack stack-4">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        <p className="prose small secondary" style={{ margin: 0 }}>
          Sharing gives one person or team access to this one thing, and changes nobody&rsquo;s
          role. It only ever adds — it cannot take access away from anybody who already has it,
          and you can only share what you can already do yourself.
        </p>

        {reach ? (
          <p className="prose small secondary" data-testid="share-reach" style={{ margin: 0 }}>
            {reach}
          </p>
        ) : null}

        {shares.length === 0 ? (
          <div className="empty small secondary">
            Not shared with anybody. People reach it through their role, department or team.
          </div>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Who</th>
                  <th style={{ width: 150 }}>May</th>
                  <th>Why, and who gave it</th>
                  <th style={{ width: 130 }}>Until</th>
                  <th style={{ width: 90 }} />
                </tr>
              </thead>
              <tbody>
                {shares.map((entry) => (
                  <tr key={entry.id} data-testid="share-row" style={entry.expired ? { opacity: 0.55 } : undefined}>
                    <td>
                      {entry.subjectName ?? 'somebody since removed'}
                      <div className="small muted">{entry.subjectType}</div>
                    </td>
                    <td className="small secondary">
                      {RELATIONS.find((option) => option.id === entry.relation)?.label ?? entry.relation}
                    </td>
                    <td className="small secondary">
                      {entry.reason ?? '—'}
                      {entry.grantedByName ? <div className="small muted">{entry.grantedByName}</div> : null}
                    </td>
                    <td className="small secondary">
                      {entry.expired ? (
                        <span className="chip">lapsed {entry.expiresAt?.slice(0, 10)}</span>
                      ) : (
                        (entry.expiresAt?.slice(0, 10) ?? 'no end date')
                      )}
                    </td>
                    <td>
                      <button
                        className="btn btn-ghost small"
                        data-testid="share-revoke"
                        disabled={busy || !entry.canRevoke}
                        title={
                          entry.canRevoke
                            ? undefined
                            : 'Somebody else granted this, and you cannot change this thing. Ask them, or an admin.'
                        }
                        onClick={() => post({ action: 'unshare', tupleId: entry.id })}
                      >
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {adding ? (
          <div className="stack stack-4" data-testid="share-editor">
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <label className="stack stack-2" style={{ flex: '0 0 130px' }} htmlFor="share-kind">
                <span className="micro">Share with a</span>
                <select
                  id="share-kind"
                  className="select"
                  value={subjectType}
                  onChange={(event) => {
                    setSubjectType(event.target.value as 'user' | 'team')
                    setSubject('')
                  }}
                >
                  <option value="user">person</option>
                  <option value="team">team</option>
                </select>
              </label>
              <label className="stack stack-2" style={{ flex: '1 1 220px' }} htmlFor="share-subject">
                <span className="micro">Which</span>
                <select
                  id="share-subject"
                  className="select"
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                >
                  <option value="">Choose…</option>
                  {options.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="stack stack-2" style={{ flex: '0 0 180px' }} htmlFor="share-relation">
                <span className="micro">So that they</span>
                <select
                  id="share-relation"
                  className="select"
                  value={relation}
                  onChange={(event) => setRelation(event.target.value)}
                >
                  {offered.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <label className="stack stack-2" style={{ flex: '2 1 300px' }} htmlFor="share-reason">
                <span className="micro">Why? (the person pruning this in six months will want it)</span>
                <input
                  id="share-reason"
                  className="input"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Covering the Halden renewal while David is away."
                />
              </label>
              <label className="stack stack-2" style={{ flex: '0 0 180px' }} htmlFor="share-expires">
                <span className="micro">Until (optional)</span>
                <input
                  id="share-expires"
                  className="input"
                  type="date"
                  value={expires}
                  onChange={(event) => setExpires(event.target.value)}
                />
              </label>
            </div>
            <p className="small muted" style={{ margin: 0 }}>
              A share with an end date stops counting the moment it passes — it is not deleted,
              so &ldquo;they lost it on Tuesday&rdquo; stays answerable.
            </p>
            <div className="row">
              <button
                className="btn btn-primary"
                data-testid="share-confirm"
                disabled={busy || !subject}
                onClick={() =>
                  post({
                    action: 'share',
                    subjectType,
                    subjectId: subject,
                    relation,
                    reason: reason || undefined,
                    expiresAt: expires ? new Date(`${expires}T23:59:59Z`).toISOString() : null,
                  })
                }
              >
                Share it
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : offered.length === 0 ? (
          <div className="empty small secondary" data-testid="share-not-yours">
            You can read this but not hand it on. Sharing passes on something you hold, so it
            needs at least your own access to give.
          </div>
        ) : (
          <div className="row">
            <button
              className="btn"
              data-testid="share-add"
              disabled={busy}
              onClick={() => {
                setAdding(true)
                setError(null)
              }}
            >
              Share it with somebody
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
