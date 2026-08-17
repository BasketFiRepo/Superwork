'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useStepUp } from './StepUp'

/**
 * The two throttles an automation runs under (§10.2, ADR 0046).
 *
 * Both columns have existed since migration 0007, both are enforced on every firing, and
 * nothing has ever written either — every workflow in every organization has run on the
 * migration's defaults. The skip message a person sees when a cap bites says "Raise the cap
 * if that is too low"; this is the screen where that finally means something.
 *
 * The numbers beside the limits are counted in SQL by the same function the scheduler calls,
 * so what the screen says about today is what the scheduler will do about today.
 */
export function WorkflowThrottle({
  workflowId,
  maxConcurrentRuns,
  dailyActionCap,
  setByName,
  setAt,
  reason,
  capacity,
  canEdit,
  denialReason,
}: {
  workflowId: string
  maxConcurrentRuns: number
  dailyActionCap: number
  setByName: string | null
  setAt: string | null
  reason: string | null
  capacity: { unfinished: number; usedToday: number; remaining: number; allow: boolean; reason: string }
  canEdit: boolean
  denialReason: string
}) {
  const router = useRouter()
  const stepUp = useStepUp()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [runs, setRuns] = useState(String(maxConcurrentRuns))
  const [cap, setCap] = useState(String(dailyActionCap))
  const [why, setWhy] = useState('')

  const raising = Number(runs) > maxConcurrentRuns || Number(cap) > dailyActionCap

  async function save() {
    setBusy(true)
    setError(null)
    const send = () =>
      fetch(`/api/workflows/${workflowId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'limits',
          maxConcurrentRuns: Number(runs),
          dailyActionCap: Number(cap),
          reason: why.trim(),
        }),
      })
    // Raising is the direction that widens what runs unattended, so it is the one that asks.
    const response = raising ? await stepUp.run(send) : await send()
    setBusy(false)
    if (!response) return
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    if (!response.ok) {
      setError(payload.error)
      return
    }
    setEditing(false)
    setWhy('')
    router.refresh()
  }

  return (
    <section className="panel" data-testid="workflow-throttle">
      {stepUp.prompt}

      <div className="panel-header">
        <h2>How hard it may run</h2>
        <span className={capacity.allow ? 'chip chip-positive' : 'chip chip-attention'}>
          {capacity.allow ? `${capacity.remaining} actions left today` : 'held'}
        </span>
      </div>

      <div className="panel-body stack stack-3">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        <div className="row wrap" data-testid="throttle-numbers">
          <span className="small secondary">
            <strong>{maxConcurrentRuns}</strong> {maxConcurrentRuns === 1 ? 'run' : 'runs'} at once ·{' '}
            {capacity.unfinished} unfinished now
          </span>
          <span className="small secondary">
            <strong>{dailyActionCap}</strong> actions a day · {capacity.usedToday} done today
          </span>
        </div>

        {!capacity.allow ? (
          <div className="banner banner-attention" data-testid="throttle-held">
            {capacity.reason}
          </div>
        ) : null}

        <p className="small secondary" style={{ margin: 0 }} data-testid="throttle-summary">
          {setByName ? (
            <>
              <strong>{setByName}</strong> set these on {setAt?.slice(0, 10)}. {reason}
            </>
          ) : (
            <>
              Nobody has chosen these. They are the defaults every workflow starts with, and they
              are what the scheduler enforces — a run is skipped rather than queued when either
              is reached.
            </>
          )}
        </p>

        {editing ? (
          <div className="stack stack-3" data-testid="throttle-editor">
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <label className="stack stack-2" style={{ flex: '0 0 140px' }} htmlFor="throttle-runs">
                <span className="micro">Runs at once</span>
                <input
                  id="throttle-runs"
                  className="input"
                  type="number"
                  min={1}
                  max={50}
                  value={runs}
                  onChange={(event) => setRuns(event.target.value)}
                />
              </label>
              <label className="stack stack-2" style={{ flex: '0 0 160px' }} htmlFor="throttle-cap">
                <span className="micro">Actions a day</span>
                <input
                  id="throttle-cap"
                  className="input"
                  type="number"
                  min={1}
                  max={10000}
                  value={cap}
                  onChange={(event) => setCap(event.target.value)}
                />
              </label>
              <label className="stack stack-2" style={{ flex: '1 1 240px' }} htmlFor="throttle-reason">
                <span className="micro">Why</span>
                <input
                  id="throttle-reason"
                  className="input"
                  value={why}
                  onChange={(event) => setWhy(event.target.value)}
                  placeholder="Two batches a day is not enough for the Monday backlog."
                />
              </label>
            </div>

            {raising ? (
              <div className="banner banner-attention" data-testid="throttle-raising">
                That lets it do more without a person watching, so you will be asked to confirm
                your password. Lowering never asks.
              </div>
            ) : null}

            <div className="row wrap">
              <button
                className="btn btn-primary"
                data-testid="throttle-confirm"
                disabled={busy || why.trim().length < 4}
                onClick={save}
              >
                {busy ? 'Saving…' : 'Set the limits'}
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="row wrap">
            <button
              className="btn"
              data-testid="throttle-edit"
              disabled={!canEdit}
              title={canEdit ? undefined : denialReason}
              onClick={() => setEditing(true)}
            >
              Change the limits
            </button>
            {canEdit ? null : <span className="small muted">{denialReason}</span>}
          </div>
        )}

        <p className="small muted" style={{ margin: 0 }}>
          There is no “unlimited”: between 1 and 50 runs at once, and between 1 and 10,000
          actions a day. An automation that acts without a person watching has a ceiling by
          design.
        </p>
      </div>
    </section>
  )
}
