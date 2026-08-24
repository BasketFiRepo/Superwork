'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * The plan, and the organization's own limits within it (§19).
 *
 * This control exists because a refusal already pointed at it. When the agent stops it says
 * *"an admin can raise the cap in Settings → Billing"* — and until now there was nothing
 * here to raise. A refusal that names a setting which does not exist is worse than a plain
 * no.
 *
 * What it cannot do is as important as what it can: an organization tightens its own limits
 * and never widens them past the plan. Changing the plan is a commercial agreement, not a
 * form, so there is no button here pretending otherwise.
 */

export interface PlanView {
  tier: string
  status: string
  seatsPurchased: number
  seatsUsed: number
  seatsRemaining: number | null
  capsReason: string | null
  capsSetByName: string | null
  limits: {
    aiSpendCapCents: number | null
    perUserDailySpendCapCents: number | null
    seats: number | null
    agentRunsPerMonth: number | null
    documentsIndexed: number | null
    storageGb: number | null
    workflowRunsPerMonth: number | null
    autopilotAllowed: boolean
    tightened: boolean
    source: { tier: string; limits: string; aiSpendCap: string; perUserDailyCap: string }
  }
  planCaps: { aiSpendCapCents: number | null; perUserDailySpendCapCents: number | null }
  /** What each limit is measured against. Shown because the plan now stops these (ADR 0086). */
  usage: {
    agentRunsThisMonth: number
    workflowRunsThisMonth: number
    documentsIndexed: number
    storageBytes: number
  }
}

const money = (cents: number | null) => (cents === null ? 'no limit' : `£${(cents / 100).toFixed(2)}`)
const limit = (value: number | null) => (value === null ? 'no limit' : value.toLocaleString('en-GB'))
const gigabytes = (bytes: number) =>
  bytes >= 1024 * 1024 * 1024 ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)}GB` : `${Math.round(bytes / 1024 / 1024)}MB`

export function PlanCaps({ plan }: { plan: PlanView }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [monthly, setMonthly] = useState(
    plan.limits.source.aiSpendCap === 'this organization' && plan.limits.aiSpendCapCents !== null
      ? String(plan.limits.aiSpendCapCents / 100)
      : '',
  )
  const [daily, setDaily] = useState(
    plan.limits.source.perUserDailyCap === 'this organization' && plan.limits.perUserDailySpendCapCents !== null
      ? String(plan.limits.perUserDailySpendCapCents / 100)
      : '',
  )
  const [reason, setReason] = useState('')

  async function save() {
    setBusy(true)
    setError(null)
    const response = await fetch('/api/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        aiSpendCapCents: monthly.trim() === '' ? null : Math.round(Number(monthly) * 100),
        perUserDailyCapCents: daily.trim() === '' ? null : Math.round(Number(daily) * 100),
        reason,
      }),
    })
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(false)
    if (!response.ok) {
      setError(payload.error)
      return
    }
    setEditing(false)
    setReason('')
    router.refresh()
  }

  const seatsTight = plan.seatsRemaining !== null && plan.seatsRemaining <= 2

  return (
    <section className="panel" data-testid="plan">
      <div className="panel-header">
        <h2>Plan and limits</h2>
        <span className="small muted">
          {plan.tier} · {plan.status}
        </span>
      </div>

      {error ? (
        <div className="panel-body">
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        </div>
      ) : null}

      <div className="panel-body-flush table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Limit</th>
              <th style={{ width: 140 }}>In force</th>
              <th style={{ width: 140 }}>The plan&rsquo;s</th>
              <th>Where it comes from</th>
            </tr>
          </thead>
          <tbody>
            <tr data-testid="plan-row">
              <td>Seats</td>
              <td className="num">
                {plan.seatsUsed} / {plan.seatsPurchased}
              </td>
              <td className="num secondary">{plan.limits.seats ?? '—'}</td>
              <td className="small secondary">
                {plan.seatsRemaining === null
                  ? 'This plan has no seat limit.'
                  : `${plan.seatsRemaining} free. An invitation nobody has accepted still holds one.`}
              </td>
            </tr>
            <tr data-testid="plan-row">
              <td>Monthly AI spend</td>
              <td className="num">{money(plan.limits.aiSpendCapCents)}</td>
              <td className="num secondary">{money(plan.planCaps.aiSpendCapCents)}</td>
              <td className="small secondary">
                {plan.limits.source.aiSpendCap === 'this organization'
                  ? 'Tightened by this organization.'
                  : `From the plan, read from the ${plan.limits.source.limits}.`}
              </td>
            </tr>
            <tr data-testid="plan-row">
              <td>Per person, per day</td>
              <td className="num">{money(plan.limits.perUserDailySpendCapCents)}</td>
              <td className="num secondary">{money(plan.planCaps.perUserDailySpendCapCents)}</td>
              <td className="small secondary">
                {plan.limits.source.perUserDailyCap === 'this organization'
                  ? 'Tightened by this organization.'
                  : 'From the plan.'}
              </td>
            </tr>
            <tr data-testid="plan-row">
              <td>Agent runs this month</td>
              <td className="num">
                {plan.usage.agentRunsThisMonth.toLocaleString('en-GB')}
                {plan.limits.agentRunsPerMonth === null ? '' : ` / ${plan.limits.agentRunsPerMonth.toLocaleString('en-GB')}`}
              </td>
              <td className="num secondary">{limit(plan.limits.agentRunsPerMonth)}</td>
              <td className="small secondary">
                At the limit a run is refused rather than queued, and the count resets on the first
                of the month.
              </td>
            </tr>
            <tr data-testid="plan-row">
              <td>Workflow runs this month</td>
              <td className="num">
                {plan.usage.workflowRunsThisMonth.toLocaleString('en-GB')}
                {plan.limits.workflowRunsPerMonth === null
                  ? ''
                  : ` / ${plan.limits.workflowRunsPerMonth.toLocaleString('en-GB')}`}
              </td>
              <td className="num secondary">{limit(plan.limits.workflowRunsPerMonth)}</td>
              <td className="small secondary">Dry runs are not counted: they are what activation requires.</td>
            </tr>
            <tr data-testid="plan-row">
              <td>Documents indexed</td>
              <td className="num">
                {plan.usage.documentsIndexed.toLocaleString('en-GB')}
                {plan.limits.documentsIndexed === null ? '' : ` / ${plan.limits.documentsIndexed.toLocaleString('en-GB')}`}
              </td>
              <td className="num secondary">{limit(plan.limits.documentsIndexed)}</td>
              <td className="small secondary">What is held, not what was added this month.</td>
            </tr>
            <tr data-testid="plan-row">
              <td>Files kept</td>
              <td className="num">
                {gigabytes(plan.usage.storageBytes)}
                {plan.limits.storageGb === null ? '' : ` / ${plan.limits.storageGb}GB`}
              </td>
              <td className="num secondary">{plan.limits.storageGb === null ? 'no limit' : `${plan.limits.storageGb}GB`}</td>
              <td className="small secondary">The bytes behind documents. Deleting a document takes them with it.</td>
            </tr>
            <tr data-testid="plan-row">
              <td>Autopilot</td>
              <td>
                <span className={plan.limits.autopilotAllowed ? 'chip chip-positive' : 'chip'}>
                  {plan.limits.autopilotAllowed ? 'allowed' : 'not on this plan'}
                </span>
              </td>
              <td className="secondary">—</td>
              <td className="small secondary">
                Set by the plan, not by a switch here. Where it is not allowed, an agent asked to run
                unattended proposes instead and says so on the run.
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {seatsTight ? (
        <div className="panel-body">
          <div className="banner banner-attention" data-testid="plan-seats-warning">
            {plan.seatsRemaining === 0
              ? 'Every seat is taken. The next invitation will be refused rather than quietly putting you over.'
              : `${plan.seatsRemaining} seat${plan.seatsRemaining === 1 ? '' : 's'} left.`}
          </div>
        </div>
      ) : null}

      {editing ? (
        <div className="panel-body hairline-top stack stack-4" data-testid="plan-editor">
          <div className="row wrap" style={{ alignItems: 'flex-end' }}>
            <label className="stack stack-2" style={{ flex: '0 0 200px' }} htmlFor="cap-monthly">
              <span className="micro">Monthly AI spend (£) — empty for the plan&rsquo;s</span>
              <input
                id="cap-monthly"
                className="input"
                type="number"
                min={0}
                step="0.01"
                value={monthly}
                onChange={(event) => setMonthly(event.target.value)}
              />
            </label>
            <label className="stack stack-2" style={{ flex: '0 0 200px' }} htmlFor="cap-daily">
              <span className="micro">Per person, per day (£)</span>
              <input
                id="cap-daily"
                className="input"
                type="number"
                min={0}
                step="0.01"
                value={daily}
                onChange={(event) => setDaily(event.target.value)}
              />
            </label>
          </div>

          <label className="stack stack-2" htmlFor="cap-reason">
            <span className="micro">Why? The agent stops when a cap is reached, and somebody will ask who set it.</span>
            <input
              id="cap-reason"
              className="input"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Trialling the agent on a small budget this month."
            />
          </label>

          <p className="small muted" style={{ margin: 0 }} data-testid="plan-tighten-only">
            You can lower these below the plan&rsquo;s, never above. Raising what the plan allows
            is a commercial change rather than a setting, so there is no control here that
            pretends to make one.
          </p>

          <div className="row">
            <button
              className="btn btn-primary"
              data-testid="plan-save"
              disabled={busy || reason.trim().length < 6}
              onClick={save}
            >
              Set the limits
            </button>
            <button className="btn btn-ghost" disabled={busy} onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="panel-body hairline-top row" style={{ justifyContent: 'space-between' }}>
          <button
            className="btn"
            data-testid="plan-edit"
            disabled={busy}
            onClick={() => {
              setEditing(true)
              setError(null)
            }}
          >
            Set this organization&rsquo;s limits
          </button>
          {plan.capsReason ? (
            <span className="small muted">
              {plan.capsReason}
              {plan.capsSetByName ? ` — ${plan.capsSetByName}` : ''}
            </span>
          ) : null}
        </div>
      )}
    </section>
  )
}
