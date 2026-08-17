'use client'

/**
 * The agent trace rail (§16.5).
 *
 * Agent output is never a chat bubble. It renders as a trace: a 1px vertical rule with
 * small square nodes marking each step, timestamps in mono, narrative to the right.
 * This one component carries the product's credibility, and it is reused in the
 * activity timeline, the run inspector and audit views.
 */

export interface TraceStep {
  ordinal: number
  phase: string
  label: string
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'awaiting_approval'
  durationMs?: number | null
  startedAt?: string | null
  toolName?: string | null
  errorMessage?: string | null
}

export interface TraceCitation {
  claim: string
  documentTitle?: string | null
  documentId?: string | null
  anchor?: string | null
  sourceType: string
}

/**
 * A step's clock time, in the viewing person's timezone (§2.4).
 *
 * The timezone is a required argument rather than a defaulted one on purpose. Without it
 * this read the runtime's own zone, which is the server's during the render and the
 * browser's a moment later during hydration — so the same step showed two different times
 * on one page load, and on a UTC host every time was wrong for everybody not on UTC. Both
 * call sites had the right zone to hand and neither was asked for it.
 */
function formatTime(value: string | null | undefined, timeZone: string): string {
  if (!value) return '--:--:--'
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value))
}

function formatDuration(ms?: number | null): string {
  if (!ms) return ''
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

export function TraceRail({
  steps,
  narrative,
  citations = [],
  timezone,
  children,
}: {
  steps: TraceStep[]
  narrative?: string | null
  citations?: TraceCitation[]
  /** The viewing person's timezone. Required: see `formatTime`. */
  timezone: string
  children?: React.ReactNode
}) {
  return (
    <div className="trace">
      {steps.map((step) => (
        <div className="trace-node" data-status={step.status} key={`${step.ordinal}-${step.label}`}>
          <div className="trace-label">
            <span className="trace-time">{formatTime(step.startedAt, timezone)}</span>
            <span className={step.status === 'skipped' ? 'muted' : undefined}>{step.label}</span>
            {step.status === 'awaiting_approval' ? <span className="chip chip-attention">Paused</span> : null}
            <span className="trace-duration">{formatDuration(step.durationMs)}</span>
          </div>
          {step.errorMessage ? (
            <div className="small" style={{ color: 'var(--critical)', marginTop: 'var(--s-2)' }}>
              {step.errorMessage}
            </div>
          ) : null}
        </div>
      ))}

      {narrative ? (
        <div className="trace-body">
          <p className="prose">{narrative}</p>
          {citations.length > 0 ? (
            <div className="row wrap" style={{ marginTop: 'var(--s-4)' }}>
              {citations.map((citation, index) => (
                <a
                  key={index}
                  className="citation"
                  href={
                    citation.documentId
                      ? `/knowledge/${citation.documentId}${citation.anchor ? `#${encodeURIComponent(citation.anchor)}` : ''}`
                      : '#'
                  }
                  title={citation.claim}
                >
                  {citation.documentTitle ?? (citation.sourceType === 'query_aggregate' ? 'Database' : 'Source')}
                </a>
              ))}
            </div>
          ) : null}
          {children}
        </div>
      ) : (
        children
      )}
    </div>
  )
}
