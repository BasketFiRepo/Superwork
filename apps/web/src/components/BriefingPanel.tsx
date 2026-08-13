'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

interface BriefingState {
  narrative: string
  counts: Record<string, number>
  citations: { label: string; route: string; count: number }[]
  recommendation: { headline: string; why: string; action: { label: string; kind: string; args: Record<string, unknown> } | null } | null
  generatedAt: string
  simulated: boolean
  localDate: string
}

export function BriefingPanel({ kind, initial }: { kind: 'daily' | 'end_of_day'; initial: BriefingState | null }) {
  const router = useRouter()
  const [state, setState] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  async function generate() {
    setBusy(true)
    setNote(null)
    const response = await fetch('/api/briefing/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, force: true }),
    })
    setBusy(false)
    if (!response.ok) {
      setNote('The briefing could not be generated.')
      return
    }
    router.refresh()
    const body = await response.json()
    setState((current) => (current ? { ...current, narrative: body.narrative } : current))
    if (!state) window.location.reload()
  }

  async function runAction(args: Record<string, unknown>) {
    setBusy(true)
    await fetch('/api/agent/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        request: String(args['request'] ?? ''),
        mode: String(args['mode'] ?? 'execute'),
        uiContext: { route: '/briefing' },
      }),
    })
    setBusy(false)
    setNote('Started. The plan will appear in the agent rail for approval before anything changes.')
  }

  if (!state) {
    return (
      <div className="panel">
        <div className="empty stack stack-4">
          <p className="secondary">No {kind === 'daily' ? 'briefing' : 'summary'} for today yet.</p>
          <p className="prose small muted" style={{ margin: '0 auto' }}>
            The worker generates these automatically at each person&rsquo;s configured hour, in their own
            timezone. You can also generate it now.
          </p>
          <div className="row" style={{ justifyContent: 'center' }}>
            <button className="btn btn-primary" onClick={generate} disabled={busy}>
              {busy ? 'Computing…' : 'Generate it now'}
            </button>
          </div>
          {note ? <span className="small muted">{note}</span> : null}
        </div>
      </div>
    )
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <div className="row-tight">
          <h2>{state.localDate}</h2>
          {state.simulated ? <span className="chip chip-accent">Simulated</span> : null}
        </div>
        <button className="btn btn-ghost btn-sm" onClick={generate} disabled={busy}>
          {busy ? 'Recomputing…' : 'Regenerate'}
        </button>
      </div>
      <div className="panel-body stack stack-6">
        <p className="prose display" data-testid="briefing" style={{ fontSize: 18, lineHeight: 1.6, fontWeight: 400 }}>
          {state.narrative}
        </p>

        {state.citations.length > 0 ? (
          <div className="row wrap">
            {state.citations.map((c) => (
              <a className="citation" href={c.route} key={c.label}>
                {c.label}: {c.count}
              </a>
            ))}
          </div>
        ) : null}

        {state.recommendation ? (
          <div className="banner banner-accent">
            <div className="stack stack-3 grow">
              <strong>{state.recommendation.headline}</strong>
              <span>{state.recommendation.why}</span>
              {state.recommendation.action ? (
                <div className="row" data-testid="briefing-action">
                  {state.recommendation.action.kind === 'agent' ? (
                    <button
                      className="btn btn-primary btn-sm"
                      disabled={busy}
                      onClick={() => runAction(state.recommendation!.action!.args)}
                    >
                      {state.recommendation.action.label}
                    </button>
                  ) : (
                    <a className="btn btn-sm" href={String(state.recommendation.action.args['route'] ?? '/')}>
                      {state.recommendation.action.label}
                    </a>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {note ? <div className="banner">{note}</div> : null}
      </div>
    </div>
  )
}
