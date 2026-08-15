'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useStepUp } from './StepUp'

/**
 * Approval policies (§11.1).
 *
 * The rules on this screen decide which proposed actions stop for a person, who may decide
 * them, and by when. They were rows in the database that governed nothing while the gate
 * carried its own hardcoded copy of one of them.
 *
 * The screen has one job beyond listing them: to make it impossible to believe a policy can
 * switch an approval *off*. It cannot — every rule tightens — and saying so once at the top
 * is cheaper than a support conversation about why turning a rule off did not let the agent
 * send mail on its own.
 */

export interface PolicyRow {
  id: string
  name: string
  description: string | null
  rule: {
    match: {
      tools?: string[]
      minWrites?: number
      minRisk?: string
      actorType?: string
      mode?: string
    }
    require?: { approverRole?: string; slaHours?: number }
    effect: 'require' | 'deny'
  }
  priority: number
  enabled: boolean
}

export interface ToolOption {
  name: string
  label: string
  riskTier: string
}

const ROLES = ['manager', 'admin', 'owner']

/** Plain English for a rule's match, so nobody has to read JSON to know what it catches. */
function describeMatch(rule: PolicyRow['rule']): string {
  const parts: string[] = []
  if (rule.match.tools?.length) {
    parts.push(`uses ${rule.match.tools.map((t) => t.replace(/@v\d+$/, '').replace(/_/g, ' ')).join(' or ')}`)
  }
  if (rule.match.minWrites !== undefined) parts.push(`changes ${rule.match.minWrites} or more things`)
  if (rule.match.minRisk) parts.push(`is ${rule.match.minRisk === 'high' ? 'high risk' : `${rule.match.minRisk} risk`} or above`)
  if (rule.match.actorType) parts.push(`is proposed by ${rule.match.actorType === 'agent' ? 'an agent' : 'a person'}`)
  if (rule.match.mode) parts.push(`runs in ${rule.match.mode} mode`)
  return parts.length ? parts.join(', and ') : 'matches nothing — this rule is inert'
}

function describeEffect(rule: PolicyRow['rule']): string {
  if (rule.effect === 'deny') return 'it is refused outright — no card, nothing to approve'
  const bits: string[] = []
  if (rule.require?.approverRole) bits.push(`a ${rule.require.approverRole} must decide it`)
  if (rule.require?.slaHours !== undefined) bits.push(`within ${rule.require.slaHours} hours`)
  return bits.length ? bits.join(', ') : 'it needs an approval'
}

export function ApprovalPolicies({ policies, tools }: { policies: PolicyRow[]; tools: ToolOption[] }) {
  const router = useRouter()
  const stepUp = useStepUp()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [toggling, setToggling] = useState<string | null>(null)
  const [toggleReason, setToggleReason] = useState('')

  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [effect, setEffect] = useState<'require' | 'deny'>('require')
  const [matchKind, setMatchKind] = useState<'tools' | 'minWrites' | 'minRisk'>('tools')
  const [tool, setTool] = useState('')
  const [minWrites, setMinWrites] = useState('20')
  const [minRisk, setMinRisk] = useState('high')
  const [approverRole, setApproverRole] = useState('manager')
  const [slaHours, setSlaHours] = useState('4')

  async function post(body: Record<string, unknown>) {
    setBusy(true)
    setError(null)
    const response = await stepUp.run(() =>
      fetch('/api/approval-policies', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
    setBusy(false)
    if (!response) return
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    if (!response.ok) {
      setError(payload.error)
      return
    }
    setToggling(null)
    setToggleReason('')
    setAdding(false)
    setName('')
    setDescription('')
    setTool('')
    router.refresh()
  }

  const live = policies.filter((policy) => policy.enabled)

  return (
    <div className="stack stack-8">
      {stepUp.prompt}
      {error ? (
        <div className="banner banner-critical" role="alert">
          {error}
        </div>
      ) : null}

      <section className="panel" data-testid="approval-policies">
        <div className="panel-header">
          <h2>Rules in force</h2>
          <span className="small muted">
            {live.length} of {policies.length} switched on
          </span>
        </div>

        <div className="panel-body">
          <p className="prose small secondary" style={{ margin: 0 }} data-testid="policy-floor">
            Every change an agent proposes is already held for a person. These rules only
            ever <strong>tighten</strong> that: a more senior approver, a shorter deadline,
            or an outright refusal. There is no rule that switches an approval off, and
            turning one off here returns to the default — it does not let anything through
            unattended.
          </p>
        </div>

        {policies.length === 0 ? (
          <div className="panel-body">
            <div className="empty small secondary">No rules. Changes are held for whoever proposed them.</div>
          </div>
        ) : (
          <div className="panel-body-flush table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Rule</th>
                  <th>When a plan…</th>
                  <th>…then</th>
                  <th style={{ width: 80 }}>Order</th>
                  <th style={{ width: 120 }} />
                </tr>
              </thead>
              <tbody>
                {policies.map((policy) => (
                  <tr
                    key={policy.id}
                    data-testid="policy-row"
                    style={policy.enabled ? undefined : { opacity: 0.55 }}
                  >
                    <td>
                      {policy.name}
                      {policy.description ? <div className="small muted">{policy.description}</div> : null}
                      {!policy.enabled ? <div className="small muted">switched off</div> : null}
                    </td>
                    <td className="small secondary">{describeMatch(policy.rule)}</td>
                    <td className="small secondary">
                      <span className={policy.rule.effect === 'deny' ? 'chip chip-critical' : 'chip'}>
                        {policy.rule.effect === 'deny' ? 'refuse' : 'require'}
                      </span>{' '}
                      {describeEffect(policy.rule)}
                    </td>
                    <td className="num small secondary">{policy.priority}</td>
                    <td>
                      <button
                        className="btn btn-ghost small"
                        data-testid="policy-toggle"
                        disabled={busy}
                        onClick={() => {
                          setToggling(toggling === policy.id ? null : policy.id)
                          setToggleReason('')
                          setError(null)
                        }}
                      >
                        {policy.enabled ? 'Switch off' : 'Switch on'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {toggling ? (
          <div className="panel-body hairline-top stack stack-4" data-testid="policy-toggle-editor">
            <label className="stack stack-2" htmlFor="policy-reason">
              <span className="micro">
                Why? Turning a rule off is the change somebody will be asked about later.
              </span>
              <input
                id="policy-reason"
                className="input"
                value={toggleReason}
                onChange={(event) => setToggleReason(event.target.value)}
                placeholder="Superseded by the new delegation matrix agreed with the works council."
              />
            </label>
            <div className="row">
              <button
                className="btn btn-primary"
                data-testid="policy-toggle-confirm"
                disabled={busy || toggleReason.trim().length < 8}
                onClick={() =>
                  post({
                    action: 'toggle',
                    policyId: toggling,
                    enabled: !policies.find((p) => p.id === toggling)?.enabled,
                    reason: toggleReason,
                  })
                }
              >
                Confirm
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setToggling(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Add a rule</h2>
          <span className="small muted">it can tighten, never loosen</span>
        </div>

        {adding ? (
          <div className="panel-body stack stack-4" data-testid="policy-editor">
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <label className="stack stack-2" style={{ flex: '2 1 280px' }} htmlFor="policy-name">
                <span className="micro">Call it something the approval card can cite</span>
                <input
                  id="policy-name"
                  className="input"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Contract changes need a manager"
                />
              </label>
              <label className="stack stack-2" style={{ flex: '0 0 150px' }} htmlFor="policy-effect">
                <span className="micro">And then</span>
                <select
                  id="policy-effect"
                  className="select"
                  value={effect}
                  onChange={(event) => setEffect(event.target.value as 'require' | 'deny')}
                >
                  <option value="require">require approval</option>
                  <option value="deny">refuse it</option>
                </select>
              </label>
            </div>

            <label className="stack stack-2" htmlFor="policy-description">
              <span className="micro">What is this for? (shown beside the rule)</span>
              <input
                id="policy-description"
                className="input"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="Anything touching a signed contract gets a second pair of eyes."
              />
            </label>

            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <label className="stack stack-2" style={{ flex: '0 0 190px' }} htmlFor="policy-match">
                <span className="micro">When a plan…</span>
                <select
                  id="policy-match"
                  className="select"
                  value={matchKind}
                  onChange={(event) => setMatchKind(event.target.value as typeof matchKind)}
                >
                  <option value="tools">uses a particular tool</option>
                  <option value="minWrites">changes many things</option>
                  <option value="minRisk">is risky enough</option>
                </select>
              </label>

              {matchKind === 'tools' ? (
                <label className="stack stack-2" style={{ flex: '1 1 260px' }} htmlFor="policy-tool">
                  <span className="micro">Which tool</span>
                  <select
                    id="policy-tool"
                    className="select"
                    value={tool}
                    onChange={(event) => setTool(event.target.value)}
                  >
                    <option value="">Choose…</option>
                    {tools.map((option) => (
                      <option key={option.name} value={option.name}>
                        {option.label} ({option.riskTier})
                      </option>
                    ))}
                  </select>
                </label>
              ) : matchKind === 'minWrites' ? (
                <label className="stack stack-2" style={{ flex: '0 0 180px' }} htmlFor="policy-writes">
                  <span className="micro">At least this many</span>
                  <input
                    id="policy-writes"
                    className="input"
                    type="number"
                    min={1}
                    value={minWrites}
                    onChange={(event) => setMinWrites(event.target.value)}
                  />
                </label>
              ) : (
                <label className="stack stack-2" style={{ flex: '0 0 180px' }} htmlFor="policy-risk">
                  <span className="micro">At this risk or above</span>
                  <select
                    id="policy-risk"
                    className="select"
                    value={minRisk}
                    onChange={(event) => setMinRisk(event.target.value)}
                  >
                    <option value="low">low</option>
                    <option value="high">high</option>
                  </select>
                </label>
              )}
            </div>

            {effect === 'require' ? (
              <div className="row wrap" style={{ alignItems: 'flex-end' }}>
                <label className="stack stack-2" style={{ flex: '0 0 190px' }} htmlFor="policy-approver">
                  <span className="micro">Who decides</span>
                  <select
                    id="policy-approver"
                    className="select"
                    value={approverRole}
                    onChange={(event) => setApproverRole(event.target.value)}
                  >
                    {ROLES.map((role) => (
                      <option key={role} value={role}>
                        a {role}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="stack stack-2" style={{ flex: '0 0 170px' }} htmlFor="policy-sla">
                  <span className="micro">Within (hours)</span>
                  <input
                    id="policy-sla"
                    className="input"
                    type="number"
                    min={1}
                    max={168}
                    value={slaHours}
                    onChange={(event) => setSlaHours(event.target.value)}
                  />
                </label>
              </div>
            ) : (
              <p className="small muted" style={{ margin: 0 }}>
                A refusal produces no card. The plan&rsquo;s changes are struck out with this
                rule&rsquo;s name as the reason, so the person who asked can see which rule stopped
                it rather than being told no.
              </p>
            )}

            <div className="row">
              <button
                className="btn btn-primary"
                data-testid="policy-save"
                disabled={busy || name.trim().length < 3 || (matchKind === 'tools' && !tool)}
                onClick={() =>
                  post({
                    action: 'create',
                    name,
                    description: description || undefined,
                    priority: 50,
                    rule: {
                      match:
                        matchKind === 'tools'
                          ? { tools: [tool] }
                          : matchKind === 'minWrites'
                            ? { minWrites: Number(minWrites) }
                            : { minRisk },
                      ...(effect === 'require'
                        ? { require: { approverRole, slaHours: Number(slaHours) } }
                        : {}),
                      effect,
                    },
                  })
                }
              >
                Add it
              </button>
              <button className="btn btn-ghost" disabled={busy} onClick={() => setAdding(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="panel-body row">
            <button
              className="btn"
              data-testid="policy-add"
              disabled={busy}
              onClick={() => {
                setAdding(true)
                setError(null)
              }}
            >
              Add a rule
            </button>
          </div>
        )}
      </section>
    </div>
  )
}
