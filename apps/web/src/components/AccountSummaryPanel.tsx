'use client'

import { useState } from 'react'

/** The 360° summary (§12.6). Every claim is a cited fact from the database. */
export function AccountSummaryPanel({ companyId, companyName }: { companyId: string; companyName: string }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{
    narrative: string
    nextBestAction: string | null
    facts: { claim: string; sourceType: string }[]
    runId: string
    simulated: boolean
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function summarize() {
    setBusy(true)
    setError(null)
    const response = await fetch(`/api/companies/${companyId}/summary`, { method: 'POST' })
    setBusy(false)
    if (!response.ok) {
      const body = await response.json().catch(() => ({ error: 'That could not be summarized.' }))
      setError(body.error)
      return
    }
    setResult(await response.json())
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <h2>360° summary</h2>
        <button className="btn btn-sm" onClick={summarize} disabled={busy}>
          {busy ? 'Reading the account…' : result ? 'Refresh' : 'Summarize'}
        </button>
      </div>
      <div className="panel-body stack stack-4">
        {!result ? (
          <p className="small muted">
            Assembles the state of {companyName} from threads, commitments, tasks, meetings and
            documents. Every sentence corresponds to a row you can open.
          </p>
        ) : (
          <>
            <p className="prose">{result.narrative}</p>
            {result.nextBestAction ? (
              <div className="banner banner-accent">
                <span>Next best action: {result.nextBestAction}</span>
              </div>
            ) : null}
            <details>
              <summary className="small" style={{ cursor: 'pointer', color: 'var(--ink-secondary)' }}>
                {result.facts.length} cited facts
              </summary>
              <ul className="stack stack-2 small secondary" style={{ margin: 'var(--s-4) 0 0', paddingLeft: 'var(--s-7)' }}>
                {result.facts.map((f, index) => (
                  <li key={index} data-testid="relationship-fact">
                    {f.claim}{' '}
                    <span className="chip" data-testid="fact-source">
                      {f.sourceType.replace(/_/g, ' ')}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
            <div className="row-tight">
              <a className="btn btn-ghost btn-sm" href={`/activity?run=${result.runId}`}>
                View in activity
              </a>
              {result.simulated ? <span className="chip chip-accent">Simulated</span> : null}
            </div>
          </>
        )}
        {error ? <div className="banner banner-critical">{error}</div> : null}
      </div>
    </section>
  )
}
