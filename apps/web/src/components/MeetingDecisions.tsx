'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * The decisions read out of a meeting, and who has stood behind them (ADR 0065).
 *
 * The panel used to be subtitled "Recorded from the transcript — confirm anything that reads
 * wrong", which was an instruction pointing at a control that did not exist: nothing in the
 * product could write `decisions.confirmed_at`. Every row here was extracted by an assistant
 * and carries the confidence it had, so the difference between "the transcript appears to say
 * this" and "somebody who was there agrees" is the whole point of the panel.
 */

export interface DecisionRow {
  id: string
  summary: string
  status: string
  confidence: number | null
  confirmedAt: string | null
  confirmedByName: string | null
  fromAgentRun: boolean
  /** The point in the meeting the decision was read out of (ADR 0078). */
  decidedAt: string
  canConfirm: boolean
  refusal: string | null
}

export function MeetingDecisions({ decisions }: { decisions: DecisionRow[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [withdrawing, setWithdrawing] = useState<string | null>(null)
  const [reason, setReason] = useState('')

  async function post(decisionId: string, confirmed: boolean, why?: string) {
    setBusy(decisionId)
    setError(null)
    const response = await fetch('/api/decision-confirmation', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decisionId, confirmed, ...(why ? { reason: why } : {}) }),
    })
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(null)
    if (!response.ok) {
      setError(payload.error)
      return
    }
    setWithdrawing(null)
    setReason('')
    router.refresh()
  }

  const unconfirmed = decisions.filter((d) => !d.confirmedAt).length

  return (
    <section className="panel" data-testid="meeting-decisions">
      <div className="panel-header">
        <h2>Decisions</h2>
        <span className="small muted" data-testid="decisions-unconfirmed">
          {unconfirmed === 0
            ? 'Every one confirmed by somebody who was there'
            : `${unconfirmed} nobody has confirmed yet`}
        </span>
      </div>

      <div className="panel-body stack stack-3">
        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}
        <p className="small secondary prose" style={{ margin: 0 }}>
          These were read out of the transcript by the assistant. Until somebody who was in the
          meeting confirms one, it is what the transcript appears to say rather than what the
          company decided — and the assistant is told the difference before it quotes one back.
        </p>
      </div>

      <div className="panel-body-flush table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Decision</th>
              {/* Everything on this panel happened in one meeting, so the useful half of the
                  moment is the time — which is the meeting's start plus the offset of the line
                  the decision was read out of (ADR 0078). */}
              <th style={{ width: 80 }}>Said at</th>
              <th style={{ width: 100 }}>Status</th>
              <th style={{ width: 100 }}>Read as</th>
              <th style={{ width: 260 }}>Stood behind by</th>
            </tr>
          </thead>
          <tbody>
            {decisions.map((decision) => (
              <tr key={decision.id} data-testid="decision-row">
                <td className="small">{decision.summary}</td>
                <td className="small mono muted" data-testid="decision-said-at">
                  {decision.decidedAt.slice(11, 16)}
                </td>
                <td>
                  <span className={decision.status === 'deferred' ? 'chip chip-attention' : 'chip chip-positive'}>
                    {decision.status}
                  </span>
                </td>
                <td className="num small">
                  {decision.confidence !== null ? `${(Number(decision.confidence) * 100).toFixed(0)}%` : '—'}
                </td>
                <td className="small">
                  {decision.confirmedAt ? (
                    <div className="stack stack-2">
                      <span data-testid="decision-confirmed">
                        <strong>{decision.confirmedByName ?? 'Somebody'}</strong>
                        {decision.confirmedAt ? ` · ${decision.confirmedAt.slice(0, 10)}` : ''}
                      </span>
                      {decision.canConfirm ? (
                        withdrawing === decision.id ? (
                          <div className="stack stack-2">
                            <input
                              className="input"
                              data-testid="decision-withdraw-reason"
                              value={reason}
                              placeholder="Why the signature is coming off"
                              onChange={(event) => setReason(event.target.value)}
                            />
                            <div className="row">
                              <button
                                className="btn btn-ghost"
                                data-testid="decision-withdraw-confirm"
                                disabled={busy !== null || reason.trim().length < 4}
                                onClick={() => post(decision.id, false, reason)}
                              >
                                {busy === decision.id ? 'Saving…' : 'Withdraw it'}
                              </button>
                              <button
                                className="btn btn-ghost"
                                disabled={busy !== null}
                                onClick={() => {
                                  setWithdrawing(null)
                                  setReason('')
                                }}
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            className="btn btn-ghost btn-small"
                            data-testid="decision-withdraw-open"
                            disabled={busy !== null}
                            onClick={() => setWithdrawing(decision.id)}
                          >
                            Withdraw
                          </button>
                        )
                      ) : null}
                    </div>
                  ) : decision.canConfirm ? (
                    <button
                      className="btn btn-small"
                      data-testid="decision-confirm"
                      disabled={busy !== null}
                      onClick={() => post(decision.id, true)}
                    >
                      {busy === decision.id ? 'Saving…' : 'I was there — this is right'}
                    </button>
                  ) : (
                    <span className="muted" data-testid="decision-refusal">
                      {decision.refusal ?? 'Nobody yet.'}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
