'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useStepUp } from './StepUp'

/**
 * Create → permission → simulate → publish, on one screen (§27, §24 Phase 3).
 *
 * Editing here changes nothing. It produces a *proposal*: you simulate it, say why, and
 * somebody else approves it. The publish button is deliberately not available to the
 * person who wrote the change.
 */

interface Snapshot {
  name: string
  purpose: string
  ownerUserId: string
  scopeDepartmentId: string | null
  mode: 'ask' | 'assist' | 'execute' | 'autopilot'
  toolGrants: string[]
  dataScopes: string[]
  maxSensitivity: 'public' | 'internal' | 'confidential' | 'restricted'
  scheduleCron: string | null
  escalationUserId: string | null
  autopilotDailyActionCap: number
  autopilotWeeklyCostCapCents: number
  digestDay: number
}

interface SimulationSummary {
  id: string
  windowFrom: string
  windowTo: string
  totals: {
    occasions: number
    stepsProposed: number
    stepsBlocked: number
    wouldRequireApproval: number
    wouldRunUnattended: number
    byTool: Record<string, number>
  }
  findings: { severity: string; message: string }[]
  proposals: {
    occasion: string
    request: string
    summary: string
    requiresApproval: boolean
    steps: { tool: string; riskTier: string; intent: string; allowed: boolean; reason: string; preview: string[] }[]
  }[]
  createdAt: string
}

interface ChangeSummary {
  id: string
  status: string
  justification: string
  requestedBy: string
  requestedByName: string | null
  decidedByName: string | null
  decisionNote: string | null
  simulationId: string | null
  diff: { field: string; from: string; to: string; widens: boolean }[]
  createdAt: string
}

const MODES: Snapshot['mode'][] = ['ask', 'assist', 'execute', 'autopilot']
const SENSITIVITIES: Snapshot['maxSensitivity'][] = ['public', 'internal', 'confidential', 'restricted']

export function AgentStudio({
  agent,
  snapshot,
  tools,
  people,
  departments,
  viewerId,
  changes,
  versions,
  simulations,
}: {
  agent: {
    agentId: string
    name: string
    status: string
    currentVersion: number
    ownerName: string | null
    publishedByName: string | null
    publishedAt: string | null
  }
  snapshot: Snapshot
  tools: { name: string; riskTier: string; description: string }[]
  people: { id: string; name: string }[]
  departments: { id: string; name: string }[]
  viewerId: string
  changes: ChangeSummary[]
  versions: {
    id: string
    ordinal: number
    justification: string | null
    publishedByName: string | null
    secondApproverName: string | null
    createdAt: string
  }[]
  simulations: SimulationSummary[]
}) {
  const router = useRouter()
  const [draft, setDraft] = useState<Snapshot>(snapshot)
  const [justification, setJustification] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [simulation, setSimulation] = useState<SimulationSummary | null>(simulations[0] ?? null)

  const stepUp = useStepUp()
  const dirty = JSON.stringify(draft) !== JSON.stringify(snapshot)
  const open = changes.find((change) => change.status === 'awaiting_approval') ?? null

  async function call(path: string, body: unknown, label: string): Promise<unknown | null> {
    setBusy(label)
    setError(null)
    setNote(null)
    // Approving a change publishes it, which is the half that needs fresh proof of
    // identity. `run` holds the call, asks for it, and replays it (§4.1).
    const response = await stepUp.run(() =>
      fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
    setBusy(null)
    if (!response) return null
    if (!response.ok) {
      const payload = await response.json().catch(() => ({ error: 'That did not work.' }))
      setError(payload.error)
      return null
    }
    return response.json()
  }

  async function simulate() {
    const result = (await call(
      `/api/agents/${agent.agentId}/simulate`,
      { proposed: draft, windowDays: 7 },
      'simulate',
    )) as SimulationSummary | null
    if (result) {
      setSimulation(result)
      setNote('Simulated. Nothing was executed and nothing was queued for approval.')
      router.refresh()
    }
  }

  async function propose() {
    const result = await call(
      `/api/agents/${agent.agentId}/changes`,
      { proposed: draft, justification, simulationId: simulation?.id ?? null },
      'propose',
    )
    if (result) {
      setJustification('')
      setNote('Sent for review. Somebody other than you has to approve it.')
      router.refresh()
    }
  }

  async function decide(changeId: string, decision: 'approve' | 'reject') {
    const result = await call(`/api/agents/${agent.agentId}/changes/${changeId}`, { decision }, decision)
    if (result) {
      setNote(decision === 'approve' ? 'Published.' : 'Rejected.')
      router.refresh()
    }
  }

  async function rollback(versionId: string) {
    const reason = window.prompt('Why are you rolling back? It goes in the agent’s history.')
    if (!reason) return
    const result = await call(`/api/agents/${agent.agentId}/rollback`, { versionId, reason }, 'rollback')
    if (result) {
      setNote('Rolled back.')
      router.refresh()
    }
  }

  async function setStatus(status: 'active' | 'paused' | 'retired') {
    const reason =
      status === 'active' ? undefined : window.prompt(`Why is ${agent.name} being ${status}? People depending on it will see this.`)
    if (status !== 'active' && !reason) return
    const result = await call(`/api/agents/${agent.agentId}/status`, { status, reason }, 'status')
    if (result) {
      setNote(`${agent.name} is now ${status}.`)
      router.refresh()
    }
  }

  return (
    <div className="stack stack-8">
      {stepUp.prompt}
      {note ? <div className="banner banner-accent">{note}</div> : null}
      {error ? <div className="banner banner-critical">{error}</div> : null}

      {open ? (
        <section className="panel" data-testid="pending-change">
          <div className="panel-header">
            <h2>Change waiting for approval</h2>
            <span className="chip chip-attention">{open.requestedByName} proposed it</span>
          </div>
          <div className="panel-body stack stack-4">
            <p className="prose">{open.justification}</p>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 220 }}>Field</th>
                    <th>Now</th>
                    <th>Proposed</th>
                  </tr>
                </thead>
                <tbody>
                  {open.diff.map((field) => (
                    <tr key={field.field}>
                      <td className="small">
                        {field.field}
                        {field.widens ? <span className="chip chip-attention" style={{ marginLeft: 8 }}>widens</span> : null}
                      </td>
                      <td className="small mono secondary">{field.from}</td>
                      <td className="small mono">{field.to}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {open.requestedBy === viewerId ? (
              <div className="banner">
                You proposed this change, so you cannot approve it. Anyone else who administers
                agents can.
              </div>
            ) : (
              <div className="row">
                <button className="btn btn-primary" onClick={() => decide(open.id, 'approve')} disabled={busy !== null}>
                  Approve and publish
                </button>
                <button className="btn" onClick={() => decide(open.id, 'reject')} disabled={busy !== null}>
                  Reject
                </button>
              </div>
            )}
          </div>
        </section>
      ) : null}

      <section className="panel" data-testid="agent-config">
        <div className="panel-header">
          <h2>Configuration</h2>
          <div className="row-tight">
            {dirty ? <span className="chip chip-attention">unsaved proposal</span> : <span className="chip">live</span>}
            {agent.status === 'active' ? (
              <button className="btn btn-sm" onClick={() => setStatus('paused')} disabled={busy !== null}>
                Pause
              </button>
            ) : agent.status === 'paused' ? (
              <button className="btn btn-sm" onClick={() => setStatus('active')} disabled={busy !== null}>
                Resume
              </button>
            ) : null}
          </div>
        </div>
        <div className="panel-body stack stack-5">
          <div className="row wrap" style={{ gap: 'var(--s-6)', alignItems: 'flex-start' }}>
            <label className="stack stack-1" style={{ minWidth: 220 }}>
              <span className="micro">Name</span>
              <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label className="stack stack-1" style={{ minWidth: 200 }}>
              <span className="micro">Accountable owner</span>
              <select
                className="select"
                value={draft.ownerUserId}
                onChange={(e) => setDraft({ ...draft, ownerUserId: e.target.value })}
              >
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="stack stack-1" style={{ minWidth: 200 }}>
              <span className="micro">Department</span>
              <select
                className="select"
                value={draft.scopeDepartmentId ?? ''}
                onChange={(e) => setDraft({ ...draft, scopeDepartmentId: e.target.value || null })}
              >
                <option value="">Whole organization</option>
                {departments.map((department) => (
                  <option key={department.id} value={department.id}>
                    {department.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="stack stack-1">
            <span className="micro">Purpose — this is what it runs on</span>
            <textarea
              className="input"
              rows={2}
              value={draft.purpose}
              onChange={(e) => setDraft({ ...draft, purpose: e.target.value })}
            />
          </label>

          <div className="row wrap" style={{ gap: 'var(--s-6)', alignItems: 'flex-start' }}>
            <label className="stack stack-1">
              <span className="micro">Mode ceiling</span>
              <select
                className="select"
                value={draft.mode}
                onChange={(e) => setDraft({ ...draft, mode: e.target.value as Snapshot['mode'] })}
              >
                {MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </select>
              <span className="small muted">
                {draft.mode === 'ask'
                  ? 'Reads and answers. Cannot change anything.'
                  : draft.mode === 'assist'
                    ? 'Proposes and drafts. A person applies it.'
                    : draft.mode === 'execute'
                      ? 'Runs reversible changes after a person approves the plan.'
                      : 'Runs low-risk changes unattended, inside the caps below.'}
              </span>
            </label>
            <label className="stack stack-1">
              <span className="micro">Clearance</span>
              <select
                className="select"
                value={draft.maxSensitivity}
                onChange={(e) => setDraft({ ...draft, maxSensitivity: e.target.value as Snapshot['maxSensitivity'] })}
              >
                {SENSITIVITIES.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
            </label>
            <label className="stack stack-1">
              <span className="micro">Schedule (cron, optional)</span>
              <input
                className="input mono"
                placeholder="0 8 * * 1-5"
                value={draft.scheduleCron ?? ''}
                onChange={(e) => setDraft({ ...draft, scheduleCron: e.target.value || null })}
              />
            </label>
          </div>

          <div className="stack stack-2">
            <span className="micro">Tools it may use</span>
            <div className="row wrap">
              {tools.map((tool) => {
                const granted = draft.toolGrants.includes(tool.name)
                return (
                  <button
                    key={tool.name}
                    type="button"
                    title={`${tool.description} (${tool.riskTier})`}
                    className={`chip${granted ? ' chip-accent' : ''}`}
                    style={{ cursor: 'pointer', border: '1px solid var(--hairline)' }}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        toolGrants: granted
                          ? draft.toolGrants.filter((name) => name !== tool.name)
                          : [...draft.toolGrants, tool.name],
                      })
                    }
                  >
                    {tool.name}
                    {tool.riskTier !== 'read' ? ` · ${tool.riskTier}` : ''}
                  </button>
                )
              })}
            </div>
            <span className="small muted">
              {draft.toolGrants.length === 0
                ? 'No tools. It can read and answer, nothing else.'
                : `${draft.toolGrants.length} granted. The gate refuses anything not on this list, whatever the plan says.`}
            </span>
          </div>

          <div className="row wrap" style={{ gap: 'var(--s-6)' }}>
            <label className="stack stack-1">
              <span className="micro">Autopilot cap — actions per day</span>
              <input
                className="input num"
                type="number"
                min={1}
                value={draft.autopilotDailyActionCap}
                onChange={(e) => setDraft({ ...draft, autopilotDailyActionCap: Number(e.target.value) })}
              />
            </label>
            <label className="stack stack-1">
              <span className="micro">Autopilot cap — spend per week (pence)</span>
              <input
                className="input num"
                type="number"
                min={1}
                value={draft.autopilotWeeklyCostCapCents}
                onChange={(e) => setDraft({ ...draft, autopilotWeeklyCostCapCents: Number(e.target.value) })}
              />
            </label>
            <label className="stack stack-1">
              <span className="micro">Escalates to</span>
              <select
                className="select"
                value={draft.escalationUserId ?? ''}
                onChange={(e) => setDraft({ ...draft, escalationUserId: e.target.value || null })}
              >
                <option value="">Its owner</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {person.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="row">
            <button className="btn" onClick={simulate} disabled={busy !== null} data-testid="simulate">
              {busy === 'simulate' ? 'Simulating…' : 'Simulate against the last 7 days'}
            </button>
            {dirty ? (
              <button className="btn btn-ghost" onClick={() => setDraft(snapshot)} disabled={busy !== null}>
                Discard changes
              </button>
            ) : null}
          </div>
        </div>
      </section>

      {simulation ? (
        <section className="panel" data-testid="simulation">
          <div className="panel-header">
            <h2>Simulation</h2>
            <span className="small muted">
              {new Date(simulation.windowFrom).toISOString().slice(0, 10)} → {new Date(simulation.windowTo).toISOString().slice(0, 10)}
            </span>
          </div>
          <div className="panel-body stack stack-5">
            <div className="row wrap" style={{ gap: 'var(--s-7)' }}>
              <Figure label="Occasions" value={simulation.totals.occasions} />
              <Figure label="Steps proposed" value={simulation.totals.stepsProposed} />
              <Figure label="Refused by the gate" value={simulation.totals.stepsBlocked} />
              <Figure label="Would wait for approval" value={simulation.totals.wouldRequireApproval} />
              <Figure label="Would run unattended" value={simulation.totals.wouldRunUnattended} />
            </div>

            {simulation.findings.length > 0 ? (
              <div className="stack stack-2">
                {simulation.findings.map((finding, index) => (
                  <div
                    className={`banner${finding.severity === 'high' ? ' banner-critical' : finding.severity === 'medium' ? ' banner-attention' : ''}`}
                    key={index}
                  >
                    <span className="small">{finding.message}</span>
                  </div>
                ))}
              </div>
            ) : null}

            <details>
              <summary className="small" style={{ cursor: 'pointer', color: 'var(--ink-secondary)' }}>
                What it would have done, occasion by occasion
              </summary>
              <div className="stack stack-4" style={{ marginTop: 'var(--s-4)' }}>
                {simulation.proposals.map((proposal, index) => (
                  <div className="stack stack-2" key={index}>
                    <div className="row-tight">
                      <span className="chip mono">{proposal.occasion}</span>
                      {proposal.requiresApproval ? <span className="chip chip-attention">would need approval</span> : null}
                    </div>
                    <span className="small secondary">{proposal.summary}</span>
                    {proposal.steps.map((step, stepIndex) => (
                      <div className="row-tight" key={stepIndex}>
                        <span className={`chip${step.allowed ? '' : ' chip-critical'}`}>{step.allowed ? 'would run' : 'refused'}</span>
                        <span className="small mono">{step.tool}</span>
                        <span className="small muted">{step.allowed ? step.intent : step.reason}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </details>

            <p className="small muted">
              Simulated against the data as it stands now, using the occasions this agent would
              have had in the window. Nothing was executed, and no approval was raised.
            </p>
          </div>
        </section>
      ) : null}

      <section className="panel">
        <div className="panel-header">
          <h2>Propose this change</h2>
        </div>
        <div className="panel-body stack stack-4">
          {!dirty ? (
            <p className="small muted">Change something above and it becomes a proposal you can send for review.</p>
          ) : (
            <>
              <label className="stack stack-1">
                <span className="micro">Why — the approver reads this first</span>
                <textarea
                  className="input"
                  rows={2}
                  value={justification}
                  onChange={(e) => setJustification(e.target.value)}
                  placeholder="Chasing overdue accounts by hand is taking an hour a day."
                />
              </label>
              <div className="row">
                <button
                  className="btn btn-primary"
                  onClick={propose}
                  disabled={busy !== null || justification.trim().length === 0}
                  data-testid="propose-change"
                >
                  {busy === 'propose' ? 'Sending…' : 'Send for review'}
                </button>
                {!simulation ? (
                  <span className="small muted">You can send it unsimulated, but the approver will ask.</span>
                ) : null}
              </div>
            </>
          )}
        </div>
      </section>

      <section className="panel" data-testid="agent-history">
        <div className="panel-header">
          <h2>History</h2>
          <span className="small muted">
            {agent.publishedAt ? `Published ${new Date(agent.publishedAt).toISOString().slice(0, 10)} by ${agent.publishedByName}` : 'Never published'}
          </span>
        </div>
        {versions.length === 0 ? (
          <div className="empty small secondary">No published version yet.</div>
        ) : (
          <div className="panel-body-flush table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 70 }}>Version</th>
                  <th>Why</th>
                  <th style={{ width: 160 }}>Proposed by</th>
                  <th style={{ width: 160 }}>Approved by</th>
                  <th style={{ width: 110 }}>Restore</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((version) => (
                  <tr key={version.id}>
                    <td className="num">{version.ordinal}</td>
                    <td className="small">{version.justification}</td>
                    <td className="small secondary">{version.publishedByName ?? '—'}</td>
                    <td className="small secondary">{version.secondApproverName ?? '—'}</td>
                    <td>
                      <button className="btn btn-ghost btn-sm" onClick={() => rollback(version.id)} disabled={busy !== null}>
                        Roll back
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {changes.filter((change) => change.status !== 'awaiting_approval').length > 0 ? (
        <section className="panel">
          <div className="panel-header">
            <h2>Past change requests</h2>
          </div>
          <div className="panel-body-flush">
            {changes
              .filter((change) => change.status !== 'awaiting_approval')
              .map((change) => (
                <div className="panel-body hairline-top spread" key={change.id}>
                  <div className="stack stack-1">
                    <span className="small">{change.justification}</span>
                    <span className="small muted">
                      {change.requestedByName} → {change.decidedByName ?? 'nobody yet'}
                      {change.decisionNote ? ` — ${change.decisionNote}` : ''}
                    </span>
                  </div>
                  <span className={`chip${change.status === 'published' ? ' chip-positive' : ''}`}>{change.status}</span>
                </div>
              ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="stack stack-1">
      <span className="micro">{label}</span>
      <span className="num" style={{ fontSize: 20 }}>
        {value}
      </span>
    </div>
  )
}
