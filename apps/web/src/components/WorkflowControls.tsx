'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * The activation gate, as a control (§10.2, §10.3.6).
 *
 * The dry run comes first and the button that activates is disabled until one has passed
 * for *this* version. The server enforces the same rule — this is the explanation, not the
 * protection.
 */

interface Outcome {
  status: string
  note: string
  occurrences: number
  matched: number
  approvalId: string | null
  error: string | null
  steps: { nodeId: string; label: string; status: string; detail: string }[]
}

export function WorkflowControls({
  workflow,
  members,
}: {
  workflow: { id: string; status: string; simulatedOk: boolean; ownerUserId: string | null }
  members: { id: string; name: string }[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [owner, setOwner] = useState(workflow.ownerUserId ?? members[0]?.id ?? '')

  async function call(path: string, body: Record<string, unknown>, label: string) {
    setBusy(label)
    setError(null)
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => ({ error: 'That could not be read.' }))
    setBusy(null)
    if (!response.ok) {
      setError(payload.error)
      return null
    }
    router.refresh()
    return payload
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>Dry run, then activate</h2>
        <span className="small muted">In that order, always</span>
      </div>
      <div className="panel-body stack stack-5">
        <p className="prose small secondary" style={{ margin: 0 }}>
          A dry run reads exactly what a real run would and stops before every effect. It tells you
          how often this would have fired and what it would have done. Editing the workflow clears
          the result — the gate belongs to the version, not to the name.
        </p>

        {error ? (
          <div className="banner banner-critical" role="alert">
            {error}
          </div>
        ) : null}

        {outcome ? (
          <div className="stack stack-3" data-testid="workflow-outcome">
            <div className="banner">
              <span>{outcome.note}</span>
            </div>
            <ul className="stack stack-2 small secondary" style={{ margin: 0, paddingLeft: 'var(--s-7)' }}>
              {outcome.steps.map((step) => (
                <li key={step.nodeId}>
                  <strong>{step.label}</strong> — {step.detail}
                </li>
              ))}
            </ul>
            {outcome.approvalId ? (
              <a className="btn btn-ghost" href="/approvals">
                It is waiting for your approval
              </a>
            ) : null}
          </div>
        ) : null}

        <div className="row wrap">
          <button
            className="btn"
            data-testid="workflow-dry-run"
            disabled={busy !== null}
            onClick={async () => {
              const payload = await call(`/api/workflows/${workflow.id}/simulate`, { windowDays: 30 }, 'simulate')
              if (payload) setOutcome(payload)
            }}
          >
            {busy === 'simulate' ? 'Reading the last 30 days…' : 'Dry run against the last 30 days'}
          </button>

          <label className="row-tight">
            <span className="micro">Accountable owner</span>
            <select className="select" value={owner} onChange={(event) => setOwner(event.target.value)}>
              {members.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name}
                </option>
              ))}
            </select>
          </label>

          {workflow.status === 'active' ? (
            <>
              <button
                className="btn"
                disabled={busy !== null}
                onClick={() => call(`/api/workflows/${workflow.id}`, { action: 'pause' }, 'pause')}
              >
                Pause
              </button>
              <button
                className="btn btn-primary"
                disabled={busy !== null}
                onClick={async () => {
                  const payload = await call(`/api/workflows/${workflow.id}`, { action: 'run' }, 'run')
                  if (payload?.outcome) setOutcome(payload.outcome)
                }}
              >
                {busy === 'run' ? 'Running…' : 'Run it now'}
              </button>
            </>
          ) : (
            <button
              className="btn btn-primary"
              data-testid="workflow-activate"
              disabled={busy !== null || !workflow.simulatedOk || !owner}
              title={
                workflow.simulatedOk
                  ? 'Activates this version, with the owner named beside it.'
                  : 'Dry-run this version first. Nothing is activated until a run against real data has shown what it would do.'
              }
              onClick={() => call(`/api/workflows/${workflow.id}`, { action: 'activate', ownerUserId: owner }, 'activate')}
            >
              {busy === 'activate' ? 'Activating…' : 'Activate'}
            </button>
          )}
        </div>
      </div>
    </section>
  )
}
