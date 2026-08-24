'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useStepUp } from './StepUp'

/**
 * Changing the plan (§19, ADR 0086).
 *
 * The panel next door sets this organization's own limits *within* a plan and says, in as many
 * words, that changing the plan is "a commercial agreement, not a form, so there is no button here
 * pretending otherwise". That sentence was true of a product where `subscriptions.tier` had no
 * writer at all. This is the button, and what makes it honest is that nothing about it pretends:
 *
 *   • the cost is shown before anything is committed, and badged **Simulated** while no billing
 *     system is connected — a figure whose provenance is hidden is worse than no figure;
 *   • what would *stop working* is shown beside what would start, in the words the refusal would
 *     later use, because a downgrade that surprises somebody a week later is a downgrade nobody
 *     really agreed to;
 *   • what cannot be done says so with the arithmetic — thirty-two people do not fit on
 *     twenty-five seats, and no button here will deactivate seven of them to make it true.
 *
 * Nothing is committed without a reason and a fresh password. Every other step-up in this product
 * asks in one direction only; this one asks in both, because spending the company's money and
 * stopping its service are both things a lifted cookie must not do.
 */

export interface PlanRow {
  tier: string
  seats: number | null
  agentRunsPerMonth: number | null
  documentsIndexed: number | null
  storageGb: number | null
  workflowRunsPerMonth: number | null
  aiSpendCapCents: number | null
  autopilotAllowed: boolean
}

export interface PlanPreview {
  from: { tier: string; seats: number; status: string; periodEnd: string | null }
  to: { tier: string; seats: number }
  direction: 'upgrade' | 'downgrade' | 'seats' | 'unchanged'
  quote: { amountCents: number; currency: string; periodDays: number; description: string; simulated: boolean }
  seats: { used: number; after: number; ceiling: number | null }
  gains: string[]
  losses: string[]
  blockers: string[]
}

export interface PlanChangeView {
  tier: string
  status: string
  seatsPurchased: number
  periodEnd: string | null
  planChangeReason: string | null
  planChangedByName: string | null
  providerReference: string | null
}

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(cents / 100)

export function PlanChange({
  plan,
  catalogue,
  mayChange,
}: {
  plan: PlanChangeView
  catalogue: PlanRow[]
  /** False for an administrator, who may read what a plan costs and not buy one (ADR 0086). */
  mayChange: boolean
}) {
  const router = useRouter()
  const stepUp = useStepUp()
  const [tier, setTier] = useState(plan.tier)
  const [seats, setSeats] = useState(String(plan.seatsPurchased))
  const [reason, setReason] = useState('')
  const [preview, setPreview] = useState<PlanPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<'change' | 'cancel' | 'resume' | null>(null)

  const seatsNumber = Number(seats)
  const seatsUsable = Number.isInteger(seatsNumber) && seatsNumber >= 1

  // The preview follows the form rather than a button, so the cost of a choice is visible while
  // it is being made. It changes nothing on the server — that is what makes it safe to do here.
  useEffect(() => {
    let cancelled = false
    if (!seatsUsable) return
    const timer = setTimeout(async () => {
      const response = await fetch(`/api/plan/change?tier=${tier}&seats=${seatsNumber}`)
      const body = await response.json().catch(() => null)
      if (cancelled) return
      if (!response.ok) {
        setPreview(null)
        setError(body?.error ?? 'That could not be priced.')
        return
      }
      setError(null)
      setPreview(body.preview)
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [tier, seatsNumber, seatsUsable])

  async function submit(action: 'change' | 'cancel' | 'resume') {
    setBusy(true)
    setError(null)
    const response = await stepUp.run(() =>
      fetch('/api/plan/change', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          action === 'change' ? { action, tier, seats: seatsNumber, reason } : { action, reason },
        ),
      }),
    )
    setBusy(false)
    if (!response) return
    const body = await response.json().catch(() => ({ error: 'That could not be read.' }))
    if (!response.ok) {
      setError(body.error)
      return
    }
    setConfirming(null)
    setReason('')
    router.refresh()
  }

  const blocked = (preview?.blockers.length ?? 0) > 0
  const nothingToDo = preview?.direction === 'unchanged'

  return (
    <section className="panel" data-testid="plan-change">
      <div className="panel-header">
        <h2>Change the plan</h2>
        <span className="small muted">
          {plan.status === 'cancelled' && plan.periodEnd
            ? `Ends ${plan.periodEnd.slice(0, 10)}`
            : plan.periodEnd
              ? `Renews ${plan.periodEnd.slice(0, 10)}`
              : 'Does not renew'}
        </span>
      </div>

      {stepUp.prompt ? <div className="panel-body">{stepUp.prompt}</div> : null}

      {error ? (
        <div className="panel-body">
          <div className="banner banner-critical" role="alert" data-testid="plan-change-error">
            {error}
          </div>
        </div>
      ) : null}

      {plan.status === 'past_due' ? (
        <div className="panel-body">
          <div className="banner banner-critical" data-testid="plan-past-due">
            The last payment did not go through. New agent and workflow runs are stopped until it is
            settled — nothing has been deleted, and moving to a smaller plan is not blocked.
          </div>
        </div>
      ) : null}

      <div className="panel-body-flush table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: 140 }}>Plan</th>
              <th style={{ width: 90 }}>Seats</th>
              <th style={{ width: 130 }}>Agent runs</th>
              <th style={{ width: 130 }}>Workflow runs</th>
              <th style={{ width: 120 }}>Documents</th>
              <th style={{ width: 100 }}>Files</th>
              <th>Unattended</th>
            </tr>
          </thead>
          <tbody>
            {catalogue.map((row) => (
              <tr key={row.tier} data-testid="plan-option" aria-selected={row.tier === tier}>
                <td>
                  <label className="row-tight" style={{ gap: 'var(--s-2)' }}>
                    <input
                      type="radio"
                      name="tier"
                      value={row.tier}
                      checked={row.tier === tier}
                      onChange={() => setTier(row.tier)}
                      aria-label={`Choose the ${row.tier} plan`}
                    />
                    <span>{row.tier}</span>
                    {row.tier === plan.tier ? <span className="chip">current</span> : null}
                  </label>
                </td>
                <td className="num secondary">{row.seats ?? '—'}</td>
                <td className="num secondary">{count(row.agentRunsPerMonth)}</td>
                <td className="num secondary">{count(row.workflowRunsPerMonth)}</td>
                <td className="num secondary">{count(row.documentsIndexed)}</td>
                <td className="num secondary">{row.storageGb === null ? 'no limit' : `${row.storageGb}GB`}</td>
                <td className="small secondary">{row.autopilotAllowed ? 'agents may run unattended' : 'a person is always in the loop'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="panel-body hairline-top stack stack-4">
        <div className="row wrap" style={{ alignItems: 'flex-end' }}>
          <label className="stack stack-2" style={{ flex: '0 0 160px' }} htmlFor="plan-seats">
            <span className="micro">Seats</span>
            <input
              id="plan-seats"
              className="input"
              data-testid="plan-seats"
              type="number"
              min={1}
              value={seats}
              onChange={(event) => setSeats(event.target.value)}
            />
          </label>
          {preview ? (
            <div className="stack stack-1" data-testid="plan-quote">
              <span className="micro">What it would cost</span>
              <span className="num" style={{ fontSize: 22 }}>
                {money(preview.quote.amountCents, preview.quote.currency)}
                <span className="small muted"> / {preview.quote.periodDays} days</span>
              </span>
              <span className="small muted">
                {preview.quote.simulated ? <span className="chip">Simulated</span> : null} {preview.quote.description}
              </span>
            </div>
          ) : null}
        </div>

        {preview ? (
          <div className="row wrap" style={{ gap: 'var(--s-8)', alignItems: 'flex-start' }}>
            <div className="stack stack-2" style={{ flex: '1 1 260px' }} data-testid="plan-gains">
              <span className="micro">What this adds</span>
              {preview.gains.length === 0 ? (
                <span className="small secondary">Nothing — this plan is not larger than the one you are on.</span>
              ) : (
                <ul className="small secondary" style={{ margin: 0, paddingLeft: '1.1em' }}>
                  {preview.gains.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
            </div>
            <div className="stack stack-2" style={{ flex: '1 1 260px' }} data-testid="plan-losses">
              <span className="micro">What stops working</span>
              {preview.losses.length === 0 ? (
                <span className="small secondary">Nothing stops working.</span>
              ) : (
                <ul className="small secondary" style={{ margin: 0, paddingLeft: '1.1em' }}>
                  {preview.losses.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : null}

        {blocked ? (
          <div className="banner banner-attention" data-testid="plan-blockers">
            {preview!.blockers.join(' ')}
          </div>
        ) : null}

        {confirming === 'change' || confirming === 'cancel' || confirming === 'resume' ? (
          <label className="stack stack-2" htmlFor="plan-reason">
            <span className="micro">
              Why? A plan change costs money, and somebody will ask who made it.
            </span>
            <input
              id="plan-reason"
              className="input"
              data-testid="plan-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Six more people joined operations this month."
            />
          </label>
        ) : null}

        {mayChange ? null : (
          <p className="small muted" style={{ margin: 0 }} data-testid="plan-change-forbidden">
            What a plan costs is here for you to read. Committing the organization to one is the
            owner&rsquo;s: it is a bill, and the person who signed for the account is the person who
            takes it on.
          </p>
        )}

        <div className="row wrap">
          {confirming === null ? (
            <>
              <button
                className="btn btn-primary"
                data-testid="plan-change-start"
                disabled={!mayChange || busy || blocked || nothingToDo || !seatsUsable}
                onClick={() => {
                  setConfirming('change')
                  setError(null)
                }}
              >
                {preview?.direction === 'downgrade'
                  ? `Move to ${tier}`
                  : preview?.direction === 'seats'
                    ? `Buy ${seatsNumber} seats`
                    : `Move to ${tier}`}
              </button>
              {plan.status === 'cancelled' ? (
                <button
                  className="btn"
                  data-testid="plan-resume-start"
                  disabled={!mayChange || busy}
                  onClick={() => setConfirming('resume')}
                >
                  Keep the plan
                </button>
              ) : plan.tier === 'free' ? null : (
                <button
                  className="btn btn-ghost"
                  data-testid="plan-cancel-start"
                  disabled={!mayChange || busy}
                  onClick={() => setConfirming('cancel')}
                >
                  Cancel the plan
                </button>
              )}
            </>
          ) : (
            <>
              <button
                className="btn btn-primary"
                data-testid="plan-confirm"
                disabled={busy || reason.trim().length < 6}
                onClick={() => submit(confirming)}
              >
                {confirming === 'change'
                  ? 'Confirm the change'
                  : confirming === 'cancel'
                    ? 'Cancel at the end of the period'
                    : 'Keep this plan'}
              </button>
              <button
                className="btn btn-ghost"
                disabled={busy}
                onClick={() => {
                  setConfirming(null)
                  setReason('')
                }}
              >
                Back
              </button>
            </>
          )}
        </div>

        {confirming === 'cancel' ? (
          <p className="small muted" style={{ margin: 0 }} data-testid="plan-cancel-note">
            Cancelling ends the plan on {plan.periodEnd ? plan.periodEnd.slice(0, 10) : 'the end of the period'},
            not today: you keep what you paid for until then. Nothing is deleted when it ends — the
            organization moves to Free, and everything already here stays readable.
          </p>
        ) : null}

        {plan.planChangeReason ? (
          <p className="small muted" style={{ margin: 0 }} data-testid="plan-provenance">
            Last change: {plan.planChangeReason}
            {plan.planChangedByName ? ` — ${plan.planChangedByName}` : ''}
            {plan.providerReference ? ` · ${plan.providerReference}` : ''}
          </p>
        ) : null}
      </div>
    </section>
  )
}

function count(value: number | null): string {
  return value === null ? 'no limit' : value.toLocaleString('en-GB')
}
