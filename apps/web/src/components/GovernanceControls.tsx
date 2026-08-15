'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useStepUp } from './StepUp'

/**
 * The two ceilings an admin could see and not set (§4.4, §29.5).
 *
 * The monitoring policy decides how hard this system may chase the people who work here. The
 * grant list decides what any agent may do at all — and the agent's own refusal has always
 * said "An admin can add it in Settings → AI governance", pointing at a screen that listed
 * the grants and had no control on it.
 *
 * Both directions of the monitoring policy tighten: **fewer** contacts a day, a **longer**
 * window to answer. The jurisdiction's own numbers are the boundary and are shown beside the
 * fields, because a control that silently clamps is not a control.
 */

export interface MonitoringView {
  jurisdictionProfile: string
  nudgeBudgetPerPersonPerDay: number
  noSurprisesReviewHours: number
  ceiling: { nudgeBudgetPerPersonPerDay: number; noSurprisesReviewHours: number }
  reason: string | null
  setByName: string | null
  prohibited: string[]
}

export interface GrantRow {
  id: string
  capability: string
  toolPattern: string
  effect: 'allow' | 'deny'
  maxSensitivity: string
  departmentName: string | null
  reason: string | null
  grantedByName: string | null
}

export interface DepartmentOption {
  id: string
  name: string
}

export function GovernanceControls({
  monitoring,
  grants,
  departments,
  canEdit,
}: {
  monitoring: MonitoringView
  grants: GrantRow[]
  departments: DepartmentOption[]
  canEdit: boolean
}) {
  const router = useRouter()
  const stepUp = useStepUp()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [budget, setBudget] = useState(String(monitoring.nudgeBudgetPerPersonPerDay))
  const [hours, setHours] = useState(String(monitoring.noSurprisesReviewHours))
  const [why, setWhy] = useState('')

  const [adding, setAdding] = useState(false)
  const [capability, setCapability] = useState('')
  const [toolPattern, setToolPattern] = useState('')
  const [effect, setEffect] = useState<'allow' | 'deny'>('allow')
  const [maxSensitivity, setMaxSensitivity] = useState('internal')
  const [department, setDepartment] = useState('')
  const [grantReason, setGrantReason] = useState('')

  /** Grants ask for the password again; tightening the monitoring policy does not. */
  async function post(body: Record<string, unknown>, stepped: boolean) {
    setBusy(true)
    setError(null)
    const send = () =>
      fetch('/api/governance', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    const response = stepped ? await stepUp.run(send) : await send()
    setBusy(false)
    if (!response) return
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    if (!response.ok) {
      setError(payload.error)
      return
    }
    setAdding(false)
    setWhy('')
    setCapability('')
    setToolPattern('')
    setGrantReason('')
    router.refresh()
  }

  return (
    <div className="stack stack-8">
      {/* The prompt renders where the change is made, so the password is asked for beside
          the thing it is protecting rather than at the top of the page. */}
      {stepUp.prompt}
      {error ? (
        <div className="banner banner-critical" role="alert">
          {error}
        </div>
      ) : null}

      <section className="panel" data-testid="monitoring-policy">
        <div className="panel-header">
          <h2>How hard this system may chase people</h2>
          <span className="chip">{monitoring.jurisdictionProfile.replace(/_/g, ' ')}</span>
        </div>
        <div className="panel-body stack stack-4">
          <p className="prose small secondary" style={{ margin: 0 }} data-testid="monitoring-tighten-only">
            These can only be tightened. Your jurisdiction profile allows at most{' '}
            <strong>{monitoring.ceiling.nudgeBudgetPerPersonPerDay}</strong> contacts per person per
            day and requires at least <strong>{monitoring.ceiling.noSurprisesReviewHours}h</strong> for
            somebody to answer before anything about them goes past them. You can ask for fewer
            contacts and give longer to answer — never the other way round.
          </p>

          <div className="row wrap" style={{ alignItems: 'flex-end' }}>
            <label className="stack stack-2" style={{ flex: '0 0 220px' }} htmlFor="nudge-budget">
              <span className="micro">Contacts per person per day</span>
              <input
                id="nudge-budget"
                className="input"
                type="number"
                min={0}
                max={monitoring.ceiling.nudgeBudgetPerPersonPerDay}
                value={budget}
                disabled={!canEdit}
                onChange={(event) => setBudget(event.target.value)}
              />
            </label>
            <label className="stack stack-2" style={{ flex: '0 0 220px' }} htmlFor="review-hours">
              <span className="micro">Hours to answer first</span>
              <input
                id="review-hours"
                className="input"
                type="number"
                min={monitoring.ceiling.noSurprisesReviewHours}
                max={168}
                value={hours}
                disabled={!canEdit}
                onChange={(event) => setHours(event.target.value)}
              />
            </label>
            <label className="stack stack-2" style={{ flex: '1 1 260px' }} htmlFor="monitoring-reason">
              <span className="micro">Why</span>
              <input
                id="monitoring-reason"
                className="input"
                value={why}
                disabled={!canEdit}
                onChange={(event) => setWhy(event.target.value)}
                placeholder="Works council asked for a quieter cadence."
              />
            </label>
          </div>

          {canEdit ? (
            <div className="row">
              <button
                className="btn btn-primary"
                data-testid="monitoring-save"
                disabled={busy || why.trim().length < 4}
                onClick={() =>
                  post(
                    {
                      action: 'monitoring',
                      nudgeBudgetPerPersonPerDay: Number(budget),
                      noSurprisesReviewHours: Number(hours),
                      reason: why.trim(),
                    },
                    false,
                  )
                }
              >
                {busy ? 'Saving…' : 'Save'}
              </button>
            </div>
          ) : (
            <p className="small muted" style={{ margin: 0 }}>
              Changing this needs administrator access.
            </p>
          )}

          {monitoring.setByName ? (
            <p className="small muted" style={{ margin: 0 }}>
              Last set by {monitoring.setByName}
              {monitoring.reason ? `: ${monitoring.reason}` : ''}
            </p>
          ) : null}

          <div className="hairline-top stack stack-2" style={{ paddingTop: 'var(--s-4)' }}>
            <span className="micro">Refused by the database, not by a setting</span>
            <ul className="stack stack-2 small secondary" style={{ margin: 0, paddingLeft: 'var(--s-7)' }}>
              {monitoring.prohibited.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="small muted" style={{ margin: 0 }}>
              There is no admin setting that turns these on. A row that tried would be rejected by a
              check constraint.
            </p>
          </div>
        </div>
      </section>

      <section className="panel" data-testid="agent-grants">
        <div className="panel-header">
          <h2>What agents may do here</h2>
          <span className="small muted">{grants.length} lines · deny beats allow</span>
        </div>
        <div className="panel-body stack stack-4">
          <p className="prose small secondary" style={{ margin: 0 }}>
            The ceiling for every agent in this organization. An agent can never exceed it, and can
            never exceed the person it is acting for. Where a deny and an allow both match, the deny
            wins. With no allow lines at all, agents are limited by their own configuration and by
            the person — this list narrows, it does not enable.
          </p>

          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 140 }}>Capability</th>
                  <th>Resource and verb</th>
                  <th style={{ width: 130 }}>Department</th>
                  <th style={{ width: 110 }}>Reads up to</th>
                  <th style={{ width: 90 }}>Effect</th>
                  {canEdit ? <th style={{ width: 90 }} /> : null}
                </tr>
              </thead>
              <tbody>
                {grants.map((grant) => (
                  <tr key={grant.id} data-testid="grant-row">
                    <td className="mono">{grant.capability}</td>
                    <td className="mono small">
                      {grant.toolPattern}
                      {grant.reason ? <div className="small muted">{grant.reason}</div> : null}
                    </td>
                    <td className="small secondary">{grant.departmentName ?? 'All'}</td>
                    <td className="small secondary">{grant.maxSensitivity}</td>
                    <td>
                      <span className={grant.effect === 'allow' ? 'chip chip-positive' : 'chip chip-critical'}>
                        {grant.effect}
                      </span>
                    </td>
                    {canEdit ? (
                      <td>
                        <button
                          className="btn btn-ghost small"
                          data-testid="grant-remove"
                          disabled={busy}
                          onClick={() =>
                            post(
                              { action: 'remove_grant', id: grant.id, reason: 'No longer needed.' },
                              true,
                            )
                          }
                        >
                          Remove
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {canEdit ? (
            adding ? (
              <div className="stack stack-4" data-testid="grant-editor">
                <div className="row wrap" style={{ alignItems: 'flex-end' }}>
                  <label className="stack stack-2" style={{ flex: '0 0 160px' }} htmlFor="grant-capability">
                    <span className="micro">Capability</span>
                    <input
                      id="grant-capability"
                      className="input"
                      value={capability}
                      onChange={(event) => setCapability(event.target.value)}
                      placeholder="email"
                    />
                  </label>
                  <label className="stack stack-2" style={{ flex: '0 0 200px' }} htmlFor="grant-pattern">
                    <span className="micro">Resource and verb</span>
                    <input
                      id="grant-pattern"
                      className="input"
                      value={toolPattern}
                      onChange={(event) => setToolPattern(event.target.value)}
                      placeholder="email:send or crm:*"
                    />
                  </label>
                  <label className="stack stack-2" style={{ flex: '0 0 130px' }} htmlFor="grant-effect">
                    <span className="micro">Effect</span>
                    <select
                      id="grant-effect"
                      className="select"
                      value={effect}
                      onChange={(event) => setEffect(event.target.value as 'allow' | 'deny')}
                    >
                      <option value="allow">allow</option>
                      <option value="deny">deny</option>
                    </select>
                  </label>
                  <label className="stack stack-2" style={{ flex: '0 0 150px' }} htmlFor="grant-sensitivity">
                    <span className="micro">Reads up to</span>
                    <select
                      id="grant-sensitivity"
                      className="select"
                      value={maxSensitivity}
                      onChange={(event) => setMaxSensitivity(event.target.value)}
                    >
                      {['public', 'internal', 'confidential', 'restricted'].map((level) => (
                        <option key={level} value={level}>
                          {level}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="stack stack-2" style={{ flex: '0 0 190px' }} htmlFor="grant-department">
                    <span className="micro">Department</span>
                    <select
                      id="grant-department"
                      className="select"
                      value={department}
                      onChange={(event) => setDepartment(event.target.value)}
                    >
                      <option value="">Everybody</option>
                      {departments.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <label className="stack stack-2" htmlFor="grant-reason">
                  <span className="micro">Why</span>
                  <input
                    id="grant-reason"
                    className="input"
                    value={grantReason}
                    onChange={(event) => setGrantReason(event.target.value)}
                    placeholder="Support may draft replies; nothing sends without a person."
                  />
                </label>
                <div className="row wrap">
                  <button
                    className="btn btn-primary"
                    data-testid="grant-confirm"
                    disabled={busy || !capability.trim() || !toolPattern.trim() || grantReason.trim().length < 4}
                    onClick={() =>
                      post(
                        {
                          action: 'grant',
                          capability: capability.trim(),
                          toolPattern: toolPattern.trim(),
                          effect,
                          maxSensitivity,
                          departmentId: department || null,
                          reason: grantReason.trim(),
                        },
                        true,
                      )
                    }
                  >
                    {busy ? 'Working…' : 'Save this line'}
                  </button>
                  <button className="btn btn-ghost" disabled={busy} onClick={() => setAdding(false)}>
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="row">
                <button className="btn" data-testid="grant-add" disabled={busy} onClick={() => setAdding(true)}>
                  Add a line
                </button>
              </div>
            )
          ) : null}
        </div>
      </section>
    </div>
  )
}
