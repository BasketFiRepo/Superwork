'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useStepUp } from './StepUp'

/**
 * Legal holds (§21).
 *
 * Two controls with deliberately different weights. Placing one is a plain form, because
 * the reason to place a hold is usually that somebody has just been told to and the cost
 * of a slow one is evidence. Releasing one asks for a password and a reason, because the
 * next sweep will delete what it was keeping and will not ask again.
 */

export interface HoldRow {
  id: string
  matter: string
  basis: string
  custodianNames: string[]
  coversFrom: string
  coversTo: string | null
  placedByName: string | null
  placedAt: string
  releasedByName: string | null
  releasedAt: string | null
  releaseReason: string | null
  live: boolean
}

export interface MemberRow {
  id: string
  name: string
  role: string
}

const day = (value: string | null) => (value ? value.slice(0, 10) : null)

export function LegalHolds({
  holds,
  members,
  heldRows,
}: {
  holds: HoldRow[]
  members: MemberRow[]
  heldRows: number
}) {
  const router = useRouter()
  const stepUp = useStepUp()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [placing, setPlacing] = useState(false)
  const [matter, setMatter] = useState('')
  const [basis, setBasis] = useState('')
  const [custodians, setCustodians] = useState<string[]>([])
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')

  const [releasing, setReleasing] = useState<string | null>(null)
  const [reason, setReason] = useState('')

  async function post(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    const response = await stepUp.run(() =>
      fetch('/api/holds', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
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

  const live = holds.filter((hold) => hold.live)
  const past = holds.filter((hold) => !hold.live)

  return (
    <div className="stack stack-8">
      {stepUp.prompt}
      {error ? (
        <div className="banner banner-critical" role="alert">
          {error}
        </div>
      ) : null}

      <section className="panel" data-testid="holds">
        <div className="panel-header">
          <h2>Holds in force</h2>
          <span className="small muted">
            {live.length === 0
              ? 'Nothing is being preserved beyond its window'
              : `${heldRows} record${heldRows === 1 ? '' : 's'} kept past their window at the last sweep`}
          </span>
        </div>

        {live.length === 0 ? (
          <div className="empty small secondary">
            No matter is open. Everything is deleted on the windows set under Retention.
          </div>
        ) : (
          <div className="panel-body-flush table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Matter</th>
                  <th style={{ width: 190 }}>Whose records</th>
                  <th style={{ width: 170 }}>Period</th>
                  <th>Basis</th>
                  <th style={{ width: 110 }} />
                </tr>
              </thead>
              <tbody>
                {live.map((hold) => (
                  <tr key={hold.id} data-testid="hold-row">
                    <td>
                      <div>{hold.matter}</div>
                      <div className="small muted">
                        Placed by {hold.placedByName ?? 'somebody since removed'} · {day(hold.placedAt)}
                      </div>
                    </td>
                    <td className="small secondary">
                      {hold.custodianNames.length === 0 ? (
                        <span className="chip chip-attention">everybody</span>
                      ) : (
                        hold.custodianNames.join(', ')
                      )}
                    </td>
                    <td className="small secondary">
                      {day(hold.coversFrom)} → {day(hold.coversTo) ?? 'ongoing'}
                    </td>
                    <td className="small secondary">{hold.basis}</td>
                    <td>
                      <button
                        className="btn btn-ghost small"
                        data-testid="hold-release"
                        disabled={busy}
                        onClick={() => {
                          setReleasing(releasing === hold.id ? null : hold.id)
                          setReason('')
                          setError(null)
                        }}
                      >
                        Release
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {releasing ? (
          <div className="panel-body stack stack-4" data-testid="hold-release-editor">
            <p className="prose small" style={{ margin: 0 }}>
              Releasing “{holds.find((hold) => hold.id === releasing)?.matter}” lets the ordinary
              retention windows apply again. The next daily sweep will delete whatever this was
              keeping, and it will not ask first.
            </p>
            <label className="stack stack-2" htmlFor="hold-release-reason">
              <span className="micro">Why is the matter closed?</span>
              <input
                id="hold-release-reason"
                className="input"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="Settled 2026-05-04; counsel confirmed the preservation notice is withdrawn."
              />
            </label>
            <div className="row">
              <button
                className="btn btn-danger"
                data-testid="hold-release-confirm"
                disabled={busy || reason.trim().length < 8}
                onClick={async () => {
                  const payload = await post({ action: 'release', holdId: releasing, reason })
                  if (payload) {
                    setReleasing(null)
                    router.refresh()
                  }
                }}
              >
                Release the hold
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setReleasing(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="panel" data-testid="hold-new">
        <div className="panel-header">
          <h2>Place a hold</h2>
          <span className="small muted">No password needed — stopping the deletion is the urgent half</span>
        </div>
        {!placing ? (
          <div className="panel-body">
            <button className="btn btn-primary" data-testid="hold-place-open" onClick={() => setPlacing(true)}>
              Preserve records for a matter
            </button>
          </div>
        ) : (
          <div className="panel-body stack stack-5">
            <p className="prose small secondary" style={{ margin: 0 }}>
              Everyone named here is told, in the record they can already read about themselves.
              That is not optional: preserving one person’s records indefinitely without telling
              them is the thing Superwork refuses to be able to do.
            </p>

            <label className="stack stack-2" htmlFor="hold-matter">
              <span className="micro">The matter</span>
              <input
                id="hold-matter"
                className="input"
                value={matter}
                onChange={(event) => setMatter(event.target.value)}
                placeholder="Ahlgren v. Northwind"
              />
            </label>

            <label className="stack stack-2" htmlFor="hold-basis">
              <span className="micro">What it is for</span>
              <input
                id="hold-basis"
                className="input"
                value={basis}
                onChange={(event) => setBasis(event.target.value)}
                placeholder="Preservation notice received 2026-03-02 from outside counsel."
              />
            </label>

            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <label className="stack stack-2" style={{ flex: '0 0 190px' }} htmlFor="hold-from">
                <span className="micro">Covering records from</span>
                <input
                  id="hold-from"
                  className="input"
                  type="date"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                />
              </label>
              <label className="stack stack-2" style={{ flex: '0 0 190px' }} htmlFor="hold-to">
                <span className="micro">Until (blank = ongoing)</span>
                <input
                  id="hold-to"
                  className="input"
                  type="date"
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                />
              </label>
            </div>

            <div className="stack stack-2">
              <span className="micro">Whose records — none selected means everybody’s</span>
              <div className="row wrap">
                {members.map((member) => {
                  const on = custodians.includes(member.id)
                  return (
                    <button
                      key={member.id}
                      type="button"
                      className={on ? 'chip chip-accent' : 'chip'}
                      data-testid="hold-custodian"
                      aria-pressed={on}
                      onClick={() =>
                        setCustodians(
                          on ? custodians.filter((id) => id !== member.id) : [...custodians, member.id],
                        )
                      }
                    >
                      {member.name}
                    </button>
                  )
                })}
              </div>
              {custodians.length === 0 ? (
                <span className="small muted">
                  This will preserve every record in the organization from that date. Nobody is
                  notified individually, because it is not about any individual.
                </span>
              ) : null}
            </div>

            <div className="row">
              <button
                className="btn btn-primary"
                data-testid="hold-place"
                disabled={busy || matter.trim().length < 3 || basis.trim().length < 12 || !from}
                onClick={async () => {
                  const payload = await post({
                    action: 'place',
                    matter,
                    basis,
                    custodianIds: custodians,
                    coversFrom: new Date(`${from}T00:00:00Z`).toISOString(),
                    coversTo: to ? new Date(`${to}T00:00:00Z`).toISOString() : null,
                  })
                  if (payload) {
                    setPlacing(false)
                    setMatter('')
                    setBasis('')
                    setCustodians([])
                    setFrom('')
                    setTo('')
                    router.refresh()
                  }
                }}
              >
                {busy ? 'Placing…' : 'Place the hold'}
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setPlacing(false)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>

      {past.length > 0 ? (
        <section className="panel" data-testid="holds-released">
          <div className="panel-header">
            <h2>Released</h2>
            <span className="small muted">Kept, because who stopped preserving and why is the record</span>
          </div>
          <div className="panel-body-flush table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Matter</th>
                  <th style={{ width: 170 }}>Period</th>
                  <th>Released, and why</th>
                  <th style={{ width: 120 }}>When</th>
                </tr>
              </thead>
              <tbody>
                {past.map((hold) => (
                  <tr key={hold.id}>
                    <td>{hold.matter}</td>
                    <td className="small secondary">
                      {day(hold.coversFrom)} → {day(hold.coversTo) ?? 'ongoing'}
                    </td>
                    <td className="small secondary">
                      {hold.releasedByName ?? '—'}: {hold.releaseReason}
                    </td>
                    <td className="small secondary">{day(hold.releasedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  )
}
