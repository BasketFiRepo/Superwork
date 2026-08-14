'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useStepUp } from './StepUp'

/**
 * How long things are kept, and erasing one person (§21).
 *
 * Both are irreversible on a schedule, so both say what will happen before it does:
 * a window shows what it is replacing, an erasure shows the whole list — deleted,
 * anonymised, kept and why — before anybody confirms it.
 */

export interface PolicyRow {
  dataClass: string
  label: string
  description: string
  keepDays: number
  minimumDays: number
  isDefault: boolean
  reason: string
  setByName: string | null
  lastAppliedAt: string | null
  lastPurged: number
}

export interface MemberRow {
  id: string
  name: string
  role: string
}

interface PreviewLine {
  table: string
  label: string
  disposition: 'delete' | 'anonymise' | 'keep'
  count: number
  basis: string
}

interface Preview {
  subjectLabel: string
  lines: PreviewLine[]
  totals: { deleted: number; anonymised: number; kept: number }
  blockers: string[]
}

const DISPOSITION: Record<PreviewLine['disposition'], { label: string; chip: string }> = {
  delete: { label: 'deleted', chip: 'chip chip-critical' },
  anonymise: { label: 'anonymised', chip: 'chip chip-attention' },
  keep: { label: 'kept', chip: 'chip' },
}

export function RetentionAdmin({ policies, members }: { policies: PolicyRow[]; members: MemberRow[] }) {
  const router = useRouter()
  const stepUp = useStepUp()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [editing, setEditing] = useState<string | null>(null)
  const [days, setDays] = useState('')
  const [reason, setReason] = useState('')

  const [subject, setSubject] = useState(members[0]?.id ?? '')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [erasureReason, setErasureReason] = useState('')
  const [note, setNote] = useState<string | null>(null)

  async function post(path: string, body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    const response = await stepUp.run(() =>
      fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    )
    setBusy(false)
    if (!response) return null
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    if (!response.ok) {
      setError(payload.error)
      return null
    }
    return payload
  }

  return (
    <div className="stack stack-8">
      {stepUp.prompt}
      {error ? (
        <div className="banner banner-critical" role="alert">
          {error}
        </div>
      ) : null}
      {note ? <div className="banner banner-accent">{note}</div> : null}

      <section className="panel" data-testid="retention">
        <div className="panel-header">
          <h2>How long things are kept</h2>
          <span className="small muted">Defaults come from the jurisdiction in force</span>
        </div>
        <div className="panel-body-flush table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>What</th>
                <th style={{ width: 110 }}>Kept for</th>
                <th>Why, and who decided</th>
                <th style={{ width: 150 }}>Last purge</th>
                <th style={{ width: 100 }} />
              </tr>
            </thead>
            <tbody>
              {policies.map((policy) => (
                <tr key={policy.dataClass} data-testid="retention-row">
                  <td>
                    <div>{policy.label}</div>
                    <div className="small muted">{policy.description}</div>
                  </td>
                  <td className="num">{policy.keepDays} days</td>
                  <td className="small secondary">
                    {policy.reason}
                    {policy.setByName ? <div className="small muted">Set by {policy.setByName}</div> : null}
                  </td>
                  <td className="small secondary">
                    {policy.lastAppliedAt
                      ? `${policy.lastPurged} removed · ${policy.lastAppliedAt.slice(0, 10)}`
                      : 'not yet run'}
                  </td>
                  <td>
                    <button
                      className="btn btn-ghost small"
                      disabled={busy}
                      onClick={() => {
                        setEditing(editing === policy.dataClass ? null : policy.dataClass)
                        setDays(String(policy.keepDays))
                        setReason('')
                        setError(null)
                      }}
                    >
                      Change
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {editing ? (
          <div className="panel-body stack stack-4" data-testid="retention-editor">
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <label className="stack stack-2" style={{ flex: '0 0 140px' }} htmlFor="retention-days">
                <span className="micro">Keep for (days)</span>
                <input
                  id="retention-days"
                  className="input"
                  inputMode="numeric"
                  value={days}
                  onChange={(event) => setDays(event.target.value)}
                />
              </label>
              <label className="stack stack-2" style={{ flex: '2 1 320px' }} htmlFor="retention-reason">
                <span className="micro">Why this number?</span>
                <input
                  id="retention-reason"
                  className="input"
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Our DPIA sets two years for anything naming a person."
                />
              </label>
            </div>
            <p className="small muted" style={{ margin: 0 }}>
              The minimum for {policies.find((p) => p.dataClass === editing)?.label.toLowerCase()} is{' '}
              {policies.find((p) => p.dataClass === editing)?.minimumDays} days. Shortening a window deletes
              what is already past it on the next daily sweep.
            </p>
            <div className="row">
              <button
                className="btn btn-primary"
                disabled={busy || !days || reason.trim().length < 8}
                onClick={async () => {
                  const payload = await post('/api/retention', {
                    dataClass: editing,
                    keepDays: Number(days),
                    reason,
                  })
                  if (payload) {
                    setEditing(null)
                    router.refresh()
                  }
                }}
              >
                Save this window
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setEditing(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="panel" data-testid="erasure">
        <div className="panel-header">
          <h2>Erase a person</h2>
          <span className="small muted">Nothing happens until you have read what it would do</span>
        </div>
        <div className="panel-body stack stack-5">
          <p className="prose small secondary" style={{ margin: 0 }}>
            Some of what a person leaves behind is theirs alone and goes. Some of it is other
            people’s work with their name on it, and that stays with the name removed. A little of
            it is kept on a stated basis — the record that a decision was taken, and the record
            that nothing was said about them behind their back. There is no undo.
          </p>

          <div className="row wrap" style={{ alignItems: 'flex-end' }}>
            <label className="stack stack-2" style={{ flex: '1 1 240px' }}>
              <span className="micro">Who</span>
              <select
                className="select"
                value={subject}
                onChange={(event) => {
                  setSubject(event.target.value)
                  setPreview(null)
                }}
              >
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name} · {member.role}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="btn"
              data-testid="erasure-preview"
              disabled={busy || !subject}
              onClick={async () => {
                const payload = await post('/api/erasure', { action: 'preview', subjectUserId: subject })
                if (payload) setPreview(payload.preview)
              }}
            >
              {busy ? 'Working…' : 'Show me what would happen'}
            </button>
          </div>

          {preview ? (
            <div className="stack stack-4" data-testid="erasure-preview-result">
              {preview.blockers.map((blocker) => (
                <div className="banner banner-critical" key={blocker}>
                  <span>{blocker}</span>
                </div>
              ))}
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>What</th>
                      <th style={{ width: 90 }}>Records</th>
                      <th style={{ width: 120 }}>Becomes</th>
                      <th>Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.lines.map((line) => (
                      <tr key={line.table}>
                        <td>{line.label}</td>
                        <td className="num">{line.count}</td>
                        <td>
                          <span className={DISPOSITION[line.disposition].chip}>
                            {DISPOSITION[line.disposition].label}
                          </span>
                        </td>
                        <td className="small secondary">{line.basis}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {preview.blockers.length === 0 ? (
                <div className="row wrap" style={{ alignItems: 'flex-end' }}>
                  <label className="stack stack-2" style={{ flex: '2 1 320px' }} htmlFor="erasure-reason">
                    <span className="micro">Why is this being erased?</span>
                    <input
                      id="erasure-reason"
                      className="input"
                      value={erasureReason}
                      onChange={(event) => setErasureReason(event.target.value)}
                      placeholder="DSAR 2026-04-11, verified by HR."
                    />
                  </label>
                  <button
                    className="btn btn-danger"
                    data-testid="erasure-execute"
                    disabled={busy || erasureReason.trim().length < 8}
                    onClick={async () => {
                      const payload = await post('/api/erasure', {
                        action: 'erase',
                        subjectUserId: subject,
                        reason: erasureReason,
                      })
                      if (payload) {
                        setNote(
                          `Erased: ${preview.totals.deleted} records deleted, ${preview.totals.anonymised} ` +
                            `anonymised, ${preview.totals.kept} kept with a stated basis.`,
                        )
                        setPreview(null)
                        setErasureReason('')
                        router.refresh()
                      }
                    }}
                  >
                    Erase — this cannot be undone
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  )
}
