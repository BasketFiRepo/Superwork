'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { TraceRail, type TraceStep } from './TraceRail'

/**
 * The agent lives docked in the context rail, always aware of the current route.
 * It is not a floating bubble (§16.4). The mode selector is always visible so the user
 * is never uncertain whether what they typed will *do* something (§5.10).
 */

type Mode = 'ask' | 'assist' | 'execute'

interface PlanView {
  summary: string
  steps: { id: string; tool: string; intent: string }[]
  needsAttention: { label: string; reason: string }[]
}

interface RailState {
  runId: string | null
  steps: TraceStep[]
  narrative: string
  plan: PlanView | null
  approvalId: string | null
  approvalTitle: string | null
  status: 'idle' | 'running' | 'awaiting_approval' | 'done' | 'failed'
  error: string | null
  costCents: number
  undoable: boolean
  simulated: boolean
  citations: { claim: string; documentTitle?: string | null; documentId?: string | null; anchor?: string | null; sourceType: string }[]
  injectionWarnings: { label: string; patterns: string[] }[]
}

/** Mirrors the RunEvent union the runtime publishes over SSE. */
type StreamEvent =
  | { type: 'run.started'; runId: string; traceId: string }
  | { type: 'step.started'; ordinal: number; phase: string; label: string }
  | { type: 'step.finished'; ordinal: number; status: TraceStep['status']; durationMs: number }
  | { type: 'plan.ready'; plan: { summary: string; steps: PlanView['steps']; needsAttention?: PlanView['needsAttention'] } }
  | { type: 'approval.required'; approvalId: string; title: string }
  | { type: 'tool.called' }
  | { type: 'tool.result' }
  | { type: 'text'; delta: string }
  | {
      type: 'run.completed'
      status: string
      costCents: number
      report: {
        narrative: string
        undoable: boolean
        simulated: boolean
        citations: RailState['citations']
        injectionWarnings: RailState['injectionWarnings']
      }
    }
  | { type: 'run.failed'; failureClass: string; message: string }

const EMPTY: RailState = {
  runId: null,
  steps: [],
  narrative: '',
  plan: null,
  approvalId: null,
  approvalTitle: null,
  status: 'idle',
  error: null,
  costCents: 0,
  undoable: false,
  simulated: false,
  citations: [],
  injectionWarnings: [],
}

const SUGGESTIONS: Record<Mode, string[]> = {
  ask: ['What is our liability cap for Halden Foods?', 'What does the cold chain SOP say about escalation?'],
  assist: ['Which customers have gone quiet?', 'What is at risk this week?'],
  execute: ['Create follow-up tasks for all overdue customers.', 'Clean up my overdue list.'],
}

export function AgentRail({ timezone }: { timezone: string }) {
  const pathname = usePathname()
  const router = useRouter()
  const [mode, setMode] = useState<Mode>('assist')
  const [request, setRequest] = useState('')
  const [state, setState] = useState<RailState>(EMPTY)
  const streamRef = useRef<EventSource | null>(null)

  useEffect(() => () => streamRef.current?.close(), [])

  const consume = useCallback((runId: string) => {
    streamRef.current?.close()
    const source = new EventSource(`/api/agent/stream?runId=${runId}`)
    streamRef.current = source

    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as StreamEvent
      setState((prev): RailState => {
        switch (event.type) {
          case 'step.started':
            return {
              ...prev,
              steps: [
                ...prev.steps.filter((s) => s.ordinal !== event.ordinal),
                {
                  ordinal: event.ordinal,
                  phase: event.phase,
                  label: event.label,
                  status: 'running' as const,
                  startedAt: new Date().toISOString(),
                },
              ].sort((a, b) => a.ordinal - b.ordinal),
            }
          case 'step.finished':
            return {
              ...prev,
              steps: prev.steps.map((s) =>
                s.ordinal === event.ordinal ? { ...s, status: event.status, durationMs: event.durationMs } : s,
              ),
            }
          case 'plan.ready':
            return { ...prev, plan: { summary: event.plan.summary, steps: event.plan.steps, needsAttention: event.plan.needsAttention ?? [] } }
          case 'approval.required':
            return { ...prev, status: 'awaiting_approval', approvalId: event.approvalId, approvalTitle: event.title }
          case 'text':
            return { ...prev, narrative: prev.narrative + event.delta }
          case 'run.completed':
            return {
              ...prev,
              status: 'done',
              narrative: event.report.narrative || prev.narrative,
              costCents: event.costCents,
              undoable: event.report.undoable,
              simulated: event.report.simulated,
              citations: event.report.citations ?? [],
              injectionWarnings: event.report.injectionWarnings ?? [],
            }
          case 'run.failed':
            return { ...prev, status: 'failed', error: event.message }
          default:
            return prev
        }
      })
      if (event.type === 'run.completed' || event.type === 'run.failed') {
        source.close()
        router.refresh()
      }
    }

    source.onerror = () => source.close()
  }, [router])

  const submit = useCallback(
    async (text: string) => {
      if (!text.trim()) return
      setState({ ...EMPTY, status: 'running' })
      setRequest('')
      const response = await fetch('/api/agent/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request: text, mode, uiContext: { route: pathname } }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: 'Something failed before the run started.' }))
        setState((prev) => ({ ...prev, status: 'failed', error: body.error }))
        return
      }
      const { runId } = await response.json()
      setState((prev) => ({ ...prev, runId }))
      consume(runId)
    },
    [consume, mode, pathname],
  )

  const decide = useCallback(
    async (decision: 'approve' | 'reject') => {
      if (!state.approvalId) return
      setState((prev) => ({ ...prev, status: 'running' }))
      const response = await fetch(`/api/approvals/${state.approvalId}/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision, reason: decision === 'reject' ? 'Rejected from the agent rail.' : undefined }),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => ({ error: 'The decision could not be recorded.' }))
        setState((prev) => ({ ...prev, status: 'failed', error: body.error }))
        return
      }
      if (decision === 'reject') {
        setState((prev) => ({ ...prev, status: 'done', approvalId: null, narrative: 'Rejected. Nothing was changed.' }))
        router.refresh()
        return
      }
      if (state.runId) consume(state.runId)
    },
    [consume, router, state.approvalId, state.runId],
  )

  const undo = useCallback(async () => {
    if (!state.runId) return
    const response = await fetch(`/api/runs/${state.runId}/undo`, { method: 'POST' })
    const body = await response.json()
    setState((prev) => ({ ...prev, narrative: body.narrative ?? prev.narrative, undoable: false }))
    router.refresh()
  }, [router, state.runId])

  return (
    <div className="stack" style={{ height: '100%' }}>
      <div className="spread" style={{ padding: 'var(--s-5) var(--s-6)', borderBottom: '1px solid var(--hairline)' }}>
        <span className="micro">Agent</span>
        <div className="row-tight">
          {(['ask', 'assist', 'execute'] as Mode[]).map((option) => (
            <button
              key={option}
              className={`btn btn-sm${mode === option ? ' btn-primary' : ' btn-ghost'}`}
              onClick={() => setMode(option)}
              title={
                option === 'ask'
                  ? 'Answers with citations. Changes nothing.'
                  : option === 'assist'
                    ? 'Answers and proposes plans. Executes nothing.'
                    : 'Executes reversible changes. Anything outbound is drafted for approval.'
              }
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      <div className="grow stack stack-5" style={{ padding: 'var(--s-6)', overflowY: 'auto' }}>
        {state.status === 'idle' ? (
          <div className="stack stack-4">
            <p className="small secondary">
              Ask about the company, or tell the agent what to do. It sees the page you are on
              ({pathname}) and answers in {timezone}.
            </p>
            <div className="stack stack-2">
              {SUGGESTIONS[mode].map((suggestion) => (
                <button key={suggestion} className="btn btn-ghost btn-sm" style={{ justifyContent: 'flex-start' }} onClick={() => submit(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {state.injectionWarnings.length > 0 ? (
          <div className="banner banner-critical" role="alert">
            <span>
              Suspicious content detected in {state.injectionWarnings.length} source
              {state.injectionWarnings.length === 1 ? '' : 's'}. It was reported, not acted on, and
              this run was restricted to reversible changes.
            </span>
          </div>
        ) : null}

        {state.steps.length > 0 || state.narrative ? (
          <TraceRail
            steps={state.steps}
            narrative={state.narrative || null}
            citations={state.citations}
            timezone={timezone}
          >
            {state.plan && state.status === 'awaiting_approval' ? (
              <div className="stack stack-4" style={{ marginTop: 'var(--s-4)' }}>
                <p className="prose">{state.plan.summary}</p>
                {state.plan.needsAttention.length > 0 ? (
                  <div className="banner banner-attention">
                    <div className="stack stack-2">
                      <strong>Needs your attention</strong>
                      {state.plan.needsAttention.map((item) => (
                        <span key={item.label}>
                          {item.label} — {item.reason}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className="row wrap">
                  <button className="btn btn-primary" onClick={() => decide('approve')}>
                    Approve plan
                  </button>
                  <button className="btn" onClick={() => decide('reject')}>
                    Reject
                  </button>
                  <a className="btn btn-ghost" href="/approvals">
                    Review {state.plan.steps.length} steps
                  </a>
                </div>
              </div>
            ) : null}

            {state.status === 'done' ? (
              <div className="row wrap" style={{ marginTop: 'var(--s-5)' }}>
                {state.undoable ? (
                  <button className="btn btn-danger btn-sm" onClick={undo}>
                    Undo this run
                  </button>
                ) : null}
                {state.runId ? (
                  <a className="btn btn-ghost btn-sm" href={`/activity?run=${state.runId}`}>
                    View in activity
                  </a>
                ) : null}
                <span className="chip mono">{(state.costCents / 100).toFixed(4)} GBP</span>
                {state.simulated ? <span className="chip chip-accent">Simulated</span> : null}
              </div>
            ) : null}
          </TraceRail>
        ) : null}

        {state.error ? (
          <div className="banner banner-critical" role="alert">
            {state.error}
          </div>
        ) : null}
      </div>

      <form
        className="stack stack-4"
        style={{ padding: 'var(--s-6)', borderTop: '1px solid var(--hairline)' }}
        onSubmit={(event) => {
          event.preventDefault()
          void submit(request)
        }}
      >
        <textarea
          className="textarea"
          value={request}
          placeholder={mode === 'execute' ? 'Tell the agent what to do…' : 'Ask about the company…'}
          onChange={(event) => setRequest(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void submit(request)
            }
          }}
          aria-label="Message the agent"
        />
        <div className="spread">
          <span className="small muted">
            {mode === 'execute' ? 'Changes are previewed and approved first.' : 'Nothing will be changed.'}
          </span>
          <button className="btn btn-primary btn-sm" type="submit" disabled={state.status === 'running' || !request.trim()}>
            {state.status === 'running' ? 'Working…' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  )
}
